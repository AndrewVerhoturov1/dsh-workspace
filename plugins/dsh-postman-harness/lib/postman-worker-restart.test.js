import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createPostmanWorkerTools } from './postman-worker.js'
import { IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import { createMemoryTaskRegistry, openPostmanTaskRegistry } from './postman-task-registry.js'

const signal = new AbortController().signal
const leader = { id: 'leader-restart', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const context = Object.freeze({ leaderSessionId: leader.id, repository: 'andrewverhoturov1/dsh-workspace',
  branch: 'task/postman-' + 'a'.repeat(32), worktree: 'C:/task', baseCommit: 'a'.repeat(40) })

async function fixture(parent = leader) {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...context, leaderSessionId: parent.id, repositoryPath: 'C:/repo', originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    stage: 'ready', diagnostic: null, worker: null, runner: { state: 'none', requestId: null }, bridge: null })
  const taskContext = Object.freeze({ ...context, leaderSessionId: parent.id })
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false }
  const calls = { starts: [], followups: [], children: new Set() }
  const ctx = { agents: { get: id => id === parent.id ? parent : undefined },
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

const task = (worker, text = 'new task', parent = leader) => worker.taskTool.execute({ task: text }, { agent: parent, signal })

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

test('pilot supervisor reuses exact durable Worker binding after runtime restart', async () => {
  const pilot = { id: 'pilot-restart', session: { header: { agentPreset: 'postman-leader-ptc', delegationDepth: 0 } } }
  const f = await fixture(pilot)
  const before = f.tool()
  const first = await task(before, 'pilot initial', pilot)
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(first.created, true)
  assert.equal(f.calls.starts[0].request.parent, pilot)
  assert.equal(first.workerSessionId, f.registry.get(pilot.id).worker.id)
  before.dispose()
  const restarted = f.tool()
  const next = await task(restarted, 'pilot follow-up', pilot)
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.deepEqual(f.calls.followups, [first.workerSessionId])
  assert.equal(f.calls.starts.length, 1)
  restarted.dispose()
})

test('pilot Worker binding survives reopening the JSON storage domain', async t => {
  const pilot = { id: 'pilot-json', session: { header: { agentPreset: 'postman-leader-ptc', delegationDepth: 0 } } }
  const root = await mkdtemp(join(tmpdir(), 'postman-pilot-worker-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const domainCtx = { storage: { backend: { get: () => backend } }, emit() {} }
  const domain = () => new DomainFacility(domainCtx, { backend: 'json', routes: {} })
  const firstRegistry = await openPostmanTaskRegistry(domain())
  const pilotContext = Object.freeze({ ...context, leaderSessionId: pilot.id })
  await firstRegistry.create(pilot.id, { ...pilotContext,
    repositoryPath: 'C:/repo', originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    stage: 'ready', diagnostic: null, worker: null, runner: { state: 'none', requestId: null }, bridge: null })
  const f = await fixture(pilot)
  const contexts = registry => ({ get: () => pilotContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false })
  const before = createPostmanWorkerTools(f.ctx, undefined, contexts(firstRegistry))
  const first = await task(before, 'pilot initial', pilot)
  assert.equal(first.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(first.workerSessionId, firstRegistry.get(pilot.id).worker.id)
  before.dispose()
  await firstRegistry.close()
  const secondRegistry = await openPostmanTaskRegistry(domain())
  const restarted = createPostmanWorkerTools(f.ctx, undefined, contexts(secondRegistry))
  const next = await task(restarted, 'pilot follow-up', pilot)
  assert.equal(next.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  assert.equal(next.created, false)
  assert.equal(next.workerSessionId, first.workerSessionId)
  assert.equal(secondRegistry.get(pilot.id).worker.id, first.workerSessionId)
  assert.equal(f.calls.starts.length, 1)
  assert.deepEqual(f.calls.followups, [first.workerSessionId])
  restarted.dispose()
  await secondRegistry.close()
  await backend.close()
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
