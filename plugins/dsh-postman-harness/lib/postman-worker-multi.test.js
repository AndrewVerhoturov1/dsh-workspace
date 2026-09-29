import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'

const leader = { id: 'multi-leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const signal = new AbortController().signal
const run = (tool, args) => tool.execute(args, { agent: leader, signal })
const task = (tools, args = {}) => run(tools.taskTool, { task: 'bounded task', ...args })
const notice = id => ({ id, session: { header: { origin: 'subagent', delegationDepth: 1, parentSession: leader.id } } })
async function fixture({ start = null, followup = null, changeRecord = null, drain = null } = {}) {
  const registry = createMemoryTaskRegistry()
  await registry.create(leader.id, { stage: 'ready', workers: {}, runner: { state: 'none' }, bridgeOperations: { job: { state: 'pending' } } })
  const context = Object.freeze({ branch: 'task/postman-test', worktree: 'C:/task' })
  const children = new Set()
  const agents = new Map([[leader.id, leader]])
  const calls = { starts: [], followups: [], drains: [] }
  const ctx = { agents: { get: id => agents.get(id) }, tools: { schemas: () => [{ name: 'postman_bridge' }, { name: 'postman_worker_list' }] },
    subagents: {
      async listChildren() { return [...children].map(id => ({ id, kind: 'child', mode: 'continuable',
        activity: agents.has(id) ? 'running' : 'inactive' })) },
      async startContinuable(spec) { calls.starts.push(spec); if (start) await start(spec); children.add(spec.childId); return { childId: spec.childId, messageId: 'initial-' + calls.starts.length } },
      async followup(parent, id, content) { calls.followups.push({ parent, id, content }); if (followup) await followup(id); return 'followup-' + calls.followups.length },
      async drainContinuableChildren(parent, ids) { calls.drains.push({ parent, ids }); if (drain) await drain(ids[0]); children.delete(ids[0]) },
    },
  }
  const contexts = { get: () => context, record: registry.get, changeRecord: changeRecord ?? registry.change,
    isRestoring: () => false, hasActiveOperation: () => false }
  const tools = createPostmanWorkerTools(ctx, undefined, contexts)
  return { tools, calls, registry, ctx, agents, children, contexts }
}

test('three independent reservations run without waiting for model completion; fourth rejects before start', async () => {
  const f = await fixture()
  const result = await Promise.all(['A', 'B', 'C', 'D'].map(label => task(f.tools, { createNew: true, label })))
  assert.deepEqual(result.map(x => x.status), [
    'POSTMAN_WORKER_TASK_ACCEPTED', 'POSTMAN_WORKER_TASK_ACCEPTED',
    'POSTMAN_WORKER_TASK_ACCEPTED', 'POSTMAN_WORKER_LIMIT_REACHED'])
  assert.equal(new Set(result.slice(0, 3).map(x => x.workerSessionId)).size, 3)
  assert.equal(f.calls.starts.length, 3)
  assert.equal(Object.keys(f.registry.get(leader.id).workers).length, 3)
  assert.equal(f.registry.get(leader.id).bridgeOperations.job.state, 'pending')
  assert.deepEqual((await run(f.tools.listTool, {})).workers.map(x => x.execution), ['unknown', 'unknown', 'unknown'])
  assert.equal((await task(f.tools)).status, 'POSTMAN_WORKER_TARGET_REQUIRED')
  assert.equal((await run(f.tools.interruptTool, { task: 'next' })).status, 'POSTMAN_WORKER_TARGET_REQUIRED')
  assert.equal((await run(f.tools.stopTool, {})).status, 'POSTMAN_WORKER_TARGET_REQUIRED')
})

test('pending start reserves a slot, other starts progress and do not exceed three', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture({ start: spec => spec.label === 'A' ? gate : undefined })
  const a = task(f.tools, { createNew: true, label: 'A' })
  const others = await Promise.all(['B', 'C', 'D'].map(label => task(f.tools, { createNew: true, label })))
  assert.equal(others[0].created, true)
  assert.equal(others[1].created, true)
  assert.equal(others[2].status, 'POSTMAN_WORKER_LIMIT_REACHED')
  assert.equal(f.registry.get(leader.id).workers[f.calls.starts[0].childId].state, 'intent')
  release()
  assert.equal((await a).status, 'POSTMAN_WORKER_TASK_ACCEPTED')
})

test('addressed followups and stop leave peers untouched; repeated stop cannot select replacement', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let aId
  const f = await fixture({ followup: id => id === aId ? gate : undefined })
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(label => task(f.tools, { createNew: true, label })))
  aId = a.workerSessionId
  const blockedA = run(f.tools.interruptTool, { workerSessionId: a.workerSessionId, task: 'A next' })
  const nextB = await run(f.tools.interruptTool, { workerSessionId: b.workerSessionId, task: 'B next' })
  assert.equal(nextB.workerSessionId, b.workerSessionId)
  const stopped = await run(f.tools.stopTool, { workerSessionId: b.workerSessionId })
  assert.equal(stopped.status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.deepEqual(f.calls.drains.map(x => x.ids), [])
  assert.equal((await run(f.tools.stopTool, { workerSessionId: b.workerSessionId })).status, 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.equal((await task(f.tools, { createNew: true, label: 'D' })).status, 'POSTMAN_WORKER_LIMIT_REACHED')
  assert.equal((await run(f.tools.interruptTool, { workerSessionId: b.workerSessionId, task: 'still mapped' })).status, 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED')
  assert.equal((await task(f.tools, { createNew: true })).status, 'POSTMAN_WORKER_LIMIT_REACHED')
  release()
  assert.equal((await blockedA).workerSessionId, a.workerSessionId)
  assert.equal(f.registry.get(leader.id).workers[c.workerSessionId].state, 'ready')
})

test('a trusted REQ belongs only to selected exact live child and disappears at restart', async () => {
  const f = await fixture()
  const requestId = 'REQ_20260925T112233Z_5678'
  const grants = { resolve: async () => ({ repository: 'AndrewVerhoturov1/dsh-workspace', requestId }) }
  const worker = createPostmanWorkerTools(f.ctx, grants, f.contexts)
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(label => task(worker, { createNew: true, label })))
  const childA = notice(a.workerSessionId), childB = notice(b.workerSessionId), childC = notice(c.workerSessionId)
  for (const agent of [childA, childB, childC]) f.agents.set(agent.id, agent)
  assert.equal((await task(worker, { workerSessionId: a.workerSessionId, artifactRequestId: requestId })).created, false)
  assert.equal(worker.ownerOf(childA, requestId), leader.id)
  assert.equal(worker.ownerOf(childB, requestId), null)
  assert.equal(worker.ownerOf(childC, requestId), null)
  assert.equal(worker.ownsNotification(childB, leader.id), true)
  assert.equal(worker.ownsNotification(notice('stranger'), leader.id), false)
  worker.dispose()
  const restarted = createPostmanWorkerTools(f.ctx, grants, f.contexts)
  assert.equal(restarted.ownerOf(childA, requestId), null)
  assert.equal((await run(restarted.interruptTool, { workerSessionId: c.workerSessionId, task: 'continue' })).status, 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED')
  assert.equal(restarted.ownerOf(childA, requestId), null)
})

test('unknown exact and conflicting create arguments never redirect or create', async () => {
  const f = await fixture()
  const first = await task(f.tools)
  assert.equal((await task(f.tools, { createNew: true, workerSessionId: first.workerSessionId })).status, 'POSTMAN_WORKER_ARGUMENTS_INVALID')
  assert.equal((await task(f.tools, { workerSessionId: 'foreign' })).status, 'POSTMAN_WORKER_TARGET_UNKNOWN')
  assert.equal((await run(f.tools.interruptTool, { workerSessionId: 'foreign', task: 'x' })).status, 'POSTMAN_WORKER_TARGET_UNKNOWN')
  assert.equal((await task(f.tools)).workerSessionId, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
})

test('inactive peers keep exact session IDs through shared-operation pause', async () => {
  const f = await fixture()
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(label => task(f.tools, { createNew: true, label })))
  assert.equal(await f.tools.pauseForOperation(leader.id, a.workerSessionId), true)
  assert.deepEqual((await run(f.tools.listTool, {})).workers.map(x => x.workerSessionId),
    [a.workerSessionId, b.workerSessionId, c.workerSessionId])
  assert.equal((await task(f.tools, { workerSessionId: b.workerSessionId })).status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(await f.tools.prepareRestore(leader.id), true)
  assert.equal((await task(f.tools, { workerSessionId: c.workerSessionId })).status, 'POSTMAN_WORKER_TASK_ACCEPTED')
})

test('removed binding is not proof that a live orphan stopped mutating files', async () => {
  const f = await fixture()
  f.children.add('orphan')
  f.agents.set('orphan', { id: 'orphan' })
  assert.equal(await f.tools.prepareRestore(leader.id), false)
  f.agents.delete('orphan')
  assert.equal(await f.tools.prepareRestore(leader.id), true)
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('special inherited and missing Worker IDs never create hidden slots or grants', async () => {
  const f = await fixture()
  const real = await task(f.tools, { createNew: true })
  const before = f.calls.followups.length
  for (const id of ['__proto__', 'constructor', 'toString', 'missing']) {
    assert.equal((await run(f.tools.interruptTool, { workerSessionId: id, task: 'wrong' })).status,
      'POSTMAN_WORKER_TARGET_UNKNOWN')
    assert.equal((await run(f.tools.stopTool, { workerSessionId: id })).status,
      'POSTMAN_WORKER_TARGET_UNKNOWN')
  }
  assert.equal(f.calls.followups.length, before)
  assert.equal((await run(f.tools.stopTool, { workerSessionId: real.workerSessionId })).status,
    'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT')
  assert.deepEqual((await run(f.tools.listTool, {})).workers.map(x => x.workerSessionId), [real.workerSessionId])
  assert.equal(await f.tools.prepareRestore(leader.id), true)
})

test('late start after disposal or Leader replacement never reports acceptance', async () => {
  for (const change of ['dispose', 'missing', 'replace']) {
    const gate = deferred(), entered = deferred()
    const f = await fixture({ start: async () => { entered.resolve(); await gate.promise } })
    const launching = task(f.tools, { createNew: true })
    await entered.promise
    if (change === 'dispose') f.tools.dispose()
    else if (change === 'missing') f.agents.delete(leader.id)
    else f.agents.set(leader.id, { ...leader })
    gate.resolve()
    const result = await launching
    assert.notEqual(result.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
    assert.equal(f.registry.get(leader.id).workers[result.workerSessionId].state, 'uncertain')
    assert.deepEqual(f.calls.drains.map(x => x.ids), [[result.workerSessionId]])
    assert.equal((await task(f.tools, { createNew: true })).status, 'POSTMAN_WORKER_CALLER_REJECTED')
  }
})


test('late start cannot revive replaced exact binding or touch peer binding', async () => {
  const gate = deferred(), entered = deferred()
  const f = await fixture({ start: async spec => {
    if (spec.label === 'A') { entered.resolve(); await gate.promise }
  } })
  const a = task(f.tools, { createNew: true, label: 'A' })
  await entered.promise
  const b = await task(f.tools, { createNew: true, label: 'B' })
  const originalId = Object.keys(f.registry.get(leader.id).workers).find(id => id !== b.workerSessionId)
  await f.registry.change(leader.id, row => ({ ...row, workers: { ...row.workers,
    [originalId]: { ...row.workers[originalId], label: 'replacement' } } }))
  gate.resolve()
  assert.equal((await a).status, 'POSTMAN_WORKER_BINDING_UNCERTAIN')
  assert.equal(f.registry.get(leader.id).workers[originalId].label, 'replacement')
  assert.equal(f.registry.get(leader.id).workers[b.workerSessionId].state, 'ready')
  assert.deepEqual(f.calls.drains.map(x => x.ids), [[originalId]])
})

test('failed late-child release leaves uncertain binding counted against three slots', async () => {
  const gate = deferred(), entered = deferred()
  const f = await fixture({ start: async spec => {
    if (spec.label === 'A') { entered.resolve(); await gate.promise }
  }, drain: () => { throw Error('release refused') } })
  const a = task(f.tools, { createNew: true, label: 'A' })
  await entered.promise
  const [b, c] = await Promise.all(['B', 'C'].map(label => task(f.tools, { createNew: true, label })))
  // The exact Leader is swapped during A, then restored only for querying limits.
  f.agents.set(leader.id, { ...leader })
  gate.resolve()
  assert.equal((await a).status, 'POSTMAN_WORKER_BINDING_UNCERTAIN')
  f.agents.set(leader.id, leader)
  assert.equal((await task(f.tools, { createNew: true })).status, 'POSTMAN_WORKER_LIMIT_REACHED')
  assert.equal(f.registry.get(leader.id).workers[b.workerSessionId].state, 'ready')
  assert.equal(f.registry.get(leader.id).workers[c.workerSessionId].state, 'ready')
})


