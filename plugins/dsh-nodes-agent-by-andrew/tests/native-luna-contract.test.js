import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
await import('./sdk-loader.mjs')
const { stage1Runtime, stage1Native } = await import('../../dsh-postman-harness/lib/fixtures/postman-stage1-runtime.js')
const { NodesAgentService } = await import('../lib/index.js')
const { createTemplate } = await import('../lib/domain.js')
const { Service } = await stage1Native('cordis')
const { SkillRegistry } = await stage1Native('dsh-skill')
const { JsonStorageBackend } = await stage1Native('dsh-storage-json')
const { DomainFacility } = await stage1Native('dsh-storage-domain')

test('real native Luna AgentNode Session: independent quota, reverse Authority, Task, cold restore', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nodes-luna-session-'))
  let rt, service
  const requests = []
  try {
    rt = await stage1Runtime(dir, {
      preset: 'postman-leader-ptc-nodes', modelCatalog: ['gpt-6-luna', 'gpt-6.1-sol'],
      nodesService: () => service,
      onRequest(agent) { requests.push(agent.id) },
      async setupTools(ctx) {
        new SkillRegistry(ctx)
        const backend = new JsonStorageBackend(join(dir, 'nodes'))
        const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} },
          { backend: 'json', routes: {} })
        ctx.provide('storageDomain', facility)
        ctx.provide('postmanNativeNodes', {
          start: (...args) => rt.worker.startNodesTeam(...args),
          nodeAction: (...args) => rt.worker.nativeNodeAction(...args),
          deliverMessage: (...args) => rt.worker.deliverNodesMessage(...args),
          reserveLunas: async () => ({ status: 'NODES_LUNA_RESERVED' }),
          lunaSnapshot: (_parent, ids) => ids.map(laneId => ({ laneId, status: 'POTENTIAL' }))
        })
        service = new NodesAgentService(ctx, {})
        await service[Service.init]()
      },
      plan: () => ({ text: 'inert native model response' })
    })
    const template = createTemplate()
    const saved = await service.saveTeam(template.definition, template.layout, 0)
    const run = await service.start(saved.definition.id, rt.leader.id)
    assert.equal(Object.keys(run.bindings).length, 1)
    const agents = run.definition.agents
    const workers = agents.filter(a => a.slot === 'worker-1' || a.slot === 'worker-2')
    const lunas = agents.filter(a => a.slot === 'luna-bridge')
    assert.equal(lunas.length, 3)
    for (const node of [...workers, ...lunas]) {
      const result = await service.nodeAction(rt.leader, node.id, 'activate')
      assert.equal(result.status, 'NODES_NODE_ACTIVE', JSON.stringify(result))
      assert.ok(service.getRun(run.id).bindings[node.id].sessionId)
    }
    assert.equal(requests.length, 0, 'native bootstrap never invokes an LLM')
    assert.equal(Object.keys(service.getRun(run.id).bindings).length, 6,
      'two regular Workers and three Luna AgentNodes coexist')
    const luna = lunas[0]
    const childId = service.getRun(run.id).bindings[luna.id].sessionId
    const lunaAgent = rt.ctx.agents.get(childId)
    assert.equal(lunaAgent.session.header.parentSession, rt.leader.id)
    assert.equal(service.bindingOf(lunaAgent)?.nodeId, luna.id)
    const reverse = await service.sendMessage(lunaAgent, run.entryNodeId, 'Reverse direct Authority')
    assert.equal(reverse.status, 'NODES_MESSAGE_DELIVERED')
    await rt.leader.whenIdle()
    const ended = Promise.withResolvers()
    const unsub = rt.ctx.on('session/event', (session, event) => {
      if (session.id === childId && event.type === 'turn/end') ended.resolve()
    })
    try {
      const task = await service.assignTask(rt.leader, luna.id, 'Native Luna assignment')
      assert.equal(task.status, 'NODES_TASK_ASSIGNED')
      await ended.promise
      await rt.ctx.agents.get(childId)?.whenIdle()
      assert.ok(requests.includes(childId), 'assignment reaches native Luna model adapter')
      const completed = await service.completeTask(rt.ctx.agents.get(childId), task.taskId, 'Inert result')
      assert.equal(completed.status, 'NODES_TASK_COMPLETED')
    } finally { unsub() }
    await rt.leader.whenIdle()
    const cold = await service.nodeAction(rt.leader, luna.id, 'finish')
    assert.equal(cold.status, 'NODES_NODE_SUSPENDED', JSON.stringify(cold))
    assert.equal(service.getRun(run.id).bindings[luna.id].sessionId, childId)
    assert.equal(service.getRun(run.id).bindings[luna.id].status, 'COLD')
    const turns = requests.filter(id => id === childId).length
    const reactivated = await service.nodeAction(rt.leader, luna.id, 'activate')
    assert.equal(reactivated.status, 'NODES_NODE_ACTIVE', JSON.stringify(reactivated))
    assert.equal(reactivated.workerSessionId, childId, 'cold activation retains exact native Session')
    assert.equal(requests.filter(id => id === childId).length, turns,
      'activation without assignment does not invoke the model')
  } finally {
    await rt?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
