import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const stagingRoot = mkdtempSync(join(tmpdir(), 'dsh-postman-ptc-install-'))
const archivePath = join(stagingRoot, 'repository.tar')

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(command + ' exited with ' + (result.status ?? 'unknown'))
}

function assertInStaging(path) {
  const location = relative(realpathSync(stagingRoot), realpathSync(path))
  assert.ok(location && location !== '..' && !location.startsWith('..' + sep) && !isAbsolute(location),
    'dependency outside clean fixture: ' + path)
}

try {
  execFileSync('git', ['archive', '--format=tar', '--output=' + archivePath, 'HEAD'], {
    cwd: repositoryRoot, stdio: 'inherit', windowsHide: true,
  })
  run('tar', ['-xf', archivePath, '-C', stagingRoot], repositoryRoot)
  rmSync(archivePath)
  // Exercise the current installer, including changes not yet committed to HEAD.
  copyFileSync(resolve(repositoryRoot, 'profiles/web/scripts/install-production.mjs'),
    resolve(stagingRoot, 'profiles/web/scripts/install-production.mjs'))

  const pluginRoot = resolve(stagingRoot, 'plugins/dsh-postman-harness')
  const profileRoot = resolve(stagingRoot, 'profiles/web')
  assert.equal(existsSync(resolve(pluginRoot, 'node_modules')), false)
  assert.equal(existsSync(resolve(profileRoot, 'node_modules')), false)
  run(process.execPath, ['profiles/web/scripts/install-production.mjs'], stagingRoot)

  assert.equal(realpathSync(resolve(profileRoot, 'node_modules/dsh-postman-harness')), realpathSync(pluginRoot))
  const requireFromProfile = createRequire(resolve(profileRoot, 'package.json'))
  const bridgePath = requireFromProfile.resolve('dsh-postman-harness/bridge')
  assertInStaging(bridgePath)
  const bridge = await import(pathToFileURL(bridgePath).href)
  assert.equal(bridge.name, 'dsh-postman-harness-bridge')
  assert.equal(typeof bridge.apply, 'function')
  const adapter = await import(pathToFileURL(resolve(pluginRoot, 'lib/ptc-adapter.js')).href)
  assert.equal(adapter.PTC_TOOL_NAME, 'ptc_execute')

  const requireFromPlugin = createRequire(bridgePath)
  const ptcPath = requireFromPlugin.resolve('dsh-ptc')
  assertInStaging(ptcPath)
  const requireFromPtc = createRequire(ptcPath)
  const quickjsPath = requireFromPtc.resolve('quickjs-emscripten')
  assertInStaging(quickjsPath)
  const { createPtcRuntime, DEFAULT_LIMITS } = await import(pathToFileURL(ptcPath).href)
  const runtime = createPtcRuntime()
  try {
    const result = await runtime.run({
      program: 'return 6 * 7',
      profile: { schemaVersion: 1, id: 'install-smoke', revision: 1, tools: [], limits: { ...DEFAULT_LIMITS } },
      bindings: {},
    })
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.value, 42)
  } finally {
    await runtime.dispose()
  }
  console.log('clean production install: bridge, ptc-adapter, dsh-ptc and QuickJS/WASM PASS')
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}
