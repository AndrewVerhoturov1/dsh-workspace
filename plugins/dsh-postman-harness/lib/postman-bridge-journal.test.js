import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { openPostmanTaskRegistry, createMemoryTaskRegistry } from './postman-task-registry.js'

const parent = { id: 'leader-bridge', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const row = () => ({ leaderSessionId: parent.id, repository: 'andrewverhoturov1/dsh-workspace',
  repositoryPath: 'C:/repo', originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
  baseCommit: 'a'.repeat(40), branch: 'task/postman-' + 'a'.repeat(32), worktree: 'C:/task',
  stage: 'ready', diagnostic: null, workers: { 'child-C': { id: 'child-C', label: 'C', state: 'ready', delivery: 'none', artifactRequests: [] } },
  runner: { state: 'failed', requestId: 'REQ_FAIL' }, bridge: null })

function fixture(registry) {
  const taskContext = Object.freeze({ branch: registry.get(parent.id).branch })
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false }
  let started = 0
  const ctx = { agents: { get: () => parent }, subagents: { start() { started++; throw new Error('must not launch') } } }
  // Keep every intent pending, modeling an abrupt process exit while QUEUED.
  const coordinator = { run: () => new Promise(() => {}), dispose() {} }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts)
  return { contexts, jobs, get started() { return started } }
}

async function exercise(registry) {
  const first = fixture(registry)
  const accepted = await Promise.all([0, 1, 2].map(i => first.jobs.accept(parent, '@PostmanAsk text ' + i, 'text')))
  assert.deepEqual(accepted.map(x => x.status), Array(3).fill('POSTMAN_BRIDGE_ACCEPTED'))
  assert.equal(new Set(accepted.map(x => x.bridgeJobId)).size, 3)
  assert.deepEqual(Object.keys(registry.get(parent.id).bridgeOperations), accepted.map(x => x.bridgeJobId))
  assert.equal((await first.jobs.accept(parent, '@PostmanAsk fourth', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  const cold = fixture(registry)
  for (const job of accepted) {
    assert.equal(cold.jobs.status(parent, job.bridgeJobId).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  }
  assert.equal(cold.started, 0, 'no queued operation is replayed')
  assert.equal((await cold.jobs.accept(parent, '@PostmanAsk fourth', 'text')).status,
    'POSTMAN_BRIDGE_LIMIT_REACHED', 'unresolved jobs continue to count after restart')
  assert.equal(Object.values(registry.get(parent.id).workers)[0].id, 'child-C')
  assert.equal(registry.get(parent.id).runner.state, 'failed')
  return { accepted, cold }
}

test('three distinct durable Bridge intents survive runtime restart without replay', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, row())
  await exercise(registry)
})

test('three Bridge intents survive independent JSON domain lifetimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-bridge-journal-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  const domain = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const first = await openPostmanTaskRegistry(domain)
  await first.create(parent.id, row())
  const { accepted } = await exercise(first)
  await first.close()
  const reopened = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  const cold = fixture(reopened)
  assert.deepEqual(accepted.map(job => cold.jobs.status(parent, job.bridgeJobId).status),
    Array(3).fill('POSTMAN_BRIDGE_OUTCOME_UNKNOWN'))
  assert.equal(cold.started, 0)
  assert.equal(Object.values(reopened.get(parent.id).workers)[0].id, 'child-C')
  await reopened.close()
  await backend.close()
})

const tick = () => new Promise(resolve => setImmediate(resolve))
test('three same-Leader jobs run independently, fourth waits for a settled slot', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, row())
  const taskContext = Object.freeze({ branch: registry.get(parent.id).branch })
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false,
    beginSync: () => true, endSync() {}, bindChild: () => true, releaseChild() {}, async sync() { return true } }
  const completions = []
  let starts = 0
  const ctx = { agents: { get: () => parent }, subagents: { async start() {
    const id = 'child-' + ++starts
    let finish
    const result = new Promise(resolve => { finish = resolve })
    completions.push(finish)
    return { id, localAgent: { id }, result, async dispose() {} }
  } }, tools: { get: () => ({ async execute(_args, exec) {
    const id = exec.agent.id
    return { status: 'COMPLETED', requestId: id, result: { requestId: id, ok: true, code: 'TEXT_RESULT_DURABLE' } }
  } }) } }
  parent.followup = () => {}
  const coordinator = { run: (_signal, launch) => launch(), dispose() {} }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts)
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(i => jobs.accept(parent, '@PostmanAsk ' + i, 'text')))
  await tick()
  assert.deepEqual([a.status, b.status, c.status], Array(3).fill('POSTMAN_BRIDGE_ACCEPTED'))
  assert.equal(starts, 3)
  assert.equal(new Set([a, b, c].map(x => x.bridgeJobId)).size, 3)
  assert.deepEqual([a, b, c].map(x => jobs.status(parent, x.bridgeJobId).status),
    Array(3).fill('POSTMAN_BRIDGE_RUNNING'))
  assert.equal((await jobs.accept(parent, '@PostmanAsk D', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  completions[1]({ stopReason: 'end_turn' })
  await tick(); await tick(); await tick()
  assert.equal(jobs.status(parent, b.bridgeJobId).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(registry.get(parent.id).bridgeOperations[b.bridgeJobId], undefined)
  assert.equal(jobs.status(parent, a.bridgeJobId).status, 'POSTMAN_BRIDGE_RUNNING')
  const d = await jobs.accept(parent, '@PostmanAsk D', 'text')
  assert.equal(d.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await tick()
  assert.equal(starts, 4)
  completions[0]({ stopReason: 'end_turn' }); completions[2]({ stopReason: 'end_turn' }); completions[3]({ stopReason: 'end_turn' })
  await tick(); await tick(); await tick()
  assert.deepEqual([a, c, d].map(x => jobs.status(parent, x.bridgeJobId).status),
    Array(3).fill('POSTMAN_BRIDGE_TERMINAL'))
  assert.deepEqual(registry.get(parent.id).bridgeOperations, {})
  await jobs.dispose()
})

test('one interrupted job does not block an independent new Bridge', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...row(), bridgeOperations: { oldA: { state: 'unknown' } } })
  const f = fixture(registry)
  const accepted = await f.jobs.accept(parent, '@PostmanAsk new B', 'text')
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(f.jobs.status(parent, 'oldA').status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal(f.jobs.status(parent, accepted.bridgeJobId).status, 'POSTMAN_BRIDGE_QUEUED')
  assert.equal(registry.get(parent.id).bridgeOperations.oldA.state, 'unknown')
  assert.equal(registry.get(parent.id).bridgeOperations[accepted.bridgeJobId].state, 'pending')
  assert.equal(f.started, 0)
})

test('backend refusal cannot create or launch an unjournaled Bridge', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, row())
  const f = fixture({ get: registry.get, async change() { throw Error('disk unavailable') } })
  const result = await f.jobs.accept(parent, '@PostmanAsk unsafe', 'text')
  assert.equal(result.status, 'POSTMAN_BRIDGE_ADMISSION_FAILED')
  assert.match(result.diagnostic, /disk unavailable/)
  assert.equal(f.started, 0)
  assert.equal(registry.get(parent.id).bridgeOperations, undefined)
})
