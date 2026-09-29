import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  POSTMAN_BRIDGE_AGENT_OPTIONS,
  POSTMAN_BRIDGE_MAX_DEPTH,
  POSTMAN_BRIDGE_PERSONA,
  POSTMAN_BRIDGE_PROVIDER,
  POSTMAN_BRIDGE_TOOL_ALLOWLIST,
  POSTMAN_BRIDGE_TOOL_NAME,
  POSTMAN_BRIDGE_STATUS_TOOL_NAME,
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  POSTMAN_LEADER_PRESET_ID,
  POSTMAN_PTC_LEADER_PRESET_ID,
  POSTMAN_PTC_TOOL_NAME,
  POSTMAN_LEADER_TOOL_ALLOWLIST,
  POSTMAN_LEADER_ONLY_TOOL_NAMES,
  buildPostmanBridgeStartRequest,
  createPostmanBridgeBoundaryManager,
  isTopLevelPostmanLeader,
  isTopLevelPostmanPtcLeader,
  isTopLevelPostmanSupervisor,
  postmanBridgeCallerAllowed,
  postmanBridgeRestrictionForAgent,
  settleTrustedPostmanStatus,
} from './postman-bridge-core.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const repoRoot = join(pluginRoot, '..', '..')

function parent(header = {}) {
  return { id: 'leader', session: { header: { id: 'leader', ...header } } }
}

function boundaryFixture(initialPreset = 'standard') {
  let preset = initialPreset
  const restrictions = []
  const agent = parent({ agentPreset: initialPreset })
  agent.ctx = {
    get: name => name === 'agentPresets' ? { composedPreset: () => preset } : undefined,
    tools: {
      restrict(filter) {
        const record = { filter, active: true }
        restrictions.push(record)
        return () => { record.active = false }
      },
    },
  }
  return {
    agent,
    setPreset(value) { preset = value },
    activeRestrictions() { return restrictions.filter(item => item.active).map(item => item.filter) },
    restrictions,
  }
}

test('bridge request pins Luna, spawn, depth and exact message', () => {
  const signal = new AbortController().signal
  const exact = '@PostmanAsk --chat REQ_20260922T101026Z_5561 A\\B | "кавычки" | ${value} | Привет-мир\nsecond line  '
  const request = buildPostmanBridgeStartRequest({
    parent: parent(),
    message: exact,
    signal,
    transportKind: 'text',
  })

  assert.equal(POSTMAN_BRIDGE_PROVIDER, 'spawn')
  assert.deepEqual(request.agentOptions, { provider: 'codex', model: 'gpt-6-luna' })
  assert.deepEqual(POSTMAN_BRIDGE_AGENT_OPTIONS, { provider: 'codex', model: 'gpt-6-luna' })
  assert.equal(request.maxDepth, POSTMAN_BRIDGE_MAX_DEPTH)
  assert.equal(request.maxDepth, 1)
  assert.deepEqual(request.toolFilter, { allow: [...POSTMAN_BRIDGE_TOOL_ALLOWLIST] })
  assert.deepEqual(request.toolFilter.allow, [
    'skill',
    'postman_send_current_turn',
    'postman_current_turn_status',
    'postman_ask_validate_reply',
    'notify_parent',
  ])
  assert.equal(request.prompt.length, 1)
  assert.equal(request.prompt[0].type, 'text')
  assert.equal(request.prompt[0].text, exact)
  assert.equal(request.signal, signal)
})

test('image bridge keeps exact prompt and image-only mode', () => {
  const signal = new AbortController().signal
  const message = '@PostmanImage draw a cat'
  const request = buildPostmanBridgeStartRequest({ parent: parent(), message, signal, transportKind: 'image' })
  assert.equal(request.label, 'Postman Image Bridge')
  assert.deepEqual(request.prompt, [{ type: 'text', text: message }])
  assert.match(request.persona, /IMAGE_RESULT_DURABLE/)
  assert.match(request.persona, /Never call an automatic continuation tool/)
})

test('bridge persona keeps Luna mechanical and branches text handoff by delivery mode', () => {
  assert.match(POSTMAN_BRIDGE_PERSONA, /minimal one-shot transport subagent/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /skill\(delegate-via-postman-ask\)/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /skill\(delegate-via-postman\)/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /postman_send_current_turn\(\) with no arguments/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /deliveryMode=inline/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /deliveryMode=file/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /do not call postman_ask_validate_reply/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /do not read or reconstruct resultFile/)
  assert.doesNotMatch(POSTMAN_BRIDGE_PERSONA, /For TEXT_RESULT_DURABLE, before your final response call postman_ask_validate_reply/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /Never call an automatic continuation tool/)
})

test('trusted status ignores child prose and waits through RUNNING', async () => {
  const statuses = [
    { status: 'RUNNING', requestId: 'REQ_1' },
    {
      status: 'COMPLETED',
      requestId: 'REQ_2',
      result: {
        ok: true,
        code: 'TEXT_RESULT_DURABLE',
        state: 'TEXT_RESULT_DURABLE',
        requestId: 'REQ_2',
        assistantText: 'TRUSTED',
      },
    },
  ]
  const result = await settleTrustedPostmanStatus(async () => statuses.shift(), new AbortController().signal)
  assert.equal(result.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(result.checks, 2)
  assert.equal(result.requestId, 'REQ_2')
  assert.equal(result.result.assistantText, 'TRUSTED')
})

test('trusted status preserves file-mode descriptor without assistantText', async () => {
  const receipt = {
    ok: true,
    code: 'TEXT_RESULT_DURABLE',
    state: 'TEXT_RESULT_DURABLE',
    requestId: 'REQ_FILE',
    deliveryMode: 'file',
    resultFile: 'C:\\Users\\andre\\AppData\\Local\\DSH\\Postman\\direct\\text-results\\REQ_FILE\\POSTMAN_REQ_FILE_ANSWER.md',
    assistantTextLength: 65925,
    assistantTextSha256: 'a'.repeat(64),
  }
  const result = await settleTrustedPostmanStatus(async () => ({
    status: 'COMPLETED',
    requestId: 'REQ_FILE',
    result: receipt,
  }), new AbortController().signal)

  assert.equal(result.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(result.result, receipt)
  assert.equal(result.result.deliveryMode, 'file')
  assert.equal(result.result.assistantText, undefined)
  assert.equal(result.result.resultFile, receipt.resultFile)
})

test('trusted status fails closed when Luna never started Direct Postman', async () => {
  const result = await settleTrustedPostmanStatus(async () => ({ status: 'NO_JOB' }), new AbortController().signal)
  assert.deepEqual(result, { status: 'POSTMAN_BRIDGE_NO_TRANSPORT', checks: 1, requestId: null })
})

test('trusted status preserves a failed Direct terminal receipt', async () => {
  const receipt = { ok: false, code: 'POSTMAN_BACKGROUND_JOB_FAILED', requestId: 'REQ_X' }
  const result = await settleTrustedPostmanStatus(async () => ({
    status: 'FAILED',
    requestId: 'REQ_X',
    result: receipt,
  }), new AbortController().signal)
  assert.equal(result.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(result.result, receipt)
})

test('bridge authorization and visibility are limited to exact top-level Postman supervisors', () => {
  assert.equal(POSTMAN_BRIDGE_TOOL_NAME, 'postman_bridge')
  assert.equal(POSTMAN_BRIDGE_STATUS_TOOL_NAME, 'postman_bridge_status')
  assert.equal(POSTMAN_BRIDGE_TOOL_ALLOWLIST.includes(POSTMAN_BRIDGE_STATUS_TOOL_NAME), false)
  assert.equal(POSTMAN_WORKER_TOOL_NAME, 'postman_worker')
  assert.equal(POSTMAN_WORKER_INTERRUPT_TOOL_NAME, 'postman_worker_interrupt')
  assert.equal(POSTMAN_WORKER_STOP_TOOL_NAME, 'postman_worker_stop')
  assert.equal(POSTMAN_LEADER_PRESET_ID, 'postman-leader')
  assert.equal(POSTMAN_PTC_LEADER_PRESET_ID, 'postman-leader-ptc')

  const leader = parent({ agentPreset: 'postman-leader' })
  const delegated = parent({ agentPreset: 'postman-leader', origin: 'subagent', delegationDepth: 1 })
  const standard = parent({ agentPreset: 'standard' })
  const switched = parent({ agentPreset: 'standard' })
  switched.ctx = { get: () => ({ composedPreset: () => 'postman-leader' }) }

  assert.equal(isTopLevelPostmanLeader(leader), true)
  assert.equal(isTopLevelPostmanLeader(delegated), false)
  assert.equal(isTopLevelPostmanLeader(standard), false)
  assert.equal(isTopLevelPostmanLeader(switched), true)

  assert.equal(postmanBridgeCallerAllowed(leader), true)
  assert.equal(postmanBridgeCallerAllowed(switched), true)
  assert.equal(postmanBridgeCallerAllowed(standard), false)
  assert.equal(postmanBridgeCallerAllowed(delegated), false)

  assert.deepEqual(POSTMAN_LEADER_TOOL_ALLOWLIST, [
    'ask_user_question', 'todo_write', 'exit_plan_mode', 'create_goal', 'get_goal', 'update_goal',
    'read', 'read_image', 'grep', 'skill', 'web_fetch', 'postman_task_prepare', 'postman_task_restore',
    'postman_bridge', 'postman_bridge_status', 'postman_worker', 'postman_worker_interrupt', 'postman_worker_stop', 'postman_yield', 'postman_worker_list',
  ])
  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.length, 20)
  assert.equal(new Set(POSTMAN_LEADER_TOOL_ALLOWLIST).size, 20)
  assert.deepEqual(POSTMAN_LEADER_ONLY_TOOL_NAMES, [
    'postman_task_prepare', 'postman_task_restore', 'postman_bridge', 'postman_bridge_status',
    'postman_worker', 'postman_worker_interrupt', 'postman_worker_stop', 'postman_yield', 'postman_worker_list',
  ])
  assert.deepEqual(postmanBridgeRestrictionForAgent(leader), {
    allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST],
  })
  assert.deepEqual(postmanBridgeRestrictionForAgent(standard), {
    deny: [...POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_TOOL_NAME],
  })
  assert.deepEqual(postmanBridgeRestrictionForAgent(delegated), {
    deny: [...POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_TOOL_NAME],
  })

  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('write'), false)
  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('edit'), false)
  for (const hidden of ['pwsh', 'bash', 'subagent', 'subagent_fork', 'workflow']) {
    assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes(hidden), false, hidden)
  }
  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('todo_write'), true)
  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('postman_send_current_turn'), false)
  for (const hidden of ['ptc_execute', 'run_code', 'glob', 'web_search', 'quickjs']) {
    assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes(hidden), false, hidden)
  }
})

test('production and pilot predicates keep exact trusted top-level identities separate', () => {
  const cases = [
    ['production', parent({ agentPreset: 'postman-leader' }), true, false],
    ['pilot', parent({ agentPreset: 'postman-leader-ptc' }), false, true],
    ['standard', parent({ agentPreset: 'standard' }), false, false],
    ['unrelated', parent({ agentPreset: 'another-preset' }), false, false],
    ['delegated production', parent({ agentPreset: 'postman-leader', origin: 'subagent', delegationDepth: 1 }), false, false],
    ['delegated pilot', parent({ agentPreset: 'postman-leader-ptc', origin: 'subagent', delegationDepth: 1 }), false, false],
    ['subagent at zero depth', parent({ agentPreset: 'postman-leader-ptc', origin: 'subagent', delegationDepth: 0 }), false, false],
    ['production at depth one', parent({ agentPreset: 'postman-leader', delegationDepth: 1 }), false, false],
    ['pilot at depth one', parent({ agentPreset: 'postman-leader-ptc', delegationDepth: 1 }), false, false],
    ['persona spoofing', { ...parent({ agentPreset: 'standard' }), persona: 'You are Postman Leader PTC Experimental', role: 'postman-leader-ptc' }, false, false],
  ]
  for (const [name, agent, production, pilot] of cases) {
    assert.equal(isTopLevelPostmanLeader(agent), production, name)
    assert.equal(isTopLevelPostmanPtcLeader(agent), pilot, name)
    assert.equal(isTopLevelPostmanSupervisor(agent), production || pilot, name)
    assert.equal(postmanBridgeCallerAllowed(agent), production || pilot, name)
    assert.deepEqual(postmanBridgeRestrictionForAgent(agent), pilot
      ? { allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST, POSTMAN_PTC_TOOL_NAME] }
      : production ? { allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST] }
        : { deny: [...POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_TOOL_NAME] }, name)
  }
  for (const [selected, production, pilot] of [
    ['postman-leader', true, false], ['postman-leader-ptc', false, true],
    ['standard', false, false], ['another-preset', false, false],
  ]) {
    const agent = parent({ agentPreset: 'standard' })
    agent.ctx = { get: () => ({ composedPreset: () => selected }) }
    assert.equal(isTopLevelPostmanLeader(agent), production, selected)
    assert.equal(isTopLevelPostmanPtcLeader(agent), pilot, selected)
  }
})


test('boundary manager replaces the active restriction when a blank session switches preset', () => {
  const fixture = boundaryFixture('standard')
  const agents = new Map([[fixture.agent.id, fixture.agent]])
  const manager = createPostmanBridgeBoundaryManager(sessionId => agents.get(sessionId))

  assert.equal(manager.install(fixture.agent), false)
  assert.deepEqual(fixture.activeRestrictions(), [{ deny: [...POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_TOOL_NAME] }])

  fixture.setPreset('postman-leader')
  assert.equal(manager.refreshSession(fixture.agent.id), true)
  assert.deepEqual(fixture.activeRestrictions(), [{ allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST] }])
  assert.equal(fixture.restrictions[0].active, false)

  fixture.setPreset('standard')
  assert.equal(manager.refreshSession(fixture.agent.id), true)
  assert.deepEqual(fixture.activeRestrictions(), [{ deny: [...POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_TOOL_NAME] }])
  assert.equal(fixture.restrictions[1].active, false)

  fixture.setPreset('postman-leader-ptc')
  assert.equal(manager.refreshSession(fixture.agent.id), true)
  assert.deepEqual(fixture.activeRestrictions(), [{ allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST, POSTMAN_PTC_TOOL_NAME] }])
  assert.equal(fixture.restrictions[2].active, false)

  fixture.setPreset('standard')
  assert.equal(manager.refreshSession(fixture.agent.id), true)
  assert.deepEqual(fixture.activeRestrictions(), [{ deny: [...POSTMAN_LEADER_ONLY_TOOL_NAMES, POSTMAN_PTC_TOOL_NAME] }])
  assert.equal(fixture.restrictions[3].active, false)
  assert.equal(fixture.restrictions.filter(item => item.active).length, 1)

  assert.equal(manager.refreshSession('missing'), false)
  assert.equal(manager.disposeAgent(fixture.agent), true)
  assert.deepEqual(fixture.activeRestrictions(), [])
  assert.equal(manager.disposeAgent(fixture.agent), false)

  manager.disposeAll()
})

test('package and composition expose bridge entrypoint and leader preset', () => {
  const packageJson = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.exports['./bridge'], './lib/postman-bridge.js')
  assert.equal(packageJson.files.includes('lib/postman-bridge.js'), true)
  assert.equal(packageJson.files.includes('lib/postman-bridge-core.js'), true)
  assert.equal(packageJson.files.includes('lib/postman-bridge-launch-coordinator.js'), true)
  assert.equal(packageJson.files.includes('lib/postman-bridge-jobs.js'), true)
  assert.equal(packageJson.files.includes('lib/postman-worker.js'), true)
  assert.equal(packageJson.peerDependencies['@deepseek-ai/dsh-subagent'], '^0.1.1-rc.2')

  const bundle = readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(bundle, /id: postman-bridge[\s\S]*name: dsh-postman-harness\/bridge/)

  const webPatch = readFileSync(join(repoRoot, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(webPatch, /preset-postman-leader|@deepseek-ai\/dsh-agent-preset/)

  const leaderPresetRoot = join(repoRoot, '.agent-presets', 'postman-leader')
  const leaderPreset = readFileSync(join(leaderPresetRoot, 'agent.cordis.yml'), 'utf8')
  const leaderMetadata = readFileSync(join(leaderPresetRoot, 'preset.yml'), 'utf8')
  assert.match(leaderMetadata, /^name: Postman Leader$/m)
  assert.match(leaderMetadata, /^order: 4$/m)
  assert.match(leaderPreset, /id: persona[\s\S]*name: '@deepseek-ai\/dsh-persona'[\s\S]*text:/)
  assert.match(leaderMetadata, /20 registered tools/i)
  assert.match(leaderPreset, /positive 20-name runtime allowlist/)
  assert.match(leaderPreset, /id: tool-web[\s\S]*fetch: true[\s\S]*search: true/)
  assert.deepEqual(
    [...leaderPreset.matchAll(/^\s*- id: ([\w-]+)\s*$/gm)].map((match) => match[1]),
    ['persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs',
      'skill-filesystem', 'tool-skill', 'tool-goal', 'planning', 'plan-mode', 'compaction',
      'compaction-basic', 'command-compact', 'tool-result-pruner', 'delegation',
      'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
      'workflow-worker-thread', 'tool-workflow', 'tool-ralph', 'tool-ask-user', 'tool-todo', 'tool-web'],
  )
  assert.match(leaderPreset, /You are Postman Leader\./)

  const pilotPresetRoot = join(repoRoot, '.agent-presets', 'postman-leader-ptc')
  const pilotMetadata = readFileSync(join(pilotPresetRoot, 'preset.yml'), 'utf8')
  const pilotPreset = readFileSync(join(pilotPresetRoot, 'agent.cordis.yml'), 'utf8')
  assert.match(pilotMetadata, /^name: Postman Leader PTC Experimental$/m)
  assert.match(pilotMetadata, /^order: 5$/m)
  const components = [...leaderPreset.matchAll(/^\s*- id: ([\w-]+)\s*$/gm)].map(match => match[1])
  assert.deepEqual([...pilotPreset.matchAll(/^\s*- id: ([\w-]+)\s*$/gm)].map(match => match[1]), components)
  assert.deepEqual(components, ['persona', 'agent-instructions', 'tool-bash', 'tool-pwsh',
    'tool-fs', 'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill',
    'tool-goal', 'planning', 'plan-mode', 'compaction', 'compaction-basic',
    'command-compact', 'tool-result-pruner', 'delegation', 'tool-subagent-control',
    'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
    'workflow-worker-thread', 'tool-workflow', 'tool-ralph', 'tool-ask-user',
    'tool-todo', 'tool-web'])
  assert.equal(pilotPreset.replace(/\r\n/g, '\n').replace(/^# Experimental pilot:.*\n/, '').replace(/^# PTC pilot:.*\n/gm, ''),
    leaderPreset.replace(/\r\n/g, '\n').replace(/^# Shared Postman composition.*\n/, ''))
  assert.doesNotMatch(pilotPreset, /ptc_execute|run_code|QuickJS|WASM|browser Worker/i)

  const bridgeSource = readFileSync(join(pluginRoot, 'lib', 'postman-bridge.js'), 'utf8')
  assert.match(bridgeSource, /POSTMAN_BRIDGE_CALLER_REJECTED/)
  assert.match(bridgeSource, /postmanBridgeCallerAllowed\(agent\)/)
  assert.match(bridgeSource, /createPostmanBridgeBoundaryManager/)
  assert.match(bridgeSource, /inject = \['agents', 'subagents', 'tools', 'storageDomain'\]/)
  assert.match(bridgeSource, /agent-preset\/selected/)
  assert.match(bridgeSource, /ctx\.agents\.get\(sessionId\)/)
  assert.match(bridgeSource, /agent\/disposed/)

  const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8')
  assert.match(agents, /postman-leader/)

  const leaderSkill = readFileSync(join(repoRoot, '.agents', 'skills', 'postman-leader', 'SKILL.md'), 'utf8')
  assert.match(leaderSkill, /POSTMAN_LEADER_SKILL_VERSION: 14/)
  assert.match(leaderSkill, /artifactRequestId/)
  assert.ok(leaderSkill.includes('implementation_artifact_apply'))

  const bridgeFlow = readFileSync(join(repoRoot, 'postman', 'POSTMAN_BRIDGE_FLOW.md'), 'utf8')
  assert.match(bridgeFlow, /deliveryMode=inline/)
  assert.match(bridgeFlow, /deliveryMode=file/)
  assert.match(bridgeFlow, /child НЕ вызывает `postman_ask_validate_reply`/)
  assert.match(bridgeFlow, /bridge host сохраняет descriptor для parent Leader/)
  assert.match(bridgeFlow, /process-local grant по точной сессии Leader и REQ/)
  assert.ok(bridgeFlow.includes('postman_worker({task, workerSessionId, artifactRequestId:'))
  assert.ok(bridgeFlow.includes('implementation_artifact_apply({requestId:'))
  assert.doesNotMatch(bridgeFlow, /применение exact `resultZip`/)
})
