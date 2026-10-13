/**
 * Local ComfyUI launcher: the panel's "start" button went missing a backend
 * that can actually spawn a server, so opening the panel against a down
 * ComfyUI ended in a dead end (a red toast and no way forward). This module
 * owns the one side effect that fixes it — running the user's own launcher
 * command — and reports success only when the server actually answers.
 *
 * Design notes:
 * - The command is configured, never guessed: `launchCommand` runs through the
 *   shell, so a portable `.bat`, a `python -s main.py` line, or a wrapper script
 *   all work. An empty value disables the feature and the panel hides the button.
 * - The child is detached with ignored stdio: ComfyUI outlives this plugin's
 *   fiber (and, being detached, the process group), and its console output must
 *   not be piped into the host, where an unread pipe would eventually block it.
 * - "Launched" means "answers /system_stats", not "spawn returned". ComfyUI
 *   needs seconds to bind its port, and a command that exits immediately
 *   (wrong path) must not read as success.
 */
import { spawn } from 'node:child_process'

/** How often the launcher polls for the server to come up. */
const POLL_INTERVAL_MS = 1_000
/** How long a launch waits for /system_stats before giving up. Portable
 * ComfyUI on a cold disk can take most of a minute; 90s leaves headroom. */
const POLL_TIMEOUT_MS = 90_000
/** After a failed launch, refuse to try again for this long — a wrong path
 * would otherwise respawn a doomed process on every click. */
const FAIL_COOLDOWN_MS = 10_000

export interface LaunchOutcome {
  ok: boolean
  /** True when this call started the server (false = it was already running). */
  started?: boolean
  version?: string
  error?: string
}

export interface LauncherDeps {
  /** The configured shell command; empty disables launching. */
  command(): string
  /** Working directory for the command; empty = the host process cwd. */
  dir(): string
  /** Probe the server; resolves with a version when it answers. */
  probe(): Promise<{ ok: true; version?: string } | { ok: false; error: string }>
  /** Optional log sink for launch diagnostics. */
  log?(message: string): void
}

export interface ComfyUILauncher {
  /** Start the local server if it is down; resolve once it answers (or fails). */
  launch(): Promise<LaunchOutcome>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Create the launcher bound to one plugin instance. */
export function createLauncher(deps: LauncherDeps): ComfyUILauncher {
  /** One launch at a time: a second click joins the first instead of spawning. */
  let inFlight: Promise<LaunchOutcome> | null = null
  let cooldownUntil = 0
  let lastError: string | undefined

  /** Spawn the configured command and forget about it. Returns a failure when
   * the command is missing or the spawn itself throws (e.g. no shell). */
  function spawnDetached(command: string, cwd: string): string | undefined {
    try {
      const child = spawn(command, {
        cwd: cwd !== '' ? cwd : undefined,
        // The command is a user-authored shell line (a .bat path with spaces,
        // flags, redirects); splitting it ourselves would break more than it
        // helps. The host is the user's own machine — this is not untrusted input.
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      // A spawn failure (missing cwd, no shell) surfaces as an 'error' event,
      // not a throw; without this listener it would crash the host process.
      child.on('error', (error: Error) => {
        lastError = error.message
        deps.log?.(`launch: spawn failed: ${error.message}`)
      })
      child.unref()
      deps.log?.(`launch: started "${command}"${cwd !== '' ? ` in ${cwd}` : ''} (pid ${String(child.pid ?? '?')})`)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  async function run(): Promise<LaunchOutcome> {
    // Already up? Nothing to do — the caller just opens the panel.
    const before = await deps.probe()
    if (before.ok) return { ok: true, started: false, version: before.version }

    const command = deps.command().trim()
    if (command === '') {
      return { ok: false, error: 'launch-not-configured' }
    }
    if (Date.now() < cooldownUntil) {
      return { ok: false, error: lastError ?? 'launch-cooldown' }
    }

    const spawnError = spawnDetached(command, deps.dir().trim())
    if (spawnError !== undefined) {
      lastError = spawnError
      cooldownUntil = Date.now() + FAIL_COOLDOWN_MS
      return { ok: false, error: spawnError }
    }

    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      const probe = await deps.probe()
      if (probe.ok) {
        lastError = undefined
        deps.log?.(`launch: server is up${probe.version !== undefined ? ` (${probe.version})` : ''}`)
        return { ok: true, started: true, version: probe.version }
      }
    }
    // The command ran but nothing ever listened. Most often a wrong path or a
    // missing model/GPU error exiting immediately; surface the probe's reason
    // so the settings page has something actionable to show.
    const final = await deps.probe()
    lastError = final.ok ? 'launch-timeout' : final.error
    cooldownUntil = Date.now() + FAIL_COOLDOWN_MS
    return { ok: false, error: lastError }
  }

  return {
    launch() {
      if (inFlight !== null) return inFlight
      inFlight = run().finally(() => {
        inFlight = null
      })
      return inFlight
    },
  }
}
