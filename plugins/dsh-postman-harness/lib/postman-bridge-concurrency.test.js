import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeTool, createPostmanBridgeStatusTool } from './postman-bridge.js'
import { createImplementationArtifactGrants } from './implementation-artifact.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createPostmanWorkerTools, postmanWorkerDeniedTools } from './postman-worker.js'

const parent = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const message = '@PostmanAsk independent text'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function clock() {
  let time = 0
  let nextId = 0
  const timers = new Map()
  const coordinator = createPostmanBridgeLaunchCoordinator({
    now: () => time, random: () => 0,
    setTimer(callback, delay) {
      const id = ++nextId
      timers.set(id, { at: time + delay, callback })
      return id
    },
    clearTimer: id => timers.delete(id),
  })
  async function advance(ms) {
    await tick()
    const end = time + ms
    while (true) {
      const due = [...timers].filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      time = due[1].at
      timers.delete(due[0])
      due[1].callback()
      await tick()
    }
    time = end
    await tick()
  }
  return { coordinator, advance }
}

function fixture({ coordinator = createPostmanBridgeLaunchCoordinator(), grants, onDispose, onStart, onStatus, onWake, contexts } = {}) {
  const pending = new Map()
  const children = new Map()
  const signals = []
  const events = []
  const ctx = {
    childById: id => children.get(String(id)),
    agents: { get: id => id === parent.id ? parent : undefined },
    subagents: { async start(_provider, request) {
      signals.push(request.signal)
      events.push('start')
      if (onStart) { const run = await onStart(request); children.set(String(run.id), run.localAgent); return run }
      const id = 'child-' + signals.length
      const result = new Promise(resolve => pending.set(id, resolve))
      const localAgent = { id }; children.set(id, localAgent)
      return { id, localAgent, result, async dispose() {
        events.push('dispose')
        await onDispose?.()
      } }
    } },
    tools: { get(_name, child) { return { async execute(_args, exec) {
      assert.equal(exec.agent, child)
      events.push('status')
      return onStatus?.(_args, exec) ?? { status: 'COMPLETED', requestId: 'REQ_1',
        result: { requestId: 'REQ_1', assistantText: 'TRUSTED' } }
    } } }, schemas: () => [{ name: 'postman_bridge_status' }, { name: 'read' }] },
  }
  parent.followup = value => { events.push('ready'); onWake?.(value) }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants, contexts)
  const bridge = createPostmanBridgeTool(ctx, jobs, contexts)
  const status = createPostmanBridgeStatusTool(ctx, jobs)
  const exec = { agent: parent, signal: new AbortController().signal }
  const read = receipt => status.execute({ bridge_job_id: receipt.bridgeJobId }, exec)
  return { ctx, jobs, bridge, status, exec, pending, signals, events, read, coordinator }
}

test('acceptance precedes child result and tool signal cannot cancel background job', async () => {
  const f = fixture()
  assert.equal(f.bridge.isConcurrencySafe({ message }), true)
  const controller = new AbortController()
  const accepted = await f.bridge.execute({ message }, { agent: parent, signal: controller.signal })
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(accepted.state, 'STARTING')
  assert.equal((await f.read(accepted)).status, 'POSTMAN_BRIDGE_RUNNING')
  await tick()
  assert.equal(f.signals.length, 1)
  assert.notEqual(f.signals[0], controller.signal)
  controller.abort()
  assert.equal(f.signals[0].aborted, false)
  f.pending.get('child-1')({ stopReason: 'end_turn', report: 'UNTRUSTED' })
  await tick()
  const terminal = await f.read(accepted)
  assert.equal(terminal.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(terminal.result.assistantText, 'TRUSTED')
  assert.equal(terminal.childSessionId, 'child-1')
  assert.deepEqual(f.events.slice(-3), ['status', 'dispose', 'ready'])
  await f.jobs.dispose()
})

test('invalid delegation and rejected caller cannot create a job', async () => {
  const f = fixture()
  assert.equal((await f.bridge.execute({ message: 'ordinary message' }, f.exec)).status,
    'POSTMAN_BRIDGE_MESSAGE_REJECTED')
  assert.equal((await f.bridge.execute({ message }, { agent: { id: 'stranger' } })).status,
    'POSTMAN_BRIDGE_CALLER_REJECTED')
  assert.equal(f.signals.length, 0)
  await f.jobs.dispose()
})

test('READY is metadata only; foreign Leader and Worker cannot read result', async () => {
  let wake
  const f = fixture({ onWake: value => { wake = value } })
  const accepted = await f.bridge.execute({ message }, f.exec)
  await tick()
  f.pending.get('child-1')({ stopReason: 'end_turn', finalText: 'Luna invented result' })
  await tick()
  assert.match(JSON.stringify(wake), /POSTMAN_BRIDGE_READY/)
  assert.doesNotMatch(JSON.stringify(wake), /TRUSTED|assistantText|Luna invented/)
  assert.equal((await f.read(accepted)).result.assistantText, 'TRUSTED')
  const other = { id: 'other', session: { header: { agentPreset: 'postman-leader' } } }
  f.ctx.agents.get = id => id === 'other' ? other : parent
  assert.equal((await f.status.execute({ bridge_job_id: accepted.bridgeJobId }, { agent: other })).status,
    'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  assert.equal((await f.status.execute({ bridge_job_id: accepted.bridgeJobId },
    { agent: { id: 'worker', session: { header: { origin: 'subagent', agentPreset: 'postman-leader' } } } })).status,
  'POSTMAN_BRIDGE_CALLER_REJECTED')
  assert.deepEqual(postmanWorkerDeniedTools(f.ctx.tools), ['postman_bridge_status'])
  await f.jobs.dispose()
})

test('failed READY remains readable after full cleanup', async () => {
  const f = fixture({ onWake: () => { throw Error('inbox unavailable') } })
  const accepted = await f.bridge.execute({ message }, f.exec)
  await tick()
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  await tick()
  assert.equal((await f.read(accepted)).notification, 'UNDELIVERED')
  assert.equal((await f.read(accepted)).result.assistantText, 'TRUSTED')
  await f.jobs.dispose()
})

test('terminal survives unavailable live Leader without routing elsewhere', async () => {
  const f = fixture()
  const accepted = await f.bridge.execute({ message }, f.exec)
  await tick()
  f.ctx.agents.get = () => undefined
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  await tick()
  assert.equal(f.jobs.status(parent, accepted.bridgeJobId).notification, 'UNDELIVERED')
  f.ctx.agents.get = id => id === parent.id ? parent : undefined
  assert.equal((await f.read(accepted)).result.assistantText, 'TRUSTED')
  await f.jobs.dispose()
})

test('terminal and active slot wait for child cleanup', async () => {
  let finishCleanup
  const f = fixture({ onDispose: () => new Promise(resolve => { finishCleanup = resolve }) })
  const accepted = await f.bridge.execute({ message }, f.exec)
  await tick()
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  await tick()
  assert.equal(f.coordinator.activeCount, 1)
  assert.equal((await f.read(accepted)).status, 'POSTMAN_BRIDGE_RUNNING')
  finishCleanup()
  await tick()
  assert.equal(f.coordinator.activeCount, 0)
  assert.equal((await f.read(accepted)).status, 'POSTMAN_BRIDGE_TERMINAL')
  await f.jobs.dispose()
})

test('queued Bridge resolves the current exact live parent instead of stale admission object', async () => {
  const timing = clock()
  const seen = []
  const f = fixture({ coordinator: timing.coordinator, onStart: request => {
    seen.push(request.parent)
    const id = 'child-' + seen.length
    const result = new Promise(resolve => f.pending.set(id, resolve))
    return { id, localAgent: { id }, result, async dispose() {} }
  } })
  const first = await f.bridge.execute({ message }, f.exec)
  const queued = await f.bridge.execute({ message }, f.exec)
  assert.equal((await f.read(queued)).status, 'POSTMAN_BRIDGE_QUEUED')
  const current = { ...parent, followup: () => {} }
  f.ctx.agents.get = id => id === parent.id ? current : undefined
  await timing.advance(5000)
  assert.equal(seen.length, 2)
  assert.equal(seen[0], parent)
  assert.equal(seen[1], current)
  assert.notEqual(seen[1], parent)
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  f.pending.get('child-2')({ stopReason: 'end_turn' })
  await tick()
  assert.equal((await f.status.execute({ bridge_job_id: queued.bridgeJobId }, { agent: current })).status,
    'POSTMAN_BRIDGE_TERMINAL')
  await f.jobs.dispose()
})

test('missing parent at queued launch fails without child and frees slot for next job', async () => {
  const timing = clock()
  const f = fixture({ coordinator: timing.coordinator })
  const first = await f.bridge.execute({ message }, f.exec)
  const missing = await f.bridge.execute({ message }, f.exec)
  const next = await f.bridge.execute({ message }, f.exec)
  let originalWakes = 0
  parent.followup = () => { originalWakes += 1 }
  f.ctx.agents.get = () => undefined
  await timing.advance(5000)
  assert.equal(f.signals.length, 1)
  assert.equal(f.coordinator.activeCount, 1)
  assert.equal(f.jobs.status(parent, missing.bridgeJobId).trustedStatus,
    'POSTMAN_BRIDGE_PARENT_UNAVAILABLE')
  assert.equal(f.jobs.status(parent, missing.bridgeJobId).notification, 'UNDELIVERED')
  assert.equal(originalWakes, 0)
  const other = { id: 'other', session: { header: { agentPreset: 'postman-leader' } } }
  f.ctx.agents.get = id => id === parent.id ? parent : id === other.id ? other : undefined
  assert.equal((await f.status.execute({ bridge_job_id: missing.bridgeJobId }, { agent: other })).status,
    'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  await timing.advance(5000)
  assert.equal(f.signals.length, 2)
  assert.equal(f.coordinator.activeCount, 2)
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  f.pending.get('child-2')({ stopReason: 'end_turn' })
  await tick()
  assert.equal((await f.read(next)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await f.read(first)).status, 'POSTMAN_BRIDGE_TERMINAL')
  await f.jobs.dispose()
})

test('queued parent with wrong identity or disposed Leader preset cannot start a child', async () => {
  for (const replacement of [
    { ...parent, id: 'different' },
    { ...parent, session: { header: { agentPreset: 'ordinary', delegationDepth: 0 } } },
    { ...parent, session: { header: { agentPreset: 'postman-leader', origin: 'subagent' } } },
  ]) {
    const timing = clock()
    const f = fixture({ coordinator: timing.coordinator })
    const first = await f.bridge.execute({ message }, f.exec)
    const queued = await f.bridge.execute({ message }, f.exec)
    f.ctx.agents.get = () => replacement
    await timing.advance(5000)
    assert.equal(f.signals.length, 1)
    assert.equal(f.coordinator.activeCount, 1)
    const failed = f.jobs.status(parent, queued.bridgeJobId)
    assert.equal(failed.status, 'POSTMAN_BRIDGE_FAILED')
    assert.equal(failed.trustedStatus, 'POSTMAN_BRIDGE_PARENT_UNAVAILABLE')
    assert.equal(failed.notification, 'UNDELIVERED')
    f.ctx.agents.get = id => id === parent.id ? parent : undefined
    f.pending.get('child-1')({ stopReason: 'end_turn' })
    await tick()
    assert.equal((await f.read(first)).status, 'POSTMAN_BRIDGE_TERMINAL')
    await f.jobs.dispose()
  }
})

test('cleaned terminal releases coordinator slot while artifact grant remains pending', async () => {
  const timing = clock()
  const grant = deferred()
  let grantStarted = false
  const f = fixture({ coordinator: timing.coordinator, grants: { register(_owner, terminal) {
    assert.equal(terminal.result.assistantText, 'TRUSTED')
    assert.deepEqual(f.events.slice(-2), ['status', 'dispose'])
    grantStarted = true
    return grant.promise
  } } })
  const accepted = await f.bridge.execute({ message }, f.exec)
  const queued = await f.bridge.execute({ message }, f.exec)
  await tick()
  assert.equal(f.coordinator.activeCount, 1)
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  await tick()
  assert.equal(grantStarted, true)
  assert.equal(f.coordinator.activeCount, 0)
  assert.equal((await f.read(accepted)).status, 'POSTMAN_BRIDGE_RUNNING')
  assert.equal(f.events.includes('ready'), false)
  await timing.advance(5000)
  assert.equal(f.signals.length, 2)
  assert.equal(f.coordinator.activeCount, 1)
  assert.equal((await f.read(queued)).status, 'POSTMAN_BRIDGE_RUNNING')
  grant.resolve()
  await tick()
  assert.equal((await f.read(accepted)).status, 'POSTMAN_BRIDGE_TERMINAL')
  f.pending.get('child-2')({ stopReason: 'end_turn' })
  await tick()
  assert.equal((await f.read(queued)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(f.events.at(-1), 'ready')
  await f.jobs.dispose()
})

test('failed child cleanup never registers an artifact grant', async () => {
  let registrations = 0
  const f = fixture({ onDispose: () => { throw Error('dispose failed') },
    grants: { register() { registrations += 1 } } })
  const accepted = await f.bridge.execute({ message }, f.exec)
  await tick()
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  await tick()
  assert.equal(f.coordinator.activeCount, 0)
  const failed = await f.read(accepted)
  assert.equal(failed.status, 'POSTMAN_BRIDGE_FAILED')
  assert.match(failed.diagnostic, /dispose failed/)
  assert.equal(registrations, 0)
  await f.jobs.dispose()
})

test('grant rejection leaves trusted terminal intact and records separate diagnostic', async () => {
  const f = fixture({ grants: { async register(_owner, terminal) {
    assert.equal(terminal.result.assistantText, 'TRUSTED')
    assert.deepEqual(f.events.slice(-2), ['status', 'dispose'])
    throw Error('grant unavailable')
  } } })
  const accepted = await f.bridge.execute({ message }, f.exec)
  await tick()
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  await tick()
  const result = await f.read(accepted)
  assert.equal(f.coordinator.activeCount, 0)
  assert.equal(result.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(result.result.assistantText, 'TRUSTED')
  assert.match(result.grantDiagnostic, /grant unavailable/)
  assert.equal(result.notification, 'DELIVERED')
  await f.jobs.dispose()
})

test('startup, missing child, reader failure become retained failures', async () => {
  for (const [onStart, onStatus, expected] of [
    [() => { throw Error('startup') }, undefined, /startup/],
    [() => ({ id: 'missing', localAgent: undefined, async dispose() {} }), undefined, /CHILD_UNAVAILABLE/],
    [() => ({ id: 'broken', localAgent: { id: 'broken' }, result: Promise.resolve({ stopReason: 'end_turn' }), async dispose() {} }),
      () => { throw Error('terminal reader') }, /terminal reader/],
  ]) {
    const f = fixture({ onStart, onStatus })
    const accepted = await f.bridge.execute({ message }, f.exec)
    await tick()
    const failed = await f.read(accepted)
    assert.equal(failed.status, 'POSTMAN_BRIDGE_FAILED')
    assert.match(JSON.stringify(failed), expected)
    assert.equal(f.coordinator.activeCount, 0)
    await f.jobs.dispose()
  }
})

test('queued and running jobs abort on manager disposal without unhandled rejection', async () => {
  let time = 0
  let timer
  const coordinator = createPostmanBridgeLaunchCoordinator({ now: () => time, random: () => 0,
    setTimer: (callback, delay) => (timer = { callback, delay }), clearTimer: () => { timer = undefined } })
  const f = fixture({ coordinator, onStart: request => ({ id: 'one', localAgent: { id: 'one' },
    result: new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ stopReason: 'abort' }))),
    async dispose() { f.events.push('dispose') } }) })
  const first = await f.bridge.execute({ message }, f.exec)
  const second = await f.bridge.execute({ message }, f.exec)
  assert.equal((await f.read(second)).status, 'POSTMAN_BRIDGE_QUEUED')
  assert.equal(f.coordinator.activeCount, 1)
  await f.jobs.dispose()
  assert.equal(f.coordinator.activeCount, 0)
  assert.equal(f.signals[0].aborted, true)
  assert.equal(timer, undefined)
  assert.ok(first.bridgeJobId !== second.bridgeJobId)
})

test('same Leader mixed Ask/Ask/Postman executes FIFO, max three with jitter and REQ grants isolated', async () => {
  const timing = clock(), base = 'a'.repeat(40), commits = ['b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40), '1'.repeat(40)]
  const lineage = new Map([[base, null], ...commits.map((sha, index) => [sha, index ? commits[index - 1] : base])])
  const context = Object.freeze({ branch: 'task/postman-' + 'a'.repeat(32), baseCommit: base })
  const syncBarriers = new Map([[commits[2], deferred()]]), syncEntered = new Map(commits.map(sha => [sha, deferred()]))
  let syncTail = Promise.resolve()
  let syncLocks = 0, runnerLock = false, restoreLock = false
  const contexts = {
    get: id => id === parent.id ? context : null, isRestoring: () => restoreLock, hasActiveOperation: () => runnerLock,
    bindChild: () => true, releaseChild() {}, beginSync: () => { syncLocks++; return true }, endSync: () => { syncLocks-- },
    beginOperation: () => { if (syncLocks || runnerLock || restoreLock) return false; runnerLock = true; return true },
    reserveRestore: () => { if (syncLocks || runnerLock || restoreLock) return false; restoreLock = true; return true }, releaseRestore: () => { restoreLock = false },
    async sync(_id, commit, expectedBase) {
      const chain = sha => { const result = []; while (sha) { result.push(sha); sha = lineage.get(sha) } return result }
      assert.equal(lineage.get(commit), expectedBase)
      assert.ok(chain(commit).includes(expectedBase), 'receipt has exact expected parent lineage')
      const previousSync = syncTail
      let releaseSync
      syncTail = new Promise(resolve => { releaseSync = resolve })
      await previousSync
      try {
        const remoteAtFetch = taskState.remote
        assert.ok(chain(remoteAtFetch).includes(commit), 'fetched remote tip must contain receipt commit')
        assert.ok(chain(remoteAtFetch).includes(taskState.head), 'remote must fast-forward current local HEAD')
        syncs.push({ expectedBase, commit, remoteAtFetch })
        syncEntered.get(commit)?.resolve()
        if (syncBarriers.has(commit)) await syncBarriers.get(commit).promise
        taskState.head = remoteAtFetch; return true
      } finally { releaseSync() }
    },
  }
  const starts = [], syncs = [], registered = [], taskState = { head: base, remote: commits[4] }
  const grantsByOwnerAndReq = new Map()
  const grants = {
    async register(owner, terminal) {
      const result = terminal?.result
      if (terminal?.transportKind !== 'artifact' || terminal.terminalStatus !== 'COMPLETED' || result?.code !== 'RESULT_DURABLE' ||
          result?.requestId !== terminal.requestId || result?.expectedFilename !== `POSTMAN_${terminal.requestId}_RESULT.zip` || !result?.sha256) return false
      const key = JSON.stringify([owner, terminal.requestId])
      grantsByOwnerAndReq.set(key, result.taskPublicationCommit)
      registered.push([owner, terminal.requestId, terminal.transportKind]); return true
    },
    resolve(owner, requestId) { return grantsByOwnerAndReq.get(JSON.stringify([owner, requestId])) ?? null },
  }
  const f = fixture({ contexts, coordinator: timing.coordinator, grants, onStart: request => {
    const id = 'child-' + (starts.length + 1), result = deferred()
    starts.push({ id, request, result }); return { id, localAgent: { id }, result: result.promise, async dispose() {} }
  }, onStatus: (_args, execution) => {
    const index = Number(execution.agent.id.slice(6)) - 1
    const commitIndex = index
    const requestId = 'REQ_20261001T00000' + (index + 1) + 'Z_0001'
    const artifact = execution.agent.id === 'child-3'
    const value = artifact
      ? { ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE', requestId, repository: 'AndrewVerhoturov1/dsh-workspace',
          expectedFilename: `POSTMAN_${requestId}_RESULT.zip`, resultZip: 'C:/temp/' + `POSTMAN_${requestId}_RESULT.zip`, sha256: '1'.repeat(64),
          taskPublicationCommit: commits[commitIndex], baseCommit: commitIndex ? commits[commitIndex - 1] : base }
      : { ok: true, code: 'TEXT_RESULT_DURABLE', state: 'TEXT_RESULT_DURABLE', requestId, assistantText: 'exact Ask answer',
          taskPublicationCommit: commits[commitIndex], baseCommit: commitIndex ? commits[commitIndex - 1] : base }
    return { status: 'COMPLETED', requestId, result: value }
  } })
  const inputs = [
    { message: '@PostmanAsk ask-a', transport: 'text' },
    { message: '@PostmanAsk ask-b', transport: 'text' },
    { message: '@Postman task-c', transport: 'artifact' },
  ]
  const accepted = await Promise.all(inputs.map(({ message }) => f.bridge.execute({ message }, f.exec)))
  assert.deepEqual(accepted.map(x => x.status), Array(3).fill('POSTMAN_BRIDGE_ACCEPTED'))
  const fourth = await f.bridge.execute({ message: '@PostmanAsk queued-fourth', }, f.exec)
  assert.equal(fourth.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal((await f.read(fourth)).status, 'POSTMAN_BRIDGE_QUEUED')
  await tick(); assert.equal(starts.length, 1); assert.equal(timing.coordinator.activeCount, 1)
  await timing.advance(5000); assert.equal(starts.length, 2)
  await timing.advance(5000); assert.equal(starts.length, 3)
  assert.equal(starts[2].request.prompt[0].text, inputs[2].message)
  assert.equal(f.jobs.status(parent, accepted[1].bridgeJobId).state, 'RUNNING')
  assert.equal(f.jobs.status(parent, accepted[2].bridgeJobId).state, 'RUNNING')
  assert.equal(starts[0].request.prompt[0].text, inputs[0].message)
  assert.deepEqual(starts.map(x => x.request.prompt[0].text), inputs.map(x => x.message))
  assert.deepEqual(starts.map(x => x.request.label.includes('Ask') ? 'text' : 'artifact'), inputs.map(x => x.transport))
  assert.ok(starts.every(x => x.request.signal instanceof AbortSignal))
  assert.equal(new Set(accepted.map((_, index) => 'REQ_20261001T00000' + (index + 1) + 'Z_0001')).size, 3)
  assert.equal(new Set(starts.map(x => x.id)).size, 3)
  // Finish in reverse start order. Each terminal is tied to a distinct exact REQ.
  starts[2].result.resolve({ stopReason: 'end_turn' }); await tick(); await tick(); await tick()
  await syncEntered.get(commits[2]).promise
  assert.equal((await f.read(accepted[2])).status, 'POSTMAN_BRIDGE_RUNNING')
  assert.equal(contexts.hasActiveOperation(parent.id), false)
  assert.equal(syncLocks, 1)
  assert.equal(contexts.beginOperation(parent.id), false, 'runner remains locked during terminal sync')
  assert.equal(contexts.reserveRestore(parent.id), false, 'restore remains locked during terminal sync')
  const duringSync = await f.bridge.execute({ message: '@PostmanAsk accepted-during-sync' }, f.exec)
  assert.equal(duringSync.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal((await f.read(duringSync)).status, 'POSTMAN_BRIDGE_QUEUED')
  syncBarriers.get(commits[2]).resolve(); await tick(); await tick()
  assert.deepEqual(registered.map(x => x.slice(0, 2)), [[parent.id, 'REQ_20261001T000003Z_0001']])
  assert.equal(grants.resolve(parent.id, 'REQ_20261001T000001Z_0001'), null)
  assert.equal(grants.resolve(parent.id, 'REQ_20261001T000002Z_0001'), null)
  await timing.advance(15000); assert.equal(starts.length, 4)
  assert.equal(starts[3].request.prompt[0].text, '@PostmanAsk queued-fourth')
  assert.equal(timing.coordinator.activeCount, 3)
  starts[3].result.resolve({ stopReason: 'end_turn' }); await tick(); await tick(); await tick()
  await syncEntered.get(commits[3]).promise
  assert.equal((await f.read(fourth)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await f.read(duringSync)).status, 'POSTMAN_BRIDGE_RUNNING')
  starts[1].result.resolve({ stopReason: 'end_turn' }); starts[0].result.resolve({ stopReason: 'end_turn' })
  await tick(); await tick(); await tick(); await tick(); await tick()
  assert.deepEqual(accepted.map(x => f.jobs.status(parent, x.bridgeJobId).status), Array(3).fill('POSTMAN_BRIDGE_TERMINAL'))
  assert.deepEqual(registered.map(x => x[1]), ['REQ_20261001T000003Z_0001'])
  assert.deepEqual(registered.map(x => x[2]), ['artifact'])
  assert.equal((await f.read(duringSync)).status, 'POSTMAN_BRIDGE_RUNNING')
  for (const [owner, requestId] of registered.map(x => x.slice(0, 2))) {
    assert.equal(grants.resolve(owner, requestId), commits[Number(requestId.slice(18, 19)) - 1])
    assert.equal(grants.resolve('other-leader', requestId), null)
  }
  assert.equal(syncs.length, 4)
  assert.equal(syncLocks, 0)
  await timing.advance(15000); assert.equal(starts.length, 5)
  assert.equal(starts[4].request.prompt[0].text, '@PostmanAsk accepted-during-sync')
  starts[4].result.resolve({ stopReason: 'end_turn' }); await tick(); await tick(); await tick()
  assert.equal((await f.read(duringSync)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await f.read(fourth)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.deepEqual(syncs.map(x => x.commit), [commits[2], commits[3], commits[1], commits[0], commits[4]])
  assert.deepEqual(syncs.map(x => x.remoteAtFetch), [commits[4], commits[4], commits[4], commits[4], commits[4]])
  for (const sync of syncs) {
    const chain = sha => { const result = []; while (sha) { result.push(sha); sha = lineage.get(sha) } return result }
    assert.ok(chain(sync.remoteAtFetch).includes(sync.commit), 'each fetched C5 tip contains receipt')
    assert.ok(chain(sync.remoteAtFetch).includes(sync.expectedBase), 'each expected parent is in fetched ancestry')
  }
  assert.deepEqual(registered.map(x => x[1]), ['REQ_20261001T000003Z_0001'])
  assert.equal(grants.resolve(parent.id, 'REQ_20261001T000005Z_0001'), null)
  assert.equal(timing.coordinator.activeCount, 0)
  await f.jobs.dispose()
})

test('Leader accepts Bridge then Worker while Web is pending', async () => {
  const f = fixture()
  const accepted = await f.bridge.execute({ message }, f.exec)
  f.ctx.subagents.startContinuable = async () => ({ childId: 'worker-1', messageId: 'worker-message' })
  const worker = createPostmanWorkerTools(f.ctx)
  const workerReceipt = await worker.taskTool.execute({ task: 'Read local files' }, f.exec)
  assert.equal(workerReceipt.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
  worker.dispose()
  assert.equal((await f.read(accepted)).status, 'POSTMAN_BRIDGE_RUNNING')
  await tick()
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  await tick()
  assert.equal((await f.read(accepted)).status, 'POSTMAN_BRIDGE_TERMINAL')
  await f.jobs.dispose()
})
