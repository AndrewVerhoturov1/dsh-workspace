import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { createPostmanBridgeStatusTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const parent = { id: 'leader-json', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } }, followup() {} }

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture({ onStart, onStatus, onDispose, onWake, grants, coordinator, contexts } = {}) {
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
  const jobs = createPostmanBridgeJobs(ctx, coordinator ?? createPostmanBridgeLaunchCoordinator(), grants, contexts)
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

test('artifact descriptor is retained without losing metadata', async () => {
  const descriptor = { requestId: 'REQ_ART', resultZip: 'C:/result.zip', sha256: 'abc',
    metadata: { files: ['manifest.json'], bytes: 7 } }
  const f = fixture({ onStatus: () => ({ status: 'COMPLETED', requestId: 'REQ_ART', result: descriptor }) })
  const accepted = f.accept()
  await tick()
  assert.deepEqual(valid(await f.read(accepted), 'POSTMAN_BRIDGE_TERMINAL').result, descriptor)
  await f.jobs.dispose()
})

test('bound publication synchronizes before grant and reports JSON-safe failure', async () => {
  const publication = { ok: true, code: 'RESULT_DURABLE', taskPublicationCommit: 'b'.repeat(40), baseCommit: 'a'.repeat(40) }
  for (const acceptedSync of [true, false, 'throws']) {
    const order = []
    const context = { branch: 'task/postman-context' }
    const contexts = { get: () => context, bindChild: () => true, releaseChild() {},
      async sync(_leader, publicationCommit, baseCommit) {
        assert.equal(publicationCommit, publication.taskPublicationCommit)
        assert.equal(baseCommit, publication.baseCommit)
        order.push('sync')
        if (acceptedSync === 'throws') throw new Error('remote unavailable')
        return acceptedSync === false ? { ok: false, diagnostic: { code: 'WORKTREE_DIRTY' } } : acceptedSync
      } }
    const grants = { async register() { order.push('grant'); return true } }
    const f = fixture({ contexts, grants, onStatus: () => ({ status: 'COMPLETED',
      requestId: 'REQ_SYNC', result: publication }) })
    const accepted = f.accept()
    await tick()
    const reply = valid(await f.read(accepted), 'POSTMAN_BRIDGE_TERMINAL')
    assert.deepEqual(order, acceptedSync === true ? ['sync', 'grant'] : ['sync'])
    assert.deepEqual(reply.result, publication)
    assert.equal(reply.synchronization, acceptedSync === true ? 'synchronized' : 'busy')
    if (acceptedSync !== true) assert.deepEqual(reply.syncDiagnostic, { code: acceptedSync === 'throws' ? 'GIT_SYNC_FAILED' : 'WORKTREE_DIRTY' })
    await f.jobs.dispose()
  }
})

test('image transport failures release only with exact pre-publication proof', async () => {
  function durableContexts(bridgeOperations = {}) {
    const context = {}
    let current = { bridgeOperations }
    return {
      context,
      contexts: { get: () => context, record: () => current,
        async changeRecord(_leaderId, update) { current = update(current) },
        bindChild: () => true, releaseChild() {} },
      record: () => current
    }
  }

  const provenStore = durableContexts()
  let provenCount = 0
  const proven = fixture({ contexts: provenStore.contexts, onStatus: () => {
    const index = ++provenCount
    const requestId = 'REQ_PREPUBLICATION_' + index
    return { status: index % 2 ? 'FAILED' : 'COMPLETED', requestId, result: {
      ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId, transportCode: 'POSTMAN_ATTACHMENT_UPLOAD_TIMEOUT',
      transportMessage: 'pre-publication transport failure', publicationStarted: false,
      details: { sendState: 'PROVEN_NOT_SENT' }
    } }
  } })
  for (let i = 0; i < 4; i++) {
    const accepted = await proven.jobs.accept(parent, '@PostmanImage proven failure ' + i, 'image')
    assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
    await tick(); await tick()
    const terminal = await proven.jobs.status(parent, accepted.bridgeJobId)
    assert.equal(terminal.terminalStatus, i % 2 ? 'COMPLETED' : 'FAILED')
    assert.equal(terminal.synchronization, 'not-required')
    assert.equal(provenStore.record().bridgeOperations[accepted.bridgeJobId].synchronization, 'not-required')
  }
  assert.equal(provenCount, 4, 'not-required failures do not consume received backlog')
  await proven.jobs.dispose()

  const incompleteStore = durableContexts()
  let incompleteCount = 0
  const incomplete = fixture({ contexts: incompleteStore.contexts, onStatus: () => {
    const requestId = 'REQ_INCOMPLETE_PROOF_' + ++incompleteCount
    return { status: 'COMPLETED', requestId, result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId,
      transportCode: 'WEB_FAILED', transportMessage: 'missing publicationStarted proof',
      details: { sendState: 'PROVEN_NOT_SENT' } } }
  } })
  for (let i = 0; i < 3; i++) {
    const accepted = await incomplete.jobs.accept(parent, '@PostmanImage incomplete proof ' + i, 'image')
    assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
    await tick(); await tick()
    const terminal = await incomplete.jobs.status(parent, accepted.bridgeJobId)
    assert.equal(terminal.terminalStatus, 'COMPLETED')
    assert.equal(terminal.synchronization, 'busy')
    assert.equal(incompleteStore.record().bridgeOperations[accepted.bridgeJobId].synchronization, 'pending')
  }
  assert.equal((await incomplete.accept()).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  assert.equal(incompleteCount, 3, 'limit rejection occurs before another child launch')
  await incomplete.jobs.dispose()

  const stuckOperations = Object.fromEntries(['stuckA', 'stuckB', 'stuckC'].map((id, index) => {
    const requestId = 'REQ_STUCK_COMPLETED_' + index
    return [id, { state: 'received', synchronization: 'pending', terminal: {
      status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', requestId, transportKind: 'image',
      result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId,
        transportCode: 'POSTMAN_ATTACHMENT_UPLOAD_TIMEOUT',
        transportMessage: 'failed before publication', publicationStarted: false,
        details: { sendState: 'PROVEN_NOT_SENT' } }
    } }]
  }))
  const recoveryStore = durableContexts(stuckOperations)
  let recoveryStatusReads = 0, recoveryChildStarts = 0
  const recovery = fixture({ contexts: recoveryStore.contexts,
    onStart: async () => {
      recoveryChildStarts++
      return { id: 'child-after-recovery', localAgent: { id: 'child-after-recovery' },
        result: Promise.resolve({ stopReason: 'end_turn' }), async dispose() {} }
    },
    onStatus: () => {
    recoveryStatusReads++
    return { status: 'FAILED', requestId: 'REQ_NEW_AFTER_RECOVERY', result: { ok: false,
      code: 'POSTMAN_TRANSPORT_FAILED', requestId: 'REQ_NEW_AFTER_RECOVERY',
      transportCode: 'WEB_FAILED', transportMessage: 'test child only' } }
  } })
  const initial = await recovery.jobs.status(parent, 'stuckA')
  assert.equal(initial.terminalStatus, 'COMPLETED')
  assert.equal(initial.synchronization, 'busy')
  assert.equal((await recovery.jobs.accept(parent, '@PostmanAsk cap remains full', 'text')).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  assert.equal(recoveryChildStarts, 0, 'full backlog launches no child')
  assert.equal(recoveryStatusReads, 0, 'limit check does not issue Direct/Web status reads')

  const recovered = await recovery.jobs.status(parent, 'stuckA', true)
  assert.equal(recovered.terminalStatus, 'COMPLETED')
  assert.equal(recovered.synchronization, 'not-required')
  assert.equal(recovered.result.requestId, 'REQ_STUCK_COMPLETED_0')
  const recoveredOperation = recoveryStore.record().bridgeOperations.stuckA
  assert.equal(recoveredOperation.state, 'received')
  assert.equal(recoveredOperation.synchronization, 'not-required')
  assert.equal(recoveredOperation.terminal.terminalStatus, 'COMPLETED')
  assert.equal(recoveryStatusReads, 0, 'retrySync resolves the saved terminal without another Direct/Web read')

  const released = await recovery.jobs.accept(parent, '@PostmanAsk after recovery', 'text')
  assert.equal(released.status, 'POSTMAN_BRIDGE_ACCEPTED', 'not-required operation releases one backlog slot')
  await tick(); await tick()
  assert.equal(recoveryChildStarts, 1, 'only the post-recovery acceptance starts a child')
  await recovery.jobs.dispose()

  const publication = { requestId: 'REQ_PUBLISHED_COMPLETED', baseCommit: 'a'.repeat(40),
    taskPublicationCommit: 'b'.repeat(40) }
  const publishedStore = durableContexts()
  let publicationSyncs = 0
  publishedStore.contexts.sync = async (_leader, taskPublicationCommit, baseCommit) => {
    assert.equal(taskPublicationCommit, publication.taskPublicationCommit)
    assert.equal(baseCommit, publication.baseCommit)
    publicationSyncs++
    return true
  }
  const published = fixture({ contexts: publishedStore.contexts, onStatus: () => ({
    status: 'COMPLETED', requestId: publication.requestId, result: { ok: false,
      code: 'POSTMAN_TRANSPORT_FAILED', requestId: publication.requestId, transportCode: 'WEB_LOST',
      transportMessage: 'failed after published task commit', details: {}, publicationReceipt: publication }
  }) })
  const publishedReceipt = await published.jobs.accept(parent, '@PostmanImage published failure', 'image')
  assert.equal(publishedReceipt.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await tick(); await tick()
  const publishedTerminal = await published.jobs.status(parent, publishedReceipt.bridgeJobId)
  assert.equal(publishedTerminal.terminalStatus, 'COMPLETED')
  assert.equal(publishedTerminal.synchronization, 'synchronized')
  assert.equal(publicationSyncs, 1, 'valid publication receipt stays on sync path')
  assert.equal(publishedStore.record().bridgeOperations[publishedReceipt.bridgeJobId], undefined)
  await published.jobs.dispose()

  const unknownOperations = Object.fromEntries(['unknownA', 'unknownB', 'unknownC'].map((id, index) => {
    const requestId = 'REQ_UNKNOWN_TERMINAL_' + index
    return [id, { state: 'received', synchronization: 'pending', terminal: {
      status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'UNRECOGNIZED', requestId, transportKind: 'image',
      result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId, transportCode: 'WEB_FAILED',
        transportMessage: 'unknown terminal status', publicationStarted: false, details: { sendState: 'PROVEN_NOT_SENT' } }
    } }]
  }))
  const unknownStore = durableContexts(unknownOperations)
  const unknown = fixture({ contexts: unknownStore.contexts })
  for (const id of ['unknownA', 'unknownB', 'unknownC']) {
    assert.equal((await unknown.jobs.status(parent, id)).synchronization, 'busy')
    assert.equal((await unknown.jobs.status(parent, id, true)).synchronization, 'busy')
  }
  assert.equal((await unknown.accept()).status, 'POSTMAN_BRIDGE_LIMIT_REACHED')
  await unknown.jobs.dispose()
})

test('failed transport synchronizes proven publication but never grants artifact', async () => {
  const receipt = { requestId: 'REQ_SYNC', taskPublicationCommit: 'b'.repeat(40), baseCommit: 'a'.repeat(40) }
  const failure = { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId: receipt.requestId,
    transportCode: 'WEB_LOST', transportMessage: 'lost', details: {}, publicationReceipt: receipt }
  for (const syncResult of [true, false]) {
    const calls = []
    const context = {}
    const contexts = { get: () => context, bindChild: () => true, releaseChild() {},
      async sync(leader, publicationCommit, baseCommit) {
        calls.push('sync')
        assert.equal(publicationCommit, receipt.taskPublicationCommit)
        assert.equal(baseCommit, receipt.baseCommit)
        return syncResult
      } }
    const grants = { async register() { calls.push('grant') } }
    const f = fixture({ contexts, grants, onStatus: () => ({ status: 'FAILED', requestId: receipt.requestId,
      result: failure }) })
    const accepted = f.accept()
    await tick()
    const response = valid(await f.read(accepted), 'POSTMAN_BRIDGE_TERMINAL')
    assert.deepEqual(calls, ['sync'])
    assert.deepEqual(response.result, failure)
    assert.equal(response.terminalStatus, 'FAILED')
    assert.equal(response.synchronization, syncResult ? 'synchronized' : 'busy')
    await f.jobs.dispose()
  }
})

test('three sequential publications synchronize second parent B to C without failure grants', async () => {
  const sha = ch => ch.repeat(40)
  const chain = [[sha('a'), sha('b')], [sha('b'), sha('c')], [sha('c'), sha('d')]]
  const calls = []
  const context = {}
  let head = sha('a')
  const contexts = { get: () => context, bindChild: () => true, releaseChild() {},
    async sync(_leader, publicationCommit, baseCommit) {
      calls.push([baseCommit, publicationCommit])
      assert.equal(baseCommit, head)
      head = publicationCommit
      return true
    } }
  const grants = { async register() { throw Error('failure must never grant') } }
  const f = fixture({ contexts, grants, onStatus: () => {
    const index = calls.length
    const [baseCommit, taskPublicationCommit] = chain[index]
    const requestId = 'REQ_CHAIN_' + index
    return { status: 'FAILED', requestId, result: { ok: false, code: 'POSTMAN_TRANSPORT_FAILED',
      requestId, transportCode: 'WEB_LOST', transportMessage: 'lost', details: {},
      publicationReceipt: { requestId, baseCommit, taskPublicationCommit } } }
  } })
  for (let i = 0; i < 3; i++) {
    const accepted = f.accept()
    await tick()
    const terminal = valid(await f.read(accepted), 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(terminal.terminalStatus, 'FAILED')
    assert.equal(terminal.result.ok, false)
  }
  assert.deepEqual(calls, chain)
  assert.equal(head, sha('d'))
  await f.jobs.dispose()
})

test('every failed status branch is lossless through ToolRuntime', async () => {
  const cases = [
    { label: 'start', onStart: () => { throw Error('startup') }, trusted: 'POSTMAN_BRIDGE_START_FAILED' },
    { label: 'parent', setup: f => { f.ctx.agents.get = () => undefined }, trusted: 'POSTMAN_BRIDGE_PARENT_UNAVAILABLE' },
    { label: 'child', onStart: async () => ({ id: 'missing', localAgent: undefined, result: Promise.resolve(), async dispose() {} }), trusted: 'POSTMAN_BRIDGE_CHILD_UNAVAILABLE' },
    { label: 'reader', onStatus: () => { throw Error('reader') }, diagnostic: /reader/ },
    { label: 'cleanup', onDispose: async () => { throw Error('cleanup') }, diagnostic: /cleanup/ },
  ]
  for (const scenario of cases) {
    const gate = deferred()
    const coordinator = { run: (_signal, task) => gate.promise.then(task), dispose() {} }
    const f = fixture({ ...scenario, coordinator })
    const accepted = f.accept()
    scenario.setup?.(f, accepted)
    gate.resolve()
    await tick()
    if (scenario.label === 'parent') f.ctx.agents.get = id => id === parent.id ? parent : undefined
    const reply = await f.read(accepted)
    const status = valid(reply, 'POSTMAN_BRIDGE_FAILED')
    if (scenario.trusted) assert.equal(status.trustedStatus, scenario.trusted, scenario.label)
    if (scenario.diagnostic) assert.match(status.diagnostic, scenario.diagnostic)
    assert.equal(status.terminalStatus, null)
    assert.equal(status.result, null)
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

test('reader, READY, and grant failures preserve JSON-safe trusted outcomes', async () => {
  for (const kind of ['ready', 'grant']) {
    const f = fixture({ onWake: kind === 'ready' ? () => { throw Error('inbox') } : undefined,
      grants: kind === 'grant' ? { async register() { throw Error('grant') } } : undefined })
    const accepted = f.accept()
    await tick()
    const result = valid(await f.read(accepted), 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(result.notification, kind === 'ready' ? 'UNDELIVERED' : 'DELIVERED')
    if (kind === 'grant') assert.match(result.grantDiagnostic, /grant/)
    assert.equal(result.result.assistantText, 'exact trusted text')
    await f.jobs.dispose()
  }
})

test('non-JSON trusted nested values fail closed instead of leaking malformed output', async () => {
  for (const malformed of [{ assistantText: undefined }, { data: () => 1 },
    { invalid: new Error('error') }, { invalid: Promise.resolve(1) }, { invalid: BigInt(1) },
    { invalid: Number.NaN }, { invalid: -0 }, (() => { const cycle = {}; cycle.self = cycle; return cycle })()]) {
    const f = fixture({ onStatus: () => ({ status: 'COMPLETED', requestId: 'REQ_BAD', result: malformed }) })
    const accepted = f.accept()
    await tick()
    const failed = valid(await f.read(accepted), 'POSTMAN_BRIDGE_FAILED')
    assert.match(failed.diagnostic, /POSTMAN_BRIDGE_NON_JSON_TERMINAL/)
    assert.equal(failed.result, null)
    await f.jobs.dispose()
  }
})
