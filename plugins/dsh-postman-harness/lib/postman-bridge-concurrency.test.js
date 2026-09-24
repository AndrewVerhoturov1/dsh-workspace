import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeTool, createPostmanBridgeStatusTool } from './postman-bridge.js'
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

function fixture({ coordinator = createPostmanBridgeLaunchCoordinator(), grants, onDispose, onStart, onStatus, onWake } = {}) {
  const pending = new Map()
  const signals = []
  const events = []
  const ctx = {
    agents: { get: id => id === parent.id ? parent : undefined },
    subagents: { async start(_provider, request) {
      signals.push(request.signal)
      events.push('start')
      if (onStart) return onStart(request)
      const id = 'child-' + signals.length
      const result = new Promise(resolve => pending.set(id, resolve))
      return { id, localAgent: { id }, result, async dispose() {
        events.push('dispose')
        await onDispose?.()
      } }
    } },
    tools: { get(_name, child) { return { async execute(_args, exec) {
      assert.equal(exec.agent, child)
      events.push('status')
      return onStatus?.() ?? { status: 'COMPLETED', requestId: 'REQ_1',
        result: { requestId: 'REQ_1', assistantText: 'TRUSTED' } }
    } } }, schemas: () => [{ name: 'postman_bridge_status' }, { name: 'read' }] },
  }
  parent.followup = value => { events.push('ready'); onWake?.(value) }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants)
  const bridge = createPostmanBridgeTool(ctx, jobs)
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
