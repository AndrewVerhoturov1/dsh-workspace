import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createPostmanBridgeStatusTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createDevspaceChannel, devspaceTerminal } from './postman-devspace.js'
import { boundedJson } from '../../dsh-ptc/src/json.js'
import { DEFAULT_LIMITS } from '../../dsh-ptc/src/profiles.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const parent = { id: 'leader-json', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } }, followup() {} }

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture({ onStart, onStatus, onDispose, onWake, grants, coordinator, contexts, direct } = {}) {
  const ctx = new Context()
  ctx.systemPrompt = { tools() {} }
  new ToolRuntime(ctx)
  ctx.agents = { get: id => id === parent.id ? parent : undefined }
  ctx.subagents = { start: onStart ?? (async () => ({ id: 'child-json', localAgent: { id: 'child-json' },
    result: Promise.resolve({ stopReason: 'end_turn' }), dispose: onDispose ?? (async () => {}) })) }
  const statusReader = onStatus ?? (() => ({ status: 'COMPLETED', requestId: 'REQ_JSON',
    result: { requestId: 'REQ_JSON', assistantText: 'exact trusted text' } }))
  const get = ctx.tools.get.bind(ctx.tools)
  ctx.tools.get = (name, agent) => name === 'postman_current_turn_status'
    ? { execute: statusReader } : get(name, agent)
  const jobs = createPostmanBridgeJobs(ctx, coordinator ?? createPostmanBridgeLaunchCoordinator(), grants, contexts, undefined, direct)
  ctx.tools.register(createPostmanBridgeStatusTool(ctx, jobs))
  parent.followup = onWake ?? (() => {})
  let next = 0
  async function read(accepted) {
    return ctx.tools.execute({ callId: 'status-json-' + ++next, name: 'postman_bridge_status',
      arguments: { bridge_job_id: accepted.bridgeJobId }, agent: parent,
      signal: new AbortController().signal })
  }
  return { ctx, jobs, read, accept: () => jobs.accept(parent, '@PostmanAsk exact', 'text') }
}

function valid(reply, expected) {
  assert.equal(reply.isError, false, reply.error?.message)
  assert.equal(reply.value.status, expected)
  return reply.value
}

test('actual ToolRuntime rejects old undefined fields before render', async () => {
  const f = fixture()
  f.ctx.tools.register({ name: 'old_bridge_status', description: 'invalid former status',
    parameters: {}, output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => ({ status: 'POSTMAN_BRIDGE_TERMINAL', childDiagnostic: undefined }) })
  const rejected = await f.ctx.tools.execute({ callId: 'old-status', name: 'old_bridge_status',
    arguments: {}, agent: parent, signal: new AbortController().signal })
  assert.equal(rejected.isError, true)
  assert.equal(rejected.error.message,
    'tool "old_bridge_status" returned invalid output: value is not lossless JSON')
  const accepted = f.accept()
  await tick()
  valid(await f.read(accepted), 'POSTMAN_BRIDGE_TERMINAL')
  await f.jobs.dispose()
})

test('queued, starting, running, success, and READY metadata survive runtime validation', async () => {
  const admission = deferred()
  const run = deferred()
  const wakes = []
  const coordinator = { run: (_signal, task) => admission.promise.then(task), dispose() {} }
  const f = fixture({ coordinator, onStart: async () => ({ id: 'child-json', localAgent: { id: 'child-json' },
    result: run.promise, async dispose() {} }), onWake: value => wakes.push(value) })
  const accepted = f.accept()
  valid(await f.read(accepted), 'POSTMAN_BRIDGE_QUEUED')
  admission.resolve()
  let current = valid(await f.read(accepted), 'POSTMAN_BRIDGE_RUNNING')
  assert.equal(current.state, 'STARTING')
  await tick()
  current = valid(await f.read(accepted), 'POSTMAN_BRIDGE_RUNNING')
  assert.equal(current.state, 'RUNNING')
  run.resolve({ stopReason: 'end_turn' })
  await tick()
  const terminal = valid(await f.read(accepted), 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(terminal.trustedStatus, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(terminal.terminalStatus, 'COMPLETED')
  assert.equal(terminal.requestId, 'REQ_JSON')
  assert.equal(terminal.childSessionId, 'child-json')
  assert.equal(terminal.result.assistantText, 'exact trusted text')
  assert.equal(terminal.notification, 'DELIVERED')
  assert.equal(terminal.childDiagnostic, null)
  assert.equal(terminal.diagnostic, null)
  assert.equal(wakes.length, 1)
  assert.doesNotMatch(JSON.stringify(wakes[0]), /exact trusted text|assistantText/)
  await f.jobs.dispose()
})

test('missing job and unauthorized caller return lossless JSON', async () => {
  const f = fixture()
  valid(await f.read({ bridgeJobId: 'unknown' }), 'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  const result = await f.ctx.tools.execute({ callId: 'foreign-status', name: 'postman_bridge_status',
    arguments: { bridge_job_id: 'unknown' }, agent: { id: 'foreign' },
    signal: new AbortController().signal })
  valid(result, 'POSTMAN_BRIDGE_CALLER_REJECTED')
  await f.jobs.dispose()
})

test('terminal journal projection passes unchanged PTC limits and preserves trusted state', async () => {
  for (const eventCount of [64, 256]) {
    const journal = Array.from({ length: eventCount }, (_, index) => ({
      timestamp: index, eventId: 'event-' + index, type: 'observe', phase: 'WORKING',
      templateId: 'template-' + index,
      proof: Array.from({ length: 64 }, (_unused, field) => ({ state: 'WORKING', count: field }))
    }))
    const terminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'FAILED',
      requestId: 'REQ_20261005T074704Z_0717', transportKind: 'artifact', result: {
        requestId: 'REQ_20261005T074704Z_0717', code: 'POSTMAN_TRANSPORT_FAILED', error: 'ASSISTANT_TURN_TIMEOUT',
        details: { phase: 'assistant-wait', sendState: 'PROVEN_SENT', webResultAvailable: false,
          transportEventJournal: journal }
      } }
    const retainedJson = JSON.stringify(terminal)
    assert.throws(() => boundedJson(terminal, DEFAULT_LIMITS), { code: 'maxValueNodes' })
    const operation = { state: 'received', synchronization: 'not-required', terminal }
    const contexts = { get: () => ({}), record: () => ({ bridgeOperations: { job: operation } }),
      bindChild: () => true, releaseChild() {} }
    const direct = { async recoveryCapability() { return { recovery_eligible: true } } }
    const f = fixture({ contexts, direct })
    const reply = valid(await f.read({ bridgeJobId: 'job' }), 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(reply.terminalStatus, 'FAILED')
    assert.equal(reply.requestId, 'REQ_20261005T074704Z_0717')
    assert.equal(reply.trustedStatus, 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(Object.hasOwn(reply, 'recoveryEligible'), false)
    assert.equal(reply.synchronization, 'not-required')
    assert.equal(reply.result.code, 'POSTMAN_TRANSPORT_FAILED')
    assert.equal(reply.result.error, 'ASSISTANT_TURN_TIMEOUT')
    assert.equal(reply.result.details.phase, 'assistant-wait')
    assert.equal(reply.result.details.sendState, 'PROVEN_SENT')
    assert.equal(reply.result.details.webResultAvailable, false)
    assert.deepEqual(reply.result.details.transportEventJournalSummary, {
      eventCount, droppedCount: eventCount, lastEvent: {
        timestamp: eventCount - 1, eventId: 'event-' + (eventCount - 1),
        type: 'observe', phase: 'WORKING', templateId: 'template-' + (eventCount - 1)
      }
    })
    assert.equal(Object.hasOwn(reply.result.details, 'transportEventJournal'), false)
    assert.equal(operation.terminal, terminal)
    assert.equal(JSON.stringify(operation.terminal), retainedJson)
    const encoded = boundedJson(reply, DEFAULT_LIMITS)
    assert.equal(encoded.value.result.details.transportEventJournalSummary.eventCount, eventCount)
    assert.ok(encoded.bytes < DEFAULT_LIMITS.maxOutputBytes)
    await f.jobs.dispose()
  }
})

test('small artifact, text and image results are retained without losing metadata', async () => {
  const descriptors = [
    { ok: true, requestId: 'REQ_20261005T000001Z_0001', code: 'RESULT_DURABLE', resultZip: 'C:/result.zip', sha256: 'abc',
      metadata: { files: ['manifest.json'], bytes: 7 } },
    { ok: true, requestId: 'REQ_20261005T000002Z_0002', code: 'TEXT_RESULT_DURABLE', deliveryMode: 'inline',
      assistantText: 'exact trusted text', assistantTextSha256: 'abc' },
    { ok: true, requestId: 'REQ_20261005T000003Z_0003', code: 'TEXT_RESULT_DURABLE', deliveryMode: 'file',
      resultFile: 'C:/answer.md', resultFileSha256: 'abc', resultFileByteLength: 4097 },
    { ok: true, requestId: 'REQ_20261005T000004Z_0004', code: 'IMAGE_RESULT_DURABLE', state: 'IMAGE_RESULT_DURABLE',
      resultImage: 'C:/image.png', imageFormat: 'png', imageSha256: 'abc', imageByteLength: 7,
      imageWidth: 20, imageHeight: 30, imageMimeType: 'image/png' }
  ]
  for (const descriptor of descriptors) {
    const f = fixture({ grants: { async register(leaderId, terminal) {
      assert.equal(leaderId, parent.id)
      assert.deepEqual(terminal.result, descriptor)
      return true
    } }, onStatus: () => ({ status: 'COMPLETED', requestId: descriptor.requestId, result: descriptor }) })
    const accepted = f.accept()
    await tick()
    const reply = valid(await f.read(accepted), 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(reply.terminalStatus, 'COMPLETED')
    assert.equal(reply.requestId, descriptor.requestId)
    assert.deepEqual(reply.result, descriptor)
    assert.equal(JSON.stringify(reply.result), JSON.stringify(descriptor))
    boundedJson(reply, DEFAULT_LIMITS)
    await f.jobs.dispose()
  }
})

test('aborted and disposed jobs remain lossless while retained and then disappear', async () => {
  const run = deferred()
  const f = fixture({ onStart: async () => ({ id: 'child-json', localAgent: { id: 'child-json' },
    result: run.promise, async dispose() {} }), onStatus: () => ({ status: 'NO_JOB' }) })
  const accepted = f.accept()
  await tick()
  const disposing = f.jobs.dispose()
  valid(await f.read(accepted), 'POSTMAN_BRIDGE_RUNNING')
  run.resolve({ stopReason: 'abort' })
  await disposing
  valid(await f.read(accepted), 'POSTMAN_BRIDGE_JOB_NOT_FOUND')
})

test('ordinary JSON serialization errors remain local job diagnostics', async () => {
  for (const malformed of [{ invalid: BigInt(1) }, (() => { const cycle = {}; cycle.self = cycle; return cycle })()]) {
    const f = fixture({ onStatus: () => ({ status: 'COMPLETED', requestId: 'REQ_BAD', result: malformed }) })
    const accepted = f.accept()
    await tick()
    const failed = valid(await f.read(accepted), 'POSTMAN_BRIDGE_FAILED')
    assert.match(failed.diagnostic, /BigInt|circular/)
    assert.equal(failed.result, null)
    await f.jobs.dispose()
  }
})
