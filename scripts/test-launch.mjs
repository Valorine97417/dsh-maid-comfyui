/**
 * Offline checks for the panel launcher (src/launch.ts).
 *
 * The launcher's whole point is that "spawn returned" is not "the server is
 * up", so most of its value sits in the probe loop. These checks cover the
 * branches that need no server and no waiting:
 *   - already running  -> started:false, the version comes from the probe
 *   - no command set   -> launch-not-configured, and nothing is spawned
 *   - spawn fails      -> the error reaches the caller and a second click in
 *                         the cooldown window does not spawn again
 * Run: node scripts/test-launch.mjs   (requires `npm run build` first)
 */
import { strict as assert } from 'node:assert'
import { createLauncher } from '../lib/launch.js'

let passed = 0
function check(name, fn) {
  return fn().then(() => {
    passed += 1
    console.log(`PASS: ${name}`)
  })
}

/** A probe that answers on the nth call. */
function probeAfter(n) {
  let calls = 0
  return async () => {
    calls += 1
    return calls >= n ? { ok: true, version: '9.9.9' } : { ok: false, error: 'ECONNREFUSED' }
  }
}

async function main() {
  await check('server already up -> started:false and no spawn', async () => {
    let commandsRead = 0
    const launcher = createLauncher({
      // An already-up probe must short-circuit before the command is even read.
      command: () => { commandsRead += 1; return 'noop' },
      dir: () => '',
      probe: probeAfter(1),
      log: () => {},
    })
    const outcome = await launcher.launch()
    assert.equal(outcome.ok, true)
    assert.equal(outcome.started, false)
    assert.equal(outcome.version, '9.9.9')
    assert.equal(commandsRead, 0)
  })

  await check('empty command -> launch-not-configured', async () => {
    const launcher = createLauncher({
      command: () => '   ',
      dir: () => '',
      probe: async () => ({ ok: false, error: 'ECONNREFUSED' }),
      log: () => {},
    })
    const outcome = await launcher.launch()
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error, 'launch-not-configured')
  })

  await check('spawn failure reaches the caller, then cools down', async () => {
    const logs = []
    const launcher = createLauncher({
      command: () => 'definitely-not-a-real-command-xyz',
      // A non-existent cwd makes spawn emit 'error' instead of starting
      // anything, which is the cheapest way to exercise that path offline.
      dir: () => 'Z:\\dsh-launch-does-not-exist',
      probe: async () => ({ ok: false, error: 'ECONNREFUSED' }),
      log: (message) => logs.push(message),
    })
    const first = await launcher.launch()
    assert.equal(first.ok, false)
    assert.ok(typeof first.error === 'string' && first.error.length > 0)
    const spawnError = first.error

    const second = await launcher.launch()
    assert.equal(second.ok, false)
    assert.equal(second.error, spawnError, 'the cooldown replays the last error')
    assert.ok(logs.some((line) => line.includes('launch:')), 'launch diagnostics are logged')
  })

  console.log(`\nALL LAUNCH TESTS PASSED (${String(passed)})`)
}

main().catch((error) => {
  console.error('FAIL:', error)
  process.exitCode = 1
})
