/**
 * Host load-compatibility smoke test — the load-compatibility seam from the
 * CONTEXT.md glossary (three-layer bar: install / load / feature compatibility).
 *
 * Drives the plugin's public entry `apply(ctx, entryConfig)` from the built
 * bundle (../lib/index.js) against a stub host context that models ONLY the
 * host boundary the plugin duck-types: tools registry, settings, skills,
 * webServer, event bus, credentials, logger-free fiber. No plugin internals
 * are mocked. Asserts what the plugin registers onto the host, plus a static
 * peer-range assertion mirroring the host's peer gate (semver with
 * { includePrerelease: true }).
 *
 * Deterministic and offline: no network, no live ComfyUI backend. The progress
 * tracker still best-effort dials the (refused) ComfyUI WebSocket and keeps a
 * 3s retry timer alive, so this script always process.exit()s explicitly.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// The cordis.patch.yml insert entry: `name` is the module specifier the loader
// imports (see section 9). Parsed leniently — a YAML dependency is not allowed.
const patchName = /(?:^|\n)[ \t]*-?[ \t]*name:[ \t]*['"]?([^'"\n]+?)['"]?[ \t]*$/m.exec(
  readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8'),
 )?.[1]?.trim()

// ---------------------------------------------------------------------------
// Minimal semver comparator. Covers ONLY caret segments (`^x.y.z` and
// `^x.y.z-prerelease`) joined by ` || ` — exactly the range shape this
// manifest uses for @deepseek-ai/dsh-settings. `semver` itself is not
// resolvable from this repo root (pnpm strict layout). If the manifest ever
// adopts ~, *, x-ranges, or bare comparators, extend this before trusting the
// result (or run where `semver` is resolvable).
// ---------------------------------------------------------------------------
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parseVersion(v) {
  const m = VERSION_RE.exec(v)
  if (m === null) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] === undefined ? null : m[4].split('.') }
}

function comparePrerelease(a, b) {
  if (a === null && b === null) return 0
  if (a === null) return 1 // a release sorts above any prerelease of the same triple
  if (b === null) return -1
  for (let i = 0; ; i++) {
    if (i >= a.length && i >= b.length) return 0
    if (i >= a.length) return -1 // fewer identifiers sort lower when equal so far
    if (i >= b.length) return 1
    const x = a[i]
    const y = b[i]
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const d = Number(x) - Number(y)
      if (d !== 0) return Math.sign(d)
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers sort below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
}

function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return Math.sign(a[k] - b[k])
  }
  return comparePrerelease(a.pre, b.pre)
}

// Caret bounds mirror real semver: lower bound is the segment version itself
// (prerelease included), upper bound bumps the leftmost nonzero component and
// always carries a `-0` prerelease, e.g. `^0.2.0-rc.1` → [0.2.0-rc.1, 0.3.0-0).
function caretBounds(segment) {
  const lo = parseVersion(segment)
  if (lo === null) throw new Error(`unparseable range segment: ^${segment}`)
  let upper
  if (lo.major > 0) upper = `${lo.major + 1}.0.0-0`
  else if (lo.minor > 0) upper = `${lo.major}.${lo.minor + 1}.0-0`
  else upper = `${lo.major}.${lo.minor}.${lo.patch + 1}-0`
  return { lo, hi: parseVersion(upper) }
}

// Mirrors the host peer gate: semver.satisfies(version, range, { includePrerelease: true }).
function satisfiesPeerRange(version, range) {
  const v = parseVersion(version)
  if (v === null) throw new Error(`unparseable version: ${version}`)
  return range
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((segment) => {
      if (!segment.startsWith('^')) {
        throw new Error(`unsupported range segment "${segment}" — comparator covers caret ranges only`)
      }
      const { lo, hi } = caretBounds(segment.slice(1))
      return compareVersions(v, lo) >= 0 && compareVersions(v, hi) < 0
    })
}

// ---------------------------------------------------------------------------
// Tiny assertion helpers (no test framework, same shape as scripts/test-*.mjs).
// ---------------------------------------------------------------------------
let failures = 0
let passed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function checkDeepEqual(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, `actual=${a} expected=${b}`)
}

// ---------------------------------------------------------------------------
// Stub host context — models only the host boundary seam, never plugin internals.
// ---------------------------------------------------------------------------
function createHostStub() {
  const calls = {
    tools: [],
    configure: [],
    skillsRegister: [],
    routes: [],
    tapIndex: 0,
    events: {},
    credentialResolve: [],
  }
  const disposers = []
  const services = {
    // 0.2.0 host shape: volatile Config page policy — NO installSection method.
    settings: {
      configure: (options, fiber) => {
        calls.configure.push({ options, fiber })
        return () => {}
      },
    },
    skills: {
      register: (skill) => {
        calls.skillsRegister.push(skill)
        return () => {}
      },
    },
    webServer: {
      register: (route) => {
        calls.routes.push(route)
        return () => {}
      },
      tapIndex: (transform) => {
        calls.tapIndex += 1
        return () => {}
      },
    },
    // Credential store that never resolves — exercises the absent-credential
    // path (resolve → undefined → env fallback).
    credentials: {
      resolve: async (ref) => {
        calls.credentialResolve.push(ref)
        return undefined
      },
    },
  }

  const ctx = {
    fiber: { id: 'host-compat-stub-fiber' },
    tools: {
      register: (definition) => {
        calls.tools.push(definition)
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on: (event, cb) => {
      ;(calls.events[event] ??= []).push(cb)
      return () => {}
    },
    get: (name) => services[name],
    inject: (deps, cb) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return () => {}
      const child = Object.create(ctx)
      for (const dep of deps) child[dep] = services[dep]
      cb(child)
      return () => {}
    },
  }
  return { ctx, calls, disposers }
}

// ---------------------------------------------------------------------------
// 1. Load compatibility: apply(ctx, entryConfig) against the 0.2.0 host shape.
// ---------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-maid-comfyui-host-compat-'))
const { ctx, calls, disposers } = createHostStub()

let applyCompleted = false
try {
  const { apply } = await import('../lib/index.js')
  await apply(ctx, {
    baseUrl: 'http://127.0.0.1:8188',
    dataDir,
    apiKeyEnv: 'COMFYUI_API_KEY_HOST_COMPAT_TEST',
  })
  applyCompleted = true
} catch (error) {
  console.log(`  FAIL apply(ctx, entryConfig) threw — ${error && error.stack ? error.stack : error}`)
  failures += 1
}
// The signal is the registrations apply left behind, not the absence of a throw.
check(
  'apply(ctx, entryConfig) completes against a 0.2.0-shaped host (no installSection) and registers onto it',
  applyCompleted && calls.tools.length > 0 && calls.configure.length > 0,
  `completed=${applyCompleted} tools=${calls.tools.length} configure=${calls.configure.length}`,
)

// 2. Exactly the 4 tools register, each with a usable output (schema + render).
const toolNames = calls.tools.map((t) => t.name).sort()
checkDeepEqual('exactly 4 tools register with the expected names', toolNames, [
  'comfyui_object_info',
  'comfyui_run',
  'comfyui_skill',
  'comfyui_workflow',
])
for (const tool of calls.tools) {
  const out = tool.output
  const usable =
    out !== null && typeof out === 'object' && out.schema !== null && typeof out.schema === 'object' &&
    typeof out.render === 'function'
  check(`tool ${tool.name} carries a usable output (schema + render)`, usable, `output=${JSON.stringify(out)}`)
}

// 3. Settings: volatile branch taken — configure({ auto: false }, fiber).
check(
  'settings.configure({ auto: false }, fiber) called exactly once (volatile branch, 0.2.0 host shape)',
  calls.configure.length === 1 &&
    JSON.stringify(calls.configure[0]?.options) === JSON.stringify({ auto: false }) &&
    calls.configure[0]?.fiber === ctx.fiber,
  `configure calls=${JSON.stringify(calls.configure)}`,
)

// 4. Companion skill registered.
check(
  'skills.register called (companion skill)',
  calls.skillsRegister.length >= 1 &&
    typeof calls.skillsRegister[0]?.name === 'string' &&
    calls.skillsRegister[0].name.length > 0,
  `registered=${JSON.stringify(calls.skillsRegister.map((s) => s.name))}`,
)

// 5. webServer mounting happened (routes mounted; index-page tap offered).
check(
  'webServer route mounting called',
  calls.routes.length > 0,
  `routes registered=${calls.routes.length}`,
)
check(
  'webServer index-page tap registered',
  calls.tapIndex >= 1,
  `tapIndex calls=${calls.tapIndex}`,
)

// 6. loader/volatile-update event subscription registered.
check(
  "event subscription for 'loader/volatile-update' registered",
  (calls.events['loader/volatile-update']?.length ?? 0) >= 1,
  `events=${JSON.stringify(Object.keys(calls.events))}`,
)

// 7. Credentials resolution exercised without throwing when credential absent:
// run the one fully-offline tool path (comfyui_workflow action 'list').
const workflowTool = calls.tools.find((t) => t.name === 'comfyui_workflow')
if (workflowTool === undefined) {
  failures += 1
  console.log('  FAIL comfyui_workflow tool not found — cannot exercise credentials path')
  failures += 1
} else {
  try {
    const result = await workflowTool.execute({ action: 'list' }, {})
    check(
      'comfyui_workflow action:list executes offline without throwing',
      result !== null && typeof result === 'object' && result.action === 'list',
      `result.action=${JSON.stringify(result?.action)}`,
    )
    check(
      'credentials.resolve consulted and absent credential handled (env fallback)',
      calls.credentialResolve.length >= 1,
      `resolve calls=${calls.credentialResolve.length}`,
    )
  } catch (error) {
    console.log(`  FAIL credentials path threw — ${error && error.stack ? error.stack : error}`)
  }
}

// ---------------------------------------------------------------------------
// 8. Install-compatibility / peer gate: manifest peer range must satisfy each target host
// version with prerelease inclusion (host gate = semver {includePrerelease:true}),
// and must reject out-of-range versions so the check cannot pass vacuously.
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const peerRange = manifest.peerDependencies?.['@deepseek-ai/dsh-settings']
check(
  'manifest declares a @deepseek-ai/dsh-settings peer range',
  typeof peerRange === 'string' && peerRange.length > 0,
  `peerRange=${JSON.stringify(peerRange)}`,
)
if (typeof peerRange === 'string') {
  const mustSatisfy = [
    '0.1.2-alpha.4',
    '0.1.5-alpha.1',
    '0.1.6-alpha.1',
    '0.1.7-alpha.1',
    '0.1.7-rc.2',
    '0.2.0-rc.2',
    '0.2.0',
    '0.2.1-alpha.1',
  ]
  for (const version of mustSatisfy) {
    check(
      `peer range satisfies target host ${version} (prerelease inclusion)`,
      satisfiesPeerRange(version, peerRange),
      `range=${peerRange}`,
    )
  }
  // 0.2.0-rc.1 is deliberately out of range: the peer floor is the lowest host
  // version actually audited (0.2.0-rc.2), and caret upper bounds carry `-0`,
  // so `^0.2.0-rc.2` = [0.2.0-rc.2, 0.3.0-0). Refusing rc.1 tells those users
  // to upgrade one nightly — an unverified host is not endorsed.
  const mustNotSatisfy = ['0.2.0-rc.1', '0.3.0', '0.1.1']
  for (const version of mustNotSatisfy) {
    check(
      `peer range rejects out-of-range host ${version}`,
      !satisfiesPeerRange(version, peerRange),
      `range=${peerRange}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 9. Identity consistency: every artifact the host resolves BY PACKAGE NAME
// must carry the current package name. Two failure modes were hit in the field
// after the fork rename:
//   - cordis.patch.yml `name` is the module specifier the cordis loader imports
//     (PluginEntry._init -> tree.import(options.name)); a stale value leaves the
//     bundle layer composed while the plugin module never loads.
//   - the client bundle banner registers the factory id the renderer's module
//     graph looks up by graph-row id (= package name); a stale banner makes the
//     row fall back to its one-resource URL, re-executes the bundle and aborts
//     web boot with `duplicate factory registration` (host never starts).
// ---------------------------------------------------------------------------
check(
  'cordis.patch.yml entry name equals the npm package name',
  patchName === manifest.name,
  `patch=${JSON.stringify(patchName)} package=${JSON.stringify(manifest.name)}`,
)
const clientBundlePath = join(repoRoot, 'client', 'client.js')
if (existsSync(clientBundlePath)) {
  const clientBundle = readFileSync(clientBundlePath, 'utf8')
  const bannerId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientBundle)?.[1]
  check(
    'client bundle registers under the npm package name (renderer module-graph id)',
    bannerId === manifest.name,
    `banner=${JSON.stringify(bannerId)} package=${JSON.stringify(manifest.name)}`,
  )
}

// ---------------------------------------------------------------------------
// Cleanup and verdict. Dispose what apply registered onto the stub (stops the
// progress retry timer when it has already armed), then exit explicitly — the
// 3s retry timer is not unref'd, so the loop must not be left to drain.
// ---------------------------------------------------------------------------
for (const dispose of disposers.reverse()) {
  try {
    dispose()
  } catch {
    // best-effort teardown only
  }
}
rmSync(dataDir, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log(`\nall ${passed} checks passed — the plugin loads onto a 0.2.0-shaped host, and the peer gate covers every target host line`)
process.exit(0)
