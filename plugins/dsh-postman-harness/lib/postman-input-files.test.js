import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostmanInputGrants, createPostmanInputFilesTool, postmanInputGrants } from './postman-input-files.js'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { postmanBridgeRestrictionForAgent, postmanPtcDirectCallGuard,
  POSTMAN_INPUT_FILES_TOOL_NAME, POSTMAN_PTC_ONLY_LEADER_TOOLS } from './postman-bridge-core.js'

const file = Object.freeze({ name: 'reference.png', repository: 'AndrewVerhoturov1/dsh-workspace',
  commit: 'a'.repeat(40), path: 'tmp/123/reference.png', sha256: createHash('sha256').update('PNG-bytes').digest('hex'), byte_length: 9,
  raw_url: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'a'.repeat(40) + '/tmp/123/reference.png' })
function privateResult(root = mkdtempSync(join(tmpdir(), 'postman-grant-test-'))) {
  const path = join(root, '001.bin')
  writeFileSync(path, 'PNG-bytes')
  return { snapshotRoot: root, descriptors: [file], materializations: [{ snapshot_path: path,
    sha256: file.sha256, byte_length: file.byte_length }] }
}
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
    const root = args[args.indexOf('--snapshot-dir') + 1]
    if (args[0] === '--stage') return { ...privateResult(root), bundle_id: 'f'.repeat(32) }
    if (args[0] === '--existing') return privateResult(root)
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
  f.grants.release(f.agent)
})

test('Bridge admission rejects fabricated and changed descriptors', async () => {
  const f = fixture()
  let accepted = 0, binding
  const bridge = createPostmanBridgeTool({ agents: { get: id => f.agents.get(id) } },
    { accept(_agent, _message, _kind, pinned) { accepted++; binding = pinned; return { status: 'POSTMAN_BRIDGE_ACCEPTED' } } }, { get: () => f.task })
  const send = descriptor => bridge.execute({ message: '@PostmanAsk --input-files-json ' + JSON.stringify([descriptor]) + '\nUse file' },
    { agent: f.agent, signal: new AbortController().signal })
  assert.equal((await send(file)).status, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
  postmanInputGrants.record(f.agent, f.task, privateResult())
  try {
    assert.equal((await send({ ...file, sha256: 'c'.repeat(64) })).status, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
    assert.equal((await send(file)).status, 'POSTMAN_BRIDGE_ACCEPTED')
    assert.equal(accepted, 1)
  } finally { postmanInputGrants.unpin(binding); postmanInputGrants.release(f.agent) }
})

test('PTC Leader direct call rejected; nested dispatch allowed, others denied', async () => {
  const f = fixture('postman-leader-ptc')
  assert.equal(POSTMAN_PTC_ONLY_LEADER_TOOLS.includes(POSTMAN_INPUT_FILES_TOOL_NAME), true)
  assert.match(postmanPtcDirectCallGuard({ agent: f.agent, name: POSTMAN_INPUT_FILES_TOOL_NAME }, id => f.agents.get(id)), /PTC_DIRECT_CALL_REJECTED/)
  assert.equal(postmanPtcDirectCallGuard({ agent: f.agent, name: POSTMAN_INPUT_FILES_TOOL_NAME, parent: {} }, id => f.agents.get(id)), undefined)
  assert.equal((await f.execute({ action: 'stage', paths: ['C:/temp/reference.png'] }, f.agent, {})).status, 'POSTMAN_INPUT_READY')
  f.grants.release(f.agent)
  for (const kind of ['standard', 'postman-bridge', 'postman-worker']) {
    const caller = { id: kind, session: { header: { agentPreset: kind, delegationDepth: kind === 'standard' ? 0 : 1, origin: kind === 'standard' ? undefined : 'subagent' } } }
    f.agents.set(kind, caller)
    assert.equal(postmanBridgeRestrictionForAgent(caller).deny.includes(POSTMAN_INPUT_FILES_TOOL_NAME), true)
    assert.equal((await f.execute({ action: 'stage', paths: ['C:/temp/reference.png'] }, caller)).status, 'POSTMAN_INPUT_CALLER_REJECTED')
  }
})

test('private tool output never includes Host paths and release removes exact materialization', async () => {
  const f = fixture()
  const result = await f.execute({ action: 'stage', paths: ['C:/source/selected.txt'] })
  const call = f.calls[0], root = call[call.indexOf('--snapshot-dir') + 1]
  assert.equal(existsSync(join(root, '001.bin')), true)
  assert.equal(JSON.stringify(result).includes(root), false)
  assert.equal(JSON.stringify(result).includes('snapshot'), false)
  assert.equal(JSON.stringify(result).includes('C:/source'), false)
  f.grants.release(f.agent)
  assert.equal(existsSync(root), false)
})

test('opaque pin survives grant cleanup; only exact child/context/descriptor can build', async () => {
  const grants = new PostmanInputGrants(), agent = { id: 'pin-leader' }, context = {}
  const result = privateResult()
  grants.record(agent, context, result)
  const binding = grants.pin(agent, context, [file]), child = { id: 'pin-child' }
  assert.deepEqual(binding, {})
  assert.equal(grants.bindChild(binding, { ...agent }, context, child), false)
  assert.equal(grants.bindChild(binding, agent, {}, child), false)
  assert.equal(grants.bindChild(binding, agent, context, child), true)
  assert.equal(grants.child({ ...child }, context, [file]), null)
  assert.equal(grants.child(child, {}, [file]), null)
  assert.equal(grants.child(child, context, [{ ...file, byte_length: 10 }]), null)
  grants.release(agent)
  assert.equal(existsSync(result.snapshotRoot), true)
  const req = 'REQ_20261001T000000Z_0987'
  const bundle = await grants.build(binding, child.id, req, [file])
  assert.equal(bundle.displayName, 'POSTMAN_INPUT_' + req + '.zip')
  const handoff = JSON.parse(readFileSync(bundle.handoffPath, 'utf8'))
  const zip = readFileSync(handoff.attachment.path)
  assert.equal(createHash('sha256').update(zip).digest('hex'), bundle.bundleSha256)
  assert.equal(zip.length, bundle.bundleByteLength)
  bundle.cleanup()
  assert.equal(existsSync(bundle.handoffPath), false)
  await assert.rejects(grants.build({}, child.id, req, [file]), /PROVENANCE_REJECTED/)
  await assert.rejects(grants.build(binding, 'wrong-child', req, [file]), /PROVENANCE_REJECTED/)
  grants.unpin(binding)
  assert.equal(existsSync(result.snapshotRoot), false)
  assert.equal(grants.child(child, context, [file]), null)
})

test('actual Bridge job pins exact child and releases binding at child disposal', async () => {
  const f = fixture(), result = privateResult(), child = { id: 'actual-input-child' }
  let finish, releaseFinish, disposed = false
  const completed = new Promise(resolve => { finish = resolve })
  const disposal = new Promise(resolve => { releaseFinish = resolve })
  postmanInputGrants.record(f.agent, f.task, result)
  const contexts = { get: id => id === f.agent.id ? f.task : null,
    bindChild: () => true, releaseChild() {} }
  const ctx = { agents: { get: id => id === f.agent.id ? f.agent : undefined },
    subagents: { async start() { return { id: child.id, localAgent: child, result: completed,
      async dispose() { disposed = true; await disposal } } } },
    tools: { get() { return { async execute() { return { status: 'COMPLETED',
      requestId: 'REQ_20261001T000000Z_0111', result: { assistantText: 'trusted' } } } } } } }
  const jobs = createPostmanBridgeJobs(ctx, { run: (_signal, launch) => launch(), dispose() {} }, null, contexts)
  const bridge = createPostmanBridgeTool(ctx, jobs, contexts)
  const accepted = await bridge.execute({ message: '@PostmanAsk --input-files-json ' + JSON.stringify([file]) + '\nUse file' },
    { agent: f.agent, signal: new AbortController().signal })
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(postmanInputGrants.child(child, f.task, [file]))
  postmanInputGrants.release(f.agent)
  assert.equal(existsSync(result.snapshotRoot), true)
  finish({ stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, true)
  assert.ok(postmanInputGrants.child(child, f.task, [file]))
  releaseFinish()
  await jobs.dispose()
  assert.equal(postmanInputGrants.child(child, f.task, [file]), null)
  assert.equal(existsSync(result.snapshotRoot), false)
})

test('snapshot hash is checked once at build after exact grant admission', async () => {
  const grants = new PostmanInputGrants(), agent = { id: 'mismatch-leader' }, context = {}
  const result = privateResult()
  grants.record(agent, context, result)
  const binding = grants.pin(agent, context, [file]), child = { id: 'mismatch-child' }
  grants.bindChild(binding, agent, context, child)
  writeFileSync(result.materializations[0].snapshot_path, 'WRONG!!!!')
  await assert.rejects(grants.build(binding, child.id, 'REQ_20261001T000000Z_0988', [file]), /MATERIALIZATION_MISMATCH/)
  grants.dispose()
  assert.equal(existsSync(result.snapshotRoot), false)
})

