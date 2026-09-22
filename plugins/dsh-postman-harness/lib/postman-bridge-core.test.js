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
  POSTMAN_LEADER_PRESET_ID,
  POSTMAN_LEADER_TOOL_ALLOWLIST,
  buildPostmanBridgeStartRequest,
  createPostmanBridgeBoundaryManager,
  isTopLevelPostmanLeader,
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
  assert.deepEqual(request.agentOptions, { provider: 'codex', model: 'gpt-5.6-luna' })
  assert.deepEqual(POSTMAN_BRIDGE_AGENT_OPTIONS, { provider: 'codex', model: 'gpt-5.6-luna' })
  assert.equal(request.maxDepth, POSTMAN_BRIDGE_MAX_DEPTH)
  assert.equal(request.maxDepth, 1)
  assert.deepEqual(request.toolFilter, { allow: [...POSTMAN_BRIDGE_TOOL_ALLOWLIST] })
  assert.deepEqual(request.toolFilter.allow, [
    'skill',
    'postman_send_current_turn',
    'postman_current_turn_status',
    'postman_ask_validate_reply',
  ])
  assert.equal(request.prompt.length, 1)
  assert.equal(request.prompt[0].type, 'text')
  assert.equal(request.prompt[0].text, exact)
  assert.equal(request.signal, signal)
})

test('bridge persona keeps Luna mechanical and forbids autonomous continuation', () => {
  assert.match(POSTMAN_BRIDGE_PERSONA, /minimal one-shot transport subagent/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /skill\(delegate-via-postman-ask\)/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /skill\(delegate-via-postman\)/)
  assert.match(POSTMAN_BRIDGE_PERSONA, /postman_send_current_turn\(\) with no arguments/)
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

test('bridge authorization and visibility are limited to top-level postman-leader', () => {
  assert.equal(POSTMAN_BRIDGE_TOOL_NAME, 'postman_bridge')
  assert.equal(POSTMAN_LEADER_PRESET_ID, 'postman-leader')

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
    'read', 'glob', 'grep', 'skill', 'web_fetch', 'web_search', 'postman_bridge',
  ])
  assert.deepEqual(postmanBridgeRestrictionForAgent(leader), {
    allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST],
  })
  assert.deepEqual(postmanBridgeRestrictionForAgent(standard), {
    deny: ['postman_bridge'],
  })
  assert.deepEqual(postmanBridgeRestrictionForAgent(delegated), {
    deny: ['postman_bridge'],
  })

  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('write'), false)
  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('edit'), false)
  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('subagent'), false)
  assert.equal(POSTMAN_LEADER_TOOL_ALLOWLIST.includes('postman_send_current_turn'), false)
})


test('boundary manager replaces the active restriction when a blank session switches preset', () => {
  const fixture = boundaryFixture('standard')
  const agents = new Map([[fixture.agent.id, fixture.agent]])
  const manager = createPostmanBridgeBoundaryManager(sessionId => agents.get(sessionId))

  assert.equal(manager.install(fixture.agent), false)
  assert.deepEqual(fixture.activeRestrictions(), [{ deny: ['postman_bridge'] }])

  fixture.setPreset('postman-leader')
  assert.equal(manager.refreshSession(fixture.agent.id), true)
  assert.deepEqual(fixture.activeRestrictions(), [{ allow: [...POSTMAN_LEADER_TOOL_ALLOWLIST] }])
  assert.equal(fixture.restrictions[0].active, false)

  fixture.setPreset('standard')
  assert.equal(manager.refreshSession(fixture.agent.id), true)
  assert.deepEqual(fixture.activeRestrictions(), [{ deny: ['postman_bridge'] }])
  assert.equal(fixture.restrictions[1].active, false)

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
  assert.equal(packageJson.peerDependencies['@deepseek-ai/dsh-subagent'], '^0.1.1-rc.2')

  const bundle = readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(bundle, /id: postman-bridge[\s\S]*name: dsh-postman-harness\/bridge/)

  const webPatch = readFileSync(join(repoRoot, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
  assert.match(webPatch, /id: preset-postman-leader/)
  assert.match(webPatch, /id: postman-leader/)
  assert.match(webPatch, /name: Postman Leader/)

  const bridgeSource = readFileSync(join(pluginRoot, 'lib', 'postman-bridge.js'), 'utf8')
  assert.match(bridgeSource, /POSTMAN_BRIDGE_CALLER_REJECTED/)
  assert.match(bridgeSource, /postmanBridgeCallerAllowed\(parent\)/)
  assert.match(bridgeSource, /createPostmanBridgeBoundaryManager/)
  assert.match(bridgeSource, /inject = \['agents', 'subagents', 'tools'\]/)
  assert.match(bridgeSource, /agent-preset\/selected/)
  assert.match(bridgeSource, /ctx\.agents\.get\(sessionId\)/)
  assert.match(bridgeSource, /agent\/disposed/)

  const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8')
  assert.match(agents, /Postman Bridge supervisor invariant/)
  assert.match(agents, /POSTMAN_BRIDGE_CALLER_REJECTED/)
})
