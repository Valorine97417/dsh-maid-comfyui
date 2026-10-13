/**
 * Connection probe + reminder toast. Opening the panel used to give zero
 * feedback when ComfyUI was down: the workflows/queue tabs just stayed empty
 * with no explanation. The header trigger now fires a real backend probe
 * (POST /comfyui/test → the host connects to the configured ComfyUI server —
 * local port or remote URL alike) and explains the result in a fixed top toast.
 *
 * Two rules the earlier version broke:
 * - The panel stays open on failure. It used to call panelStore.close() on a
 *   failed probe, so the click looked like it did nothing and the sticky
 *   reminder was the only thing left on screen — with the window already gone.
 *   A failed backend is a reason to offer help, not to take the window away.
 * - The toast offers the way out: when a launcher command is configured, it
 *   carries a "start local ComfyUI" button that spawns it through the host
 *   (POST /comfyui/launch) and resolves only once the server answers.
 */
import { createElement as h, useSyncExternalStore } from 'react'
import { getJson, postJson } from './api.ts'

export interface ConnectionToastProps {
  t: (key: string, ...rest: unknown[]) => string
}

/** hidden → probing / launching (delayed fade-in) → fail (sticky) / ok (auto-hide). */
type ConnStatus = 'hidden' | 'probing' | 'launching' | 'fail' | 'ok'

interface ConnState {
  status: ConnStatus
  /** Raw failure reason from the /comfyui/test or /comfyui/launch route. */
  message?: string
  version?: string
  latencyMs?: number
  /** Whether the host has a launcher command to offer on failure. */
  canLaunch?: boolean
}

const listeners = new Set<() => void>()
let state: ConnState = { status: 'hidden' }
/** Dedupe concurrent probes (rapid trigger clicks). */
let inFlight: Promise<void> | null = null
/** The ok toast only shows on fail→ok transitions, never on healthy opens. */
let hadFailure = false
/** Whether the launcher was already tried this page, so the retry button can
 * say "start again" rather than "start" after a failed attempt. */
let launchedOnce = false
let okHideTimer: ReturnType<typeof setTimeout> | null = null
/** `canLaunch` comes from /comfyui/config, which costs a round-trip; the answer
 * only changes when the user edits settings, so one lookup per page load is
 * plenty. `undefined` = not asked yet. */
let canLaunchCache: boolean | undefined
/** Skip re-probing while a "connected" verdict is still fresh. */
let lastOkAt = 0

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: ConnState): void {
  state = next
  emit()
}

function clearOkTimer(): void {
  if (okHideTimer !== null) {
    clearTimeout(okHideTimer)
    okHideTimer = null
  }
}

/** Close button on the toast; also ends the transient ok feedback early. */
export function dismissConnectionToast(): void {
  clearOkTimer()
  if (state.status !== 'hidden') setState({ status: 'hidden' })
}

/** Resolve whether the host can start ComfyUI for the user, once per page. */
function canLaunch(): Promise<boolean> {
  if (canLaunchCache !== undefined) return Promise.resolve(canLaunchCache)
  return (async () => {
    try {
      const payload = (await getJson('/comfyui/config')) as { config?: { canLaunch?: boolean } }
      canLaunchCache = payload.config?.canLaunch === true
    } catch {
      // An unreadable config is not an answer; keep the offer but let the
      // launch route report the real problem ("启动命令未配置").
      canLaunchCache = true
    }
    return canLaunchCache
  })()
}

/** Record a successful connection (shared by probe and launch). */
function settleOk(payload: { version?: string; latencyMs?: number }): void {
  lastOkAt = Date.now()
  const recovered = hadFailure
  hadFailure = false
  if (recovered) {
    // Come-back feedback: a previous failure just resolved.
    setState({ status: 'ok', version: payload.version, latencyMs: payload.latencyMs })
    clearOkTimer()
    okHideTimer = setTimeout(dismissConnectionToast, 4000)
  } else {
    setState({ status: 'hidden' })
  }
}

/** Record a failure; the toast keeps the reason and any retry offer. */
function settleFail(message: string, offer: boolean): void {
  hadFailure = true
  setState({ status: 'fail', message, canLaunch: offer })
}

/**
 * Run the host-side launcher and report its verdict. Split from
 * probeConnection because the probe calls it automatically when ComfyUI is
 * down — the user's click should start the server, not ask them to click a
 * second time. Resolves only when the server answers (or the launch gives up).
 */
async function runLaunch(): Promise<void> {
  clearOkTimer()
  launchedOnce = true
  setState({ status: 'launching', canLaunch: state.canLaunch })
  try {
    const payload = (await postJson('/comfyui/launch', {})) as {
      ok?: boolean
      started?: boolean
      version?: string
      error?: string
    }
    if (payload.ok === true) settleOk({ version: payload.version })
    else settleFail(payload.error ?? 'unknown error', true)
  } catch (error) {
    settleFail(error instanceof Error ? error.message : String(error), true)
  }
}

/**
 * Probe the ComfyUI server through the host and surface the result as toast
 * state. A success within the last 30s skips the round-trip entirely, so
 * healthy repeated panel opens do not hammer the server; failures always
 * re-probe on the next open (the user may have just started ComfyUI).
 *
 * When the probe fails and a launcher is configured, this starts ComfyUI
 * itself: opening the panel is the user's request to use ComfyUI, and making
 * them find a second button first is what the old version did badly.
 */
export function probeConnection(): Promise<void> {
  if (inFlight !== null) return inFlight
  if (Date.now() - lastOkAt < 30_000) return Promise.resolve()
  // A visible fail toast stays up (and keeps its reason) while re-checking;
  // only upgrade hidden → probing so the check itself never flashes red.
  if (state.status !== 'fail') {
    clearOkTimer()
    setState({ status: 'probing' })
  }
  inFlight = (async () => {
    let failure: string | undefined
    try {
      const payload = (await postJson('/comfyui/test', {})) as {
        ok?: boolean
        version?: string
        latencyMs?: number
        error?: string
      }
      if (payload.ok === true) {
        settleOk(payload)
        return
      }
      failure = payload.error ?? 'unknown error'
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (await canLaunch()) {
      await runLaunch()
    } else {
      settleFail(failure, false)
    }
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Start the local ComfyUI from the toast's retry button. Same launcher as the
 * automatic path; exported for the button, which is the only way back when the
 * automatic attempt was refused by the launcher's cooldown.
 */
export function launchConnection(): Promise<void> {
  if (inFlight !== null) return inFlight
  inFlight = runLaunch().finally(() => {
    inFlight = null
  })
  return inFlight
}

function getConnState(): ConnState {
  return state
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Fixed top-center status toast; mounted next to the header trigger so it
 * renders (and can be dismissed) even when the panel is closed again. The
 * probing/launching variants fade in after a short CSS delay, so a fast
 * successful probe never paints anything. */
export function ConnectionToast({ t }: ConnectionToastProps): ReturnType<typeof h> | null {
  const conn = useSyncExternalStore(subscribe, getConnState, getConnState)
  if (conn.status === 'hidden') return null
  const busy = conn.status === 'probing' || conn.status === 'launching'
  return h('div', { className: `dsc-conn-toast dsc-conn-toast--${conn.status}`, role: 'status' },
    h('span', { className: 'dsc-conn-toast-dot', 'aria-hidden': true }),
    h('div', { className: 'dsc-conn-toast-body' },
      conn.status === 'fail'
        ? h('div', { className: 'dsc-conn-toast-body-inner' },
            h('div', { className: 'dsc-conn-toast-title' }, t('connFailTitle')),
            h('div', { className: 'dsc-conn-toast-text' }, t('connFailBody', { message: conn.message ?? '' })),
            conn.canLaunch === true
              ? h('button', {
                  type: 'button',
                  className: 'dsc-btn dsc-conn-toast-action',
                  onClick: () => void launchConnection(),
                }, launchedOnce ? t('connRetryButton') : t('connStartButton'))
              : null,
          )
        : h('div', { className: 'dsc-conn-toast-title' },
            busy
              ? conn.status === 'launching' ? t('connStarting') : t('connChecking')
              : t('connOk', { version: conn.version ?? 'unknown', ms: conn.latencyMs ?? 0 }),
          ),
    ),
    busy
      ? null
      : h('button', {
          className: 'dsc-conn-toast-close',
          'aria-label': t('close'),
          onClick: dismissConnectionToast,
        }, '✕'),
  )
}
