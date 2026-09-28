import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanWorkerTools } from './postman-worker.js'
import { IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'

const signal = new AbortController().signal
const leader = { id: 'leader-restart', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const context = Object.freeze({ leaderSessionId: leader.id, repository: 'andrewverhoturov1/dsh-workspace',
  branch: 'task/postman-' + 'a'.repeat(32), worktree: 'C:/task', baseCommit: 'a'.repeat(40) })

async function fixture() {
  const registry = createMemoryTaskRegistry()
  await registry.create(leader.id, { ...context, repositoryPath: 'C:/repo', originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    stage: 'ready', diagnostic: null, worker: null, runner: { state: 'none', requestId: null }, bridge: null })
  const contexts = { get: () => context, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false }
  const calls = { starts: [], followups: [], children: new Set() }
  const ctx = { agents: { get: id => id === leader.id ? leader : undefined },
    tools: { schemas: () => [{ name: 'postman_bridge' }, { name: 'postman_send_current_turn' }] },
    subagents: {
      async listChildren() { return [...calls.children].map(id => ({ kind: 'child', mode: 'continuable', id })) },
      async startContinuable(spec) { calls.starts.push(spec); calls.children.add(spec.childId)
        return { childId: spec.childId, messageId: 'initial' } },
      async followup(_parent, id) { calls.followups.push(id); return 'followup-' + calls.followups.length },
      async drainContinuableChildren() {},
    },
  }
  return { contexts, registry, calls, ctx, tool: () => createPostmanWorkerTools(ctx, undefined, contexts) }
}

const task = (worker, text = 'new task') => worker.taskTool.execute({ task: text }, { agent: leader, signal })

test('reserved exact Worker id survives a new runtime without duplicate creation', async () => {
  const f = await fixture()
  const a = f.tool()
  const first = await task(a, 'first')
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(first.workerSessionId, f.calls.starts[0].childId)
  assert.equal(f.registry.get(leader.id).worker.id, first.workerSessionId)
  a.dispose()
  const b = f.tool()
  const next = await task(b)
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
  assert.deepEqual(f.calls.followups, [first.workerSessionId])
})

test('new trusted artifact REQ follows up existing Worker and persists authorization', async () => {
  const f = await fixture()
  const requestId = 'REQ_20260925T112233Z_5678'
  const grants = { async resolve(id, request) {
    assert.equal(id, leader.id)
    assert.equal(request, requestId)
    return { repository: IMPLEMENTATION_REPOSITORY, requestId }
  } }
  const worker = createPostmanWorkerTools(f.ctx, grants, f.contexts)
  const first = await task(worker, 'ordinary')
  const next = await worker.taskTool.execute({ task: 'apply artifact', artifactRequestId: requestId }, { agent: leader, signal })
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
  assert.deepEqual(f.calls.followups, [first.workerSessionId])
  assert.deepEqual(f.registry.get(leader.id).worker.artifactRequests, [requestId])
})

test('crash between child acceptance and ready write never creates a second Worker', async () => {
  const f = await fixture()
  const a = f.tool()
  const first = await task(a)
  await f.registry.change(leader.id, row => ({ ...row, worker: { ...row.worker, state: 'intent', delivery: 'pending' } }))
  a.dispose()
  const b = f.tool()
  const next = await task(b)
  assert.equal(next.status, 'POSTMAN_WORKER_DELIVERY_UNKNOWN')
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.equal(f.registry.get(leader.id).worker.state, 'ready')
  assert.equal(f.calls.starts.length, 1)
  assert.equal(f.calls.followups.length, 0)
})

test('missing reserved child fails closed without guessing by label', async () => {
  const f = await fixture()
  await f.registry.change(leader.id, row => ({ ...row, worker: { id: 'reserved-id', state: 'intent',
    delivery: 'pending', artifactRequests: [] } }))
  f.calls.children.add('another-child')
  const result = await task(f.tool())
  assert.equal(result.status, 'POSTMAN_WORKER_BINDING_UNCERTAIN')
  assert.equal(f.calls.starts.length, 0)
})

test('followup uncertainty is persisted before delivery and cannot replay', async () => {
  const f = await fixture()
  const a = f.tool()
  const first = await task(a)
  f.ctx.subagents.followup = async () => { throw new Error('inbox uncertain') }
  assert.equal((await task(a)).status, 'POSTMAN_WORKER_FOLLOWUP_FAILED')
  assert.equal(f.registry.get(leader.id).worker.delivery, 'unknown')
  a.dispose()
  assert.equal((await task(f.tool())).status, 'POSTMAN_WORKER_DELIVERY_UNKNOWN')
  assert.equal(f.calls.starts.length, 1)
  assert.equal(f.calls.followups.length, 0)
  assert.equal(first.workerSessionId, f.registry.get(leader.id).worker.id)
})
