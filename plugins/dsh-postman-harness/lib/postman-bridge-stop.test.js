import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'

const parent = { id: 'leader-stop', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
const requestId = 'REQ_20261004T010101Z_0001'
const publication = { requestId, baseCommit: 'a'.repeat(40), taskPublicationCommit: 'b'.repeat(40) }

function fixture({ trusted = { status: 'RUNNING', requestId }, durable = true, failIntent = false } = {}) {
  let row = { bridgeOperations: {}, artifactGrants: { saved: { value: 'preserve' } } }
  const task = Object.freeze({ branch: 'task' })
  const runs = []
  let releases = 0, syncs = 0, grants = 0, reads = 0
  const coordinator = createPostmanBridgeLaunchCoordinator({ random: () => 0 })
  const contexts = durable ? { get: () => task, record: id => id === parent.id ? row : null,
    async changeRecord(id, update) {
      assert.equal(id, parent.id)
      const next = update(row)
      if (failIntent && Object.values(next.bridgeOperations).some(op => op.cancellationRequested)) throw Error('intent write failed')
      row = next
    }, bindChild: () => true, releaseChild() { releases++ },
    async sync() { syncs++; return false } } : undefined
  const ctx = { agents: { get: id => id === parent.id ? parent : undefined },
    subagents: { async start(_provider, req) {
      const end = deferred(), cleanup = deferred()
      const run = { signal: req.signal, end, cleanup, disposed: 0 }
      runs.push(run)
      req.signal.addEventListener('abort', () => end.resolve({ stopReason: 'aborted' }), { once: true })
      return { id: 'child-' + runs.length, localAgent: { id: 'child-' + runs.length }, result: end.promise,
        async dispose() { run.disposed++; await cleanup.promise } }
    } }, tools: { get() { return { async execute(_args, exec) {
      assert.equal(exec.signal?.aborted, undefined)
      reads++; return trusted
    } } } } }
  const direct = { inspectRequest() { throw Error('must not inspect Direct') },
    continueLast() { throw Error('must not recover') }, recoveryCapability() { return { recovery_eligible: false } } }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, { async register() { grants++; return true } }, contexts, null, direct)
  const accept = () => jobs.accept(parent, '@PostmanAsk stop test', 'text')
  const settle = async () => { for (const run of runs) { run.end.resolve({ stopReason: 'end_turn' }); run.cleanup.resolve() }; await tick() }
  return { jobs, ctx, contexts, coordinator, runs, accept, settle, get row() { return row },
    get counts() { return { releases, syncs, grants, reads } } }
}

test('queued stop persists intent and releases only after actual coordinator rejection', async () => {
  const f = fixture()
  const first = await f.accept(); await tick()
  const queued = await f.accept()
  assert.equal(queued.state, 'QUEUED')
  const stopped = await f.jobs.stop(parent, queued.bridgeJobId)
  assert.equal(stopped.status, 'POSTMAN_BRIDGE_STOP_REQUESTED')
  assert.equal(stopped.intentPersisted, true)
  await tick()
  assert.equal(f.runs.length, 1)
  const op = f.row.bridgeOperations[queued.bridgeJobId]
  assert.deepEqual({ state: op.state, phase: op.phase, sync: op.synchronization, cancel: op.cancellationRequested },
    { state: 'received', phase: 'not-sent', sync: 'not-required', cancel: true })
  assert.equal(f.jobs.teamSnapshot(parent).used, 1)
  const cold = createPostmanBridgeJobs({}, { run() { throw Error('no launch') }, dispose() {} }, null, { record: () => f.row })
  assert.deepEqual(await cold.status(parent, queued.bridgeJobId), { status: 'POSTMAN_BRIDGE_NOT_SENT', bridgeJobId: queued.bridgeJobId, requestId: null, synchronization: 'not-required' })
  assert.equal(cold.teamSnapshot(parent).used, 1)
  await cold.dispose()
  assert.equal(f.coordinator.activeCount, 1)
  assert.equal((await f.jobs.stop(parent, queued.bridgeJobId)).status, 'POSTMAN_BRIDGE_STOP_NOT_LIVE')
  await f.jobs.stop(parent, first.bridgeJobId); await f.settle(); await f.jobs.dispose()
})

test('running potentially sent stop aborts exact controller; unknown retains durable slot through disposal', async () => {
  const f = fixture()
  const accepted = await f.accept(); await tick()
  const queued = await f.accept()
  const stop = await f.jobs.stop(parent, accepted.bridgeJobId)
  assert.equal(stop.status, 'POSTMAN_BRIDGE_STOP_REQUESTED')
  assert.equal(f.runs[0].signal.aborted, true)
  await tick()
  assert.equal(f.runs[0].disposed, 1)
  assert.equal(f.coordinator.activeCount, 1, 'cleanup still pending')
  assert.equal(f.counts.releases, 0)
  assert.equal(f.jobs.teamSnapshot(parent).used, 2)
  await f.jobs.stop(parent, queued.bridgeJobId)
  f.runs[0].cleanup.resolve(); await tick()
  assert.equal(f.row.bridgeOperations[accepted.bridgeJobId].state, 'unknown')
  assert.equal(f.jobs.teamSnapshot(parent).used, 1, 'unknown Direct cannot free durable capacity')
  assert.equal(f.coordinator.activeCount, 0)
  assert.equal(f.counts.releases, 1)
  const status = await f.jobs.status(parent, accepted.bridgeJobId)
  assert.notEqual(status.result?.code, 'CANCELLED_BEFORE_SEND')
  await Promise.all([f.jobs.dispose(), f.jobs.dispose()])
  assert.equal(f.runs[0].disposed, 1)
  assert.equal(f.counts.releases, 1)
})

test('trusted terminal after abort remains authority; stop does not destroy sync or grants', async () => {
  const f = fixture({ trusted: { status: 'COMPLETED', requestId,
    result: { ...publication, ok: true, code: 'TEXT_RESULT_DURABLE', assistantText: 'trusted private answer' } } })
  const accepted = await f.accept(); await tick()
  await f.jobs.stop(parent, accepted.bridgeJobId)
  await f.settle()
  assert.equal(f.row.bridgeOperations[accepted.bridgeJobId].state, 'received')
  assert.equal(f.row.bridgeOperations[accepted.bridgeJobId].terminal.result.assistantText, 'trusted private answer')
  assert.equal(f.counts.syncs, 1)
  const before = structuredClone(f.row)
  assert.equal((await f.jobs.stop(parent, accepted.bridgeJobId)).status, 'POSTMAN_BRIDGE_ALREADY_TERMINAL')
  assert.deepEqual(f.row, before)
  assert.equal((await f.jobs.status(parent, accepted.bridgeJobId)).result.assistantText, 'trusted private answer')
  assert.doesNotMatch(JSON.stringify(f.jobs.teamSnapshot(parent)), /private answer|artifactGrants|terminal/)
  await f.jobs.dispose()
})

test('foreign ID and non-top-level caller disclose no owned metadata', async () => {
  const f = fixture()
  const accepted = await f.accept(); await tick()
  const foreign = { ...parent, id: 'foreign' }
  assert.deepEqual(await f.jobs.stop(foreign, accepted.bridgeJobId), { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' })
  f.ctx.agents.get = id => id === parent.id ? parent : id === foreign.id ? foreign : undefined
  assert.deepEqual(await f.jobs.stop(foreign, accepted.bridgeJobId), { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' })
  assert.deepEqual(await f.jobs.stop({ ...parent }, accepted.bridgeJobId), { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' })
  assert.deepEqual(f.jobs.teamSnapshot({ ...parent }), { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' })
  assert.deepEqual(await f.jobs.stop(parent, 'missing'), { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' })
  assert.deepEqual(await f.jobs.stop({ ...parent, session: { header: { agentPreset: 'postman-leader', origin: 'subagent' } } }, accepted.bridgeJobId),
    { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' })
  assert.equal(f.runs[0].signal.aborted, false)
  await f.jobs.stop(parent, accepted.bridgeJobId)
  await f.settle(); await f.jobs.dispose()
})

test('cold stop and bounded team snapshot never inspect recover write sync grant or send', async () => {
  const ops = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['cold-' + i,
    { state: 'unknown', requestId, transportKind: 'text', cancellationRequested: i === 0, result: { secret: 'raw' } }]))
  const row = { bridgeOperations: ops, artifactGrants: { secret: 'raw' } }
  const before = structuredClone(row)
  const forbidden = () => { throw Error('read-only violation') }
  const jobs = createPostmanBridgeJobs({}, { run: forbidden, dispose() {} }, { register: forbidden },
    { record: id => id === parent.id ? row : null, changeRecord: forbidden, sync: forbidden }, null,
    { inspectRequest: forbidden, continueLast: forbidden })
  assert.deepEqual(await jobs.stop(parent, 'cold-0'), { status: 'POSTMAN_BRIDGE_STOP_NOT_LIVE', bridgeJobId: 'cold-0', cancellationRequested: true })
  assert.deepEqual(await jobs.stop({ ...parent, id: 'foreign' }, 'cold-0'), { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' })
  const snapshot = jobs.teamSnapshot(parent)
  assert.equal(snapshot.used, 40); assert.equal(snapshot.limit, 3)
  assert.equal(snapshot.operations.length, 30); assert.equal(snapshot.truncated, true)
  assert.deepEqual(Object.keys(snapshot.operations[0]), ['bridgeJobId', 'state', 'transportKind', 'requestId', 'synchronization', 'countsAgainstLimit', 'cancellationRequested'])
  assert.deepEqual(row, before)
  await jobs.dispose()
})

test('intent write failure still aborts live exact controller and reports non-durable intent', async () => {
  const f = fixture({ failIntent: true })
  const accepted = await f.accept(); await tick()
  const result = await f.jobs.stop(parent, accepted.bridgeJobId)
  assert.equal(result.intentPersisted, false)
  assert.match(result.diagnostic, /intent write failed/)
  assert.equal(f.runs[0].signal.aborted, true)
  await f.settle(); await f.jobs.dispose()
})

test('trusted terminal awaiting sync or grant is never aborted by stop', async () => {
  const f = fixture({ trusted: { status: 'COMPLETED', requestId,
    result: { ...publication, ok: true, code: 'RESULT_DURABLE' } } })
  const sync = deferred(), entered = deferred()
  f.contexts.sync = async () => { entered.resolve(); return sync.promise }
  const accepted = await f.accept(); await tick()
  await f.settle(); await entered.promise
  const before = structuredClone(f.row)
  assert.equal((await f.jobs.stop(parent, accepted.bridgeJobId)).status, 'POSTMAN_BRIDGE_ALREADY_TERMINAL')
  assert.equal(f.runs[0].signal.aborted, false)
  assert.deepEqual(f.row, before)
  sync.resolve(true); await tick()
  assert.equal(f.counts.grants, 1)
  assert.equal(f.runs[0].signal.aborted, false)
  assert.equal((await f.jobs.status(parent, accepted.bridgeJobId)).synchronization, 'synchronized')
  await f.jobs.dispose()
})

test('terminal received during intent write wins race before abort', async () => {
  const f = fixture({ trusted: { status: 'COMPLETED', requestId,
    result: { ...publication, ok: true, code: 'TEXT_RESULT_DURABLE' } } })
  const accepted = await f.accept(); await tick()
  const intent = deferred(), written = deferred(), change = f.contexts.changeRecord
  f.contexts.changeRecord = async (id, update) => {
    const candidate = update(f.row)
    await change(id, () => candidate)
    if (candidate.bridgeOperations[accepted.bridgeJobId]?.cancellationRequested) { written.resolve(); await intent.promise }
  }
  const stop = f.jobs.stop(parent, accepted.bridgeJobId)
  await written.promise
  await f.settle()
  intent.resolve()
  assert.equal((await stop).status, 'POSTMAN_BRIDGE_ALREADY_TERMINAL')
  assert.equal(f.runs[0].signal.aborted, false)
  // Other terminal journal updates may share the write gate; all settle normally.
  await tick(); await f.jobs.dispose()
})

test('disposal during normal RUNNING polling observes one next response then settles unknown', async () => {
  const f = fixture()
  const response = deferred(), entered = deferred()
  let polls = 0
  f.ctx.tools.get = () => ({ async execute() { polls++; entered.resolve(); return response.promise } })
  const accepted = await f.accept(); await tick()
  f.runs[0].end.resolve({ stopReason: 'end_turn' })
  await entered.promise
  const closing = f.jobs.dispose()
  response.resolve({ status: 'RUNNING', requestId })
  f.runs[0].cleanup.resolve()
  await closing
  assert.equal(polls, 1)
  assert.equal(f.row.bridgeOperations[accepted.bridgeJobId].state, 'unknown')
  assert.equal(f.runs[0].disposed, 1)
})

test('live fixtures without registry expose capacity and cancellation metadata', async () => {
  const f = fixture({ durable: false })
  const accepted = await f.accept(); await tick()
  assert.equal(f.jobs.teamSnapshot(parent).used, 1)
  await f.jobs.stop(parent, accepted.bridgeJobId)
  assert.equal(f.jobs.teamSnapshot(parent).operations[0].cancellationRequested, true)
  await f.settle()
  assert.equal(f.jobs.teamSnapshot(parent).used, 0)
  await f.jobs.dispose()
})
