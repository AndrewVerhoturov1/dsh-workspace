import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter, getEventListeners } from 'node:events'
import { DirectPostmanJobManager, createDirectCurrentTurnToolConfigs } from './direct-current-turn.js'
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

function fixture({ trusted = { status: 'RUNNING', requestId }, durable = true, failIntent = false, directManager } = {}) {
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
      assert.equal(exec.signal, runs.at(-1).signal)
      reads++; return trusted
    } } } } }
  const direct = { inspectRequest() { throw Error('must not inspect Direct') },
    continueLast() { throw Error('must not recover') }, recoveryCapability() { return { recovery_eligible: false } } }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, { async register() { grants++; return true } }, contexts, null, directManager ?? direct)
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

test('started early stop with trusted NO_JOB persists NOT_SENT and frees live and cold slots', async () => {
  const f = fixture({ trusted: { status: 'NO_JOB' } })
  const accepted = await f.accept(); await tick()
  await f.jobs.stop(parent, accepted.bridgeJobId)
  await tick()
  assert.equal(f.coordinator.activeCount, 1, 'cleanup must finish before release')
  await f.settle()
  const op = f.row.bridgeOperations[accepted.bridgeJobId]
  assert.equal(op.state, 'received')
  assert.equal(op.phase, 'not-sent')
  assert.equal(op.synchronization, 'not-required')
  assert.equal(op.requestId, undefined)
  const expected = { status: 'POSTMAN_BRIDGE_NOT_SENT', bridgeJobId: accepted.bridgeJobId,
    requestId: null, synchronization: 'not-required' }
  assert.deepEqual(await f.jobs.status(parent, accepted.bridgeJobId), expected)
  assert.equal(f.jobs.teamSnapshot(parent).used, 0)
  assert.equal(f.jobs.teamSnapshot(parent).operations[0].countsAgainstLimit, false)
  assert.equal(f.coordinator.activeCount, 0)
  assert.equal(f.counts.syncs, 0); assert.equal(f.counts.grants, 0)
  const cold = createPostmanBridgeJobs({}, { run() { throw Error('no launch') }, dispose() {} }, null,
    { record: () => structuredClone(f.row) })
  assert.deepEqual(await cold.status(parent, accepted.bridgeJobId), expected)
  assert.equal(cold.teamSnapshot(parent).used, 0)
  assert.equal(cold.teamSnapshot(parent).operations[0].countsAgainstLimit, false)
  await cold.dispose(); await f.jobs.dispose()
})

for (const reason of ['missing-tool', 'request-id', 'request-known', 'unknown-phase', 'invalid-status', 'status-error']) {
  test('early stop remains UNKNOWN with ambiguous evidence: ' + reason, async () => {
    const f = fixture({ trusted: { status: 'NO_JOB', ...(reason === 'request-id' ? { requestId } : {}) } })
    if (reason === 'missing-tool') f.ctx.tools.get = () => undefined
    if (reason === 'invalid-status') f.ctx.tools.get = () => ({ execute: async () => ({ status: 'INVALID' }) })
    if (reason === 'status-error') f.ctx.tools.get = () => ({ execute: async () => { throw Error('status unavailable') } })
    const accepted = await f.accept(); await tick()
    if (reason === 'request-known' || reason === 'unknown-phase') await f.contexts.changeRecord(parent.id, row => ({ ...row,
      bridgeOperations: { ...row.bridgeOperations, [accepted.bridgeJobId]: {
        ...row.bridgeOperations[accepted.bridgeJobId], phase: reason === 'request-known' ? 'request-known' : 'unrecognized' } } }))
    await f.jobs.stop(parent, accepted.bridgeJobId); await f.settle()
    assert.equal(f.row.bridgeOperations[accepted.bridgeJobId].state, 'unknown')
    assert.equal((await f.jobs.status(parent, accepted.bridgeJobId)).status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
    assert.equal(f.jobs.teamSnapshot(parent).used, 1)
    assert.equal(f.counts.syncs, 0); assert.equal(f.counts.grants, 0)
    await f.jobs.dispose()
  })
}

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



for (const action of ['stop', 'plugin disposal']) test('actual Direct wait: ' + action + ' promptly settles live/cold UNKNOWN without second wait', { timeout: 3000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = new EventEmitter()
  transport.stdout = new EventEmitter(); transport.stderr = new EventEmitter()
  transport.kill = () => assert.fail('Bridge cancellation does not own Direct process cancellation')
  const direct = new DirectPostmanJobManager({ exists: () => true,
    readPublicationState() { throw Error('no durable Direct terminal') },
    spawn() { queueMicrotask(() => transport.emit('spawn')); return transport } })
  const plugin = createDirectCurrentTurnToolConfigs({}, { jobs: direct })
  const statusTool = plugin.tools.find(t => t.name === 'postman_current_turn_status')
  const f = fixture({ directManager: direct })
  t.after(async () => { transport.emit('close', 1); plugin.dispose(); await f.settle(); await f.jobs.dispose() })
  const accepted = await f.accept(); await tick()
  const run = f.runs[0], child = { id: 'child-1' }
  await direct.start({ sessionId: child.id, workspace: '/repo', branch: 'main', payload: 'exact intent' })
  const job = direct.latest(child.id)
  await f.contexts.changeRecord(parent.id, row => ({ ...row, bridgeOperations: { ...row.bridgeOperations,
    [accepted.bridgeJobId]: { ...row.bridgeOperations[accepted.bridgeJobId], requestId: job.requestId, phase: 'request-known' } } }))
  let reads = 0
  f.ctx.tools.get = () => ({ execute(args, exec) {
    assert.equal(exec.signal, run.signal, 'post-child status must use the same cancellation signal')
    assert.equal(exec.signal.aborted, true, 'no post-stop unbounded status read')
    assert.equal(++reads, 1)
    return statusTool.execute(args, exec)
  } })
  // The child cannot settle until its actual current-turn status tool is unblocked.
  const childStatus = statusTool.execute({}, { agent: child, signal: run.signal })
  void childStatus.then(() => run.end.resolve({ stopReason: 'aborted' }))
  assert.equal(job.waiters.size, 1)
  let closing
  if (action === 'stop') assert.equal((await f.jobs.stop(parent, accepted.bridgeJobId)).status, 'POSTMAN_BRIDGE_STOP_REQUESTED')
  else closing = f.jobs.dispose()
  assert.equal(job.waiters.size, 0, 'abort wakes child status immediately')
  assert.equal(getEventListeners(run.signal, 'abort').length, 0)
  assert.equal((await childStatus).status, 'RUNNING')
  await tick()
  assert.equal(reads, 1)
  assert.equal(job.waiters.size, 0, 'post-child read never opens another 480-second timer')
  assert.equal(f.coordinator.activeCount, 1, 'pending cleanup still owns the slot')
  assert.equal(f.row.bridgeOperations[accepted.bridgeJobId].state, 'pending')
  run.cleanup.resolve()
  if (closing) await closing
  else await tick()
  assert.equal(f.coordinator.activeCount, 0)
  assert.equal(f.row.bridgeOperations[accepted.bridgeJobId].state, 'unknown')
  assert.equal(f.jobs.hasActive(parent.id), false)
  const live = await f.jobs.status(parent, accepted.bridgeJobId)
  assert.equal(live.status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal(live.requestId, job.requestId)
  assert.equal(live.result, undefined)
  assert.equal(live.terminalStatus, undefined)
  const before = structuredClone(f.row)
  const cold = createPostmanBridgeJobs({}, { run() { assert.fail('no replay') }, dispose() {} },
    { register() { assert.fail('no fabricated grant') } }, { record: () => f.row }, null, direct)
  assert.deepEqual(await cold.status(parent, accepted.bridgeJobId), live)
  assert.equal(cold.teamSnapshot(parent).used, 1, 'UNKNOWN durable capacity remains held')
  assert.deepEqual(f.row, before)
  assert.equal(job.state, 'running', 'Direct remains authoritative and alive')
  await cold.dispose()
  assert.equal(job.waiters.size, 0)
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
