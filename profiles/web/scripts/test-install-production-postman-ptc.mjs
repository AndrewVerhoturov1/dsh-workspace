import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const stagingRoot = mkdtempSync(join(tmpdir(), 'dsh-postman-ptc-install-'))
const archivePath = join(stagingRoot, 'repository.tar')

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true })
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

  // Include the current role implementation and canonical sources before commit.
  cpSync(resolve(repositoryRoot,'plugins/dsh-postman-harness/lib'),resolve(stagingRoot,'plugins/dsh-postman-harness/lib'),{recursive:true})
  for (const name of ['package.json','pnpm-lock.yaml'])
    copyFileSync(resolve(repositoryRoot,'plugins/dsh-postman-harness',name),resolve(stagingRoot,'plugins/dsh-postman-harness',name))
  for(const role of ['postman-leader','postman-worker','postman-secretary','postman-sol-worker'])
    cpSync(resolve(repositoryRoot,'.agents/skills',role),resolve(stagingRoot,'.agents/skills',role),{recursive:true})
  for(const preset of ['postman-leader','postman-leader-ptc'])
    cpSync(resolve(repositoryRoot,'.agent-presets',preset),resolve(stagingRoot,'.agent-presets',preset),{recursive:true})
  for(const name of ['postman-native-child-cutoff.patch','postman-native-cold-compact.patch'])
    copyFileSync(resolve(repositoryRoot,'system/patches',name),resolve(stagingRoot,'system/patches',name))
  copyFileSync(resolve(repositoryRoot,'system/patches/apply-postman-native-child-cutoff.mjs'),resolve(stagingRoot,'system/patches/apply-postman-native-child-cutoff.mjs'))
  const pluginRoot = resolve(stagingRoot, 'plugins/dsh-postman-harness')
  // The real installer must patch an isolated, pinned SDK on disk, not APPDATA.
  const sdkRoot = resolve(stagingRoot, 'plugins/native-sdk')
  mkdirSync(sdkRoot)
  for (const name of ['package.json','pnpm-lock.yaml']) copyFileSync(resolve(pluginRoot,name),resolve(sdkRoot,name))
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const sdkInstall = spawnSync(pnpm, ['install','--offline','--frozen-lockfile','--ignore-scripts'], {
    cwd:sdkRoot, stdio:'inherit', shell:process.platform==='win32', windowsHide:true,
  })
  if (sdkInstall.error) throw sdkInstall.error
  assert.equal(sdkInstall.status,0,'isolated native SDK install')
  const sdkAnchor = createRequire(resolve(sdkRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json')
  assertInStaging(sdkAnchor)
  const sdkRequire = createRequire(sdkAnchor)
  const env = { ...process.env, DSH_INSTALL_SDK:sdkAnchor, DSH_CAPABILITY_SDK:sdkAnchor }
  const profileRoot = resolve(stagingRoot, 'profiles/web')
  assert.equal(existsSync(resolve(pluginRoot, 'node_modules')), false)
  assert.equal(existsSync(resolve(profileRoot, 'node_modules')), false)
  run(process.execPath, ['profiles/web/scripts/install-production.mjs'], stagingRoot, env)
  const { applyPostmanNativeChildCutoff } = await import(pathToFileURL(resolve(stagingRoot,'system/patches/apply-postman-native-child-cutoff.mjs')).href)
  const targets = applyPostmanNativeChildCutoff([sdkAnchor, resolve(pluginRoot,'package.json')])
  assert.ok(targets.length >= 2)
  for (const target of targets) { assertInStaging(target.path); assert.equal(target.updated,false,'installer already applied patch') }
  // Exact previous Stage 2 native postimage upgrades on disk, then is idempotent.
  const subagentTarget = targets.find(target => target.path.endsWith(join('dsh-subagent','lib','index.js')))
  const upgradedBytes = readFileSync(subagentTarget.path)
  const upgradeStage = mkdtempSync(join(stagingRoot,'native-upgrade-'))
  const upgradeRelative = 'node_modules/@deepseek-ai/dsh-subagent/lib/index.js'
  mkdirSync(resolve(upgradeStage,upgradeRelative,'..'),{recursive:true})
  copyFileSync(subagentTarget.path,resolve(upgradeStage,upgradeRelative))
  const upgradePatch = resolve(upgradeStage,'upgrade.patch')
  writeFileSync(upgradePatch,readFileSync(resolve(stagingRoot,'system/patches/postman-native-cold-compact.patch'),'utf8').replaceAll('\r',''))
  run('git',['-c','core.longpaths=true','apply','--reverse',upgradePatch],upgradeStage,{...process.env,GIT_CEILING_DIRECTORIES:stagingRoot})
  const oldBytes = readFileSync(resolve(upgradeStage,upgradeRelative))
  assert.equal(execFileSync('git',['hash-object','--stdin'],{input:oldBytes.toString('utf8').replaceAll('\r',''),encoding:'utf8'}).trim(),'753ba9babe4aa1e548cf7b1dd6eee2ccdc666f40')
  // Atomic replacement, never overwrite a pnpm store hardlink.
  rmSync(subagentTarget.path);copyFileSync(resolve(upgradeStage,upgradeRelative),subagentTarget.path)
  assert.ok(applyPostmanNativeChildCutoff([sdkAnchor,resolve(pluginRoot,'package.json')]).some(target => target.updated))
  assert.deepEqual(readFileSync(subagentTarget.path),upgradedBytes)
  assert.ok(applyPostmanNativeChildCutoff([sdkAnchor,resolve(pluginRoot,'package.json')]).every(target => !target.updated))
  const { SubagentRuntime } = await import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-subagent')).href)
  for (const method of ['closeContinuableChild','inspectClosedContinuableChild','compactContinuableChild'])
    assert.equal(typeof SubagentRuntime.prototype[method],'function',method)

  assert.equal(realpathSync(resolve(profileRoot, 'node_modules/dsh-postman-harness')), realpathSync(pluginRoot))
  const requireFromProfile = createRequire(resolve(profileRoot, 'package.json'))
  const bridgePath = requireFromProfile.resolve('dsh-postman-harness/bridge')
  assertInStaging(bridgePath)
  const bridge = await import(pathToFileURL(bridgePath).href)
  assert.equal(bridge.name, 'dsh-postman-harness-bridge')
  assert.equal(typeof bridge.apply, 'function')
  const worker=await import(pathToFileURL(resolve(pluginRoot,'lib/postman-worker.js')).href)
  for(const role of ['luna','secretary','sol'])assert.ok(worker.postmanRoleInstruction(role).includes('TASK_CONTRACT'))
  assert.deepEqual(worker.POSTMAN_WORKER_AGENT_OPTIONS,{provider:'codex',model:'gpt-6-luna',reasoningEffort:'low'})
  const adapter = await import(pathToFileURL(resolve(pluginRoot, 'lib/ptc-adapter.js')).href)
  assert.equal(adapter.PTC_TOOL_NAME, 'ptc_execute')
  assert.equal(adapter.LEADER_SUPERVISOR_PROFILE.id,'postman-leader-supervisor')
  assert.equal(adapter.LEADER_SUPERVISOR_PROFILE.revision,9)
  assert.equal(adapter.PILOT_PROFILE,adapter.LEADER_SUPERVISOR_PROFILE)
  assert.equal(adapter.LEADER_SUPERVISOR_PROFILE.limits.maxConcurrentToolCalls,1)
  for(const name of ['postman_sol_worker','postman_yield','postman_team_status','postman_bridge_stop'])
    assert.ok(adapter.LEADER_SUPERVISOR_PROFILE.tools.includes(name),name)
  for(const name of ['skill','ask_user_question','exit_plan_mode','read_image'])
    assert.ok(!adapter.LEADER_SUPERVISOR_PROFILE.tools.includes(name),name)
  assert.equal(adapter.SOL_WORKER_PROFILE.id,'postman-sol-worker-engineering')
  for(const name of ['read','glob','grep','write','edit','pwsh'])assert.ok(adapter.SOL_WORKER_PROFILE.tools.includes(name))
  for(const name of ['postman_bridge','postman_bridge_stop','postman_team_status','postman_yield','postman_secretary','postman_sol_worker','postman_worker','ask_user_question'])assert.ok(!adapter.SOL_WORKER_PROFILE.tools.includes(name))
  assert.ok(worker.postmanRoleInstruction('sol').includes('PTC-first'))
  assert.ok(worker.postmanRoleInstruction('sol').includes('Worker-first'))

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
  // Native APIs run from the actual installed SDK, without a test loader.
  run(process.execPath,['--test','lib/postman-native-cutoff.test.js'],pluginRoot,{...env,DSH_ROOT:resolve(sdkAnchor,'..')})
  // Preserve one SDK identity for plugin/preset tests, as in the original fixture.
  const pluginSdkInstall = spawnSync(pnpm,['install','--offline','--frozen-lockfile','--ignore-scripts'],{
    cwd:pluginRoot,stdio:'inherit',shell:process.platform==='win32',windowsHide:true,
  })
  if (pluginSdkInstall.error) throw pluginSdkInstall.error
  assert.equal(pluginSdkInstall.status,0,'portable capability test SDK install')
  const pluginSdkAnchor = createRequire(resolve(pluginRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json')
  applyPostmanNativeChildCutoff([pluginSdkAnchor,resolve(pluginRoot,'package.json')])
  run(process.execPath,['--test','lib/postman-capability-lifecycle.test.js','lib/postman-capability-cold.test.js','lib/postman-stage2-control.test.js','lib/postman-stage2-bridge.test.js','lib/postman-stage2-cascade.test.js','lib/postman-task-close.test.js','lib/postman-objective-budget.test.js'],pluginRoot,{...process.env,DSH_CAPABILITY_SDK:pluginSdkAnchor})
  console.log('clean production install: role model-request catalogs, FAST no PTC, Leader/Sol usable PTC and QuickJS/WASM PASS')
} finally {
  rmSync(stagingRoot, { recursive: true, force: true })
}
