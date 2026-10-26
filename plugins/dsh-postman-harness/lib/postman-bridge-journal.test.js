import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createNodesLunaNativeBridge } from './postman-bridge.js'
import { createDevspaceChannel, readDevspaceControls } from './postman-devspace.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'minimal-bridge-')), previous = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = root
  t.after(() => { previous === undefined ? delete process.env.LOCALAPPDATA : process.env.LOCALAPPDATA = previous; rmSync(root, { recursive: true, force: true }) })
  const channelRoot = join(root, 'DSH', 'Postman', 'devspace'); mkdirSync(channelRoot, { recursive: true })
  const parent = { id: 'leader', session: { header: { cwd: root, agentPreset: 'postman-leader', delegationDepth: 0 } }, followup() { wakes++ } }
  const owner = { leaderSessionId: parent.id, worktree: root, workspaceOnly: true }
  let row = { leaderSessionId: parent.id, cwd: root, bridgeOperations: {} }, wakes = 0, liaiseFails = false
  const calls = [], children = new Map([[parent.id, parent]]), pending = new Map()
  const contexts = { get: id => id === parent.id ? owner : null, record: id => id === parent.id ? row : null,
    async changeRecord(id, change) { assert.equal(id, parent.id); row = change(row) } }
  const ctx = { agents: { get: id => children.get(id) }, subagents: {
    async startContinuable(args) { calls.push(['luna', args.childId]); children.set(args.childId, { id: args.childId }); return { childId: args.childId } },
    async followup(...args) { calls.push(['liaison', ...args]); if (liaiseFails) throw Error('liaison unavailable'); return 'accepted' },
    async closeContinuableChild(_parent, _child, check) { return check() },
  } }
  const direct = {
    async start(args) {
      calls.push(['send', args]); const requestId = `REQ_20261020T120000Z_${String(calls.filter(c => c[0] === 'send').length).padStart(4, '0')}`
      const binding = createDevspaceChannel({ ...args.devspaceBinding, root: channelRoot, requestId, sourceRoot: root })
      await args.onRequestAllocated(requestId, binding.channel)
      pending.set(args.sessionId, { binding, args, deferred: Promise.withResolvers() }); return { requestId }
    },
    wait(child) { return pending.get(child).deferred.promise }, dispose() {},
  }
  const coordinator = { run: (_signal, launch) => Promise.resolve().then(launch), dispose() {} }
  const make = () => createPostmanBridgeJobs(ctx, coordinator, null, contexts, null, direct)
  const finish = (id, source = 'text_fallback', text = 'BLOCKED: unsupported operation') => {
    const op = row.bridgeOperations[id], item = pending.get(op.childSessionId)
    item.deferred.resolve({ status: 'COMPLETED', requestId: op.requestId, result: { requestId: op.requestId,
      source, assistantText: text, conversationRef: 'https://chatgpt.com/c/' + op.childSessionId } })
  }
  const saved = (state = 'unknown', { bell = true, text = false, address = true, revoked = false } = {}) => {
    const bridgeJobId = randomUUID(), childId = randomUUID(), requestId = 'REQ_20261020T100000Z_9999'
    const binding = createDevspaceChannel({ root: channelRoot, bridgeJobId, requestId, leaderSessionId: parent.id,
      lunaSessionId: childId, worktree: root, sourceRoot: root, branch: '', workspaceOnly: true, mode: 'WRITE_TEST' })
    if (bell) writeFileSync(join(binding.channel, 'event.json'), JSON.stringify({ version: 1,
      ...Object.fromEntries(['jobId', 'requestId', 'leaderSessionId', 'lunaSessionId', 'capability'].map(k => [k, binding[k]])),
      reportedOutcome: 'DONE', message: 'saved result', reportRef: join(root, 'report.md') }))
    if (text) writeFileSync(join(binding.channel, 'result.json'), JSON.stringify({ requestId, source: 'text_fallback', assistantText: 'saved text' }))
    if (address) { const directory = join(binding.channel, 'web', 'workers'); mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, requestId + '.json'), JSON.stringify({ requestId, conversationUrl: 'https://chatgpt.com/c/saved' })) }
    row.bridgeOperations[bridgeJobId] = { state, transportKind: 'devspace', requestId, childSessionId: childId,
      executionRevoked: revoked, devspace: { channel: binding.channel, laneId: 'legacy' } }
    row.devspaceLuna = { childId, state: 'uncertain', activeBridgeJobId: bridgeJobId, requestIds: [requestId], conversationRef: null }
    return { bridgeJobId, binding }
  }
  return { make, parent, contexts, ctx, direct, calls, finish, saved, row: () => row, root,
    wakes: () => wakes, setLiaisonFailure() { liaiseFails = true } }
}

test('cold bell and text are readable without Luna, model wake, grant or journal writes', async t => {
  for (const text of [false, true]) {
    const f = fixture(t), { bridgeJobId } = f.saved('unknown', { bell: !text, text })
    const before = structuredClone(f.row()), jobs = f.make()
    for (let i = 0; i < 2; i++) {
      const result = await jobs.status(f.parent, bridgeJobId, true, true, true)
      assert.equal(result.status, 'POSTMAN_BRIDGE_TERMINAL')
      assert.equal(result.result.source, text ? 'text_fallback' : 'bell')
      assert.equal(result.result.conversationRef, 'https://chatgpt.com/c/saved')
      assert.deepEqual(f.row(), before); assert.equal(f.wakes(), 0); assert.equal(f.calls.length, 0)
    }
    assert.equal(jobs.list(f.parent).used, 0)
    await jobs.dispose()
  }
})

test('startup wakes for an existing result once, without a Luna turn or Send', async t => {
  const f = fixture(t), { bridgeJobId } = f.saved(), jobs = f.make()
  await jobs.recoverDevspacePending(f.parent)
  await jobs.recoverDevspacePending(f.parent)
  assert.equal(f.wakes(), 1); assert.equal(f.calls.length, 0)
  assert.equal(f.row().bridgeOperations[bridgeJobId].terminal.result.source, 'bell')
  await jobs.dispose()
})

test('cold controls use the exact durable address and never another Leader job', async t => {
  const f = fixture(t), { bridgeJobId, binding } = f.saved('unknown', { bell: false }), jobs = f.make()
  assert.equal(jobs.devspaceControl({ ...f.parent }, bridgeJobId, 'stop').status, 'POSTMAN_DEVSPACE_CONTROL_CALLER_REJECTED')
  assert.equal(jobs.devspaceControl(f.parent, bridgeJobId, 'steer', 'look at saved report').status, 'POSTMAN_DEVSPACE_CONTROL_QUEUED')
  assert.equal(jobs.devspaceControl(f.parent, bridgeJobId, 'stop').status, 'POSTMAN_DEVSPACE_CONTROL_QUEUED')
  assert.deepEqual(readDevspaceControls(binding).map(c => c.kind).sort(), ['steer', 'stop'])
  assert.equal(f.calls.length, 0)
  await jobs.dispose()
})

test('unknown lane continues explicitly from Web receipt without native history proofs', async t => {
  const f = fixture(t); f.saved('unknown', { bell: false }); const jobs = f.make()
  f.setLiaisonFailure()
  const accepted = await jobs.accept(f.parent, '@PostmanDevspace next task', 'devspace', undefined, undefined, 'READ_ONLY', 'legacy')
  await tick(); await tick()
  const sent = f.calls.find(call => call[0] === 'send')[1]
  assert.equal(sent.devspaceBinding.conversationUrl, 'https://chatgpt.com/c/saved')
  assert.equal(f.calls.filter(call => call[0] === 'luna').length, 0)
  f.finish(accepted.bridgeJobId); await tick(); await tick()
  const result = await jobs.status(f.parent, accepted.bridgeJobId)
  assert.equal(result.status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 1)
  assert.equal(jobs.list(f.parent).used, 0)
  await jobs.dispose()
})

test('three running executions consume capacity; old unknown lanes do not', async t => {
  const f = fixture(t); f.saved('unknown', { bell: false, address: false }); const jobs = f.make()
  const accepted = []
  for (let i = 0; i < 3; i++) accepted.push(await jobs.accept(f.parent, '@PostmanDevspace independent ' + i, 'devspace'))
  assert.equal((await jobs.accept(f.parent, '@PostmanDevspace fourth', 'devspace')).status, 'POSTMAN_DEVSPACE_CAPACITY_REACHED')
  await tick(); await tick()
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 3)
  for (const item of accepted) f.finish(item.bridgeJobId)
  await tick(); await tick()
  assert.equal(jobs.list(f.parent).used, 0)
  assert.equal(f.calls.filter(call => call[0] === 'send').length, 3, 'BLOCKED prose never creates a new REQ')
  await jobs.dispose()
})

test('Nodes lanes permit one live job per Luna, retain verified old chats, and resume only a selected URL', async t => {
  const f = fixture(t);
  f.parent.session.header.agentPreset = 'postman-leader-ptc-nodes';
  const firstLane = 'nodes:run-a:luna-a', rotatedLane = firstLane + ':next';
  const peerLane = 'nodes:run-a:luna-b', nextRunLane = 'nodes:run-b:luna-a';
  await f.contexts.changeRecord(f.parent.id, row => ({ ...row,
    devspaceLanes: Object.fromEntries([firstLane, rotatedLane, peerLane].map(id =>
      [id, { state: 'reserved', activeBridgeJobId: null, requestIds: [], conversationRef: null }])) }));
  const jobs = f.make();
  const absent = jobs.nodesLunaSnapshot(f.parent, [firstLane]);
  assert.equal(absent[0].status, 'POTENTIAL');
  assert.equal(absent[0].conversationRef, null);
  const a = await jobs.accept(f.parent, '@PostmanDevspace mocked A', 'devspace',
    undefined, undefined, 'READ_ONLY', firstLane);
  assert.equal(a.status, 'POSTMAN_BRIDGE_ACCEPTED');
  const sameLuna = await jobs.accept(f.parent, '@PostmanDevspace denied concurrent', 'devspace',
    undefined, undefined, 'READ_ONLY', rotatedLane);
  assert.equal(sameLuna.status, 'NODES_LUNA_BUSY', 'lane rotation cannot bypass one-current limit');
  const peer = await jobs.accept(f.parent, '@PostmanDevspace mocked B', 'devspace',
    undefined, undefined, 'READ_ONLY', peerLane);
  assert.equal(peer.status, 'POSTMAN_BRIDGE_ACCEPTED');
  await tick(); await tick();
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 2, 'no extra external Send');
  const op = f.row().bridgeOperations[a.bridgeJobId];
  const ref = 'https://chatgpt.com/c/' + op.childSessionId;
  const dir = join(op.devspace.channel, 'web', 'workers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, op.requestId + '.json'), JSON.stringify({
    requestId: op.requestId, conversationUrl: ref
  }));
  f.finish(a.bridgeJobId); f.finish(peer.bridgeJobId);
  await tick(); await tick();
  const snapshot = jobs.nodesLunaSnapshot(f.parent, [firstLane, peerLane]);
  assert.equal(snapshot[0].status, 'IDLE', 'saved history must not consume execution slot');
  assert.equal(snapshot[0].conversationRef, ref);
  assert.equal(snapshot[0].conversations[0].requestId, op.requestId);
  assert.equal(snapshot[0].conversations[0].sourceChildSessionId, op.childSessionId);
  assert.equal(snapshot[0].reminderSent, null, 'no invented reminders');
  assert.equal(snapshot[0].elapsedMs === null || snapshot[0].elapsedMs >= 0, true);
  assert.equal(jobs.list(f.parent).used, 0);
  await f.contexts.changeRecord(f.parent.id, row => ({ ...row,
    bridgeOperations: { ...row.bridgeOperations,
      [a.bridgeJobId]: { ...row.bridgeOperations[a.bridgeJobId], executionRevoked: true } },
  }));
  assert.equal(jobs.nodesLunaSnapshot(f.parent, [firstLane])[0].conversationRef, ref,
    'archive remains accessible after previous job is retired');
  const archive = snapshot[0].conversations[0];
  const native = createNodesLunaNativeBridge(f.ctx, f.contexts, jobs, null);
  assert.equal((await native.reserveLunas(f.parent,[nextRunLane],{...archive,
    conversationRef:'https://chatgpt.com/c/foreign'})).status,'NODES_LUNA_ARCHIVE_UNPROVEN');
  assert.equal((await native.reserveLunas(f.parent,[nextRunLane],archive)).status,'NODES_LUNA_RESERVED');
  assert.equal(jobs.nodesLunaSnapshot(f.parent, [nextRunLane])[0].status, 'IDLE',
    'selected verified chat is idle, never a working job');
  const resumed = await jobs.accept(f.parent, '@PostmanDevspace explicit continuation', 'devspace',
    undefined, undefined, 'READ_ONLY', nextRunLane);
  assert.equal(resumed.status, 'POSTMAN_BRIDGE_ACCEPTED');
  await tick(); await tick();
  const next = f.calls.filter(c => c[0] === 'send').at(-1)[1];
  assert.equal(next.devspaceBinding.conversationUrl, ref);
  assert.equal(next.devspaceBinding.priorRequestId, undefined, 'old REQ is historical only');
  assert.notEqual(next.sessionId, op.childSessionId, 'new Luna identity is independent');
  assert.equal(f.row().bridgeOperations[a.bridgeJobId].requestId, op.requestId);
  f.finish(resumed.bridgeJobId); await tick(); await tick();
  await jobs.dispose();
})

test('ready terminal is readable while Luna delivery is still pending', async t => {
  const f = fixture(t), relay = Promise.withResolvers()
  f.ctx.subagents.followup = () => relay.promise
  const jobs = f.make(), accepted = await jobs.accept(f.parent, '@PostmanDevspace work', 'devspace')
  await tick(); await tick(); f.finish(accepted.bridgeJobId); await tick()
  assert.equal((await jobs.status(f.parent, accepted.bridgeJobId)).status, 'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(f.row().bridgeOperations[accepted.bridgeJobId].state, 'received')
  assert.equal(f.wakes(), 1, 'READY delivery does not await Luna acceptance')
  relay.resolve('accepted'); await tick(); await jobs.dispose()
})

test('revoked job cannot control, but its late bell remains readable', async t => {
  const f = fixture(t), { bridgeJobId } = f.saved('unknown', { revoked: true }), jobs = f.make()
  assert.equal(jobs.devspaceControl(f.parent, bridgeJobId, 'steer', 'new work').status, 'POSTMAN_DEVSPACE_CONTROL_JOB_NOT_FOUND')
  const result = await jobs.status(f.parent, bridgeJobId)
  assert.equal(result.status, 'POSTMAN_BRIDGE_ARCHIVED')
  assert.equal(result.lateResult.source, 'bell')
  await jobs.dispose()
})
