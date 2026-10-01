import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createPtcAdapter } from './ptc-adapter.js'
import { createPostmanYieldTool } from './postman-bridge.js'
const root = join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
const source = readFileSync(root, 'utf8')
const first = source.indexOf('\tasync turn() {')
const last = source.indexOf('\n\tasync step(', first)
assert.ok(first >= 0 && last > first)
const realTurn = new Function('LlmError', 'errorChain', 'return ({' + source.slice(first, last) + '}).turn')(
  class LlmError extends Error {}, String)
const tool = createPostmanYieldTool({ agents: { get: id => id === 'L' ? active : null } })
let active
function loop(initial, onStep) {
  const nextTurn = initial.map(id => ({ id }))
  const nextStep = []
  const events = [], calls = []
  const agent = { turn: realTurn }
  agent.id = 'L'
  agent.session = { header: { agentPreset: 'postman-leader', delegationDepth: 0 },
    append(type, data) { events.push({ type, data }) } }
  agent.phase = { kind: 'running', turn: 0, step: 0, abort: new AbortController() }
  agent.inbox = { nextTurn, nextStep, get hasPending() { return nextTurn.length + nextStep.length > 0 },
    splice(target, index, removed, inserted) { (target === 'next-turn' ? nextTurn : nextStep).splice(index, removed, ...inserted) },
    claim(target) { return [...nextStep.splice(0), ...target === 'next-turn' ? nextTurn.splice(0) : []] } }
  agent.dispatch = { async serial() {} }
  agent.preStep = async target => ({ kind: 'enter', messages: agent.inbox.claim(target), assembly: {} })
  agent.step = async () => {
    calls.push(agent.phase.turn)
    return onStep(agent, calls.length, tool)
  }
  agent.throwError = error => { throw error }
  active = agent
  return { agent, calls, events, nextTurn }
}
test('real installed turn ends after yield without empty final or extra model call', async () => {
  const f = loop(['user'], async (agent, count, yieldTool) => {
    const result = await yieldTool.execute({}, { agent, concludeTurn() { agent.concluded = true } })
    assert.equal(result.status, 'POSTMAN_YIELDED')
    return agent.concluded ? { kind: 'completed' } : null
  })
  assert.equal(await f.agent.turn(), false)
  assert.equal(f.calls.length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(f.events.some(e => e.type === 'assistant/message'), false)
})
test('real installed turn preserves report/user before, during and after yield', async () => {
  for (const moment of ['before','during','after']) {
    const f = loop(['user'], async (agent, count, yieldTool) => {
      if (count === 1) {
        if (moment === 'during') agent.inbox.nextStep.push({ id: 'report' })
        const result = await yieldTool.execute({}, { agent, concludeTurn() { agent.concluded = true } })
        assert.equal(result.status, 'POSTMAN_YIELDED')
        return agent.concluded ? { kind: 'completed' } : null
      }
      return { kind: 'completed' }
    })
    if (moment === 'before') f.agent.inbox.nextStep.push({ id: 'report' })
    assert.equal(await f.agent.turn(), false)
    if (moment === 'after') f.agent.inbox.nextTurn.push({ id: 'report' })
    if (f.agent.inbox.hasPending) assert.equal(await f.agent.turn(), false)
    assert.ok(f.events.filter(e => e.type === 'user/message').some(e => e.data.id === 'report'), moment)
  }
})

test('PTC automatic conclusion preserves real events queued during dispatch and after turn end', async () => {
  for (const moment of ['during', 'after']) {
    const ctx = new Context(), order = []
    ctx.systemPrompt = { tools() {}, section() { return () => {} } }
    new ToolRuntime(ctx)
    let adapter
    const f = loop(['user'], async (agent, count) => {
      if (count > 1) return { kind: 'completed' }
      const result = await ctx.tools.execute({ callId:'ptc',name:'ptc_execute',agent,signal:agent.phase.abort.signal,
        arguments:{description:'Dispatch and wait for real event',boundary:'external_event',yield_on_success:true,
          program:"ptc.expectStatus(await tools.postman_task_prepare({}),['TASK_CONTEXT_READY']); const w=ptc.expectStatus(await tools.postman_worker({}),['POSTMAN_WORKER_TASK_ACCEPTED']); return {workerSessionId:w.workerSessionId}"} })
      assert.equal(result.value.status,'ok',JSON.stringify(result.value))
      return result.concludesTurn ? { kind:'completed' } : null
    })
    f.agent.session.header.agentPreset = 'postman-leader-ptc'
    ctx.agents = { get: id => id === f.agent.id ? f.agent : null }
    f.agent.ctx = createScope(ctx, f.agent).ctx
    for (const name of ['read','grep','postman_task_prepare','postman_worker']) ctx.tools.register(defineTool({
      name,description:name,parameters:{},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
      execute() {
        order.push(name)
        if (name === 'postman_worker' && moment === 'during') f.agent.inbox.nextStep.push({id:'worker-report'})
        return name === 'postman_task_prepare' ? {status:'TASK_CONTEXT_READY'} :
          name === 'postman_worker' ? {status:'POSTMAN_WORKER_TASK_ACCEPTED',workerSessionId:'worker'} : {name}
      },
    }))
    adapter = createPtcAdapter(ctx, { authorize: agent => agent === f.agent })
    ctx.tools.register(adapter.tool); adapter.refresh(f.agent)
    try {
      assert.equal(await f.agent.turn(),false)
      // A real event arriving during dispatch may trigger the next turn immediately.
      assert.equal(f.calls.length,moment === 'during' ? 2 : 1)
      assert.deepEqual(order,['postman_task_prepare','postman_worker'])
      if (moment === 'after') {
        f.nextTurn.push({id:'bridge-ready'})
        assert.equal(await f.agent.turn(),false)
      }
      assert.equal(f.calls.length,2)
      assert.ok(f.events.some(event => event.type === 'user/message' && event.data.id === (moment === 'during' ? 'worker-report' : 'bridge-ready')))
    } finally { await adapter.dispose(); await ctx.fiber.dispose() }
  }
})

