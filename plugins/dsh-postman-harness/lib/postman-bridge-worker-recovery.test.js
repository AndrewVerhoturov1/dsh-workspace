import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'

const leader = { id: 'bridge-recovery', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } }, followup() {} }
const tick = () => new Promise(resolve => setImmediate(resolve))
const worker = id => ({ id, label: id, state: 'ready', delivery: 'none', artifactRequests: [] })

async function fixture({ zip = false, before = false, finishGate = false, rejectGrant = false } = {}) {
  const registry = createMemoryTaskRegistry()
  await registry.create(leader.id, { stage: 'ready', workers: before ? { A: worker('A') } : {},
    runner: { state: 'none', requestId: null }, bridgeOperations: {} })
  const context = Object.freeze({ branch: 'task/postman-' + 'a'.repeat(32) })
  let starts = 0, syncs = 0, grantCount = 0, allowed = false, grantAllowed = !rejectGrant, finish
  const result = finishGate ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ stopReason: 'end_turn' })
  const terminalResult = zip ? { ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE' }
    : { ok: true, code: 'TEXT_RESULT_DURABLE', assistantText: 'verified' }
  const publication = { ...terminalResult, taskPublicationCommit: 'b'.repeat(40), baseCommit: 'a'.repeat(40) }
  const contexts = { get: () => context, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false,
    bindChild: () => true, releaseChild() {},
    async sync(_id, _commit, _base, beforeSync) { syncs++; return allowed && await beforeSync(leader.id) } }
  const grants = { async register(_leaderId, terminal) {
    if (terminal.result?.code === 'RESULT_DURABLE') { grantCount++; return grantAllowed }
    return true
  } }
  const ctx = { agents: { get: () => leader }, subagents: { async start() {
    starts++
    return { id: 'child-' + starts, localAgent: { id: 'child-' + starts }, result, async dispose() {} }
  } }, tools: { get: () => ({ async execute() {
    return { status: 'COMPLETED', requestId: 'REQ_' + starts, result: publication }
  } }) } }
  const coordinator = { run: (_signal, launch) => launch(), dispose() {} }
  const peers = { async pauseForOperation() { return true } }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants, contexts, peers)
  const accept = () => jobs.accept(leader, '@PostmanAsk verified', zip ? 'artifact' : 'text')
  return { registry, jobs, accept, contexts, publication, finish: () => finish?.({ stopReason: 'end_turn' }),
    allow: () => { allowed = true }, allowGrant: () => { grantAllowed = true }, insertWorker: () => registry.change(leader.id, row => ({ ...row,
      workers: { ...row.workers, A: worker('A') } })),
    counts: () => ({ starts, syncs, grants: grantCount }) }
}

for (const before of [true, false]) for (const zip of [false, true]) {
  test('verified result survives Worker ' + (before ? 'before' : 'during') + ' ' + (zip ? 'ZIP' : 'text'), async () => {
    const f = await fixture({ zip, before, finishGate: !before })
    const first = await f.accept()
    if (!before) { await tick(); await f.insertWorker(); f.finish() }
    await tick(); await tick(); await tick()
    const received = await f.jobs.status(leader, first.bridgeJobId)
    assert.equal(received.status, 'POSTMAN_BRIDGE_TERMINAL')
    assert.deepEqual(received.result, f.publication)
    assert.equal(received.synchronization, 'busy')
    assert.equal(f.registry.get(leader.id).bridgeOperations[first.bridgeJobId].state, 'received')
    assert.equal(f.counts().grants, 0, 'no early grant')
    const initialStarts = f.counts().starts
    f.allow()
    const synchronized = await f.jobs.status(leader, first.bridgeJobId, true)
    assert.equal(synchronized.synchronization, 'synchronized')
    assert.equal(f.counts().starts, initialStarts, 'no replayed Direct send')
    assert.equal(f.counts().grants, zip ? 1 : 0)
    assert.equal(f.registry.get(leader.id).bridgeOperations[first.bridgeJobId], undefined)
    await f.jobs.dispose()
  })
}


test('persisted terminal survives restart and retries sync without Direct', async () => {
  const f = await fixture({ zip: true, before: true })
  const receipt = await f.accept()
  await tick(); await tick(); await tick()
  assert.equal(f.registry.get(leader.id).bridgeOperations[receipt.bridgeJobId].state, 'received')
  await f.jobs.dispose()
  let sends = 0, syncs = 0, grants = 0
  const contexts = { record: f.registry.get, changeRecord: f.registry.change,
    async sync(_leader, _commit, _parent, beforeSync) { syncs++; return beforeSync(leader.id) } }
  const cold = createPostmanBridgeJobs({ agents: { get: () => leader }, subagents: {
    async start() { sends++; throw Error('must not send') }
  } }, { run: () => { sends++; throw Error('must not run') }, dispose() {} },
  { async register() { grants++; return true } }, contexts,
  { async pauseForOperation() { return true } })
  const before = await cold.status(leader, receipt.bridgeJobId)
  assert.equal(before.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(before.synchronization, 'busy')
  const [recovered, simultaneous] = await Promise.all([
    cold.status(leader, receipt.bridgeJobId, true), cold.status(leader, receipt.bridgeJobId, true)])
  assert.equal(recovered.synchronization, 'synchronized')
  assert.deepEqual(simultaneous.result, f.publication)
  for (let i = 0; i < 2; i++) {
    const again = await cold.status(leader, receipt.bridgeJobId)
    assert.equal(again.status, 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(again.state, 'TERMINAL')
    assert.ok(again.finishedAt)
    assert.deepEqual(again.result, f.publication)
  }
  assert.equal((await cold.status(leader, receipt.bridgeJobId, true)).synchronization, 'synchronized')
  assert.deepEqual({ sends, syncs, grants }, { sends: 0, syncs: 1, grants: 1 })
  await cold.dispose()
})

test('verified artifact grant failure remains recoverable across restart', async () => {
  const f = await fixture({ zip: true, rejectGrant: true })
  f.allow()
  const receipt = await f.accept()
  await tick(); await tick(); await tick()
  assert.equal((await f.jobs.status(leader, receipt.bridgeJobId)).status, 'POSTMAN_BRIDGE_FAILED')
  const stored = f.registry.get(leader.id).bridgeOperations[receipt.bridgeJobId]
  assert.equal(stored.state, 'received')
  assert.equal(stored.synchronization, 'synchronized')
  assert.match(stored.grantDiagnostic, /registration rejected/)
  f.allowGrant()
  const recovered = await f.jobs.status(leader, receipt.bridgeJobId, true)
  assert.equal(recovered.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(recovered.grantDiagnostic, undefined)
  assert.equal(f.registry.get(leader.id).bridgeOperations[receipt.bridgeJobId], undefined)
  await f.jobs.dispose()

  let sends = 0, grants = 0
  const second = await fixture({ zip: true, rejectGrant: true })
  second.allow()
  const other = await second.accept()
  await tick(); await tick(); await tick()
  await second.jobs.dispose()
  const cold = createPostmanBridgeJobs({ agents: { get: () => leader } },
    { run: () => { sends++; throw Error('must not send') }, dispose() {} },
    { async register() { grants++; return true } },
    { record: second.registry.get, changeRecord: second.registry.change,
      async sync(_id, _commit, _base, beforeSync) { return beforeSync(leader.id) } },
    { async pauseForOperation() { return true } })
  assert.equal((await cold.status(leader, other.bridgeJobId)).status, 'POSTMAN_BRIDGE_FAILED')
  assert.equal((await cold.status(leader, other.bridgeJobId, true)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await cold.status(leader, other.bridgeJobId)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await cold.status(leader, other.bridgeJobId, true)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.deepEqual({ sends, grants }, { sends: 0, grants: 1 })
  await cold.dispose()
})


test('cold text terminal retains result after local retry without repeated sync', async () => {
  const f = await fixture()
  const receipt = await f.accept()
  await tick(); await tick(); await tick()
  await f.jobs.dispose()
  let sends = 0, syncs = 0
  const cold = createPostmanBridgeJobs({ agents: { get: () => leader } },
    { run() { sends++; throw Error('Direct replay') }, dispose() {} }, null,
    { record: f.registry.get, changeRecord: f.registry.change,
      async sync() { syncs++; return true } }, { async pauseForOperation() { return true } })
  assert.equal((await cold.status(leader, receipt.bridgeJobId)).synchronization, 'busy')
  assert.equal((await cold.status(leader, receipt.bridgeJobId, true)).synchronization, 'synchronized')
  for (let i = 0; i < 2; i++) {
    const status = await cold.status(leader, receipt.bridgeJobId)
    assert.equal(status.status, 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(status.state, 'TERMINAL')
    assert.deepEqual(status.result, f.publication)
  }
  assert.equal((await cold.status(leader, receipt.bridgeJobId, true)).synchronization, 'synchronized')
  assert.deepEqual({ sends, syncs }, { sends: 0, syncs: 1 })
  await cold.dispose()
})

test('three known received results are not classified as unknown; unknown intents retain cap', async () => {
  const f = await fixture({ before: true })
  for (let i = 0; i < 3; i++) {
    const receipt = await f.accept()
    await tick(); await tick(); await tick()
    assert.equal((await f.jobs.status(leader, receipt.bridgeJobId)).status, 'POSTMAN_BRIDGE_TERMINAL')
  }
  assert.deepEqual(Object.values(f.registry.get(leader.id).bridgeOperations).map(op => op.state),
    ['received', 'received', 'received'])
  assert.equal((await f.accept()).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  await f.jobs.dispose()
  const cold = await fixture()
  await cold.registry.change(leader.id, row => ({ ...row, bridgeOperations: {
    A: { state: 'unknown' }, B: { state: 'unknown' }, C: { state: 'unknown' } } }))
  assert.equal((await cold.accept()).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
})
