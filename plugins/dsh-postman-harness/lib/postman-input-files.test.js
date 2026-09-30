import assert from 'node:assert/strict'
import test from 'node:test'
import { PostmanInputGrants, createPostmanInputFilesTool, postmanInputGrants } from './postman-input-files.js'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { postmanBridgeRestrictionForAgent, postmanPtcDirectCallGuard,
  POSTMAN_INPUT_FILES_TOOL_NAME, POSTMAN_PTC_ONLY_LEADER_TOOLS } from './postman-bridge-core.js'

const file = Object.freeze({ name: 'reference.png', repository: 'AndrewVerhoturov1/dsh-workspace',
  commit: 'a'.repeat(40), path: 'tmp/123/reference.png', sha256: 'b'.repeat(64), byte_length: 9,
  raw_url: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'a'.repeat(40) + '/tmp/123/reference.png' })
function fixture(preset = 'postman-leader') {
  const agent = { id: 'leader', session: { header: { agentPreset: preset, delegationDepth: 0 } } }
  const task = { leaderSessionId: agent.id }
  const agents = new Map([[agent.id, agent]])
  const ctx = { agents: { get: id => agents.get(id) } }
  const contexts = { get: id => id === agent.id ? task : null }
  const grants = new PostmanInputGrants()
  const calls = []
  const run = async (_root, args) => {
    calls.push(args)
    if (args[0] === '--stage') return { bundle_id: 'f'.repeat(32), descriptors: [file] }
    if (args[0] === '--existing') return file
    return { bundle_id: args[1], removed: 1 }
  }
  const tool = createPostmanInputFilesTool(ctx, contexts, { grants, run })
  const execute = (args, caller = agent, parent) => tool.execute(args, { agent: caller, parent, signal: new AbortController().signal })
  return { agent, task, grants, tool, calls, execute, agents }
}

test('exact production Leader receives Host descriptors, own cleanup and deterministic repeat', async () => {
  const f = fixture()
  assert.equal(f.tool.name, POSTMAN_INPUT_FILES_TOOL_NAME)
  assert.equal(postmanBridgeRestrictionForAgent(f.agent).allow.includes(POSTMAN_INPUT_FILES_TOOL_NAME), true)
  const existing = await f.execute({ action: 'describe_existing', repository: file.repository, commit: file.commit, path: file.path })
  assert.deepEqual(existing, { status: 'POSTMAN_INPUT_READY', descriptors: [file] })
  assert.equal(f.grants.owns(f.agent, f.task, [file]), true)
  const staged = await f.execute({ action: 'stage', paths: ['C:/temp/attachments/reference.png'] })
  assert.equal(staged.bundleId, 'f'.repeat(32))
  assert.equal(f.grants.owns(f.agent, f.task, staged.descriptors), true)
  assert.equal((await f.execute({ action: 'cleanup', bundleId: 'e'.repeat(32) })).status, 'POSTMAN_INPUT_BUNDLE_NOT_OWNED')
  assert.equal((await f.execute({ action: 'cleanup', bundleId: staged.bundleId })).status, 'POSTMAN_INPUT_CLEANED')
  assert.equal((await f.execute({ action: 'cleanup', bundleId: staged.bundleId })).status, 'POSTMAN_INPUT_ALREADY_CLEANED')
  assert.equal(f.grants.owns(f.agent, f.task, [file]), false)
  assert.deepEqual(f.calls.map(call => call[0]), ['--existing', '--stage', '--cleanup'])
})

test('fabrication or any altered descriptor fails exact session/task provenance', async () => {
  const f = fixture()
  assert.equal(f.grants.owns(f.agent, f.task, [file]), false)
  await f.execute({ action: 'describe_existing', repository: file.repository, commit: file.commit, path: file.path })
  for (const field of ['sha256', 'path', 'commit', 'byte_length']) {
    const altered = { ...file, [field]: field === 'byte_length' ? 10 : 'c'.repeat(40) }
    assert.equal(f.grants.owns(f.agent, f.task, [altered]), false, field)
  }
  assert.equal(f.grants.owns(f.agent, {}, [file]), false)
  assert.equal(f.grants.owns({ ...f.agent }, f.task, [file]), false)
})

test('Bridge admission rejects fabricated and changed descriptors', async () => {
  const f = fixture()
  let accepted = 0
  const bridge = createPostmanBridgeTool({ agents: { get: id => f.agents.get(id) } },
    { accept: () => { accepted++; return { status: 'POSTMAN_BRIDGE_ACCEPTED' } } }, { get: () => f.task })
  const send = descriptor => bridge.execute({ message: '@PostmanAsk --input-files-json ' + JSON.stringify([descriptor]) + '\nUse file' },
    { agent: f.agent, signal: new AbortController().signal })
  assert.equal((await send(file)).status, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
  postmanInputGrants.record(f.agent, f.task, { descriptors: [file] })
  try {
    assert.equal((await send({ ...file, sha256: 'c'.repeat(64) })).status, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
    assert.equal((await send(file)).status, 'POSTMAN_BRIDGE_ACCEPTED')
    assert.equal(accepted, 1)
  } finally { postmanInputGrants.release(f.agent) }
})

test('PTC Leader direct call rejected; nested dispatch allowed, others denied', async () => {
  const f = fixture('postman-leader-ptc')
  assert.equal(POSTMAN_PTC_ONLY_LEADER_TOOLS.includes(POSTMAN_INPUT_FILES_TOOL_NAME), true)
  assert.match(postmanPtcDirectCallGuard({ agent: f.agent, name: POSTMAN_INPUT_FILES_TOOL_NAME }, id => f.agents.get(id)), /PTC_DIRECT_CALL_REJECTED/)
  assert.equal(postmanPtcDirectCallGuard({ agent: f.agent, name: POSTMAN_INPUT_FILES_TOOL_NAME, parent: {} }, id => f.agents.get(id)), undefined)
  assert.equal((await f.execute({ action: 'stage', paths: ['C:/temp/reference.png'] }, f.agent, {})).status, 'POSTMAN_INPUT_READY')
  for (const kind of ['standard', 'postman-bridge', 'postman-worker']) {
    const caller = { id: kind, session: { header: { agentPreset: kind, delegationDepth: kind === 'standard' ? 0 : 1, origin: kind === 'standard' ? undefined : 'subagent' } } }
    f.agents.set(kind, caller)
    assert.equal(postmanBridgeRestrictionForAgent(caller).deny.includes(POSTMAN_INPUT_FILES_TOOL_NAME), true)
    assert.equal((await f.execute({ action: 'stage', paths: ['C:/temp/reference.png'] }, caller)).status, 'POSTMAN_INPUT_CALLER_REJECTED')
  }
})
