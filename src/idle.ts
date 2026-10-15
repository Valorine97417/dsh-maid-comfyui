/**
 * Lifecycle for a local ComfyUI this plugin started.
 *
 * A ComfyUI server holds several GB of VRAM loaded and a few hundred MB of RSS
 * even with nothing queued, so leaving one running after a single image is
 * waste the user pays for in every other GPU workload. The plugin therefore
 * stops the server it started itself when the work that needed it is over: the
 * end of a conversation turn (see `shutdownNow`), or the panel's power button,
 * which drives the same explicit path through `shutdownComfyUI`.
 *
 * There is no idle timer. An earlier version also stopped the server after a
 * configurable quiet period; that backstop is gone, so the plugin never stops a
 * server merely because it has been quiet. (The module keeps its historical
 * `idle` name — the timer it used to own no longer exists.)
 *
 * Boundaries, deliberately narrow:
 * - Only an instance **this plugin launched** is ever stopped. `armed` is set
 *   by a successful launch (and restored from `<dataDir>/launched.json` across
 *   host restarts). A ComfyUI the user started by hand is never touched.
 * - Only a loopback `baseUrl` qualifies. A server on another machine is not
 *   ours to kill, and its port would resolve to nothing local anyway.
 * - Never while work is in flight: the caller supplies `busy()`, which reports
 *   the ComfyUI queue (running + pending) and the plugin's tracked runs. A
 *   shutdown that lands mid-generation would destroy the user's image. A
 *   request that arrives while the queue is still draining is remembered and
 *   retried until the queue empties.
 * - The PID is resolved from the listening port at shutdown time, never cached:
 *   a `.bat` launcher exits immediately, so the pid we spawned is not the
 *   server's pid.
 *
 * ComfyUI 0.39 exposes no "quit" route (only /interrupt and /free), so stopping
 * it means terminating the process that listens on its port — on Windows with
 * `taskkill /T /F` so the launcher's whole tree (bat → python) goes with it.
 */
import { execFile } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

/** How often a deferred "the work is over" request is retried. The tick only
 * acts while such a request is waiting for the queue to drain; with nothing
 * pending it does nothing at all, because the plugin has no idle timer. */
const PENDING_TICK_MS = 5_000

export interface IdleShutdownDeps {
  /** True while a generation is queued, running, or tracked as in flight. */
  busy(): Promise<boolean>
  /** PIDs listening on a local TCP port. Empty = nothing to stop. */
  findPids(port: number): Promise<number[]>
  /** Terminate the given PIDs (process tree included, best effort). */
  kill(pids: number[]): Promise<void>
  /** Path of the marker file that survives a host restart; empty = memory only. */
  markerPath(): string
  /** Host-side log sink. */
  log?(message: string): void
}

export interface IdleShutdown {
  /** This plugin just started a server; arms the shutdown and persists it. */
  markLaunched(port: number): void
  /** Forget the launch (the server is down or the plugin is unloading). */
  clearLaunched(): void
  /**
   * Stop because the work is over (the conversation's turn ended, or the user
   * pressed the panel's power button). The safety gates still apply: an unarmed
   * server, an in-flight generation, and a server that never bound its port all
   * keep it alive. A run that outlives the turn leaves the request pending, so
   * the next tick stops the server as soon as the queue drains.
   */
  shutdownNow(reason: string): Promise<'stopped' | 'skipped'>
  /** One check, exposed so tests drive it directly. Finishes a deferred request. */
  check(): Promise<'stopped' | 'skipped'> | 'stopped' | 'skipped'
  dispose(): void
  /** Diagnostics for the panel and logs. */
  snapshot(): { armed: boolean; port: number | null }
}

/** Extract a local TCP port from a base URL; undefined when remote or unusable. */
export function localPortOf(baseUrl: string): number | undefined {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return undefined
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '0.0.0.0') return undefined
  if (url.port !== '') {
    const port = Number(url.port)
    return Number.isInteger(port) && port > 0 ? port : undefined
  }
  if (url.protocol === 'http:') return 80
  if (url.protocol === 'https:') return 443
  return undefined
}

/** Run a command and resolve with its stdout; never rejects. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? stdout : '')
    })
  })
}

/** Default port→PID lookup: netstat on Windows, lsof elsewhere. */
export async function findListeningPids(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    // netstat rows look like `TCP    127.0.0.1:8188    0.0.0.0:0    LISTENING    28912`
    const out = await run('netstat', ['-ano', '-p', 'TCP'])
    const pids = new Set<number>()
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const cells = line.trim().split(/\s+/)
      const local = cells[1] ?? ''
      const pid = Number(cells[cells.length - 1])
      if (local.endsWith(`:${String(port)}`) && Number.isInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
  }
  const out = await run('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t'])
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** Default process-tree kill: taskkill on Windows, SIGTERM elsewhere. */
export async function killProcessTree(pids: number[]): Promise<void> {
  for (const pid of pids) {
    if (process.platform === 'win32') {
      await run('taskkill', ['/PID', String(pid), '/T', '/F'])
    } else {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone: nothing to report.
      }
    }
  }
}

/** Create the shutdown owner bound to one plugin instance. */
export function createIdleShutdown(deps: IdleShutdownDeps): IdleShutdown {
  let armed = false
  let port: number | null = null
  let running = false
  let disposed = false
  /** A "the work is over" request that arrived while the queue was still
   * draining. The next tick finishes the job instead of dropping it — an async
   * run outliving its turn is the common case, not an exception. */
  let pending = false

  /** Restore the launch marker written by a previous host run. */
  function restore(): void {
    const file = deps.markerPath()
    if (file === '') return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { port?: unknown; ts?: unknown }
      if (typeof raw.port === 'number' && Number.isFinite(raw.port)) {
        port = raw.port
        armed = true
      }
    } catch {
      // No marker, unreadable marker, or hand-edited garbage: stay disarmed.
    }
  }

  function persist(): void {
    const file = deps.markerPath()
    if (file === '') return
    try {
      if (!armed || port === null) {
        rmSync(file, { force: true })
        return
      }
      writeFileSync(file, JSON.stringify({ port, ts: new Date().toISOString() }), 'utf8')
    } catch (error) {
      deps.log?.(`idle: marker write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The one shutdown path, always an explicit request — there is no timer route
   * any more. Returns 'stopped' when the server was asked to stop.
   */
  async function stop(reason: string): Promise<'stopped' | 'skipped'> {
    if (disposed || running) return 'skipped'
    if (!armed || port === null) return 'skipped'
    running = true
    try {
      if (await deps.busy()) {
        // Queue not empty: the user (or a slow render) is still working. The
        // request is remembered so the next tick finishes the job the moment
        // the queue drains.
        pending = true
        deps.log?.(`idle: ${reason} shutdown deferred, work in flight`)
        return 'skipped'
      }
      const pids = await deps.findPids(port)
      if (pids.length === 0) {
        // A launch may not have bound its port yet, and this request is not
        // evidence that the server is gone: the launch stays armed so the next
        // request (or the panel's power button) can still stop it.
        deps.log?.(`idle: ${reason} shutdown skipped, nothing listening on ${String(port)} yet`)
        return 'skipped'
      }
      deps.log?.(`idle: stopping ComfyUI on port ${String(port)} (${reason}; pid ${pids.join(',')})`)
      await deps.kill(pids)
      armed = false
      pending = false
      persist()
      deps.log?.(`idle: shutdown requested (${reason})`)
      return 'stopped'
    } catch (error) {
      deps.log?.(`idle: shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'skipped'
    } finally {
      running = false
    }
  }

  function check(): Promise<'stopped' | 'skipped'> | 'stopped' | 'skipped' {
    if (disposed || running) return 'skipped'
    // Nothing to do unless a request is still waiting for the queue to drain.
    if (!pending) return 'skipped'
    return stop('turn-end')
  }

  restore()
  const timer = setInterval(() => {
    void check()
  }, PENDING_TICK_MS)
  // The host process must be able to exit even if nobody disposes the plugin.
  timer.unref?.()

  return {
    markLaunched(nextPort) {
      armed = true
      port = nextPort
      persist()
    },
    clearLaunched() {
      armed = false
      port = null
      pending = false
      persist()
    },
    shutdownNow(reason) {
      return stop(reason)
    },
    check,
    dispose() {
      disposed = true
      clearInterval(timer)
    },
    snapshot() {
      return { armed, port }
    },
  }
}

/** Marker file path for a data directory (empty string when there is none). */
export function launchMarkerPath(dataDir: string): string {
  if (dataDir.trim() === '' || !isAbsolute(dataDir)) return ''
  return join(dataDir, 'launched.json')
}
