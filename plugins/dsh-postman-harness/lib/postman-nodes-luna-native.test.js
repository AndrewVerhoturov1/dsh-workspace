import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// Use native installed SDK modules inside the isolated source worktree.
await import('../../dsh-nodes-agent-by-andrew/tests/sdk-loader.mjs')
const { createNodesLunaNativeBridge, createPostmanBridgeTool } = await import('./postman-bridge.js')
const { createPostmanBridgeJobs } = await import('./postman-bridge-jobs.js')
const { createDevspaceChannel } = await import('./postman-devspace.js')
const { openPostmanTaskRegistry } = await import('./postman-task-registry.js')
const { stage1Native } = await import('./fixtures/postman-stage1-runtime.js')

const { JsonStorageBackend } = await stage1Native('dsh-storage-json')
const { DomainFacility } = await stage1Native('dsh-storage-domain')
const root = tmpdir()
const tick = () => new Promise(resolve => setImmediate(resolve))

test('real durable Bridge registry: three Luna lanes, live facts, A→B→A, exact new REQ and cold cross-Run provenance', { timeout: 30000 }, async t => {
  const dir = mkdtempSync(join(root, 'phase-b-registry-'))
  const originalLocal = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = dir
  const channelRoot = join(dir, 'DSH', 'Postman', 'devspace')
  mkdirSync(channelRoot, { recursive: true })
  let registry, jobs
  t.after(async () => {
    try { await jobs?.dispose() } finally {
      await registry?.close()
      if (originalLocal === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = originalLocal
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function openRegistry() {
    const backend = new JsonStorageBackend(join(dir, 'durable-tasks'))
    const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} },
      { backend: 'json', routes: {} })
    return openPostmanTaskRegistry(facility)
  }
  registry = await openRegistry()
  const owners = new Map(), agents = new Map(), selections = new Map(), pending = new Map()
  const calls = [], lifecycle = { models: 0, lunaStarts: 0 }
  function createLeader(id) {
    const parent = { id, status: 'idle', session: { header: {
      agentPreset: 'postman-leader-ptc-nodes', delegationDepth: 0, cwd: dir } },
      followup() {} }
    agents.set(id, parent)
    owners.set(id, { leaderSessionId: id, worktree: dir, workspaceOnly: true })
    return parent
  }
  const contexts = {
    get: id => owners.get(id) ?? null,
    record: id => registry.get(id),
    changeRecord: (id, fn) => registry.change(id, fn),
    ensure: async p => assert.ok(registry.get(p.id)),
  }
  const ctx = {
    agents: { get: id => agents.get(id) },
    subagents: {
      async startContinuable({ childId, request }) {
        assert.match(request.persona, /Luna transport liaison/)
        lifecycle.lunaStarts++
        agents.set(childId, { id: childId })
        return { childId }
      },
      async followup() { return 'native-accepted' },
    },
  }
  let requestNo = 0
  const direct = {
    async start(args) {
      const requestId = 'REQ_20261026T221000Z_' + String(++requestNo).padStart(4, '0')
      const binding = createDevspaceChannel({ ...args.devspaceBinding, root: channelRoot,
        requestId, sourceRoot: dir })
      calls.push({ args, requestId, binding })
      await args.onRequestAllocated(requestId, binding.channel)
      pending.set(args.sessionId, { binding, deferred: Promise.withResolvers(), args })
      return { requestId }
    },
    wait: child => pending.get(child).deferred.promise,
    dispose() {},
  }
  const coordinator = { run: (_signal, fn) => Promise.resolve().then(fn),
    fork() { return this }, dispose() {} }
  const nodes = { runForAgent(a) {
    const selection = selections.get(a?.id)
    return agents.get(a?.id) === a && selection
      ? { status: 'RUNNING', lunaSelections: selection } : null
  } }
  function makeBridge() {
    jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts, null, direct, () => nodes)
    const tool = createPostmanBridgeTool(ctx, jobs, contexts, () => nodes)
    return createNodesLunaNativeBridge(ctx, contexts, jobs, tool)
  }
  async function allocate(jobId, owner) {
    for (let n = 0; n < 120; n++) {
      const op = registry.get(owner.id)?.bridgeOperations?.[jobId]
      if (op?.requestId && pending.has(op.childSessionId))
        return { op, slot: pending.get(op.childSessionId) }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Fake external adapter did not receive an exact Bridge Send: ' +
      JSON.stringify({ status: await jobs.status(owner, jobId),
        operation: registry.get(owner.id)?.bridgeOperations?.[jobId],
        attempts: calls.map(c => c.requestId), active: [...pending.keys()], lifecycle,
        lanes: registry.get(owner.id)?.devspaceLanes }))
  }
  function observe(jobId, owner, url, reminderSlots = undefined) {
    const op = registry.get(owner.id).bridgeOperations[jobId]
    const slot = pending.get(op.childSessionId)
    assert.ok(slot, 'direct adapter knows the exact child')
    const workerPath = join(slot.binding.channel, 'web', 'workers')
    mkdirSync(workerPath, { recursive: true })
    writeFileSync(join(workerPath, op.requestId + '.json'),
      JSON.stringify({ requestId: op.requestId, conversationUrl: url }))
    if (reminderSlots) writeFileSync(join(slot.binding.channel, 'result.json'),
      JSON.stringify({ requestId: op.requestId, conversationRef: url,
        transportDiagnostics: { reminderSlots } }))
    return { op, slot }
  }
  async function complete(jobId, owner, url) {
    const { op, slot } = observe(jobId, owner, url)
    slot.deferred.resolve({ status: 'COMPLETED', requestId: op.requestId,
      result: { requestId: op.requestId, source: 'text_fallback',
        assistantText: 'Fake external transport terminal', conversationRef: url } })
    for (let n = 0; n < 120; n++) {
      if ((await jobs.status(owner, jobId)).status === 'POSTMAN_BRIDGE_TERMINAL' &&
          jobs.list(owner).operations.find(item => item.bridgeJobId === jobId)?.countsAgainstLimit === false)
        return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw Error('Bridge job did not reach a native terminal')
  }

  const leader1 = createLeader('native-root-1')
  await registry.create(leader1.id, { leaderSessionId: leader1.id, cwd: dir,
    workers: {}, bridgeOperations: {} })
  const first = ['nodes:run-1:luna-a', 'nodes:run-1:luna-b', 'nodes:run-1:luna-c']
  selections.set(leader1.id, { a: first[0], b: first[1], c: first[2] })
  let native = makeBridge()
  assert.equal((await native.reserveLunas(leader1, first)).status, 'NODES_LUNA_RESERVED')
  assert.equal(lifecycle.lunaStarts, 0, 'potential Luna must not create a DSH Session at TeamRun Start')
  assert.equal(lifecycle.models, 0)
  assert.ok(jobs.nodesLunaSnapshot(leader1, first).every(value => value.status === 'POTENTIAL'))
  const send = (parent, lane, message) => native.sendLuna(parent, lane,
    { message: '@PostmanDevspace ' + message, devspace_mode: 'READ_ONLY' })

  const a = await send(leader1, first[0], 'first chat A')
  assert.equal(a.status, 'POSTMAN_BRIDGE_ACCEPTED', JSON.stringify(a))
  assert.ok(['NODES_LUNA_BUSY', 'POSTMAN_DEVSPACE_LUNA_BUSY'].includes(
    (await send(leader1, first[0], 'rejected concurrent A')).status))
  assert.equal((await native.reserveLunas(leader1, ['nodes:run-1:luna-a:bad-rotation'],
    null, first[0])).status, 'NODES_LUNA_BUSY')
  const b = await send(leader1, first[1], 'peer B')
  const c = await send(leader1, first[2], 'peer C')
  for (const receipt of [a, b, c]) {
    assert.equal(receipt.status, 'POSTMAN_BRIDGE_ACCEPTED')
    await allocate(receipt.bridgeJobId, leader1)
  }
  assert.equal(jobs.list(leader1).used, 3)
  assert.equal((await send(leader1, first[0], 'fourth')).status !== 'POSTMAN_BRIDGE_ACCEPTED', true)
  const urlA = 'https://chatgpt.com/c/native-a', urlPeerB = 'https://chatgpt.com/c/peer-b',
    urlPeerC = 'https://chatgpt.com/c/peer-c', urlB = 'https://chatgpt.com/c/native-b'
  observe(a.bridgeJobId, leader1, urlA, {
    first: { state: 'SENT_CONFIRMED' }, next: { state: 'PENDING' }, uncertain: { state: 'BLOCKED_UNKNOWN' }
  })
  const working = jobs.nodesLunaSnapshot(leader1, [first[0]])[0]
  assert.equal(working.status, 'WORKING')
  assert.equal(working.hostJobState, 'RUNNING')
  assert.equal(working.activeJobId, a.bridgeJobId)
  assert.equal(working.conversationRef, urlA)
  assert.ok(working.startedAt && working.elapsedMs >= 0)
  assert.equal(working.timeBasis, 'HOST_JOB')
  assert.equal(working.reminderSent, 1, 'only SENT_CONFIRMED counts')
  assert.equal(working.reminderState, 'PENDING')
  assert.ok(!Object.hasOwn(working, 'model') && !Object.hasOwn(working, 'reasoning'))

  await complete(a.bridgeJobId, leader1, urlA)
  await complete(b.bridgeJobId, leader1, urlPeerB)
  await complete(c.bridgeJobId, leader1, urlPeerC)
  assert.equal(jobs.list(leader1).used, 0)
  const archiveA = jobs.nodesLunaSnapshot(leader1, [first[0]])[0].conversations[0]
  assert.equal(archiveA.sourceLaneId, first[0])
  assert.equal(archiveA.requestId, registry.get(leader1.id).bridgeOperations[a.bridgeJobId].requestId)
  assert.equal(jobs.nodesLunaSnapshot(leader1, [first[0]])[0].reminderSent, 1)
  assert.equal(jobs.nodesLunaSnapshot(leader1, [first[0]])[0].status, 'IDLE')

  const bLane = first[0] + ':fresh-b'
  assert.equal((await native.reserveLunas(leader1, [bLane], null, first[0])).status, 'NODES_LUNA_RESERVED')
  selections.get(leader1.id).a = bLane
  assert.equal((await send(leader1, first[0], 'stale original')).status, 'NODES_LUNA_EXACT_LANE_REQUIRED')
  const freshB = await send(leader1, bLane, 'new chat B')
  await allocate(freshB.bridgeJobId, leader1)
  assert.equal(calls.at(-1).args.devspaceBinding.conversationUrl, undefined)
  await complete(freshB.bridgeJobId, leader1, urlB)

  const back = first[0] + ':return-a'
  const unknown = { ...archiveA, conversationRef: 'https://chatgpt.com/c/foreign' }
  assert.equal((await native.reserveLunas(leader1, [back], unknown, bLane)).status,
    'NODES_LUNA_ARCHIVE_UNPROVEN')
  assert.equal((await native.reserveLunas(leader1, [back], archiveA, bLane)).status, 'NODES_LUNA_RESERVED')
  selections.get(leader1.id).a = back
  const restored = await send(leader1, back, 'continue archived A')
  await allocate(restored.bridgeJobId, leader1)
  const aAgain = calls.at(-1)
  assert.equal(aAgain.args.devspaceBinding.conversationUrl, urlA,
    'selected exact old chat must reach actual native transport')
  assert.equal(aAgain.args.devspaceBinding.priorRequestId, undefined,
    'historical REQ is never assigned to the new job')
  assert.notEqual(aAgain.requestId, archiveA.requestId)
  assert.notEqual(aAgain.args.sessionId, archiveA.sourceChildSessionId)
  await complete(restored.bridgeJobId, leader1, urlA)
  assert.equal(registry.get(leader1.id).bridgeOperations[a.bridgeJobId].requestId, archiveA.requestId)
  assert.equal(jobs.list(leader1).used, 0)

  await jobs.dispose()
  jobs = null
  await registry.close()
  registry = await openRegistry()
  const leader2 = createLeader('native-root-2')
  agents.delete(leader1.id)
  await registry.create(leader2.id, { leaderSessionId: leader2.id, cwd: dir,
    workers: {}, bridgeOperations: {} })
  const crossRunLane = 'nodes:run-2:luna-a'
  selections.set(leader2.id, { a: crossRunLane })
  native = makeBridge()
  assert.equal(jobs.nodesLunaSnapshot(leader1.id, [first[0]])[0].conversations[0].requestId,
    archiveA.requestId, 'cold Host archive is re-read from durable registry and exact channel')
  assert.equal((await native.reserveLunas(leader2, [crossRunLane],
    { ...archiveA, sourceLeaderSessionId: 'forged' })).status, 'NODES_LUNA_ARCHIVE_UNPROVEN')
  assert.equal((await native.reserveLunas(leader2, [crossRunLane], archiveA)).status,
    'NODES_LUNA_RESERVED', 'new TeamRun independently re-proves exact historical source')
  const cross = await send(leader2, crossRunLane, 'new REQ in proven archived A')
  await allocate(cross.bridgeJobId, leader2)
  const crossBound = calls.at(-1)
  assert.equal(crossBound.args.devspaceBinding.conversationUrl, urlA)
  assert.equal(crossBound.args.devspaceBinding.priorRequestId, undefined)
  assert.notEqual(crossBound.requestId, archiveA.requestId)
  await complete(cross.bridgeJobId, leader2, urlA)
  assert.equal(registry.get(leader1.id).bridgeOperations[a.bridgeJobId].requestId, archiveA.requestId)
  assert.equal(jobs.list(leader2).used, 0)
  assert.equal(lifecycle.models, 0, 'external fake and native Luna lifecycle invoked no model adapter')
})
