import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanDevspaceLuna } from './postman-devspace-luna.js'
import { createDevspaceChannel, devspaceTerminal } from './postman-devspace.js'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openPostmanTaskRegistry } from './postman-task-registry.js'
import { postmanInputGrants } from './postman-input-files.js'
import { createPostmanTaskContexts } from './postman-task-context.js'

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
  const launches = [], relays = [], directJobs = new Map(), waiters = new Map(), children = new Map()
  const ctx = { agents: { get: id => id === leader.id ? leader : children.get(id) ?? null }, subagents: {
    async startContinuable(args) { children.set(args.childId, { id: args.childId }); return { childId: args.childId } },
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

test('review1: transient failure before URL gets three new owned attempts without guessing a conversation', async t => {
  const f = fixture(t, ['transport_diagnostic', 'transport_diagnostic', 'transport_diagnostic', 'bell'])
  const originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    if (result.result.source !== 'bell') result.result.conversationRef = null
    return result
  }
  const jobs = f.make()
  await jobs.accept(f.leader, '@PostmanDevspace continue authorised work', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 100; i++) await tick()
  assert.equal(f.launches.length, 4)
  assert.ok(f.launches.every(value => value.binding.conversationUrl === undefined))
  assert.deepEqual(f.launches.slice(1).map(value => value.binding.recovery.attempt), [1, 2, 3])
  assert.ok(Object.values(f.row().devspaceLanes).filter(value => value.state !== 'closed').length <= 3)
  await jobs.dispose()
})

for (const failure of ['before-luna', 'before-req']) test('review1: three infrastructure retries ' + failure, async t => {
  const f = fixture(t, ['bell'])
  let calls = 0
  if (failure === 'before-luna') {
    const original = f.ctx.subagents.startContinuable
    f.ctx.subagents.startContinuable = async args => {
      if (++calls <= 3) throw Error('temporary connection reset while creating Luna')
      return original(args)
    }
  } else {
    const original = f.direct.start
    f.direct.start = async args => {
      if (++calls <= 3) throw Error('temporary connection reset before allocation')
      return original(args)
    }
  }
  const jobs = f.make()
  await jobs.accept(f.leader, '@PostmanDevspace bounded authorised task', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 100; i++) await tick()
  assert.equal(calls, 4)
  assert.equal(f.launches.length, 1)
  const operations = Object.values(f.row().bridgeOperations)
  assert.equal(operations.length, 4)
  assert.deepEqual(operations.filter(value => value.devspace.recovery).map(value => value.devspace.recovery.attempt), [1, 2, 3])
  assert.equal(operations.filter(value => value.requestId).length, 1)
  await jobs.dispose()
  if (failure === 'before-luna') {
    const backend = new JsonStorageBackend(join(f.root, 'review-registry'))
    const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} })
    const registry = await openPostmanTaskRegistry(facility)
    const durableRow = { ...f.row(), repository: 'andrewverhoturov1/dsh-workspace', repositoryPath: f.root,
      originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git', baseCommit: 'a'.repeat(40),
      branch: 'main', stage: 'ready', diagnostic: null, runner: { state: 'none', requestId: null }, bridge: null }
    await registry.create(f.leader.id, durableRow); await registry.close()
    const reopened = await openPostmanTaskRegistry(facility)
    const saved = reopened.get(f.leader.id)
    assert.deepEqual(saved.bridgeOperations, JSON.parse(JSON.stringify(durableRow.bridgeOperations)))
    assert.ok(Object.values(saved.bridgeOperations).some(value => value.devspace.hostFailure?.diagnostic.includes('temporary connection reset')))
    assert.ok(Object.values(saved.bridgeOperations).some(value => value.devspace.recovery?.freshConversation === true))
    assert.ok(Object.values(saved.bridgeOperations).some(value => value.devspace.recoveryRetired === true))
    f.setRow(saved)
    await reopened.close(); await backend.close()
    const cold = f.make()
    await cold.recoverDevspacePending(f.leader)
    assert.equal(f.launches.length, 1)
    await cold.dispose()
  }
})

for (const source of ['bell', 'text_fallback']) test('review2: ambiguous temporary BLOCKED ' + source + ' recovers', async t => {
  const f = fixture(t, [source, 'bell']), originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    if (f.launches.length === 1) {
      if (source === 'text_fallback') result.result = devspaceTerminal(f.launches[0].binding, {
        source, diagnostic: 'BLOCKED', conversationRef: CHAT,
        message: 'Completed response without local signal', assistantText: 'Temporary DevSpace Bash/MCP tool failure' })
      else Object.assign(result.result, {
        reportedOutcome: 'BLOCKED', diagnostic: 'BLOCKED', message: 'Temporary DevSpace Bash/MCP tool failure' })
    }
    return result
  }
  const jobs = f.make()
  const first = await jobs.accept(f.leader, '@PostmanDevspace inspect and continue', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 100; i++) await tick()
  assert.equal(f.launches.length, 2)
  assert.equal(f.row().bridgeOperations[first.bridgeJobId].terminal.result.reportedOutcome,
    source === 'text_fallback' ? 'UNKNOWN' : 'BLOCKED')
  assert.equal(f.row().bridgeOperations[f.launches[1].binding.jobId].terminal.result.reportedOutcome, 'DONE')
  await jobs.dispose()
})

for (const blocker of ['NEED_DECISION', 'PERMISSION_DENIED']) test('review2: explicit ' + blocker + ' is actionable without automatic replay', async t => {
  const f = fixture(t, ['transport_diagnostic']), originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    Object.assign(result.result, { reportedOutcome: blocker === 'NEED_DECISION' ? blocker : 'BLOCKED',
      diagnostic: blocker, message: blocker === 'PERMISSION_DENIED' ? 'Permission denied for requested scope' : 'Leader decision required' })
    return result
  }
  const jobs = f.make()
  await jobs.accept(f.leader, '@PostmanDevspace task within current permission', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 100; i++) await tick()
  assert.equal(f.launches.length, 1)
  await jobs.dispose()
})

test('review5: root retry traverses the completed chain and concurrent calls reserve one fourth attempt', async t => {
  const f = fixture(t, ['transport_diagnostic', 'transport_diagnostic', 'transport_diagnostic', 'transport_diagnostic', 'bell'])
  const jobs = f.make()
  const first = await jobs.accept(f.leader, '@PostmanDevspace approved task', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 4 && Object.values(f.row().bridgeOperations).every(value => value.state === 'received'))
  await tick()
  const [a, b] = await Promise.all([jobs.status(f.leader, first.bridgeJobId, false, true),
    jobs.status(f.leader, first.bridgeJobId, false, true)])
  assert.ok([a.status, b.status].includes('POSTMAN_BRIDGE_ACCEPTED'))
  assert.equal(a.bridgeJobId, b.bridgeJobId)
  await until(() => f.launches.length === 5 && f.row().bridgeOperations[a.bridgeJobId]?.state === 'received')
  assert.equal(f.launches.at(-1).binding.recovery.attempt, 4)
  assert.equal((await jobs.status(f.leader, first.bridgeJobId)).recovery.rootJobId, first.bridgeJobId)
  assert.equal((await jobs.status(f.leader, a.bridgeJobId)).recovery.attempts.length, 4)
  await jobs.dispose()
})

test('review1: missing URL after a possibly sent writer creates only an isolated new attempt', async t => {
  const f = fixture(t, ['transport_diagnostic', 'bell']), writerRoot = join(f.root, 'owned-writer')
  mkdirSync(writerRoot); writeFileSync(join(writerRoot, 'keep.txt'), 'original bytes')
  const originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    if (f.launches.length === 1) result.result.conversationRef = null
    return result
  }
  const jobs = f.make()
  const first = await jobs.accept(f.leader, '@PostmanDevspace change approved file', 'devspace',
    undefined, undefined, 'WRITE_APPROVED_TARGET', undefined, { root: writerRoot, access: 'write' })
  await until(() => f.launches.length === 2 && f.row().bridgeOperations[f.launches[1].binding.jobId]?.state === 'received')
  const next = f.launches[1]
  assert.equal(f.row().bridgeOperations[first.bridgeJobId].residualWriteRoot, writerRoot)
  assert.equal(next.binding.mode, 'WRITE_TEST')
  assert.equal(next.binding.workspaceRef, writerRoot)
  assert.equal(next.binding.writeRoot, join(next.binding.channel, 'workspace'))
  assert.notEqual(next.sessionId, f.launches[0].sessionId)
  assert.equal(next.binding.conversationUrl, undefined)
  assert.match(next.payload, /прежнюю область только читай/)
  assert.equal(readFileSync(join(writerRoot, 'keep.txt'), 'utf8'), 'original bytes')
  await jobs.dispose()
})

test('review1: concurrent cold infrastructure reconciliation retains attempt count and does not replay old intent', async t => {
  const f = fixture(t, ['bell']), rootId = randomUUID(), laneId = randomUUID()
  f.setRow({ ...f.row(), bridgeOperations: { [rootId]: { state: 'unknown', phase: 'reserved',
    transportKind: 'devspace', devspace: { mode: 'READ_ONLY', laneId, payload: '@PostmanDevspace authorised task',
      hostFailure: { status: 'POSTMAN_DEVSPACE_LUNA_START_FAILED', diagnostic: 'temporary connection reset' } } } },
    devspaceLanes: { [laneId]: { state: 'reserved', activeBridgeJobId: rootId, requestIds: [], conversationRef: null } } })
  const jobs = f.make()
  await Promise.all([jobs.recoverDevspacePending(f.leader), jobs.recoverDevspacePending(f.leader)])
  await until(() => f.launches.length === 1 && f.row().bridgeOperations[f.launches[0].binding.jobId]?.state === 'received')
  assert.equal(f.launches[0].binding.recovery.attempt, 1)
  assert.equal(f.launches[0].binding.recovery.sourceRequestId, undefined)
  assert.equal(f.row().bridgeOperations[rootId].state, 'unknown')
  assert.equal(f.row().devspaceLanes[laneId].state, 'closed')
  await jobs.dispose()
  const cold = f.make()
  await cold.recoverDevspacePending(f.leader)
  assert.equal(f.launches.length, 1)
  await cold.dispose()
})

test('review5: cold root and leaf retries return the same active next attempt, then stop after success', async t => {
  const f = fixture(t, ['transport_diagnostic', 'transport_diagnostic', 'transport_diagnostic', 'transport_diagnostic', 'pending'])
  let jobs = f.make()
  const root = await jobs.accept(f.leader, '@PostmanDevspace recover', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 4 && Object.values(f.row().bridgeOperations).every(value => value.state === 'received'))
  await tick(); await jobs.dispose()
  jobs = f.make()
  const previousLeaf = f.launches[3].binding.jobId
  const [a, b] = await Promise.all([jobs.status(f.leader, root.bridgeJobId, false, true),
    jobs.status(f.leader, previousLeaf, false, true)])
  assert.equal(a.bridgeJobId, b.bridgeJobId)
  await until(() => f.launches.length === 5 && f.waiters.has(f.launches[4].requestId))
  const again = await jobs.status(f.leader, root.bridgeJobId, false, true)
  assert.equal(again.status, 'POSTMAN_DEVSPACE_RECOVERY_RUNNING')
  assert.equal(again.bridgeJobId, a.bridgeJobId)
  f.waiters.get(f.launches[4].requestId)(f.terminal(f.launches[4].requestId, 'bell'))
  await until(() => f.row().bridgeOperations[a.bridgeJobId].state === 'received')
  const success = await jobs.status(f.leader, root.bridgeJobId, false, true)
  assert.equal(success.status, 'POSTMAN_DEVSPACE_RECOVERY_NOT_REQUIRED')
  assert.equal(success.recovery?.resultJobId ?? success.resultJobId, a.bridgeJobId)
  assert.equal(f.launches.length, 5)
  await jobs.dispose()
})

test('review5: cyclic and incompatible links are diagnosed without another request; archive forbids retry', async t => {
  const f = fixture(t, ['transport_diagnostic']), jobs = f.make()
  const root = await jobs.accept(f.leader, '@PostmanDevspace recover', 'devspace', undefined, undefined, 'READ_ONLY')
  await until(() => f.launches.length === 4 && Object.values(f.row().bridgeOperations).every(value => value.state === 'received'))
  await tick()
  const leafId = f.launches[3].binding.jobId, before = structuredClone(f.row())
  f.setRow({ ...before, bridgeOperations: { ...before.bridgeOperations, [leafId]: {
    ...before.bridgeOperations[leafId], devspace: { ...before.bridgeOperations[leafId].devspace, recoveryNextJobId: root.bridgeJobId } } } })
  assert.equal((await jobs.status(f.leader, root.bridgeJobId, false, true)).status, 'POSTMAN_DEVSPACE_RECOVERY_CHAIN_INVALID')
  f.setRow(structuredClone(before))
  const childId = f.launches[1].binding.jobId
  f.setRow({ ...f.row(), bridgeOperations: { ...f.row().bridgeOperations, [childId]: {
    ...f.row().bridgeOperations[childId], devspace: { ...f.row().bridgeOperations[childId].devspace,
      recovery: { ...f.row().bridgeOperations[childId].devspace.recovery, sourceJobId: 'foreign-job' } } } } })
  assert.equal((await jobs.status(f.leader, root.bridgeJobId, false, true)).status, 'POSTMAN_DEVSPACE_RECOVERY_CHAIN_INVALID')
  assert.equal(f.launches.length, 4)
  f.setRow(before)
  await jobs.stop(f.leader, root.bridgeJobId, true)
  assert.equal((await jobs.status(f.leader, root.bridgeJobId, false, true)).status, 'POSTMAN_BRIDGE_ARCHIVED')
  assert.equal(f.launches.length, 4)
  await jobs.dispose()
})

test('review2: positive newer user turn blocks old automatic recovery even with transport diagnostic', async t => {
  const f = fixture(t, ['transport_diagnostic']), originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    result.result.transportDiagnostics.supersededByUserTurn = true
    return result
  }
  const jobs = f.make()
  const first = await jobs.accept(f.leader, '@PostmanDevspace old task', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 80; i++) await tick()
  assert.equal(f.launches.length, 1)
  const status = await jobs.status(f.leader, first.bridgeJobId, false, true)
  assert.equal(status.status, 'POSTMAN_DEVSPACE_RECOVERY_LEADER_DECISION_REQUIRED')
  assert.equal(status.recovery.classification.kind, 'decision')
  await jobs.dispose()
})

test('review4: status reconciliation invokes only owned Host proof and never model receipts or browser Send', async t => {
  const f = fixture(t), calls = []
  f.contexts.reconcileWriter = async (owner, id) => {
    calls.push({ owner, id })
    return { status: 'POSTMAN_WRITER_EXIT_UNPROVEN', bridgeJobId: id, alternative: 'Use a separate isolated write folder' }
  }
  const jobs = f.make(), id = randomUUID()
  assert.equal((await jobs.status({ ...f.leader }, id, false, false, true)).status, 'POSTMAN_BRIDGE_CALLER_REJECTED')
  const result = await jobs.status(f.leader, id, false, false, true)
  assert.equal(result.status, 'POSTMAN_WRITER_EXIT_UNPROVEN')
  assert.deepEqual(calls, [{ owner: f.leader.id, id }])
  assert.equal(f.launches.length, 0)
  await jobs.dispose()
})

test('review2: actual text fallback envelope cannot hide permission denial behind a generic message', async t => {
  const f = fixture(t)
  f.direct.wait = async childId => {
    const launch = f.launches.findLast(value => value.sessionId === childId)
    return { status: 'COMPLETED', requestId: launch.requestId, result: devspaceTerminal(launch.binding, {
      source: 'text_fallback', diagnostic: 'BLOCKED', conversationRef: CHAT,
      message: 'Completed response without local signal', assistantText: 'Permission denied for the requested scope.' }) }
  }
  const jobs = f.make()
  const first = await jobs.accept(f.leader, '@PostmanDevspace inspect permitted files', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 80; i++) await tick()
  assert.equal(f.launches.length, 1)
  assert.equal(f.row().bridgeOperations[first.bridgeJobId].terminal.result.reportedOutcome, 'UNKNOWN')
  assert.equal((await jobs.status(f.leader, first.bridgeJobId, false, true)).status, 'POSTMAN_DEVSPACE_RECOVERY_LEADER_DECISION_REQUIRED')
  await jobs.dispose()
})

test('review2: explicit NEED_DECISION diagnostic requires a decision even when reported outcome is unknown', async t => {
  const f = fixture(t), originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    Object.assign(result.result, { diagnostic: 'NEED_DECISION', reportedOutcome: 'UNKNOWN' })
    return result
  }
  const jobs = f.make()
  await jobs.accept(f.leader, '@PostmanDevspace inspect', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 80; i++) await tick()
  assert.equal(f.launches.length, 1)
  await jobs.dispose()
})

test('review2: late old BLOCKED observation does not mark the recovery chain successful', async t => {
  const f = fixture(t, ['transport_diagnostic', 'transport_diagnostic', 'bell']), originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    if (f.launches.length === 2) result.result = devspaceTerminal(f.launches[1].binding, {
      source: 'transport_diagnostic', diagnostic: 'UNKNOWN', conversationRef: CHAT,
      transportDiagnostics: { recoverySourceCompleted: true, recoverySourceOutcome: 'BLOCKED',
        recoverySourceMessage: 'Temporary DevSpace Bash failure', submitProof: { sendState: 'PROVEN_NOT_SENT' } } })
    return result
  }
  const jobs = f.make()
  const root = await jobs.accept(f.leader, '@PostmanDevspace inspect and continue', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 100; i++) await tick()
  assert.equal(f.launches.length, 3)
  const rootStatus = await jobs.status(f.leader, root.bridgeJobId)
  assert.equal(rootStatus.recovery.resultJobId, f.launches[2].binding.jobId)
  const skipped = f.row().bridgeOperations[f.launches[1].binding.jobId].terminal.result
  assert.equal(skipped.source, 'transport_diagnostic')
  assert.equal(skipped.requestId, f.launches[1].requestId)
  assert.notEqual(skipped.reportedOutcome, 'DONE')
  await jobs.dispose()
})

for (const blocked of ['NEED_DECISION', 'PERMISSION_DENIED']) test('review2: late old ' + blocked + ' does not authorize another attempt', async t => {
  const f = fixture(t, ['transport_diagnostic']), originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    if (f.launches.length === 2) result.result = devspaceTerminal(f.launches[1].binding, {
      source: 'transport_diagnostic', diagnostic: 'UNKNOWN', conversationRef: CHAT,
      transportDiagnostics: { recoverySourceCompleted: true,
        recoverySourceOutcome: blocked === 'NEED_DECISION' ? blocked : 'BLOCKED',
        recoverySourceMessage: blocked === 'PERMISSION_DENIED' ? 'Permission denied for requested scope' : 'Need a Leader decision',
        submitProof: { sendState: 'PROVEN_NOT_SENT' } } })
    return result
  }
  const jobs = f.make()
  const root = await jobs.accept(f.leader, '@PostmanDevspace approved scope', 'devspace', undefined, undefined, 'READ_ONLY')
  for (let i = 0; i < 100; i++) await tick()
  assert.equal(f.launches.length, 2)
  const status = await jobs.status(f.leader, root.bridgeJobId, false, true)
  assert.equal(status.status, 'POSTMAN_DEVSPACE_RECOVERY_LEADER_DECISION_REQUIRED')
  assert.equal(status.recovery.resultJobId, null)
  assert.equal(status.recovery.classification.kind, 'decision')
  await jobs.dispose()
})

test('review1: fresh recovery retains only the exact selected native inputs through a new Host pin', async t => {
  const f = fixture(t, ['transport_diagnostic', 'bell']), snapshots = join(f.root, 'selected-inputs')
  mkdirSync(snapshots)
  const bytes = 'selected private reference', sha256 = createHash('sha256').update(bytes).digest('hex')
  const descriptor = { name: 'reference.txt', repository: 'AndrewVerhoturov1/dsh-workspace', commit: 'a'.repeat(40),
    path: 'tmp/reference.txt', sha256, byte_length: Buffer.byteLength(bytes),
    raw_url: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'a'.repeat(40) + '/tmp/reference.txt' }
  writeFileSync(join(snapshots, '001.bin'), bytes)
  postmanInputGrants.record(f.leader, f.task, { descriptors: [descriptor], snapshotRoot: snapshots,
    materializations: [{ snapshot_path: join(snapshots, '001.bin'), sha256, byte_length: descriptor.byte_length }] })
  t.after(() => postmanInputGrants.release(f.leader))
  const originalWait = f.direct.wait
  f.direct.wait = async (...args) => {
    const result = await originalWait(...args)
    if (f.launches.length === 1) result.result.conversationRef = null
    return result
  }
  const jobs = f.make(), inputBinding = postmanInputGrants.pin(f.leader, f.task, [descriptor])
  await jobs.accept(f.leader, '@PostmanDevspace --input-files-json ' + JSON.stringify([descriptor]) + '\nRead selected reference',
    'devspace', inputBinding, undefined, 'READ_ONLY')
  for (let i = 0; i < 100; i++) await tick()
  assert.equal(f.launches.length, 2)
  assert.deepEqual(f.launches[1].inputFiles, [descriptor])
  assert.notEqual(f.launches[1].inputBinding, inputBinding)
  assert.match(f.launches[1].payload, /Read selected reference/)
  assert.equal(f.launches[1].binding.conversationUrl, undefined)
  await jobs.dispose()
})

test('review1: cold recovery without the selected input grant returns a durable provenance blocker', async t => {
  const f = fixture(t), id = randomUUID(), laneId = randomUUID(), requestId = req(90)
  const descriptor = { name: 'reference.txt', repository: 'AndrewVerhoturov1/dsh-workspace', commit: 'a'.repeat(40),
    path: 'tmp/reference.txt', sha256: 'b'.repeat(64), byte_length: 1,
    raw_url: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'a'.repeat(40) + '/tmp/reference.txt' }
  f.setRow({ ...f.row(), devspaceLanes: { [laneId]: { childId: 'cold-luna', state: 'ready',
    activeBridgeJobId: null, conversationRef: null, requestIds: [requestId] } },
    bridgeOperations: { [id]: { state: 'received', transportKind: 'devspace', requestId, childSessionId: 'cold-luna',
      synchronization: 'not-required', devspace: { mode: 'READ_ONLY', laneId,
        payload: '@PostmanDevspace --input-files-json ' + JSON.stringify([descriptor]) + '\nInspect selected file' },
      terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'devspace', requestId,
        result: { requestId, source: 'transport_diagnostic', diagnostic: 'UNKNOWN', conversationRef: null } } } } })
  const jobs = f.make()
  const first = await jobs.recoverDevspacePending(f.leader)
  assert.equal(first.continuations[0].status, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
  assert.equal(f.row().bridgeOperations[id].devspace.hostFailure.status, 'POSTMAN_INPUT_PROVENANCE_REJECTED')
  assert.equal((await jobs.recoverDevspacePending(f.leader)).continuations.length, 0)
  assert.equal((await jobs.status(f.leader, id, false, true)).status, 'POSTMAN_DEVSPACE_RECOVERY_LEADER_DECISION_REQUIRED')
  assert.equal(f.launches.length, 0)
  await jobs.dispose()
})

test('review cycle: three attempts, root fourth, archive, native writer release, and new independent task', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async t => {
  const { writerRuntimeFixture } = await import('./fixtures/postman-writer-runtime.js')
  const native = await writerRuntimeFixture(t)
  const { binding } = native, leader = { id: binding.leaderSessionId,
    session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } }, followup() {} }
  const backend = new JsonStorageBackend(join(native.directory, 'registry'))
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} })
  let registry = await openPostmanTaskRegistry(facility)
  const row = { leaderSessionId: leader.id, repository: 'andrewverhoturov1/dsh-workspace',
    repositoryPath: native.worktree, originUrl: 'https://github.com/andrewverhoturov1/dsh-workspace.git',
    baseCommit: 'a'.repeat(40), branch: native.branch, worktree: native.worktree, stage: 'ready',
    diagnostic: null, workers: {}, runner: { state: 'none', requestId: null }, bridge: null,
    devspaceLanes: { legacy: { childId: binding.lunaSessionId, state: 'ready', activeBridgeJobId: null,
      requestIds: [binding.requestId], conversationRef: CHAT } },
    bridgeOperations: { [binding.jobId]: { state: 'received', synchronization: 'not-required',
      transportKind: 'devspace', requestId: binding.requestId, childSessionId: binding.lunaSessionId,
      devspace: { mode: 'WRITE_ISOLATED', laneId: 'legacy', channel: binding.channel, payload: '@PostmanDevspace inspect and continue' },
      terminal: { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED', transportKind: 'devspace',
        requestId: binding.requestId, result: { requestId: binding.requestId, source: 'transport_diagnostic',
          diagnostic: 'UNKNOWN', conversationRef: CHAT } } } } }
  await registry.create(leader.id, row)
  let task = { leaderSessionId: leader.id, branch: native.branch, worktree: native.worktree,
    repository: row.repository, baseCommit: row.baseCommit }
  const proofs = createPostmanTaskContexts({ registry, writerControlFile: native.control.file })
  const contexts = { get: id => id === leader.id ? task : null, record: id => registry.get(id),
    records: () => registry.entries(), changeRecord: (id, fn) => registry.change(id, fn),
    reconcileWriter: proofs.reconcileWriter }
  const ctx = { agents: { get: id => id === leader.id ? leader : null }, subagents: {
    async startContinuable(args) { return { childId: args.childId } },
    async inspectOpenContinuableChild() { return true }, async followup() { return 'accepted' },
  } }
  const launches = [], gates = []
  const direct = { async start(args) {
    const requestId = req(launches.length + 1)
    const channel = createDevspaceChannel({ ...args.devspaceBinding, requestId, sourceRoot: native.directory })
    await args.onRequestAllocated(requestId, channel.channel)
    launches.push({ ...args, requestId, channel })
    return { requestId }
  }, async wait() {
    const launched = launches.at(-1), done = launches.length >= 4
    return { status: 'COMPLETED', requestId: launched.requestId, result: {
      requestId: launched.requestId, source: done ? 'bell' : 'transport_diagnostic',
      reportedOutcome: done ? 'DONE' : 'BLOCKED', diagnostic: done ? null : 'UNKNOWN', conversationRef: CHAT } }
  }, dispose() {} }
  const coordinator = { run(signal, fn, ready) {
    gates.push(ready)
    if (ready()) return Promise.resolve().then(fn)
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
  }, refresh() {}, dispose() {} }
  const jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts, null, direct)
  t.after(async () => { await jobs.dispose(); await registry.close(); await backend.close() })
  async function durableState(check) {
    const deadline = Date.now() + 5000
    let ready = await check()
    while (!ready && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); ready = await check() }
    assert.ok(ready, JSON.stringify({ launches: launches.length, bridge: jobs.list(leader),
      operations: registry.get(leader.id).bridgeOperations }))
  }
  const nativeResult = await native.operations("require('node:fs').writeFileSync('preserved.txt','native writer finished');console.log('native exit')")
  assert.equal(nativeResult.exitCode, 0)
  await jobs.recoverDevspacePending(leader)
  await durableState(() => launches.length === 3 && Object.values(registry.get(leader.id).bridgeOperations).every(op => op.state === 'received'))
  await durableState(async () => (await jobs.status(leader, launches[2].channel.jobId)).status === 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await jobs.status(leader, binding.jobId)).recovery.exhausted, true)
  assert.ok(launches.every(value => value.channel.mode === 'WRITE_TEST' && value.channel.writeRoot !== native.worktree))
  const fourth = await jobs.status(leader, binding.jobId, false, true)
  assert.equal(fourth.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await durableState(() => launches.length === 4 && registry.get(leader.id).bridgeOperations[fourth.bridgeJobId].state === 'received')
  await tick()
  assert.equal((await jobs.stop(leader, binding.jobId, true)).status, 'POSTMAN_BRIDGE_ARCHIVED')
  assert.equal(registry.get(leader.id).bridgeOperations[binding.jobId].residualWriteRoot, native.worktree)
  await registry.change(leader.id, current => ({ ...current, stage: 'closed', abandoned: true }))
  const newRoot = join(native.directory, 'independent'); mkdirSync(newRoot)
  const nextRow = { ...row, branch: 'task/postman-' + 'b'.repeat(32), worktree: newRoot,
    bridgeOperations: {}, devspaceLanes: {}, workers: {} }
  await registry.create(leader.id, nextRow)
  task = { ...task, branch: nextRow.branch, worktree: newRoot }
  const released = await jobs.status(leader, binding.jobId, false, false, true)
  assert.equal(released.status, 'POSTMAN_WRITER_RELEASED', JSON.stringify(released))
  assert.equal(released.writerSettlement.source, 'devspace_native_tree')
  const old = registry.get(leader.id).retiredTasks[0].bridgeOperations[binding.jobId]
  assert.equal(old.residualWriteRoot, undefined)
  assert.equal(old.terminal.result.source, 'transport_diagnostic')
  const independent = await jobs.accept(leader, '@PostmanDevspace independent approved work', 'devspace',
    undefined, undefined, 'WRITE_APPROVED_TARGET', undefined, { root: native.worktree, access: 'write' })
  assert.equal(independent.status, 'POSTMAN_BRIDGE_ACCEPTED')
  await durableState(() => launches.length === 5 && registry.get(leader.id).bridgeOperations[independent.bridgeJobId]?.state === 'received')
  assert.equal(gates.at(-1)(), true)
  assert.equal(readFileSync(join(native.worktree, 'preserved.txt'), 'utf8'), 'native writer finished')
  await jobs.dispose(); await registry.close()
  registry = await openPostmanTaskRegistry(facility)
  const cold = createPostmanTaskContexts({ registry, writerControlFile: native.control.file })
  assert.equal((await cold.reconcileWriter(leader.id, binding.jobId)).status, 'POSTMAN_WRITER_ALREADY_RELEASED')
  assert.deepEqual(registry.get(leader.id).retiredTasks[0].bridgeOperations[binding.jobId].writerSettlement, released.writerSettlement)
})
