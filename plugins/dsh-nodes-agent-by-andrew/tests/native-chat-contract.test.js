import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
await import('./sdk-loader.mjs')
const { stage1Runtime, stage1Native } = await import('../../dsh-postman-harness/lib/fixtures/postman-stage1-runtime.js')
const { NodesAgentService } = await import('../lib/index.js')
const { createTemplate } = await import('../lib/domain.js')
const { createNodesLunaNativeBridge, createPostmanBridgeTool } = await import('../../dsh-postman-harness/lib/postman-bridge.js')
const { createPostmanBridgeJobs } = await import('../../dsh-postman-harness/lib/postman-bridge-jobs.js')
const { createDevspaceChannel } = await import('../../dsh-postman-harness/lib/postman-devspace.js')
const { openPostmanTaskRegistry } = await import('../../dsh-postman-harness/lib/postman-task-registry.js')
const { Service } = await stage1Native('cordis')
const { SkillRegistry } = await stage1Native('dsh-skill')
const { JsonStorageBackend } = await stage1Native('dsh-storage-json')
const { DomainFacility } = await stage1Native('dsh-storage-domain')

test('real SDK/PTC all-role connected Chat routes through the durable native Bridge and own exact REQ', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-nodes-chat-'))
  const priorLocal = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = dir
  const channelRoot = join(dir, 'transport')
  mkdirSync(channelRoot, { recursive: true })
  let rt, registry, jobs, service, native
  let serial = 0, count = 0
  const pending = new Map(), sends = [], outcomes = [], requests = []
  try {
    const backend = new JsonStorageBackend(join(dir, 'tasks'))
    const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} },
      { backend: 'json', routes: {} })
    registry = await openPostmanTaskRegistry(facility)
    const contexts = {
      get: id => id === 'leader' ? { leaderSessionId: id, cwd: dir, worktree: dir, workspaceOnly: true } : null,
      record: registry.get, changeRecord: registry.change,
      ensure: async parent => assert.equal(parent.id, 'leader')
    }
    const direct = {
      async start(args) {
        const requestId = 'REQ_20261027T094449Z_' + String(++serial).padStart(4, '0')
        const binding = createDevspaceChannel({
          ...args.devspaceBinding, root: channelRoot, requestId, sourceRoot: dir
        })
        await args.onRequestAllocated(requestId, binding.channel)
        pending.set(args.sessionId, { args, requestId, binding, finished: Promise.withResolvers() })
        sends.push({ requestId, sessionId: args.sessionId,
          conversationUrl: args.devspaceBinding.conversationUrl ?? null })
        return { requestId }
      },
      wait: id => pending.get(id).finished.promise,
      dispose() {}
    }
    const coordinator = { run: (_signal, action) => Promise.resolve().then(action),
      fork() { return this }, dispose() {} }
    rt = await stage1Runtime(dir, {
      registry, preset: 'postman-leader-ptc-nodes',
      modelCatalog: ['gpt-6-luna', 'gpt-6.1-sol'], nodesService: () => service,
      onRequest(agent) { requests.push(agent.id) },
      async setupTools(ctx) {
        new SkillRegistry(ctx)
        const nodeBackend = new JsonStorageBackend(join(dir, 'nodes'))
        const nodeFacility = new DomainFacility({
          storage: { backend: { get: () => nodeBackend } }, emit() {}
        }, { backend: 'json', routes: {} })
        ctx.provide('storageDomain', nodeFacility)
        jobs = createPostmanBridgeJobs(ctx, coordinator, null, contexts, null, direct, () => service)
        const bridge = createPostmanBridgeTool(ctx, jobs, contexts, () => service)
        ctx.tools.register(bridge)
        native = createNodesLunaNativeBridge(ctx, contexts, jobs, bridge)
        ctx.provide('postmanNativeNodes', {
          start: (...args) => rt.worker.startNodesTeam(...args),
          nodeAction: (...args) => rt.worker.nativeNodeAction(...args),
          deliverMessage: (...args) => rt.worker.deliverNodesMessage(...args),
          ...native
        })
        service = new NodesAgentService(ctx, {})
        await service[Service.init]()
      },
      plan: () => ({ text: 'inert local model output' })
    })
    const template = createTemplate(), shared = template.definition.chats[0]
    const connected = new Set(template.definition.chatConnections.map(c => c.agentId + ':' + c.chatNodeId))
    for (const agent of template.definition.agents) {
      const key = agent.id + ':' + shared.id
      if (!connected.has(key)) template.definition.chatConnections.push({
        id: 'shared:' + agent.id, agentId: agent.id, chatNodeId: shared.id
      })
    }
    const saved = await service.saveTeam(template.definition, template.layout, 0)
    const run = await service.start(saved.definition.id, rt.leader.id)
    const rootNode = run.entryNodeId
    const roleNodes = run.definition.agents
    for (const node of roleNodes) {
      if (node.slot === 'entry' || node.slot.startsWith('sol-worker')) continue
      const activated = await service.nodeAction(rt.leader, node.id, 'activate')
      assert.equal(activated.status, 'NODES_NODE_ACTIVE', node.slot + ':' + JSON.stringify(activated))
    }
    const sol = roleNodes.find(a => a.slot === 'sol')
    for (const node of roleNodes.filter(a => a.slot.startsWith('sol-worker'))) {
      const nativeSol = rt.ctx.agents.get(service.getRun(run.id).bindings[sol.id].sessionId)
      assert(nativeSol, 'Sol native parent must be resident')
      await nativeSol.whenIdle()
      const activated = await service.nodeAction(nativeSol, node.id, 'activate')
      assert.equal(activated.status, 'NODES_NODE_ACTIVE', node.slot + ':' + JSON.stringify(activated))
    }
    assert.equal(Object.keys(service.getRun(run.id).bindings).length, roleNodes.length)
    assert.equal(roleNodes.length, 10)

    async function getAgent(node) {
      const binding = service.getRun(run.id).bindings[node.id]
      assert(binding?.sessionId)
      if (node.slot === 'sol' && !rt.ctx.agents.get(binding.sessionId)) {
        const restored = await service.nodeAction(rt.leader, node.id, 'activate')
        assert.equal(restored.status, 'NODES_NODE_ACTIVE')
      }
      const agent = rt.ctx.agents.get(binding.sessionId)
      assert.ok(agent, 'resident native Session ' + node.slot)
      return agent
    }
    const directTool = async (agent, name, args) => {
      const raw = await rt.ctx.tools.execute({ name, arguments: args,
        callId: 'chat-native-' + (++count), ...rt.exec(agent) })
      assert.equal(raw?.isError, false, JSON.stringify(raw))
      return raw?.value ?? raw
    }
    const ptc = async (agent, expression) => {
      const value = await directTool(agent, 'ptc_execute', { program: 'return await (' + expression + ');' })
      assert.equal(value?.status, 'ok', JSON.stringify(value))
      return value.value
    }
    async function chatCall(node, name, args) {
      const agent = await getAgent(node)
      if (node.slot === 'entry' || node.slot === 'sol')
        return ptc(agent, 'tools.' + name + '(' + JSON.stringify(args) + ')')
      return directTool(agent, name, args)
    }
    async function allocation(jobId) {
      for (let retry = 0; retry < 150; retry++) {
        const op = registry.get(rt.leader.id)?.bridgeOperations?.[jobId]
        if (op?.requestId && pending.has(op.childSessionId))
          return { op, entry: pending.get(op.childSessionId) }
        await new Promise(resolve => setTimeout(resolve, 6))
      }
      throw Error('Native Bridge allocation absent: ' + jobId)
    }
    const urlA = 'https://chatgpt.com/c/native-connected-chat'
    const urlB = 'https://chatgpt.com/c/native-new-chat'
    async function externalComplete(jobId, url = urlA) {
      const { op, entry } = await allocation(jobId)
      const folder = join(entry.binding.channel, 'web', 'workers')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, op.requestId + '.json'),
        JSON.stringify({ requestId: op.requestId, conversationUrl: url }))
      entry.finished.resolve({ status: 'COMPLETED', requestId: op.requestId,
        result: { requestId: op.requestId, source: 'text_fallback',
          assistantText: 'verified fake reply ' + op.requestId, conversationRef: url } })
      for (let retry = 0; retry < 180; retry++) {
        const status = await jobs.status(rt.leader, jobId)
        const durable = registry.get(rt.leader.id)?.bridgeOperations?.[jobId]
        if (status.status === 'POSTMAN_BRIDGE_TERMINAL' && durable?.nodesDelivery?.status === 'delivered')
          return { status, durable }
        await new Promise(resolve => setTimeout(resolve, 6))
      }
      const status = await jobs.status(rt.leader, jobId)
      const durable = registry.get(rt.leader.id)?.bridgeOperations?.[jobId]
      throw Error('Missing trusted terminal/delivery ' + JSON.stringify({
        status, nodesDelivery: durable?.nodesDelivery, requestId: op.requestId
      }))
    }
    for (const role of roleNodes) {
      const reply = await chatCall(role, 'nodes_chat_send', {
        chatNodeId: shared.id, message: 'inert task for ' + role.slot,
        devspaceMode: 'WRITE_TEST'
      })
      assert.equal(reply.status, 'POSTMAN_BRIDGE_ACCEPTED', role.slot + ':' + JSON.stringify(reply))
      assert.equal(reply.laneId, service.getRun(run.id).lunaSelections[shared.lunaId])
      const terminal = await externalComplete(reply.bridgeJobId, role.slot === 'secretary' ? urlB : urlA)
      assert.equal(terminal.durable.nodesInvocation.initiatorNodeId, role.id)
      assert.equal(terminal.durable.nodesInvocation.initiatorSessionId,
        service.getRun(run.id).bindings[role.id].sessionId)
      assert.equal(terminal.durable.nodesInvocation.chatNodeId, shared.id)
      assert.equal(terminal.durable.nodesInvocation.runId, run.id)
      const own = await chatCall(role, 'nodes_chat_result', {
        chatNodeId: shared.id, bridgeJobId: reply.bridgeJobId
      })
      assert.equal(own.status, 'POSTMAN_BRIDGE_TERMINAL')
      assert.equal(own.requestId, terminal.durable.requestId)
      assert.equal(own.result.assistantText, 'verified fake reply ' + own.requestId)
      assert.equal(Object.hasOwn(own, 'nodesInvocation'), false, 'no foreign invocation leaked')
      outcomes.push({ role: role.slot, jobId: reply.bridgeJobId, requestId: own.requestId })
      await rt.leader.whenIdle()
      if (role.slot === 'entry') {
        const before = sends.length, oldLane = service.getRun(run.id).lunaSelections[shared.lunaId]
        const switched = await chatCall(roleNodes.find(a => a.slot === 'worker-1'),
          'nodes_chat_select', { chatNodeId: shared.id })
        assert.equal(switched.status, 'NODES_CHAT_SELECTED', JSON.stringify(switched))
        assert.notEqual(switched.laneId, oldLane, 'explicit new-chat selection rotates the lane')
        assert.equal(sends.length, before, 'selecting does not Send')
      }
      if (role.slot === 'secretary') {
        assert.equal(sends.at(-1).conversationUrl, null, 'a new Chat is not historical continuation')
        const archivedFacts = jobs.nodesLunaSnapshot(rt.leader.id, [run.lunaSelections[shared.lunaId]])[0]
        assert.equal(archivedFacts.conversations[0]?.id, outcomes[0].jobId, JSON.stringify(archivedFacts))
        await service.syncLunaArchive(run.id)
        assert.equal(service.getRun(run.id).lunaArchive[shared.lunaId]?.[0]?.id, outcomes[0].jobId,
          JSON.stringify(service.getRun(run.id).lunaArchive))
        const before = sends.length
        const selected = await chatCall(roleNodes.find(a => a.slot === 'sol'),
          'nodes_chat_select', { chatNodeId: shared.id, archiveId: outcomes[0].jobId })
        assert.equal(selected.status, 'NODES_CHAT_SELECTED', JSON.stringify(selected))
        assert.equal(selected.selectedArchiveId, outcomes[0].jobId)
        assert.equal(selected.conversationRef, urlA)
        assert.equal(sends.length, before, 'archive selection is not a Send')
      }
      if (role.slot === 'worker-1') {
        assert.equal(sends.at(-1).conversationUrl, urlA, 'verified archived Chat is reused by another connected role')
        assert.notEqual(own.requestId, outcomes[0].requestId, 'continuation has a new REQ identity')
      }
    }
    assert.equal(outcomes.length, 10)
    assert.equal(new Set(outcomes.map(o => o.requestId)).size, 10, 'fresh REQ for every send')
    assert.equal(sends.length, 10, 'one native external transport Send for each role')
    const worker = roleNodes.find(n => n.slot === 'worker-1')
    const secret = roleNodes.find(n => n.slot === 'secretary')
    const otherChat = template.definition.chats[1]
    const isolated = await chatCall(worker, 'nodes_chat_send', {
      chatNodeId: otherChat.id, message: 'forbidden disconnected'
    })
    assert.equal(isolated.status, 'NODES_CHAT_NOT_CONNECTED')
    const unauthorized = await chatCall(secret, 'nodes_chat_result', {
      chatNodeId: shared.id, bridgeJobId: outcomes[0].jobId
    })
    assert.equal(unauthorized.status, 'NODES_CHAT_JOB_NOT_OWNED')
    const beforeForged = sends.length
    const forged = await native.sendLuna(rt.leader,
      service.getRun(run.id).lunaSelections[shared.lunaId],
      { message: '@PostmanDevspace forged cross-Run', devspace_mode: 'WRITE_TEST' },
      new AbortController().signal,
      { runId: 'foreign-run', initiatorNodeId: rootNode,
        initiatorSessionId: rt.leader.id, chatNodeId: shared.id,
        laneId: service.getRun(run.id).lunaSelections[shared.lunaId] })
    assert.equal(forged.status, 'NODES_CHAT_INVOCATION_REJECTED')
    assert.equal(sends.length, beforeForged, 'forged cross-Run intent cannot create a REQ')
    assert.equal(jobs.list(rt.leader).used, 0)
  } finally {
    await jobs?.dispose()
    await rt?.dispose()
    await registry?.close()
    if (priorLocal === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = priorLocal
    rmSync(dir, { recursive: true, force: true })
  }
})
