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
    assert.equal((await cold.jobs.status(parent, job.bridgeJobId)).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
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
  assert.deepEqual(await Promise.all(accepted.map(async job => (await cold.jobs.status(parent, job.bridgeJobId)).status)),
    Array(3).fill('POSTMAN_BRIDGE_OUTCOME_UNKNOWN'))
  assert.equal(cold.started, 0)
  assert.equal(Object.values(reopened.get(parent.id).workers)[0].id, 'child-C')
  await reopened.close()
  await backend.close()
})


test('verified terminal persists through independent JSON-domain lifetimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-terminal-journal-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  const first = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json', routes: {} }))
  await first.create(parent.id, row())
  const result = { ok: true, code: 'TEXT_RESULT_DURABLE', assistantText: 'persisted',
    taskPublicationCommit: 'b'.repeat(40), baseCommit: 'a'.repeat(40) }
  await first.change(parent.id, current => ({ ...current, bridgeOperations: { job: {
    state: 'received', terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', requestId: 'REQ_ONE',
      terminalStatus: 'COMPLETED', transportKind: 'text', result }, synchronization: 'busy' } } }))
  await first.close()
  const reopened = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  const cold = fixture(reopened)
  const status = await cold.jobs.status(parent, 'job')
  assert.equal(status.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.deepEqual(status.result, result)
  assert.equal(status.synchronization, 'busy')
  assert.equal(cold.started, 0)
  assert.equal(Object.values(reopened.get(parent.id).workers)[0].id, 'child-C')
  await reopened.close()
  await backend.close()
})

test('failed artifact grant diagnostic survives independent JSON-domain lifetime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-grant-journal-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const ctx = { storage: { backend: { get: () => backend } }, emit() {} }
  const first = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json', routes: {} }))
  await first.create(parent.id, row())
  await first.change(parent.id, current => ({ ...current, bridgeOperations: { artifact: {
    state: 'received', terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', requestId: 'REQ_ONE',
      terminalStatus: 'COMPLETED', transportKind: 'artifact', result: { ok: true, code: 'RESULT_DURABLE' } },
    synchronization: 'synchronized', grantDiagnostic: 'Artifact grant registration rejected.' } } }))
  await first.close()
  const reopened = await openPostmanTaskRegistry(new DomainFacility(ctx, { backend: 'json' }))
  const cold = fixture(reopened)
  const status = await cold.jobs.status(parent, 'artifact')
  assert.equal(status.status, 'POSTMAN_BRIDGE_FAILED')
  assert.equal(status.trustedStatus, 'POSTMAN_BRIDGE_TERMINAL')
  assert.match(status.grantDiagnostic, /registration rejected/)
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
  assert.deepEqual(await Promise.all([a, b, c].map(async x => (await jobs.status(parent, x.bridgeJobId)).status)),
    Array(3).fill('POSTMAN_BRIDGE_RUNNING'))
  assert.equal((await jobs.accept(parent, '@PostmanAsk D', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  completions[1]({ stopReason: 'end_turn' })
  await tick(); await tick(); await tick()
  assert.equal((await jobs.status(parent, b.bridgeJobId)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(registry.get(parent.id).bridgeOperations[b.bridgeJobId], undefined)
  assert.equal((await jobs.status(parent, a.bridgeJobId)).status, 'POSTMAN_BRIDGE_RUNNING')
  const d = await jobs.accept(parent, '@PostmanAsk D', 'text')
  assert.equal(d.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await tick()
  assert.equal(starts, 4)
  completions[0]({ stopReason: 'end_turn' }); completions[2]({ stopReason: 'end_turn' }); completions[3]({ stopReason: 'end_turn' })
  await tick(); await tick(); await tick()
  assert.deepEqual(await Promise.all([a, c, d].map(async x => (await jobs.status(parent, x.bridgeJobId)).status)),
    Array(3).fill('POSTMAN_BRIDGE_TERMINAL'))
  assert.deepEqual(registry.get(parent.id).bridgeOperations, {})
  await jobs.dispose()
})


test('proven pre-publication failure persists not-required across restarts and admission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postman-early-terminal-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const backend = new JsonStorageBackend(root)
  const storage = { storage: { backend: { get: () => backend } }, emit() {} }
  const registry = await openPostmanTaskRegistry(new DomainFacility(storage, { backend: 'json', routes: {} }))
  await registry.create(parent.id, row())
  const taskContext = Object.freeze({ branch: row().branch })
  let sends = 0, syncs = 0
  const contexts = { get: () => taskContext, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false, bindChild: () => true, releaseChild() {},
    async sync() { syncs++; throw Error('no publication exists') } }
  const ctx = { agents: { get: () => parent }, subagents: { async start() {
    sends++
    const id = 'child-' + sends
    return { id, localAgent: { id }, result: Promise.resolve({ stopReason: 'end_turn' }), async dispose() {} }
  } }, tools: { get: () => ({ async execute() {
    const requestId = 'REQ_20260929T01010' + sends + 'Z_0001'
    return { status: 'FAILED', requestId, result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED',
      requestId, transportCode: sends % 2 ? 'IMAGE_GENERATION_ABORTED' : 'POSTMAN_INPUT_BUNDLE_HANDOFF_INVALID',
      transportMessage: 'rejected before publication', publicationStarted: false,
      details: sends % 2 ? {} : { sendState: 'PROVEN_NOT_SENT', inputBundlePhase: 'direct-handoff' } } }
  } }) } }
  const jobs = createPostmanBridgeJobs(ctx, { run: (_signal, launch) => launch(), dispose() {} }, null, contexts)
  const receipts = []
  for (let i = 0; i < 5; i++) {
    const receipt = await jobs.accept(parent, '@PostmanAsk early failure ' + i, 'text')
    assert.equal(receipt.status, 'POSTMAN_BRIDGE_ACCEPTED')
    receipts.push(receipt)
    for (let attempt = 0; attempt < 40 &&
      !['not-required', 'busy'].includes(registry.get(parent.id).bridgeOperations[receipt.bridgeJobId]?.synchronization); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    const status = await jobs.status(parent, receipt.bridgeJobId)
    assert.equal(status.synchronization, 'not-required', JSON.stringify({ status, op: registry.get(parent.id).bridgeOperations[receipt.bridgeJobId] }))
    assert.equal(status.state, 'TERMINAL')
    const op = registry.get(parent.id).bridgeOperations[receipt.bridgeJobId]
    assert.equal(op.state, 'received')
    assert.equal(op.synchronization, 'not-required')
  }
  assert.deepEqual({ sends, syncs }, { sends: 5, syncs: 0 })
  await jobs.dispose(); await registry.close()
  const reopened = await openPostmanTaskRegistry(new DomainFacility(storage, { backend: 'json' }))
  for (const receipt of receipts) {
    assert.equal(reopened.get(parent.id).bridgeOperations[receipt.bridgeJobId].synchronization, 'not-required')
  }
  const cold = createPostmanBridgeJobs({ agents: { get: () => parent } },
    { run() { throw Error('must not resend') }, dispose() {} }, null,
    { record: reopened.get, changeRecord: reopened.change, async sync() { throw Error('must not sync') } })
  for (const receipt of receipts) {
    const status = await cold.status(parent, receipt.bridgeJobId)
    assert.equal(status.synchronization, 'not-required')
    assert.equal((await cold.status(parent, receipt.bridgeJobId, true)).synchronization, 'not-required')
  }
  await cold.dispose(); await reopened.close(); await backend.close()
})

test('absence of publication proof alone retains busy received terminal and unknown intent cap', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, row())
  const context = Object.freeze({ branch: row().branch })
  let sends = 0
  const jobs = createPostmanBridgeJobs({ agents: { get: () => parent }, subagents: { async start() {
    sends++
    return { id: 'mock-child', localAgent: { id: 'mock-child' }, result: Promise.resolve({ stopReason: 'end_turn' }), async dispose() {} }
  } }, tools: { get: () => ({ async execute() { return { status: 'FAILED', requestId: 'REQ_UNKNOWN',
    result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId: 'REQ_UNKNOWN',
      transportCode: 'WEB_FAILED', transportMessage: 'publication unknown', details: {} } } } }) } },
  { run: (_signal, launch) => launch(), dispose() {} }, null,
  { get: () => context, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false, bindChild: () => true, releaseChild() {},
    async sync() { throw Error('must not sync') } })
  const receipt = await jobs.accept(parent, '@PostmanAsk unknown', 'text')
  await tick(); await tick(); await tick()
  assert.equal((await jobs.status(parent, receipt.bridgeJobId)).synchronization, 'busy')
  assert.equal(registry.get(parent.id).bridgeOperations[receipt.bridgeJobId].synchronization, 'pending')
  assert.equal((await jobs.status(parent, receipt.bridgeJobId, true)).synchronization, 'busy')
  assert.equal(sends, 1)
  await registry.change(parent.id, row => ({ ...row, bridgeOperations: { ...row.bridgeOperations,
    oldA: { state: 'unknown' }, oldB: { state: 'unknown' }, oldC: { state: 'unknown' } } }))
  assert.equal((await jobs.accept(parent, '@PostmanAsk blocked', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  assert.equal(sends, 1)
  await jobs.dispose()
})

test('one interrupted job does not block an independent new Bridge', async () => {
  const registry = createMemoryTaskRegistry()
  await registry.create(parent.id, { ...row(), bridgeOperations: { oldA: { state: 'unknown' } } })
  const f = fixture(registry)
  const accepted = await f.jobs.accept(parent, '@PostmanAsk new B', 'text')
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal((await f.jobs.status(parent, 'oldA')).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal((await f.jobs.status(parent, accepted.bridgeJobId)).status, 'POSTMAN_BRIDGE_QUEUED')
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

test('old presend failure with full proof releases slot locally; missing proof remains diagnostic', async () => {
  const registry = createMemoryTaskRegistry()
  const ids = ['1103ac1e-6e22-4168-998d-0eed73790cfc', 'ba8a3918-31b3-4a7a-b4ea-a388634e7d1e']
  const terminal = (requestId, extra) => ({ status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', requestId,
    result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', directVersion: 5, requestId, transportMessage: 'failed before publication', ...extra } })
  await registry.create(parent.id, { ...row(), bridgeOperations: {
    [ids[0]]: { state: 'received', synchronization: 'pending', terminal: terminal('REQ_20261003T102744Z_5744', { transportCode: 'DIRECT_CHAT_REFERENCE_UNAVAILABLE', details: {} }) },
    [ids[1]]: { state: 'received', synchronization: 'pending', terminal: terminal('REQ_20261003T103121Z_0257', { transportCode: 'BRIDGE_PIPELINE_FAILED', publicationStarted: false, details: { value: null } }) },
  } })
  let sends = 0, syncs = 0
  const jobs = createPostmanBridgeJobs({ agents: { get: () => parent }, subagents: { start() { sends++; throw Error('no Send') } } },
    { run() { sends++; throw Error('no transport') }, dispose() {} }, null,
    { record: registry.get, changeRecord: registry.change, sync() { syncs++; throw Error('no Git publication') } })
  const unknown = await jobs.status(parent, ids[0], true)
  assert.equal(unknown.synchronization, 'busy')
  assert.deepEqual(unknown.syncDiagnostic, { code: 'PUBLICATION_PROOF_MISSING' })
  assert.equal((await jobs.status(parent, ids[1], true)).synchronization, 'not-required')
  assert.equal((await jobs.status(parent, ids[1], true)).synchronization, 'not-required')
  assert.deepEqual({ sends, syncs }, { sends: 0, syncs: 0 })
  await jobs.dispose()
})

