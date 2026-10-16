import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanDevspaceLuna } from './postman-devspace-luna.js'
import { createDevspaceChannel } from './postman-devspace.js'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openPostmanTaskRegistry } from './postman-task-registry.js'

const CHAT = 'https://chatgpt.com/c/owned-recovery'
const req = index => 'REQ_20261017T120000Z_' + String(index).padStart(4, '0')
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick() }
  assert.fail('expected durable state was not reached')
}

function fixture(t, outcomes = ['transport_diagnostic']) {
  const root = mkdtempSync(join(tmpdir(), 'postman-recovery-'))
  const original = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = root
  t.after(() => {
    if (original === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = original
    rmSync(root, { recursive: true, force: true })
  })
  const privateRoot = join(root, 'DSH', 'Postman', 'devspace')
  mkdirSync(privateRoot, { recursive: true })
  const leader = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } },
    followup() {} }
  const task = { branch: 'main', worktree: root, repositoryPath: root, devspaceReadOnly: true }
  let row = { leaderSessionId: leader.id, worktree: root, bridgeOperations: {} }
  const launches = [], relays = [], directJobs = new Map(), waiters = new Map()
  const ctx = { agents: { get: id => id === leader.id ? leader : null }, subagents: {
    async startContinuable(args) { return { childId: args.childId } },
    async inspectOpenContinuableChild() { return true },
    async followup(_parent, child, content) { relays.push({ child, text: content[0].text }); return 'accepted' },
    async closeContinuableChild(_parent, _child, check) { return check() },
  } }
  const contexts = { get: id => id === leader.id ? task : null,
    record: id => id === leader.id ? row : null,
    async changeRecord(id, fn) { assert.equal(id, leader.id); row = fn(row); return row } }
  const terminal = (requestId, source, sendState) => ({ status: 'COMPLETED', requestId,
    result: { requestId, ok: true, source, conversationRef: CHAT,
      reportedOutcome: source === 'bell' ? 'DONE' : 'BLOCKED',
      diagnostic: source === 'bell' ? null : 'UNKNOWN',
      transportDiagnostics: { submitProof: { sendState: sendState ?? 'SEND_UNKNOWN' },
        ...(source === 'bell' ? { transportEventJournal: [{ event: 'STAGE_STARTED' }] } : {}) } } })
  const direct = {
    async start(args) {
      const requestId = req(launches.length + 1)
      const binding = createDevspaceChannel({ ...args.devspaceBinding,
        requestId, root: privateRoot, sourceRoot: root })
      await args.onRequestAllocated(requestId, binding.channel)
      const job = { state: 'running', requestId, devspaceChannel: binding }
      directJobs.set(args.sessionId, job)
      launches.push({ ...args, requestId, binding })
      return { requestId }
    },
    async wait(childId, _timeout, signal) {
      const job = directJobs.get(childId), index = launches.findIndex(value => value.requestId === job.requestId)
      const outcome = outcomes[index] ?? outcomes.at(-1)
      if (outcome === 'pending') return new Promise(resolve => {
        waiters.set(job.requestId, value => { job.state = 'completed'; resolve(value) })
        signal.addEventListener('abort', () => resolve({ status: 'RUNNING', requestId: job.requestId }), { once: true })
      })
      job.state = 'completed'
      if (outcome === 'failure') return { status: 'FAILED', requestId: job.requestId,
        result: { ok: false, requestId: job.requestId, code: 'POSTMAN_DEVSPACE_ROUTING_FAILED',
          conversationRef: CHAT } }
      return terminal(job.requestId, outcome === 'not-sent' ? 'transport_diagnostic' : outcome,
        outcome === 'not-sent' ? 'PROVEN_NOT_SENT' : undefined)
    },
    latest: id => directJobs.get(id), dispose() {},
  }
  const coordinator = { run: (_signal, fn) => Promise.resolve().then(fn), dispose() {}, refresh() {} }
  const make = () => createPostmanBridgeJobs(ctx, coordinator, null, contexts, null, direct)
  return { root, privateRoot, leader, task, ctx, contexts, launches, relays, direct,
    waiters, terminal, make, row: () => row, setRow: value => { row = value } }
}

test('transport diagnostic then PROVEN_NOT_SENT do not block a third distinct REQ in the owned chat', async t => {
  const f = fixture(t, ['bell']), laneId = randomUUID(), child = 'saved-luna'
  const oldIds = [randomUUID(), randomUUID()]
  const old = Object.fromEntries(oldIds.map((id, index) => [id, {
    state: 'received', phase: 'synchronized', transportKind: 'devspace', childSessionId: child,
    requestId: req(index + 10), synchronization: 'not-required',
    terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'devspace',
      requestId: req(index + 10), result: f.terminal(req(index + 10), 'transport_diagnostic',
        index ? 'PROVEN_NOT_SENT' : 'SEND_UNKNOWN').result },
    devspace: { mode: 'READ_ONLY', laneId },
  }]))
  f.setRow({ ...f.row(), bridgeOperations: old,
    devspaceLanes: { [laneId]: { childId: child, state: 'ready', conversationRef: CHAT,
      requestIds: [req(10), req(11)], activeBridgeJobId: null } } })
  const before = structuredClone(old), jobs = f.make()
  const accepted = await jobs.accept(f.leader, '@PostmanDevspace continue the audit', 'devspace',
    undefined, undefined, 'READ_ONLY', laneId)
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await until(() => f.launches.length === 1 && f.row().bridgeOperations[accepted.bridgeJobId]?.state === 'received')
  assert.equal(f.launches[0].sessionId, child)
  assert.equal(f.launches[0].devspaceBinding.conversationUrl, CHAT)
  assert.equal(f.launches[0].devspaceBinding.priorRequestId, req(11))
  for (const id of oldIds) assert.deepEqual(f.row().bridgeOperations[id], before[id])
  await jobs.dispose()
})

test('three recovery attempts persist separate jobs and REQs; Leader can authorize a fourth', async t => {
  const f = fixture(t, ['transport_diagnostic', 'not-sent', 'transport_diagnostic', 'transport_diagnostic', 'bell'])
  const jobs = f.make()
  const accepted = await jobs.accept(f.leader, '@PostmanDevspace inspect files and finish', 'devspace',
    undefined, undefined, 'READ_ONLY', undefined, undefined, { computerUse: 'allow' })
  await until(() => f.launches.length === 4 && Object.values(f.row().bridgeOperations)
    .every(value => value.state === 'received'))
  await tick()
  assert.equal(f.launches.length, 4, 'initial request plus three, never just three total')
  assert.equal(new Set(f.launches.map(value => value.requestId)).size, 4)
  assert.equal(new Set(f.launches.map(value => value.binding.jobId)).size, 4)
  assert.equal(new Set(f.launches.map(value => value.sessionId)).size, 1)
  assert.deepEqual(f.launches.slice(1).map(value => value.binding.recovery.attempt), [1, 2, 3])
  assert.ok(f.launches.slice(1).every(value => value.binding.conversationUrl === CHAT &&
    value.binding.recovery.intent === 'observe-then-continue' && value.binding.computerUse === 'allow'))
  assert.match(f.launches[1].payload, /проверь историю/)
  assert.match(f.launches[1].payload, /ещё выполняющиеся процессы/)
  const first = await jobs.status(f.leader, accepted.bridgeJobId)
  assert.equal(first.result.source, 'transport_diagnostic', 'old failure is not promoted')
  assert.equal(first.recovery.attempts.length, 3)
  assert.equal(first.recovery.exhausted, true)
  assert.deepEqual(first.recovery.choices, ['retry', 'new-conversation-or-executor', 'archive'])
  const last = f.launches.at(-1).binding.jobId
  const manual = await jobs.status(f.leader, last, false, true)
  assert.equal(manual.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await until(() => f.launches.length === 5 && f.row().bridgeOperations[manual.bridgeJobId]?.state === 'received')
  assert.equal(f.launches.at(-1).binding.recovery.attempt, 4)
  assert.equal(f.row().bridgeOperations[last].terminal.result.source, 'transport_diagnostic')
  await jobs.dispose()
})

test('a successful second recovery stops the series before the third recovery', async t => {
  const f = fixture(t, ['failure', 'not-sent', 'bell']), jobs = f.make()
  await jobs.accept(f.leader, '@PostmanDevspace finish once', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 3 && Object.values(f.row().bridgeOperations).every(value => value.state === 'received'))
  for (let i = 0; i < 8; i++) await tick()
  assert.equal(f.launches.length, 3)
  assert.deepEqual(f.launches.slice(1).map(value => value.binding.recovery.attempt), [1, 2])
  await jobs.dispose()
})

test('owned saved URL needs no visible old REQ, but native foreign Luna reproof still rejects', async t => {
  const f = fixture(t, ['bell'])
  f.setRow({ ...f.row(), devspaceLuna: { childId: 'owned-child', state: 'ready',
    conversationRef: CHAT, requestIds: [req(20)] },
    bridgeOperations: { current: { state: 'pending', phase: 'reserved', transportKind: 'devspace' } } })
  const luna = createPostmanDevspaceLuna(f.ctx, f.contexts, f.direct)
  const job = { bridgeJobId: 'current', taskContext: f.task, controller: new AbortController(), devspaceMode: 'READ_ONLY' }
  f.ctx.subagents.inspectOpenContinuableChild = async () => false
  assert.equal((await luna.run(job, '@PostmanDevspace continue', f.leader)).status,
    'POSTMAN_DEVSPACE_LUNA_REPROOF_FAILED')
  assert.equal(f.launches.length, 0)
  f.ctx.subagents.inspectOpenContinuableChild = async () => true
  // This test uses a valid immutable channel identity, as real Bridge admission does.
  const id = randomUUID()
  f.setRow({ ...f.row(), bridgeOperations: { [id]: { state: 'pending', phase: 'reserved', transportKind: 'devspace' } } })
  const result = await luna.run({ ...job, bridgeJobId: id }, '@PostmanDevspace continue', f.leader)
  assert.equal(result.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(f.launches[0].devspaceBinding.priorRequestId, undefined)
  assert.equal(f.launches[0].binding.conversationUrl, CHAT)
})

test('cold recovery never replays a reserved old REQ and concurrent reconciliation reserves one successor', async t => {
  const f = fixture(t, ['bell']), rootJobId = randomUUID(), reservedId = randomUUID(), laneId = randomUUID()
  const source = { state: 'received', transportKind: 'devspace', childSessionId: 'saved-luna',
    requestId: req(20), synchronization: 'not-required',
    terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'devspace',
      requestId: req(20), result: f.terminal(req(20), 'transport_diagnostic').result },
    devspace: { mode: 'READ_ONLY', laneId, payload: '@PostmanDevspace original task', recoveryNextJobId: reservedId } }
  f.setRow({ ...f.row(), bridgeOperations: { [rootJobId]: source,
    [reservedId]: { state: 'pending', phase: 'reserved', transportKind: 'devspace',
      devspace: { mode: 'READ_ONLY', laneId, payload: source.devspace.payload,
        recovery: { rootJobId, sourceJobId: rootJobId, sourceRequestId: req(20), attempt: 1 } } } },
    devspaceLanes: { [laneId]: { childId: 'saved-luna', state: 'ready',
      conversationRef: CHAT, requestIds: [req(20)], activeBridgeJobId: reservedId } } })
  const jobs = f.make()
  await Promise.all([jobs.recoverDevspacePending(f.leader), jobs.recoverDevspacePending(f.leader)])
  await until(() => f.launches.length === 1 && Object.values(f.row().bridgeOperations).some(value =>
    value.terminal?.result?.source === 'bell'))
  assert.equal(f.launches.length, 1)
  assert.equal(f.launches[0].binding.recovery.attempt, 2)
  assert.equal(f.launches[0].binding.recovery.sourceRequestId, req(20))
  assert.equal(f.row().bridgeOperations[reservedId].state, 'unknown')
  assert.equal(f.row().bridgeOperations[reservedId].executionRevoked, true)
  assert.ok(f.row().bridgeOperations[reservedId].devspace.recoveryNextJobId)
  await jobs.dispose()
})

test('archived unknown releases a lane and fences late callbacks without fake process termination', async t => {
  const f = fixture(t, ['pending', 'bell']), jobs = f.make()
  const initial = await jobs.accept(f.leader, '@PostmanDevspace wait', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 1 && f.waiters.size === 1)
  const old = f.launches[0]
  assert.equal((await jobs.stop({ ...f.leader }, initial.bridgeJobId, true)).status, 'POSTMAN_BRIDGE_CALLER_REJECTED')
  const receipt = await jobs.stop(f.leader, initial.bridgeJobId, true)
  assert.equal(receipt.status, 'POSTMAN_BRIDGE_ARCHIVED')
  assert.equal(receipt.processStopProven, false)
  const revocation = JSON.parse(readFileSync(join(old.binding.channel, 'revoked.json'), 'utf8'))
  assert.equal(revocation.requestId, old.requestId)
  assert.equal(revocation.leaderSessionId, f.leader.id)
  assert.equal(jobs.list(f.leader).used, 0)
  assert.equal(f.row().devspaceLanes[initial.laneId].state, 'closed')
  const replacement = await jobs.accept(f.leader, '@PostmanDevspace independent task', 'devspace', undefined, undefined, 'READ_ONLY')
  assert.equal(replacement.status, 'POSTMAN_BRIDGE_ACCEPTED')
  assert.notEqual(replacement.laneId, initial.laneId)
  await until(() => f.launches.length === 2)
  const nextLane = structuredClone(f.row().devspaceLanes[replacement.laneId])
  f.waiters.get(old.requestId)(f.terminal(old.requestId, 'bell'))
  writeFileSync(join(old.binding.channel, 'event.json'), JSON.stringify({ version: 1,
    ...Object.fromEntries(['jobId', 'requestId', 'leaderSessionId', 'lunaSessionId', 'capability']
      .map(key => [key, old.binding[key]])), reportedOutcome: 'DONE', message: 'late old bell', reportRef: null }))
  for (let i = 0; i < 8; i++) await tick()
  assert.equal((await jobs.status(f.leader, initial.bridgeJobId)).lateResult.source, 'bell')
  assert.equal(f.row().bridgeOperations[initial.bridgeJobId].terminal, undefined)
  assert.equal(f.row().bridgeOperations[initial.bridgeJobId].lateTerminal?.result.source, 'bell')
  assert.equal(f.row().devspaceLanes[initial.laneId].state, 'closed')
  assert.equal(f.row().devspaceLanes[replacement.laneId].childId, nextLane.childId)
  assert.equal((await jobs.status(f.leader, initial.bridgeJobId)).status, 'POSTMAN_BRIDGE_ARCHIVED')
  await jobs.dispose()
  const cold = f.make()
  assert.equal(cold.list(f.leader).used, 0)
  assert.equal((await cold.recoverDevspacePending(f.leader)).continuations.length, 0)
  await cold.dispose()
})

test('one archived unknown does not count beside three live lanes; a fourth live lane is rejected', async t => {
  const f = fixture(t, ['pending']), jobs = f.make()
  const first = await jobs.accept(f.leader, '@PostmanDevspace old', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 1 && f.waiters.size === 1)
  await jobs.stop(f.leader, first.bridgeJobId, true)
  const accepted = await Promise.all([1, 2, 3].map(index =>
    jobs.accept(f.leader, '@PostmanDevspace independent ' + index, 'devspace', undefined, undefined, 'READ_ONLY')))
  assert.ok(accepted.every(value => value.status === 'POSTMAN_BRIDGE_ACCEPTED'))
  await until(() => f.launches.length === 4)
  assert.equal(jobs.list(f.leader).used, 3)
  assert.equal(jobs.devspaceLunaSnapshot(f.leader).capacity.used, 3)
  assert.equal((await jobs.accept(f.leader, '@PostmanDevspace fourth', 'devspace', undefined, undefined, 'READ_ONLY')).status,
    'POSTMAN_DEVSPACE_CAPACITY_REACHED')
  await jobs.dispose()
})

test('unknown external writer retained in a retired task blocks only overlapping write scope', async t => {
  const f = fixture(t, ['bell']), pending = [], gates = []
  const oldId = randomUUID(), oldRoot = join(f.root, 'old-writer'), otherRoot = join(f.root, 'independent')
  mkdirSync(oldRoot); mkdirSync(otherRoot)
  f.setRow({ ...f.row(), retiredTasks: [{ stage: 'closed', worktree: oldRoot,
    bridgeOperations: { [oldId]: { state: 'unknown', archivedAt: '2026-10-17T00:00:00Z',
      executionRevoked: true, residualWriteRoot: oldRoot } } }] })
  const coordinator = { run(signal, fn, ready) {
    gates.push(ready)
    if (ready()) return Promise.resolve().then(fn)
    return new Promise((_resolve, reject) => {
      pending.push(signal); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })
    })
  }, dispose() {}, refresh() {} }
  const jobs = createPostmanBridgeJobs(f.ctx, coordinator, null, f.contexts, null, f.direct)
  const blocked = await jobs.accept(f.leader, '@PostmanDevspace conflicting write', 'devspace',
    undefined, undefined, 'WRITE_APPROVED_TARGET', undefined, { root: oldRoot, access: 'write' })
  assert.equal(blocked.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await tick()
  assert.equal(gates[0](), false)
  assert.equal(f.launches.length, 0)
  const allowed = await jobs.accept(f.leader, '@PostmanDevspace independent write', 'devspace',
    undefined, undefined, 'WRITE_APPROVED_TARGET', undefined, { root: otherRoot, access: 'write' })
  assert.equal(allowed.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await until(() => f.launches.length === 1)
  assert.equal(gates[1](), true)
  assert.equal(f.launches[0].binding.workspaceRef, otherRoot)
  await jobs.dispose()
})

test('failed browser revoke followed by dirty isolation retains the original external writer scope', async t => {
  const f = fixture(t, ['pending']), oldRoot = join(f.root, 'external-writer'), otherRoot = join(f.root, 'other-work')
  mkdirSync(oldRoot); mkdirSync(otherRoot)
  const firstJobs = f.make()
  const first = await firstJobs.accept(f.leader, '@PostmanDevspace old external work', 'devspace',
    undefined, undefined, 'WRITE_APPROVED_TARGET', undefined, { root: oldRoot, access: 'write' })
  await until(() => f.launches.length === 1 && f.waiters.size === 1)
  // A corrupt owner binding is a real revocation refusal. Dirty isolation must
  // preserve the unresolved scope rather than treating that refusal as Stop.
  const old = f.launches[0]
  writeFileSync(join(old.binding.channel, 'binding.json'), JSON.stringify({ ...old.binding,
    leaderSessionId: 'foreign' }))
  assert.equal((await firstJobs.stop(f.leader, first.bridgeJobId, true)).status,
    'POSTMAN_BRIDGE_ARCHIVE_FENCE_FAILED')
  assert.equal(f.row().bridgeOperations[first.bridgeJobId].residualWriteRoot, undefined)
  const retired = { ...structuredClone(f.row()), stage: 'closed', abandoned: true }
  f.setRow({ ...f.row(), stage: 'ready', bridgeOperations: {}, devspaceLanes: {}, retiredTasks: [retired] })
  const gates = []
  const coordinator = { run(signal, fn, ready) {
    gates.push(ready)
    if (ready()) return Promise.resolve().then(fn)
    return new Promise((_resolve, reject) => signal.addEventListener('abort',
      () => reject(Error('aborted')), { once: true }))
  }, dispose() {}, refresh() {} }
  const jobs = createPostmanBridgeJobs(f.ctx, coordinator, null, f.contexts, null, f.direct)
  await jobs.accept(f.leader, '@PostmanDevspace conflicting', 'devspace', undefined, undefined,
    'WRITE_APPROVED_TARGET', undefined, { root: oldRoot, access: 'write' })
  await tick()
  assert.equal(gates[0](), false)
  await jobs.accept(f.leader, '@PostmanDevspace independent', 'devspace', undefined, undefined,
    'WRITE_APPROVED_TARGET', undefined, { root: otherRoot, access: 'write' })
  await until(() => f.launches.length === 2)
  assert.equal(gates[1](), true)
  assert.equal(f.launches[1].binding.workspaceRef, otherRoot)
  await jobs.dispose(); await firstJobs.dispose()
})

test('durable recovery and archive metadata survive an actual registry close and reopen', async t => {
  const f = fixture(t, ['transport_diagnostic', 'bell']), jobs = f.make()
  const accepted = await jobs.accept(f.leader, '@PostmanDevspace inspect once', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 2 && Object.values(f.row().bridgeOperations).every(value => value.state === 'received'))
  await tick()
  await jobs.stop(f.leader, accepted.bridgeJobId, true)
  const backend = new JsonStorageBackend(join(f.root, 'registry'))
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} })
  const registry = await openPostmanTaskRegistry(facility)
  const row = { ...f.row(), repository: 'andrewverhoturov1/dsh-workspace', repositoryPath: f.root,
    originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git', baseCommit: 'a'.repeat(40),
    branch: 'main', stage: 'ready', diagnostic: null, runner: { state: 'none', requestId: null }, bridge: null }
  await registry.create(f.leader.id, row)
  await registry.close()
  const reopened = await openPostmanTaskRegistry(facility)
  assert.deepEqual(reopened.get(f.leader.id).bridgeOperations, JSON.parse(JSON.stringify(row.bridgeOperations)))
  assert.deepEqual(reopened.get(f.leader.id).devspaceLanes, row.devspaceLanes)
  await reopened.close(); await backend.close(); await jobs.dispose()
})

test('late bell during recovery observation belongs to old REQ and ends recovery without a third Send', async t => {
  const f = fixture(t, ['transport_diagnostic', 'transport_diagnostic'])
  const originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    if (f.launches.length === 2) {
      result.result.transportDiagnostics.recoverySourceCompleted = true
      result.result.transportDiagnostics.recoveryObservation = {
        sourceRequestId: f.launches[0].requestId, messageObserved: true, newMessageSent: false }
      const binding = f.launches[0].binding
      writeFileSync(join(binding.channel, 'event.json'), JSON.stringify({ version: 1,
        ...Object.fromEntries(['jobId', 'requestId', 'leaderSessionId', 'lunaSessionId', 'capability']
          .map(key => [key, binding[key]])), reportedOutcome: 'DONE', message: 'original finished', reportRef: null }))
    }
    return result
  }
  const jobs = f.make()
  const accepted = await jobs.accept(f.leader, '@PostmanDevspace finish task', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 2 && Object.values(f.row().bridgeOperations).every(value => value.state === 'received'))
  await tick()
  const first = await jobs.status(f.leader, accepted.bridgeJobId)
  assert.equal(first.result.requestId, f.launches[0].requestId)
  assert.equal(first.result.source, 'bell')
  const recovered = await jobs.status(f.leader, f.launches[1].binding.jobId)
  assert.equal(recovered.result.requestId, f.launches[1].requestId)
  assert.equal(recovered.result.source, 'transport_diagnostic', 'new REQ did not acquire old bell')
  assert.equal(recovered.recovery.attempts[0].observation.newMessageSent, false)
  assert.equal(f.launches.length, 2)
  await jobs.dispose()
})

test('late old result is saved in retired task after a new context replaces the abandoned one', async t => {
  const f = fixture(t, ['pending', 'bell']), jobs = f.make()
  const initial = await jobs.accept(f.leader, '@PostmanDevspace old', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 1 && f.waiters.size === 1)
  const old = f.launches[0]
  await jobs.stop(f.leader, initial.bridgeJobId, true)
  const retired = structuredClone(f.row())
  f.setRow({ leaderSessionId: f.leader.id, worktree: f.root, stage: 'ready', bridgeOperations: {},
    retiredTasks: [retired] })
  const next = await jobs.accept(f.leader, '@PostmanDevspace new', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 2)
  writeFileSync(join(old.binding.channel, 'event.json'), JSON.stringify({ version: 1,
    ...Object.fromEntries(['jobId', 'requestId', 'leaderSessionId', 'lunaSessionId', 'capability']
      .map(key => [key, old.binding[key]])), reportedOutcome: 'DONE', message: 'late retired bell', reportRef: null }))
  const seen = await jobs.status(f.leader, initial.bridgeJobId)
  assert.equal(seen.lateResult.requestId, old.requestId)
  assert.equal(f.row().bridgeOperations[initial.bridgeJobId], undefined)
  assert.equal(f.row().retiredTasks[0].bridgeOperations[initial.bridgeJobId].lateTerminal.result.source, 'bell')
  assert.equal(f.row().bridgeOperations[next.bridgeJobId].requestId, f.launches[1].requestId)
  await jobs.dispose()
})
