import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createPostmanYieldTool } from './postman-bridge.js'
function fixture() {
  const registry = createMemoryTaskRegistry()
  const leader = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 }, events: [] } }
  const agents = new Map([[leader.id, leader]])
  const calls = { drains: [], starts: [], follows: [], approvals: [] }
  const context = { branch: 'task/a', worktree: 'C:/temp' }
  const contexts = { get: () => context, record: registry.get,
    changeRecord: registry.change }
  let approve = 'unavailable'
  const ctx = { agents: { get: id => agents.get(id) },
    tools: { schemas: () => ['postman_worker','postman_worker_interrupt','postman_worker_stop','report'].map(name => ({name})) },
    get: name => name === 'approval' ? { request: async request => { calls.approvals.push(request); return approve } } : null,
    subagents: {
      async startContinuable(spec) { calls.starts.push(spec); const id = spec.childId;
        agents.set(id, { id, status: 'idle', inbox: { hasPending: true }, session: {
          header: { origin: 'subagent', parentSession: leader.id, delegationDepth: 1 }, events: [] } });
        return { childId: id, messageId: 'initial' } },
      async followup(...args) { calls.follows.push(args); return 'followup-' + calls.follows.length },
      async listChildren() { return [...agents.keys()].filter(id => id !== leader.id).map(id => ({ id, kind: 'child', mode: 'continuable' })) },
      async listDescendants() { return [] },
      async drainContinuableChildren(_parent, ids) { calls.drains.push(ids) },
    } }
  const tools = createPostmanWorkerTools(ctx, undefined, contexts)
  const exec = { agent: leader, signal: new AbortController().signal, callId: 'stop-1' }
  return { registry, leader, agents, calls, tools, ctx, exec, setApproval: value => { approve = value } }
}
async function start(f) {
  await f.registry.create(f.leader.id, { worker: null })
  const accepted = await f.tools.taskTool.execute({ task: 'work' }, f.exec)
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  return accepted.workerSessionId
}
test('accepted but idle Worker cannot close, nor can forged cancel reason/force/flag', async () => {
  const f = fixture(); const id = await start(f)
  assert.equal((await f.tools.stopTool.execute({}, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  for (const args of [{ mode: 'cancel', workerSessionId: id, reason: 'user_cancel', force: true },
    { mode: 'cancel', workerSessionId: 'other', reason: 'emergency' }])
    assert.equal((await f.tools.stopTool.execute(args, f.exec)).status, 'POSTMAN_WORKER_CANCEL_APPROVAL_REQUIRED')
  assert.deepEqual(f.calls.drains, [])
  assert.equal(f.registry.get('leader').worker.id, id)
})
test('approval applies to exact snapshot, not a later followup', async () => {
  const f = fixture(); const id = await start(f)
  f.setApproval('allowed-once')
  f.ctx.get = () => ({ request: async () => { await f.tools.interruptTool.execute({ task: 'later' }, f.exec); return 'allowed-once' } })
  const result = await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: id }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_CANCEL_APPROVAL_REQUIRED')
  assert.deepEqual(f.calls.drains, [])
})
test('approved cancel frees exact Worker, retains Session and never claims task success', async () => {
  const f = fixture(); const id = await start(f); f.setApproval('allowed-once')
  const result = await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: id, reason: 'user request' }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_CANCELLED')
  assert.equal(result.taskCompleted, false)
  assert.equal(result.durableSessionDeleted, false)
  assert.deepEqual(f.calls.drains, [[id]])
  assert.equal(f.registry.get('leader').worker, null)
})
test('unknown drain outcome keeps binding and blocks replacement', async () => {
  const f = fixture(); const id = await start(f); f.setApproval('allowed-once')
  f.ctx.subagents.drainContinuableChildren = async () => { throw new Error('unknown') }
  const result = await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: id }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_STOP_FAILED')
  assert.equal(result.outcome, 'unknown')
  assert.equal(f.registry.get('leader').worker.state, 'uncertain')
  assert.notEqual((await f.tools.taskTool.execute({ task: 'next' }, f.exec)).status, 'POSTMAN_WORKER_TASK_ACCEPTED')
})
test('completed native report included in Leader context permits close, but stale report does not', async () => {
  const f = fixture(); const id = await start(f); const child = f.agents.get(id)
  child.inbox.hasPending = false
  child.session.events.push({ type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'initial' } },
    { type: 'tool/call', data: { turn: 1, callId: 'report-call', name: 'report', arguments: { output: 'result' } } })
  await f.tools.observeReport({ agent: child, name: 'report', callId: 'report-call', arguments: { output: 'result' } },
    { value: { messageId: 'native-result' } })
  child.session.events.push({ type: 'tool/result', data: { turn: 1, message: { callId: 'report-call', isError: false } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal((await f.tools.stopTool.execute({}, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  f.leader.session.events.push({ type: 'user/message', data: { id: 'native-result' } })
  const result = await f.tools.stopTool.execute({}, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_STOPPED')
  assert.equal(result.taskCompleted, false)
  assert.equal(result.resultReported, true)
  assert.deepEqual(f.calls.drains, [[id]])
})
test('close rechecks Worker when new work arrives during descendant inspection', async () => {
  const f = fixture(); const id = await start(f); const child = f.agents.get(id)
  child.inbox.hasPending = false
  child.session.events.push({ type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'initial' } },
    { type: 'tool/call', data: { turn: 1, callId: 'r', name: 'report', arguments: { output: 'done' } } })
  await f.tools.observeReport({ agent: child, name: 'report', callId: 'r', arguments: { output: 'done' } },
    { value: { messageId: 'report-id' } })
  child.session.events.push({ type: 'tool/result', data: { turn: 1, message: { callId: 'r' } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  f.leader.session.events.push({ type: 'user/message', data: { id: 'report-id' } })
  f.ctx.subagents.listDescendants = async () => { child.status = 'running'; return [] }
  assert.equal((await f.tools.stopTool.execute({}, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.deepEqual(f.calls.drains, [])
  assert.equal(f.registry.get('leader').worker.id, id)
})
test('native report before TASK_ACCEPTED remains linked to reserved Worker', async () => {
  const f = fixture()
  await f.registry.create(f.leader.id, { worker: null })
  f.ctx.subagents.startContinuable = async spec => {
    const child = { id: spec.childId, status: 'idle', inbox: { hasPending: false }, session: {
      header: { origin: 'subagent', parentSession: f.leader.id, delegationDepth: 1 },
      events: [{ type: 'tool/call', data: { turn: 1, callId: 'early', name: 'report', arguments: { output: 'early' } } }] } }
    f.agents.set(child.id, child)
    await f.tools.observeReport({ agent: child, name: 'report', callId: 'early', arguments: { output: 'early' } },
      { value: { messageId: 'report-before-return' } })
    return { childId: spec.childId, messageId: 'initial' }
  }
  const accepted = await f.tools.taskTool.execute({ task: 'work' }, f.exec)
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.deepEqual(f.registry.get(f.leader.id).worker.lifecycle.reports.map(x => x.messageId), ['report-before-return'])
})
test('close with managed descendant refuses before drain and retains mapping', async () => {
  const f = fixture(); const id = await start(f); const child = f.agents.get(id)
  child.inbox.hasPending = false
  child.session.events.push({ type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'initial' } },
    { type: 'tool/call', data: { turn: 1, callId: 'r', name: 'report', arguments: { output: 'done' } } })
  await f.tools.observeReport({ agent: child, name: 'report', callId: 'r', arguments: { output: 'done' } },
    { value: { messageId: 'report-id' } })
  child.session.events.push({ type: 'tool/result', data: { turn: 1, message: { callId: 'r' } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  f.leader.session.events.push({ type: 'user/message', data: { id: 'report-id' } })
  f.ctx.subagents.listDescendants = async () => [{ kind: 'child', id: 'nested', activity: 'inactive' }]
  assert.equal((await f.tools.stopTool.execute({}, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.equal(f.registry.get('leader').worker.id, id)
  assert.deepEqual(f.calls.drains, [])
})
test('yield invokes Host concludeTurn only for live Leader without changing Worker mapping', async () => {
  const f = fixture(); const id = await start(f)
  const yieldTool = createPostmanYieldTool(f.ctx)
  let concluded = 0
  assert.equal((await yieldTool.execute({}, { agent: f.leader, concludeTurn: () => concluded++ })).status, 'POSTMAN_YIELDED')
  assert.equal(concluded, 1)
  assert.equal((await yieldTool.execute({}, { agent: f.leader })).status, 'POSTMAN_YIELD_UNSUPPORTED')
  assert.equal(f.registry.get('leader').worker.id, id)
  assert.deepEqual(f.calls.drains, [])
})
