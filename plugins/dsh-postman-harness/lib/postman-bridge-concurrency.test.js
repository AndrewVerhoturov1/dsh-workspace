import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeTool, createPostmanBridgeStatusTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createPostmanWorkerTools, postmanWorkerDeniedTools } from './postman-worker.js'

const parent = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const message = '@PostmanAsk independent text'

function fixture({ coordinator = createPostmanBridgeLaunchCoordinator(), onDispose, onStart, onStatus, onWake } = {}) {
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
  const jobs = createPostmanBridgeJobs(ctx, coordinator)
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
