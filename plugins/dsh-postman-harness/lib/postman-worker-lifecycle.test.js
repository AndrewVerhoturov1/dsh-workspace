import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createPostmanYieldTool } from './postman-bridge.js'
function fixture({ localDevelopment = false } = {}) {
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
          header: { id, origin: 'subagent', parentSession: leader.id, delegationDepth: 1 }, events: [] } });
        return { childId: id, messageId: 'initial' } },
      async followup(...args) { calls.follows.push(args); return 'followup-' + calls.follows.length },
      async listChildren() { return [...agents.keys()].filter(id => id !== leader.id).map(id => ({ id, kind: 'child', mode: 'continuable', activity: agents.has(id) ? 'running' : 'inactive' })) },
      async listDescendants() { return [] },
      async drainContinuableChildren(_parent, ids) { calls.drains.push(ids) },
      async closeContinuableChild(parent, id, verify) {
        if (!await verify()) return false
        await this.drainContinuableChildren(parent, [id])
        return true
      },
    } }
  const tools = createPostmanWorkerTools(ctx, undefined, contexts, { localDevelopment })
  const exec = { agent: leader, signal: new AbortController().signal, callId: 'stop-1' }
  return { registry, leader, agents, calls, tools, ctx, contexts, exec, setApproval: value => { approve = value } }
}
async function start(f) {
  await f.registry.create(f.leader.id, { workers: {} })
  const accepted = await f.tools.taskTool.execute({ task: 'work' }, f.exec)
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  return accepted.workerSessionId
}
test('addressed stop needs no reason or approval and does not certify success', async () => {
  const f = fixture(), id = await start(f)
  f.ctx.get = () => null
  const result = await f.tools.stopTool.execute({ workerSessionId:id }, f.exec)
  assert.equal(result.status,'POSTMAN_WORKER_CANCELLED')
  assert.equal(result.taskCompleted,false)
  assert.deepEqual(f.calls.drains,[[id]])
  assert.deepEqual(f.calls.approvals,[])
})
test('local cancellation needs no unavailable approval, releases only exact child, and never claims success', async () => {
  const f = fixture({ localDevelopment: true }), id = await start(f)
  f.ctx.get = () => null
  f.agents.get(id).status = 'running'
  const result = await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: id }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_CANCELLED')
  assert.equal(result.taskCompleted, false)
  assert.equal(result.resultReported, false)
  assert.equal(result.durableSessionDeleted, false)
  assert.deepEqual(f.calls.drains, [[id]])
  assert.equal(f.registry.get('leader').workers[id], undefined)
  assert.deepEqual(f.calls.approvals, [])
})
test('local close releases idle Worker without certifying missing historical reports', async () => {
  const f = fixture({ localDevelopment: true }), id = await start(f)
  f.agents.get(id).inbox.hasPending = false
  const result = await f.tools.stopTool.execute({ mode: 'close', workerSessionId: id }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_STOPPED')
  assert.equal(result.resultReported, false)
  assert.equal(result.taskCompleted, false)
  assert.equal(f.registry.get('leader').workers[id], undefined)
})
test('local close still rejects running, queued, descendants, wrong caller and unknown target', async () => {
  for (const scenario of ['queued', 'running', 'descendants']) {
    const f = fixture({ localDevelopment: true }), id = await start(f)
    if (scenario !== 'queued') f.agents.get(id).inbox.hasPending = false
    if (scenario === 'running') f.agents.get(id).status = 'running'
    if (scenario === 'descendants') f.ctx.subagents.listDescendants = async () =>
      [{ kind: 'child', mode: 'continuable', activity: 'running' }]
    assert.equal((await f.tools.stopTool.execute({ mode: 'close', workerSessionId: id }, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
    assert.deepEqual(f.calls.drains, [])
  }
  const f = fixture({ localDevelopment: true }), id = await start(f)
  assert.equal((await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: id }, { ...f.exec, agent: { ...f.leader } })).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: 'other' }, f.exec)
  assert.deepEqual(f.calls.drains, [])
})
test('local restore reservation releases idle bindings, not active work', async () => {
  const f = fixture({ localDevelopment: true }), id = await start(f)
  f.contexts.isRestoring = () => true
  f.ctx.subagents.drainContinuableChildren = async (_parent, ids) => { f.calls.drains.push(ids); ids.forEach(id => f.agents.delete(id)) }
  assert.equal(await f.tools.prepareRestore('leader'), false)
  f.agents.get(id).inbox.hasPending = false
  assert.equal(await f.tools.prepareRestore('leader'), true)
  assert.equal(f.registry.get('leader').workers[id], undefined)
  assert.deepEqual(f.calls.drains, [[id]])
})

test('explicit idle close remains guarded; addressed stop accepts active work and rejects foreign ID', async () => {
  const f = fixture(), id = await start(f)
  assert.equal((await f.tools.stopTool.execute({mode:'close'}, f.exec)).status,'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  await f.tools.stopTool.execute({workerSessionId:'other'}, f.exec)
  assert.deepEqual(f.calls.drains,[])
  f.agents.get(id).status = 'running'
  assert.equal((await f.tools.stopTool.execute({workerSessionId:id},f.exec)).status,'POSTMAN_WORKER_CANCELLED')
  assert.deepEqual(f.calls.drains,[[id]])
})
test('approved cancel frees exact Worker, retains Session and never claims task success', async () => {
  const f = fixture(); const id = await start(f); f.setApproval('allowed-once')
  const result = await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: id, reason: 'user request' }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_CANCELLED')
  assert.equal(result.taskCompleted, false)
  assert.equal(result.durableSessionDeleted, false)
  assert.deepEqual(f.calls.drains, [[id]])
  assert.equal(f.registry.get('leader').workers[id], undefined)
})
test('unknown drain outcome keeps binding and blocks replacement', async () => {
  const f = fixture(); const id = await start(f); f.setApproval('allowed-once')
  f.ctx.subagents.drainContinuableChildren = async () => { throw new Error('unknown') }
  const result = await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: id }, f.exec)
  assert.equal(result.status, 'POSTMAN_WORKER_STOP_FAILED')
  assert.equal(result.outcome, 'unknown')
  assert.equal(f.registry.get('leader').workers[id].state, 'uncertain')
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
  child.session.events.push({ type: 'tool/result', data: { turn: 1, message: { source: { kind: 'tool', callId: 'report-call' },
      content: [{ type: 'tool-result', toolCallId: 'report-call', isError: false }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal((await f.tools.stopTool.execute({}, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  f.leader.session.events.push({ type: 'user/message', data: { id: 'native-result', source: { kind: 'subagent-report', senderSessionId: id } } })
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
  child.session.events.push({ type: 'tool/result', data: { turn: 1, message: { source: { kind: 'tool', callId: 'r' },
      content: [{ type: 'tool-result', toolCallId: 'r', isError: false }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  f.leader.session.events.push({ type: 'user/message', data: { id: 'report-id', source: { kind: 'subagent-report', senderSessionId: id } } })
  f.ctx.subagents.listDescendants = async () => { child.status = 'running'; return [] }
  assert.equal((await f.tools.stopTool.execute({}, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.deepEqual(f.calls.drains, [])
  assert.equal(f.registry.get('leader').workers[id].id, id)
})
// Construct a completed, delivered report for stop-level evidence.
async function completed(f, id) {
  const child = f.agents.get(id)
  child.inbox.hasPending = false
  child.session.events.push({ type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'initial' } },
    { type: 'tool/call', data: { turn: 1, callId: 'r', name: 'report', arguments: { output: 'done' } } })
  await f.tools.observeReport({ agent: child, name: 'report', callId: 'r', arguments: { output: 'done' } },
    { value: { messageId: 'report-id' } })
  child.session.events.push({ type: 'tool/result', data: { turn: 1, message: { source: { callId: 'r' },
    content: [{ isError: false }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  f.leader.session.events.push({ type: 'user/message', data: { id: 'report-id',
    source: { kind: 'subagent-report', senderSessionId: id } } })
  return child
}

test('ordinary close accepts a completed read error followed by the actual native report', async () => {
  const f = fixture(), id = await start(f), child = await completed(f, id)
  child.session.events.splice(2, 0,
    { type: 'tool/call', data: { turn: 1, callId: 'bad', name: 'read', arguments: {} } },
    { type: 'tool/result', data: { turn: 1, message: { source: { callId: 'bad' }, content: [{ isError: true }] } } },
    { type: 'tool/call', data: { turn: 1, callId: 'fixed', name: 'read', arguments: {} } },
    { type: 'tool/result', data: { turn: 1, message: { source: { callId: 'fixed' }, content: [{ isError: false }] } } })
  const response = await f.tools.stopTool.execute({ mode: 'close', workerSessionId: id }, f.exec)
  assert.equal(response.status, 'POSTMAN_WORKER_STOPPED')
  assert.equal(response.taskCompleted, false)
  assert.equal(f.registry.get('leader').workers[id], undefined)
})

test('native report before TASK_ACCEPTED remains linked to reserved Worker', async () => {
  const f = fixture()
  await f.registry.create(f.leader.id, { workers: {} })
  f.ctx.subagents.startContinuable = async spec => {
    const child = { id: spec.childId, status: 'idle', inbox: { hasPending: false }, session: {
      header: { id: spec.childId, origin: 'subagent', parentSession: f.leader.id, delegationDepth: 1 },
      events: [{ type: 'tool/call', data: { turn: 1, callId: 'early', name: 'report', arguments: { output: 'early' } } }] } }
    f.agents.set(child.id, child)
    await f.tools.observeReport({ agent: child, name: 'report', callId: 'early', arguments: { output: 'early' } },
      { value: { messageId: 'report-before-return' } })
    return { childId: spec.childId, messageId: 'initial' }
  }
  const accepted = await f.tools.taskTool.execute({ task: 'work' }, f.exec)
  assert.equal(accepted.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.deepEqual(f.registry.get(f.leader.id).workers[accepted.workerSessionId].lifecycle.reports.map(x => x.messageId), ['report-before-return'])
})
test('close with managed descendant refuses before drain and retains mapping', async () => {
  const f = fixture(); const id = await start(f); const child = f.agents.get(id)
  child.inbox.hasPending = false
  child.session.events.push({ type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'initial' } },
    { type: 'tool/call', data: { turn: 1, callId: 'r', name: 'report', arguments: { output: 'done' } } })
  await f.tools.observeReport({ agent: child, name: 'report', callId: 'r', arguments: { output: 'done' } },
    { value: { messageId: 'report-id' } })
  child.session.events.push({ type: 'tool/result', data: { turn: 1, message: { source: { kind: 'tool', callId: 'r' },
      content: [{ type: 'tool-result', toolCallId: 'r', isError: false }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  f.leader.session.events.push({ type: 'user/message', data: { id: 'report-id', source: { kind: 'subagent-report', senderSessionId: id } } })
  f.ctx.subagents.listDescendants = async () => [{ kind: 'child', mode: 'continuable', id: 'nested', activity: 'running' }]
  assert.equal((await f.tools.stopTool.execute({}, f.exec)).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.equal(f.registry.get('leader').workers[id].id, id)
  assert.deepEqual(f.calls.drains, [])
})
test('yield invokes Host concludeTurn only for live Leader without changing Worker mapping', async () => {
  const f = fixture(); const id = await start(f)
  const yieldTool = createPostmanYieldTool(f.ctx)
  let concluded = 0
  assert.equal((await yieldTool.execute({}, { agent: f.leader, concludeTurn: () => concluded++ })).status, 'POSTMAN_YIELDED')
  assert.equal(concluded, 1)
  assert.equal((await yieldTool.execute({}, { agent: f.leader })).status, 'POSTMAN_YIELD_UNSUPPORTED')
  assert.equal(f.registry.get('leader').workers[id].id, id)
  assert.deepEqual(f.calls.drains, [])
})

test('released Agent closes using saved exact Session without another model turn', async () => {
  const f = fixture(), id = await start(f), child = f.agents.get(id)
  child.inbox.hasPending = false
  child.session.events.push({ type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'initial' } },
    { type: 'tool/call', data: { turn: 1, callId: 'r', name: 'report', arguments: '{"output":"done"}' } })
  await f.tools.observeReport({ agent: child, name: 'report', callId: 'r', arguments: { output: 'done' } },
    { value: { messageId: 'delivered' } })
  child.session.events.push({ type: 'tool/result', data: { turn: 1, message: {
    source: { callId: 'r' }, content: [{ isError: false }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  f.leader.session.events.push({ type: 'user/message', data: { id: 'delivered',
    source: { kind: 'subagent-report', senderSessionId: id } } })
  f.agents.delete(id)
  f.ctx.subagents.listChildren = async () => [{ id, kind: 'child', mode: 'continuable', activity: 'inactive' }]
  f.ctx.get = name => name === 'sessionPersistence' ? { inspect: async target => {
    assert.equal(target, id); return { meta: { id, origin: 'subagent',
      parentSession: f.leader.id, delegationDepth: 1 }, events: child.session.events }
  } } : null
  f.ctx.subagents.listDescendants = async () => [{ id: 'historical', kind: 'child',
    mode: 'continuable', activity: 'inactive' }]
  child.session.events.push({ type: 'agent/inbox/spliced', data: { target: 'next-turn',
    start: 0, inserted: [{ id: 'later', role: 'user', content: [{ type: 'text', text: 'followup' }] }] } })
  assert.equal((await f.tools.stopTool.execute({ mode: 'close', workerSessionId: id }, f.exec)).status,
    'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.deepEqual(f.calls.drains, [])
  child.session.events.pop()
  assert.equal((await f.tools.stopTool.execute({ mode: 'close', workerSessionId: id }, f.exec)).status, 'POSTMAN_WORKER_STOPPED')
  assert.deepEqual(f.calls.drains, [[id]])
})
test('restart uncertain and failed drain permit new approved exact cancel only', async () => {
  const f = fixture(), id = await start(f)
  await f.registry.change(f.leader.id, row => ({ ...row, workers: { ...row.workers,
    [id]: { ...row.workers[id], state: 'uncertain', delivery: 'unknown' } } }))
  f.tools.dispose()
  const restarted = (await import('./postman-worker.js')).createPostmanWorkerTools(f.ctx, undefined,
    { get: () => ({ branch: 'task/a', worktree: 'C:/temp' }), record: f.registry.get, changeRecord: f.registry.change })
  f.setApproval('allowed-once')
  f.ctx.subagents.drainContinuableChildren = async () => { throw new Error('unknown drain') }
  assert.equal((await restarted.stopTool.execute({ mode: 'cancel', workerSessionId: id }, f.exec)).status,
    'POSTMAN_WORKER_STOP_FAILED')
  f.ctx.subagents.drainContinuableChildren = async (_leader, ids) => f.calls.drains.push(ids)
  assert.equal((await restarted.stopTool.execute({ mode: 'cancel', workerSessionId: id }, f.exec)).status,
    'POSTMAN_WORKER_CANCELLED')
})

test('independent B assignment does not transfer or invalidate approval of A', async () => {
  const f = fixture(), a = await start(f)
  const b = await f.tools.taskTool.execute({ task: 'independent', createNew: true }, f.exec)
  assert.equal(b.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  f.ctx.get = () => ({ request: async () => {
    await f.tools.interruptTool.execute({ workerSessionId: b.workerSessionId, task: 'B later' }, f.exec)
    return 'allowed-once'
  } })
  assert.equal((await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: a }, f.exec)).status,
    'POSTMAN_WORKER_CANCELLED')
  assert.ok(f.registry.get(f.leader.id).workers[b.workerSessionId])
  assert.deepEqual(f.calls.drains, [[a]])
})
test('late report callback cannot resurrect removed A or mutate B', async () => {
  const f = fixture(), a = await start(f)
  const child = f.agents.get(a)
  const b = await f.tools.taskTool.execute({ task: 'independent', createNew: true }, f.exec)
  f.setApproval('allowed-once')
  child.session.events.push({ type: 'tool/call', data: { turn: 1, callId: 'old', name: 'report' } })
  assert.equal((await f.tools.stopTool.execute({ mode: 'cancel', workerSessionId: a }, f.exec)).status,
    'POSTMAN_WORKER_CANCELLED')
  const before = structuredClone(f.registry.get(f.leader.id).workers[b.workerSessionId])
  await f.tools.observeReport({ agent: child, name: 'report', callId: 'old', arguments: { output: 'late' } },
    { value: { messageId: 'late' } })
  assert.equal(f.registry.get(f.leader.id).workers[a], undefined)
  assert.deepEqual(f.registry.get(f.leader.id).workers[b.workerSessionId], before)
})
