/**
 * Offline checks for the idle shutdown (src/idle.ts). Run after `npm run build`:
 *   node scripts/test-idle.mjs
 *
 * Nothing here touches a real ComfyUI or a real process: `findPids` and `kill`
 * are injected, and the clock is driven by passing an explicit `now` to check().
 * The point is the boundary the feature promises — only a plugin-launched
 * server, only when nothing is in flight, only after the idle window.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdleShutdown, launchMarkerPath, localPortOf } from '../lib/idle.js'

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} — ${name}`)
}

/** A deps object whose clock and probes the test fully controls. */
function makeDeps(overrides = {}) {
  const killed = []
  const state = {
    minutes: 10,
    busyValue: false,
    pids: [4242],
    killed,
    logs: [],
  }
  const deps = {
    minutes: () => state.minutes,
    busy: async () => state.busyValue,
    findPids: async () => state.pids,
    kill: async (pids) => {
      killed.push(...pids)
    },
    markerPath: () => '',
    log: (message) => state.logs.push(message),
    ...overrides,
  }
  return { deps, state }
}

// --- localPortOf: the "is this ours to kill" gate -------------------------

check('localPortOf accepts loopback with an explicit port', () => {
  assert.equal(localPortOf('http://127.0.0.1:8188'), 8188)
  assert.equal(localPortOf('http://localhost:8188'), 8188)
  assert.equal(localPortOf('http://[::1]:8188'), 8188)
})

check('localPortOf rejects a remote host and an unparsable URL', () => {
  assert.equal(localPortOf('http://192.168.1.5:8188'), undefined)
  assert.equal(localPortOf('https://comfy.example.com'), undefined)
  assert.equal(localPortOf('not a url'), undefined)
})

check('localPortOf falls back to the scheme default port', () => {
  assert.equal(localPortOf('http://127.0.0.1'), 80)
  assert.equal(localPortOf('https://localhost'), 443)
})

// --- launchMarkerPath -----------------------------------------------------

check('launchMarkerPath needs an absolute data dir', () => {
  assert.equal(launchMarkerPath(''), '')
  assert.equal(launchMarkerPath('relative/dir'), '')
  assert.ok(launchMarkerPath('C:\\data\\dsh').endsWith('launched.json'))
})

// --- the watchdog ---------------------------------------------------------

check('a server this plugin never started is never stopped', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    const result = await idle.check(Date.now() + 60 * 60_000)
    assert.equal(result, 'skipped')
    assert.equal(state.killed.length, 0)
  } finally {
    idle.dispose()
  }
})

check('inside the idle window nothing happens', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    const result = await idle.check(Date.now() + 5 * 60_000)
    assert.equal(result, 'skipped')
    assert.equal(state.killed.length, 0)
  } finally {
    idle.dispose()
  }
})

check('work in flight defers the shutdown and restarts the clock', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    state.busyValue = true
    const late = Date.now() + 30 * 60_000
    assert.equal(await idle.check(late), 'skipped')
    assert.equal(state.killed.length, 0)
    // The clock moved to `late`, so a check one minute later is still inside.
    assert.equal(await idle.check(late + 60_000), 'skipped')
    assert.equal(state.killed.length, 0)
    // A full window after the busy check, with nothing queued, stops it.
    state.busyValue = false
    assert.equal(await idle.check(late + 11 * 60_000), 'idle')
    assert.deepEqual(state.killed, [4242])
  } finally {
    idle.dispose()
  }
})

check('an idle plugin-started server is stopped and disarmed', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    assert.equal(idle.snapshot().armed, true)
    assert.equal(await idle.check(Date.now() + 11 * 60_000), 'idle')
    assert.deepEqual(state.killed, [4242])
    assert.equal(idle.snapshot().armed, false)
    // Disarmed means a second window does not try to kill a pid that may since
    // have been handed to someone else.
    state.killed.length = 0
    assert.equal(await idle.check(Date.now() + 60 * 60_000), 'skipped')
    assert.equal(state.killed.length, 0)
  } finally {
    idle.dispose()
  }
})

check('noteActivity postpones the shutdown', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    idle.noteActivity()
    assert.equal(await idle.check(Date.now() + 5 * 60_000), 'skipped')
    assert.equal(state.killed.length, 0)
  } finally {
    idle.dispose()
  }
})

check('minutes = 0 disables the shutdown', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    state.minutes = 0
    idle.markLaunched(8188)
    assert.equal(await idle.check(Date.now() + 24 * 60 * 60_000), 'skipped')
    assert.equal(state.killed.length, 0)
  } finally {
    idle.dispose()
  }
})

check('nothing listening on the port disarms instead of killing a stranger', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    state.pids = []
    idle.markLaunched(8188)
    assert.equal(await idle.check(Date.now() + 11 * 60_000), 'skipped')
    assert.equal(state.killed.length, 0)
    assert.equal(idle.snapshot().armed, false)
  } finally {
    idle.dispose()
  }
})

check('a kill failure leaves the watchdog armed for the next tick', async () => {
  const { deps } = makeDeps({
    kill: async () => {
      throw new Error('taskkill exploded')
    },
  })
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    assert.equal(await idle.check(Date.now() + 11 * 60_000), 'skipped')
    assert.equal(idle.snapshot().armed, true)
  } finally {
    idle.dispose()
  }
})

check('the launch marker survives a host restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-idle-'))
  try {
    const { deps } = makeDeps({ markerPath: () => join(dir, 'launched.json') })
    const first = createIdleShutdown(deps)
    first.markLaunched(8188)
    first.dispose()
    assert.match(readFileSync(join(dir, 'launched.json'), 'utf8'), /8188/)
    // A fresh instance (a new host process) picks the launch back up.
    const second = createIdleShutdown({ ...deps, markerPath: () => join(dir, 'launched.json') })
    try {
      assert.equal(second.snapshot().armed, true)
      assert.equal(second.snapshot().port, 8188)
    } finally {
      second.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- the turn-end trigger (shutdownNow) -----------------------------------

check('shutdownNow stops a plugin-started server without waiting for the window', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    // Right after arming: the idle window would never fire this early.
    assert.equal(await idle.check(Date.now()), 'skipped')
    assert.equal(await idle.shutdownNow('turn-end'), 'idle')
    assert.deepEqual(state.killed, [4242])
    assert.equal(idle.snapshot().armed, false)
  } finally {
    idle.dispose()
  }
})

check('shutdownNow during work in flight waits for the queue to drain', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    state.busyValue = true
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    assert.equal(state.killed.length, 0)
    assert.equal(idle.snapshot().armed, true)
    // The request stays pending: the next tick, once the queue is empty, stops
    // it even though no idle window has passed.
    state.busyValue = false
    assert.equal(await idle.check(Date.now()), 'idle')
    assert.deepEqual(state.killed, [4242])
  } finally {
    idle.dispose()
  }
})

check('shutdownNow on a port that is not listening yet stays armed', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    state.pids = []
    idle.markLaunched(8188)
    // Unlike the idle path, this must not disarm: a launch may not have bound
    // the port yet, and the turn-end request is not evidence of anything.
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    assert.equal(state.killed.length, 0)
    assert.equal(idle.snapshot().armed, true)
  } finally {
    idle.dispose()
  }
})

check('shutdownNow never touches a server this plugin did not start', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    assert.equal(state.killed.length, 0)
  } finally {
    idle.dispose()
  }
})

check('minutes = 0 disables the turn-end shutdown too', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    state.minutes = 0
    idle.markLaunched(8188)
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    assert.equal(state.killed.length, 0)
    assert.equal(idle.snapshot().armed, true)
  } finally {
    idle.dispose()
  }
})

check('dispose stops the clock and the shutdown', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  idle.markLaunched(8188)
  idle.dispose()
  assert.equal(await idle.check(Date.now() + 60 * 60_000), 'skipped')
  assert.equal(state.killed.length, 0)
})

console.log(`\n${String(passed)} idle-shutdown checks passed`)
