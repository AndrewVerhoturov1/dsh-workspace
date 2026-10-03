import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DirectPostmanJobManager } from './direct-current-turn.js'
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

function fixture({ coordinator = createPostmanBridgeLaunchCoordinator(), grants, onDispose, onStart, onStatus, onWake, parentAgent = parent } = {}) {
  const pending = new Map()
  const signals = []
  const events = []
  const ctx = {
    agents: { get: id => id === parentAgent.id ? parentAgent : undefined },
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
  parentAgent.followup = value => { events.push('ready'); onWake?.(value) }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants)
  const bridge = createPostmanBridgeTool(ctx, jobs)
  const status = createPostmanBridgeStatusTool(ctx, jobs)
  const exec = { agent: parentAgent, signal: new AbortController().signal }
  const read = receipt => status.execute({ bridge_job_id: receipt.bridgeJobId }, exec)
  return { ctx, jobs, bridge, status, exec, pending, signals, events, read, coordinator }
}

test('pilot supervisor owns its existing Bridge lifecycle and terminal status', async () => {
  const pilot = { id: 'pilot-bridge', session: { header: { agentPreset: 'postman-leader-ptc', delegationDepth: 0 } } }
  let wake
  const f = fixture({ parentAgent: pilot, onWake: value => { wake = value },
    onStart(request) {
      assert.equal(request.parent, pilot)
      assert.equal(request.agentOptions.model, 'gpt-6-luna')
      assert.equal(request.maxDepth, 1)
      const result = new Promise(resolve => f.pending.set('pilot-child', resolve))
      return { id: 'pilot-child', localAgent: { id: 'pilot-child' }, result, async dispose() {} }
    } })
  const accepted = await f.bridge.execute({ message }, f.exec)
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await tick()
  f.pending.get('pilot-child')({ stopReason: 'end_turn', finalText: 'UNTRUSTED' })
  await tick()
  assert.equal((await f.read(accepted)).result.assistantText, 'TRUSTED')
  assert.match(JSON.stringify(wake), /POSTMAN_BRIDGE_READY/)
  assert.doesNotMatch(JSON.stringify(wake), /TRUSTED|assistantText/)
  f.ctx.agents.get = id => id === pilot.id ? pilot : id === parent.id ? parent : undefined
  assert.equal((await f.status.execute({ bridge_job_id: accepted.bridgeJobId }, { agent: parent })).status,
    'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  await f.jobs.dispose()
})

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
  assert.equal((await f.jobs.status(parent, accepted.bridgeJobId)).notification, 'UNDELIVERED')
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
  assert.equal((await f.jobs.status(parent, missing.bridgeJobId)).trustedStatus,
    'POSTMAN_BRIDGE_PARENT_UNAVAILABLE')
  assert.equal((await f.jobs.status(parent, missing.bridgeJobId)).notification, 'UNDELIVERED')
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
    const failed = await f.jobs.status(parent, queued.bridgeJobId)
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

test('false artifact grant registration is not a successful handoff', async () => {
  const artifact = { requestId: 'REQ_20260925T112233Z_1234', ok: true, code: 'RESULT_DURABLE', state: 'RESULT_DURABLE',
    resultZip: 'C:/result.zip' }
  const f = fixture({ grants: { async register(owner, terminal) {
    assert.equal(owner, parent.id)
    assert.deepEqual(terminal.result, artifact)
    return false
  } }, onStatus: () => ({ status: 'COMPLETED', requestId: artifact.requestId, result: artifact }) })
  const accepted = await f.bridge.execute({ message: '@Postman make package' }, f.exec)
  await tick()
  f.pending.get('child-1')({ stopReason: 'end_turn' })
  await tick()
  const result = await f.read(accepted)
  assert.equal(result.status, 'POSTMAN_BRIDGE_FAILED')
  assert.equal(result.state, 'FAILED')
  assert.equal(result.trustedStatus, 'POSTMAN_BRIDGE_TERMINAL')
  assert.deepEqual(result.result, artifact)
  assert.match(result.grantDiagnostic, /grant registration rejected/i)
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
  f.ctx.subagents.startContinuable = async spec => ({ childId: spec.childId, messageId: 'worker-message' })
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
// Exercise the public Leader API against the real Python capability/claim, not a supplied eligibility flag.
test('Leader Bridge recovery reaches Direct once; negative capabilities and restart remain mechanical', async t => {
  const workspace = fileURLToPath(new URL('../../../', import.meta.url))
  const original = 'REQ_20261003T010203Z_1234'
  const branch = 'task/postman-' + 'a'.repeat(32)
  for (const [name, fields, eligible, kind] of [
    ['proven sent', {}, true, 'artifact'],
    ['Ask proven sent', { state: 'ASK_FAILED' }, true, 'text'],
    ['Image generation', {}, true, 'image'],
    ['Image packaging', { imageGenerated: true }, true, 'image'],
    ['not sent', { sendProofClass: 'PROVEN_NOT_SENT' }, false, 'artifact'],
    ['unknown', { sendProofClass: 'UNKNOWN' }, false, 'artifact'],
    ['unknown exact reproof', { sendProofClass: 'UNKNOWN', promptSha256: 'b'.repeat(64),
      readOnlySendReproof: { requestId: original, conversationId: 'exact-chat',
        conversationUrl: 'https://chatgpt.com/c/exact-chat', exactUserTurn: true, promptSha256: 'b'.repeat(64) } }, true, 'artifact'],
    ['unresolved unknown', { unresolvedSendUnknown: true }, false, 'artifact'],
    ['durable result', { state: 'RESULT_DURABLE', ok: true }, false, 'artifact'],
    ['Web result download failed', { webResultAvailable: true }, false, 'artifact'],
  ]) await t.test(name, async () => {
    const root = mkdtempSync(join(tmpdir(), 'postman-leader-recovery-'))
    try {
      mkdirSync(join(root, 'requests'))
      writeFileSync(join(root, 'requests', original + '.json'), JSON.stringify({ requestId: original,
        repository: 'AndrewVerhoturov1/dsh-workspace', state: 'FAILED', failureCode: 'CONTROLLED_FAILURE',
        sendProofClass: 'PROVEN_SENT', conversationId: 'exact-chat', conversationUrl: 'https://chatgpt.com/c/exact-chat', ...fields }))
      const leader = { id: 'recovery-leader', session: { header: { cwd: workspace, agentPreset: 'postman-leader' } }, followup() {} }
      const terminal = { status: 'COMPLETED', requestId: original, result: { ok: false,
        code: 'POSTMAN_TRANSPORT_FAILED', requestId: original, transportCode: 'CONTROLLED_FAILURE',
        transportMessage: 'controlled post-send failure', details: {} } }
      const context = { branch }
      let persisted, sends = 0, argv
      const contexts = { get: () => context, bindChild: () => true, releaseChild() {},
        record: () => ({ bridgeOperations: persisted }) }
      const direct = new DirectPostmanJobManager({ directRoot: root, exists: () => true,
        spawn(_command, args) {
          sends++; argv = args
          const requestId = args[args.indexOf('-RequestId') + 1]
          // This stands in for Direct's pre-publication phase, using its actual durable claim.
          execFileSync(process.env.POSTMAN_PYTHON ?? 'python', ['-X', 'utf8', '-c',
            'import sys; sys.path.insert(0,sys.argv[1]); import postman_direct; import chat_reference as c; r=c.resolve_chat_reference(sys.argv[2],sys.argv[3],expected_repository="AndrewVerhoturov1/dsh-workspace"); c.claim_recovery(sys.argv[2],r,sys.argv[4])',
            join(workspace, 'postman', 'direct'), root, original, requestId])
          const child = new EventEmitter()
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
          queueMicrotask(() => { child.emit('spawn'); setImmediate(() => {
            child.stdout.emit('data', JSON.stringify({ ...terminal.result, requestId }))
            child.emit('close', 1)
          }) })
          return child
        } })
      const ctx = { agents: { get: id => id === leader.id ? leader : undefined },
        subagents: { async start() { return { id: 'bridge-child', localAgent: { id: 'bridge-child' },
          result: Promise.resolve({ stopReason: 'end_turn' }), async dispose() {} } } },
        tools: { get: () => ({ execute: async () => terminal }) } }
      const coordinator = { run: (_signal, launch) => launch(), dispose() {} }
      const jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts, null, direct)
      const status = createPostmanBridgeStatusTool(ctx, jobs)
      const exec = { agent: leader }
      const first = await jobs.accept(leader, '@Postman ORIGINAL_PROMPT_MUST_NOT_REPEAT', kind)
      await tick(); await tick()
      const visible = await status.execute({ bridge_job_id: first.bridgeJobId }, exec)
      assert.equal(visible.recoveryEligible, eligible, JSON.stringify(await direct.recoveryCapability(workspace, original)))
      const recovery = await status.execute({ bridge_job_id: first.bridgeJobId, recover: true }, exec)
      if (!eligible) {
        assert.equal(recovery.status, 'POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED')
        assert.equal(sends, 0)
      } else {
        assert.equal(recovery.status, 'POSTMAN_BRIDGE_ACCEPTED')
        await tick(); await tick()
        assert.equal(sends, 1)
        const newId = argv[argv.indexOf('-RequestId') + 1]
        assert.notEqual(newId, original)
        assert.equal(argv[argv.indexOf('-ChatRequestId') + 1], original)
        assert.ok(argv.includes('-AutomaticContinuation'))
        assert.equal(argv.includes('-ImageMode'), kind === 'image')
        assert.equal(argv.find(value => value.endsWith('.ps1')).endsWith('postman-ask.ps1'), kind === 'text')
        assert.doesNotMatch(Buffer.from(argv[argv.indexOf('-TaskBase64') + 1], 'base64').toString('utf8'), /ORIGINAL_PROMPT/)
        const proof = await direct.recoveryCapability(workspace, original)
        assert.equal(proof.conversation_url, 'https://chatgpt.com/c/exact-chat')
        assert.equal(proof.automatic_recovery_used, true)
        assert.equal((await status.execute({ bridge_job_id: first.bridgeJobId, recover: true }, exec)).status,
          'POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED')
        persisted = { [first.bridgeJobId]: { state: 'received', synchronization: 'not-required',
          terminal: { ...visible, status: 'POSTMAN_BRIDGE_TERMINAL', transportKind: kind } } }
        const cold = createPostmanBridgeJobs(ctx, coordinator, null, contexts, null,
          new DirectPostmanJobManager({ directRoot: root, spawn() { assert.fail('restart must not spawn') } }))
        assert.equal((await createPostmanBridgeStatusTool(ctx, cold).execute({ bridge_job_id: first.bridgeJobId, recover: true }, exec)).status,
          'POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED')
        await cold.dispose()
        assert.equal(sends, 1)
      }
      await jobs.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

