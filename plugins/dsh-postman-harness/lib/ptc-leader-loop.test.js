import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPtcAdapter } from './ptc-adapter.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createPostmanBridgeTool, createPostmanTaskPrepareTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { isTopLevelPostmanPtcLeader, postmanBridgeRestrictionForAgent } from './postman-bridge-core.js'

// One installed SDK identity. The model and external runners are inert; the
// complete AgentLoop scheduler, ToolRuntime, tools and QuickJS are real.
const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh')
const pkg = name => import(pathToFileURL(join(installed, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const { Context } = await pkg('cordis')
const { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session')
const { SystemPrompt } = await pkg('dsh-system-prompt')
const { ToolRuntime, defineTool } = await pkg('dsh-tools')
const { LlmRuntime, LlmAdapter, createUserMessage } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop')

for (const producer of ['postman_worker', 'postman_worker_interrupt', 'postman_bridge', 'prepare-only', 'unknown-status', 'failure-status', 'pending-status', 'ambiguous-program', 'bridge-with-queued-notice', 'worker-with-queued-notice', 'interrupt-with-queued-notice', 'bridge-with-queued-user', 'bridge-post-blocked']) {
  const accepted = ['postman_worker', 'postman_worker_interrupt', 'postman_bridge', 'bridge-with-queued-notice', 'worker-with-queued-notice', 'interrupt-with-queued-notice', 'bridge-with-queued-user'].includes(producer)
  const queued = producer.includes('-with-queued-')
  const toolName = producer.startsWith('worker-')?'postman_worker':producer.startsWith('interrupt-')?'postman_worker_interrupt':producer.startsWith('bridge-')?'postman_bridge':producer
  test('full Leader runtime acceptance boundary: ' + producer, { timeout: 15000 }, async t => {
    const ctx = new Context(), requests = [], diagnostics = []
    new AgentRegistry(ctx); new SessionStore(ctx); new SystemPrompt(ctx, {})
    new ToolRuntime(ctx); new LlmRuntime(ctx); new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
    ctx.logger.exporter({ export: m => { if (m.name === 'postman-ptc') diagnostics.push(m.args[1]) } })
    const context = Object.freeze({ worktree: process.cwd(), branch: 'task/fixture' })
    const contexts = { get: () => context, prepare: () => ({ status: 'POSTMAN_TASK_CONTEXT_ALREADY_READY' }) }
    ctx.subagents = {
      startContinuable: async spec => ({ childId: spec.childId, messageId: 'accepted' }),
      followup: async () => 'followup',
      drainContinuableChildren: async () => {},
    }
    const worker = createPostmanWorkerTools(ctx, undefined, contexts)
    // Hold the real job lifecycle outside the PTC program; acceptance must not
    // confuse QUEUED Bridge state with an unsettled nested dispatch effect.
    const held = Promise.withResolvers()
    const coordinator = { run: () => held.promise, dispose() { held.resolve({ status: 'fixture-stopped' }) } }
    const jobs = createPostmanBridgeJobs(ctx, coordinator, undefined, contexts)
    const adapter = createPtcAdapter(ctx, { authorize: isTopLevelPostmanPtcLeader })
    const output = { schema: { type: 'object', additionalProperties: true }, render: (_a,v) => [{ type: 'text', text: JSON.stringify(v) }] }
    for (const name of ['read', 'grep']) ctx.tools.register(defineTool({ name, description: name, parameters: {}, output, execute: () => ({ name }) }))
    for (const tool of [adapter.tool, worker.taskTool, worker.interruptTool, createPostmanBridgeTool(ctx, jobs, contexts), createPostmanTaskPrepareTool(ctx, contexts)]) ctx.tools.register(tool)
    const unconfirmed={'unknown-status':'NEW_STATUS','failure-status':'POSTMAN_BRIDGE_CALLER_REJECTED','pending-status':'POSTMAN_BRIDGE_PENDING'}
    if (unconfirmed[producer]) ctx.on('tools/execute',async(exec,next)=>exec.parent && exec.name==='postman_bridge'?
      {isError:false,value:{status:unconfirmed[producer]}}:next())
    let workerId
    class Model extends LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'] } }
      async *stream(request) {
        requests.push(request)
        if (requests.length === 1) {
          const program = producer === 'prepare-only' ? "return ptc.expectStatus(await tools.postman_task_prepare({}), 'postman_task_prepare')" :
            producer === 'ambiguous-program' ? "const accepted=await tools.postman_bridge({message:'@PostmanAsk fixture'}); return {status:accepted.status,needsModelDecision:true}" :
            toolName === 'postman_bridge' || unconfirmed[producer] ? "return await tools.postman_bridge({message:'@PostmanAsk fixture'})" :
            toolName === 'postman_worker_interrupt' ? 'return await tools.postman_worker_interrupt({task:"continue",workerSessionId:' + JSON.stringify(workerId) + '})' :
            'return await tools.postman_worker({task:"fixture",createNew:true})'
          const checkedProgram = accepted ? 'return ptc.expectStatus('+program.slice('return '.length)+','+JSON.stringify(toolName)+')' : program
          yield { type:'block-end', index:0, block:{type:'tool-call',id:'dispatch',name:'ptc_execute',arguments:JSON.stringify({program:checkedProgram,description:'Dispatch and wait for external event '.repeat(20),boundary:'external_event', ...(producer==='postman_bridge'?{yield_on_success:false}:{})})} }
        } else yield { type:'block-end',index:0,block:{type:'text',text:'review event'} }
        yield {type:'finish',reason:{kind:'stop'}}
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Model())
    const leader = ctx.agentLoop.create('leader', {provider:'fixture',model:'sol'}, {cwd:process.cwd(),agentPreset:'postman-leader-ptc'})
    leader.ctx.tools.restrict({allow:postmanBridgeRestrictionForAgent(leader).allow.filter(name=>ctx.tools.get(name))}); adapter.refresh(leader)
    if (toolName === 'postman_worker_interrupt') workerId = (await worker.taskTool.execute({task:'initial',createNew:true}, {agent:leader,signal:new AbortController().signal})).workerSessionId
    if (queued) {
      ctx.on('tools/execute',async(exec,next)=>{
        if (exec.parent && exec.name===toolName) {
          const notice=createUserMessage({content:[{type:'text',text:'Worker settled notice after report'}],source:{kind:'subagent-settled',form:'notice',senderSessionId:'reported-worker',summary:'Worker finished'}})
          if (producer==='bridge-with-queued-user') {
            leader.followup(createUserMessage({content:[{type:'text',text:'new user message'}]}))
            leader.steer(notice)
          } else leader.steer(notice)
        }
        return next()
      })
      ctx.on('agent/pre-step',async(payload,next)=>{
        const decision=await next()
        return decision.kind==='enter' && payload.step>1 ? {kind:'enter',messages:[...decision.messages,createUserMessage({content:[{type:'text',text:'one-shot policy evidence'}]})]} : decision
      })
    }
    if (producer==='bridge-post-blocked') ctx.on('tools/post-execute',async(exec,result,next)=>
      exec.name==='ptc_execute'?{kind:'block',feedback:'Outer PTC result rejected'}:next())
    t.after(async () => { worker.dispose(); await adapter.dispose(); await jobs.dispose(); await ctx.fiber.dispose() })
    leader.followup(createUserMessage({content:[{type:'text',text:'start'}]}))
    await leader.whenIdle()
    assert.equal(requests.length, accepted && !queued ? 1 : 2)
    if (queued) {
      const second=leader.session.events.filter(e=>e.type==='assistant/message').at(-1)
      assert.equal(second.data.step,1)
      assert.equal(second.data.turn,2,'queued notice must be reviewed in a NEW turn, not a yield-only continuation')
      assert.equal(leader.session.events.filter(e=>e.type==='turn/end').length,2)
      const messages=leader.session.events.filter(e=>e.type==='user/message' && e.data.source?.kind!=='tool')
      assert.equal(messages.filter(e=>e.data.content.some(c=>c.text==='Worker settled notice after report')).length,1)
      if (producer!=='bridge-with-queued-user') assert.equal(messages.filter(e=>e.data.content.some(c=>c.text==='one-shot policy evidence')).length,1)
      else assert.ok(messages.some(e=>e.data.content.some(c=>c.text==='new user message')))
      const { Inbox } = await pkg('dsh-agent')
      const replay=new Inbox(leader.session,{inserted(){},discarded(){},claimed(){}})
      assert.equal(replay.hasPending,false)
    }
    assert.deepEqual(leader.session.events.filter(e=>e.type==='tool/call').map(e=>e.data.name), ['ptc_execute'])
    assert.equal(diagnostics.at(-1).yieldApplied, accepted || producer==='bridge-post-blocked') // Post-execute can still veto the staged marker.
    assert.equal(leader.status, 'idle')
    assert.equal(diagnostics.at(-1).descriptionNormalized,true)
    if (!accepted && producer!=='bridge-post-blocked') assert.equal(diagnostics.at(-1).yieldBlockedReason, producer==='prepare-only'?'no-accepted-producer':producer==='ambiguous-program'?'model-decision-requested':'acceptance-not-confirmed')
    if (accepted && !queued) {
      leader.followup(createUserMessage({content:[{type:'text',text:producer==='postman_bridge'?'POSTMAN_BRIDGE_READY':'Worker report'}]}))
      await leader.whenIdle()
      assert.equal(requests.length, 2)
    }
  })
}
