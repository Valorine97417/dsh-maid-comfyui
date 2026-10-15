/**
 * Idle shutdown for a local ComfyUI.
 *
 * A ComfyUI server holds several GB of VRAM loaded and a few hundred MB of
 * RSS even with nothing queued, so leaving one running after a single image is
 * waste the user pays for in every other GPU workload. The plugin therefore
 * stops the server it started itself once the work is over — the primary
 * trigger is the end of a conversation turn (see `shutdownNow`), with the idle
 * window as a backstop for whatever never reaches a turn boundary (a crash, a
 * client that vanished, a browser-only run).
 *
 * Boundaries, deliberately narrow:
 * - Only an instance **this plugin launched** is ever stopped. `armed` is set
 *   by a successful launch (and restored from `<dataDir>/launched.json` across
 *   host restarts). A ComfyUI the user started by hand is never touched.
 * - Only a loopback `baseUrl` qualifies. A server on another machine is not
 *   ours to kill, and its port would resolve to nothing local anyway.
 * - Never while work is in flight: the caller supplies `busy()`, which reports
 *   the ComfyUI queue (running + pending) and the plugin's tracked runs. A
 *   shutdown that lands mid-generation would destroy the user's image.
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

/** How often the idle clock is checked. Ten minutes of slack do not need a
 * tighter tick; 30s keeps the shutdown responsive without a busy timer loop. */
const TICK_MS = 30_000
/** Grace given to a launch before the idle clock may stop it: the panel's own
 * "start" click is activity, but the first probe can land before ComfyUI binds
 * its port, and killing it in that window would undo the user's click. */
const LAUNCH_GRACE_MS = 5_000

export interface IdleShutdownDeps {
  /** Configured idle window in minutes; 0 disables the shutdown entirely. */
  minutes(): number
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
  /** A request came in: the clock restarts. */
  noteActivity(): void
  /** This plugin just started a server; arms the shutdown and persists it. */
  markLaunched(port: number): void
  /** Forget the launch (the server is down or the plugin is unloading). */
  clearLaunched(): void
  /**
   * Stop because the work is over (the conversation's turn ended) — the idle
   * window does not apply, since the point is to give the VRAM back the moment
   * nobody needs it. The safety gates still do: an unarmed server, an
   * in-flight generation, and a server that never bound its port all keep it
   * alive. A run that outlives the turn leaves the request pending, so the
   * next tick stops the server as soon as the queue drains.
   */
  shutdownNow(reason: string): Promise<'idle' | 'skipped'>
  /** One check, exposed so tests drive the clock directly. */
  check(now?: number): Promise<'idle' | 'skipped'> | 'idle' | 'skipped'
  dispose(): void
  /** Diagnostics for the panel and logs. */
  snapshot(): { armed: boolean; port: number | null; idleMs: number; minutes: number }
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

/** Create the idle watchdog bound to one plugin instance. */
export function createIdleShutdown(deps: IdleShutdownDeps): IdleShutdown {
  let lastActivity = Date.now()
  let armed = false
  let port: number | null = null
  let running = false
  let disposed = false
  /** A "the work is over" request that arrived while the queue was still
   * draining. The next tick finishes the job instead of waiting out a whole
   * idle window — an async run outliving its turn is the common case, not an
   * exception. */
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
   * The one shutdown path. `idleMs` is the elapsed idle window for the timer
   * route and `null` for an explicit "the work is over" request, which skips
   * the window but keeps every safety gate. Returns 'idle' when the server was
   * asked to stop.
   */
  async function stop(reason: string, idleMs: number | null): Promise<'idle' | 'skipped'> {
    if (disposed || running) return 'skipped'
    // `0` disables every automatic stop, not just the timed one: a user who
    // turned the behaviour off must not watch the server vanish when a turn
    // ends. The panel's "stop now" button bypasses this module entirely.
    if (!armed || port === null || deps.minutes() <= 0) return 'skipped'
    if (idleMs !== null && idleMs < LAUNCH_GRACE_MS) return 'skipped'
    running = true
    try {
      if (await deps.busy()) {
        // Queue not empty: the user (or a slow render) is still working. The
        // clock restarts so the next check is a full window away — except for
        // an explicit request, which is remembered so the next tick finishes
        // the job the moment the queue drains.
        lastActivity = Date.now()
        if (idleMs === null) pending = true
        deps.log?.(`idle: ${reason} shutdown skipped, work in flight`)
        return 'skipped'
      }
      const pids = await deps.findPids(port)
      if (pids.length === 0) {
        // On the timed route an empty port means the server is gone for good,
        // so the marker is dropped. An explicit request can land while a fresh
        // launch is still binding its port — disarming there would silently
        // disable the watchdog, so the launch stays armed for the next tick.
        if (idleMs !== null) {
          deps.log?.(`idle: nothing listening on ${String(port)}, disarming`)
          armed = false
          pending = false
          persist()
        } else {
          deps.log?.(`idle: ${reason} shutdown skipped, nothing listening on ${String(port)} yet`)
        }
        return 'skipped'
      }
      const waited = idleMs === null ? '' : ` after ${String(Math.round(idleMs / 60_000))}m`
      deps.log?.(`idle: stopping ComfyUI on port ${String(port)}${waited} (${reason}; pid ${pids.join(',')})`)
      await deps.kill(pids)
      armed = false
      pending = false
      persist()
      deps.log?.(`idle: shutdown requested (${reason})`)
      return 'idle'
    } catch (error) {
      deps.log?.(`idle: shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'skipped'
    } finally {
      running = false
    }
  }

  function check(now: number = Date.now()): Promise<'idle' | 'skipped'> | 'idle' | 'skipped' {
    if (disposed || running) return 'skipped'
    const minutes = deps.minutes()
    if (!armed || port === null || minutes <= 0) return 'skipped'
    // A turn ended while the queue was still draining: finish that job now
    // rather than making the server wait out a full idle window.
    if (pending) return stop('turn-end', null)
    const idleMs = now - lastActivity
    if (idleMs < minutes * 60_000) return 'skipped'
    return stop('idle', idleMs)
  }

  restore()
  const timer = setInterval(() => {
    void check()
  }, TICK_MS)
  // The host process must be able to exit even if nobody disposes the plugin.
  timer.unref?.()

  return {
    noteActivity() {
      lastActivity = Date.now()
    },
    markLaunched(nextPort) {
      armed = true
      port = nextPort
      lastActivity = Date.now()
      persist()
    },
    clearLaunched() {
      armed = false
      port = null
      persist()
    },
    shutdownNow(reason) {
      return stop(reason, null)
    },
    check,
    dispose() {
      disposed = true
      clearInterval(timer)
    },
    snapshot() {
      return { armed, port, idleMs: Date.now() - lastActivity, minutes: deps.minutes() }
    },
  }
}

/** Marker file path for a data directory (empty string when there is none). */
export function launchMarkerPath(dataDir: string): string {
  if (dataDir.trim() === '' || !isAbsolute(dataDir)) return ''
  return join(dataDir, 'launched.json')
}
