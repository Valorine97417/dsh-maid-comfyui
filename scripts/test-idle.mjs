/**
 * Offline checks for the server shutdown (src/idle.ts). Run after `npm run build`:
 *   node scripts/test-idle.mjs
 *
 * Nothing here touches a real ComfyUI or a real process: `findPids` and `kill`
 * are injected. The point is the boundary the feature promises — only a server
 * this plugin launched, only when nothing is in flight, and only on an explicit
 * request (the end of a turn, or the panel's power button). There is no idle
 * timer, so no check fires merely because time passed.
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

/** A deps object whose probes the test fully controls. */
function makeDeps(overrides = {}) {
  const killed = []
  const state = {
    busyValue: false,
    pids: [4242],
    killed,
    logs: [],
  }
  const deps = {
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

// --- no timer: time alone never stops anything ----------------------------

check('a server this plugin never started is never stopped', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    assert.equal(await idle.check(), 'skipped')
    assert.equal(state.killed.length, 0)
  } finally {
    idle.dispose()
  }
})

check('an armed server is left alone until someone asks', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    assert.equal(idle.snapshot().armed, true)
    // The old idle timer would have stopped it here; nothing may happen now.
    assert.equal(await idle.check(), 'skipped')
    assert.equal(state.killed.length, 0)
    assert.equal(idle.snapshot().armed, true)
  } finally {
    idle.dispose()
  }
})

// --- the explicit request (shutdownNow) -----------------------------------

check('shutdownNow stops a plugin-started server', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    assert.equal(await idle.shutdownNow('turn-end'), 'stopped')
    assert.deepEqual(state.killed, [4242])
    assert.equal(idle.snapshot().armed, false)
    // Disarmed: a second request does not kill a pid that may since have been
    // handed to someone else.
    state.killed.length = 0
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    assert.equal(state.killed.length, 0)
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
    // it without anyone asking again.
    state.busyValue = false
    assert.equal(await idle.check(), 'stopped')
    assert.deepEqual(state.killed, [4242])
  } finally {
    idle.dispose()
  }
})

check('a deferred request stops retrying once it has been served', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    state.busyValue = true
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    state.busyValue = false
    assert.equal(await idle.check(), 'stopped')
    assert.equal(await idle.check(), 'skipped')
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
    // A launch may not have bound its port yet, and this request is not
    // evidence of anything: the panel's power button must still be able to stop
    // the server a moment later.
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    assert.equal(state.killed.length, 0)
    assert.equal(idle.snapshot().armed, true)
  } finally {
    idle.dispose()
  }
})

check('a kill failure leaves the shutdown armed for the next request', async () => {
  const { deps } = makeDeps({
    kill: async () => {
      throw new Error('taskkill exploded')
    },
  })
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    assert.equal(idle.snapshot().armed, true)
  } finally {
    idle.dispose()
  }
})

check('clearLaunched drops both the arm and a pending request', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  try {
    idle.markLaunched(8188)
    state.busyValue = true
    assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
    idle.clearLaunched()
    state.busyValue = false
    assert.equal(await idle.check(), 'skipped')
    assert.equal(state.killed.length, 0)
  } finally {
    idle.dispose()
  }
})

// --- the launch marker ----------------------------------------------------

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

check('dispose stops the shutdown', async () => {
  const { deps, state } = makeDeps()
  const idle = createIdleShutdown(deps)
  idle.markLaunched(8188)
  idle.dispose()
  assert.equal(await idle.shutdownNow('turn-end'), 'skipped')
  assert.equal(await idle.check(), 'skipped')
  assert.equal(state.killed.length, 0)
})

console.log(`\n${String(passed)} shutdown checks passed`)
