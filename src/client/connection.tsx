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
 * - The toast reports; it does not act. Starting and stopping the server lives
 *   behind exactly one switch, the panel header's power button. An earlier
 *   version carried its own "start local ComfyUI" button, which gave the same
 *   decision two entry points and made the panel's button look broken whenever
 *   the toast had already brought the server up.
 */
import { Fragment, createElement as h, useSyncExternalStore } from 'react'
import { postJson } from './api.ts'

export interface ConnectionToastProps {
  t: (key: string, ...rest: unknown[]) => string
}

/** hidden → probing (delayed fade-in) → fail (sticky) / ok (auto-hide). */
type ConnStatus = 'hidden' | 'probing' | 'fail' | 'ok'

interface ConnState {
  status: ConnStatus
  /** Raw failure reason from the /comfyui/test route. */
  message?: string
  version?: string
  latencyMs?: number
}

const listeners = new Set<() => void>()
let state: ConnState = { status: 'hidden' }
/** Dedupe concurrent probes (rapid trigger clicks). */
let inFlight: Promise<void> | null = null
/** The ok toast only shows on fail→ok transitions, never on healthy opens. */
let hadFailure = false
let okHideTimer: ReturnType<typeof setTimeout> | null = null
/** Set when the user closes the toast themselves: failures then stop popping
 * up on their own (the panel's own error note still explains the tab), until a
 * probe succeeds once. Without this, every panel click re-raised the same red
 * toast and the close button looked broken. */
let suppressed = false
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

/** Close button on the toast; also ends the transient ok feedback early. A
 * dismissed failure is remembered (`suppressed`) so the next panel click does
 * not paint the same red toast again — the user already read it. */
export function dismissConnectionToast(): void {
  clearOkTimer()
  if (state.status === 'fail') suppressed = true
  if (state.status !== 'hidden') setState({ status: 'hidden' })
}

/** Record a successful connection. */
function settleOk(payload: { version?: string; latencyMs?: number }): void {
  lastOkAt = Date.now()
  const recovered = hadFailure && !suppressed
  hadFailure = false
  suppressed = false
  if (recovered) {
    // Come-back feedback: a previous failure just resolved.
    setState({ status: 'ok', version: payload.version, latencyMs: payload.latencyMs })
    clearOkTimer()
    okHideTimer = setTimeout(dismissConnectionToast, 4000)
  } else {
    setState({ status: 'hidden' })
  }
}

/** Record a failure; the toast keeps the reason for the user to act on. */
function settleFail(message: string): void {
  hadFailure = true
  // A failure the user already dismissed stays dismissed — re-raising the same
  // red toast on every panel click is what made the close button look broken.
  if (suppressed) return
  setState({ status: 'fail', message })
}

/**
 * Probe the ComfyUI server through the host and surface the result as toast
 * state. A success within the last 30s skips the round-trip entirely, so
 * healthy repeated panel opens do not hammer the server; failures always
 * re-probe on the next open (the user may have just started ComfyUI).
 *
 * Opening the panel never starts ComfyUI: bringing up a multi-GB process is a
 * decision, not a side effect of looking at a panel. A down server is reported
 * here, and the panel header's power button is the one place that starts it.
 */
export function probeConnection(): Promise<void> {
  if (inFlight !== null) return inFlight
  if (Date.now() - lastOkAt < 30_000) return Promise.resolve()
  // A visible fail toast stays up (and keeps its reason) while re-checking;
  // only upgrade hidden → probing so the check itself never flashes red. A
  // dismissed failure stays silent: the check still runs, but it no longer
  // repaints a toast the user just closed.
  if (state.status !== 'fail' && !suppressed) {
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
    settleFail(failure)
  })().finally(() => {
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
 * probing variant fades in after a short CSS delay, so a fast successful probe
 * never paints anything. */
export function ConnectionToast({ t }: ConnectionToastProps): ReturnType<typeof h> | null {
  const conn = useSyncExternalStore(subscribe, getConnState, getConnState)
  if (conn.status === 'hidden') return null
  const busy = conn.status === 'probing'
  return h('div', { className: `dsc-conn-toast dsc-conn-toast--${conn.status}`, role: 'status' },
    h('span', { className: 'dsc-conn-toast-dot', 'aria-hidden': true }),
    h('div', { className: 'dsc-conn-toast-body' },
      conn.status === 'fail'
        ? h(Fragment, null,
            h('div', { className: 'dsc-conn-toast-title' }, t('connFailTitle')),
            h('div', { className: 'dsc-conn-toast-text' }, t('connFailBody', { message: conn.message ?? '' })),
          )
        : h('div', { className: 'dsc-conn-toast-title' },
            busy
              ? t('connChecking')
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
