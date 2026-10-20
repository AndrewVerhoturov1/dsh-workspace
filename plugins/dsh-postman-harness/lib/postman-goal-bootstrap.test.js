import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { createPtcAdapter } from './ptc-adapter.js'
import { isTopLevelPostmanPtcLeader } from './postman-bridge-core.js'

// Real native AgentLoop/SubagentRuntime/goal driver, isolated SDK and fake LLM.
// Only the external transport is inert; no live Host, model, goal or DevSpace.
assert.ok(process.env.DSH_ROOT, 'isolated DSH_ROOT required')
const sdk = createRequire(join(process.env.DSH_ROOT, 'package.json'))
const pkg = name => import(pathToFileURL(sdk.resolve('@deepseek-ai/' + name)).href)
const { Context } = await pkg('cordis')
const { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session')
const { SessionProjectionRegistry } = await pkg('dsh-session-projection')
const { JsonlSessionPersistence } = await pkg('dsh-session-persistence-jsonl')
const { SystemPrompt } = await pkg('dsh-system-prompt')
const { ToolRuntime, defineTool } = await pkg('dsh-tools')
const { LlmRuntime, LlmAdapter, createUserMessage } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop')
const { GoalService } = await pkg('dsh-goal')
const { SubagentRuntime } = await pkg('dsh-subagent')
const { apply: spawn } = await pkg('dsh-subagent-spawn-in-process')
const { apply: report } = await pkg('dsh-tool-subagent-report')
const { apply: goalTools } = await pkg('dsh-tool-goal')
const { apply: goalDriver } = await pkg('dsh-goal-round-driver')
const text = value => ({type:'block-end',index:0,block:{type:'text',text:value}})
const ptc = program => ({type:'block-end',index:0,block:{
  type:'tool-call',id:'phase',name:'ptc_execute',arguments:JSON.stringify({
    program, wait_for_event:true})}})
const human = value => createUserMessage({content:[{type:'text',text:value}],source:{kind:'user',form:'direct'}})
async function drain(agent) {
  await agent.whenIdle()
  for (let i=0;i<8;i++) {
    await agent.ctx.sessions.flush(agent.session)
    await new Promise(resolve=>setImmediate(resolve)); await agent.whenIdle()
  }
}

async function fixture(t, { count=1, ack='POSTMAN_LUNA_BOOTSTRAP_ACK', reasoning='', duringAck, ackDuringDispatch=false,
  expectedInitialRequests=1 } = {}) {
  const dir=mkdtempSync(join(tmpdir(),'goal-bootstrap-')), ctx=new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx,{})
  new JsonlSessionPersistence(ctx,{root:join(dir,'sessions')})
  new ToolRuntime(ctx); new LlmRuntime(ctx); new GoalService(ctx)
  for(const name of ['read','grep'])ctx.tools.register(defineTool({name,description:name,parameters:{},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({fixture:true})}))
  new SubagentRuntime(ctx); spawn(ctx,{providerName:'spawn'}); report(ctx,{reportDelivery:'next-step'})
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1}); goalTools(ctx,{}); goalDriver(ctx)
  const task=Object.freeze({leaderSessionId:'leader',cwd:dir,worktree:dir})
  let row={leaderSessionId:'leader',bridgeOperations:{}}, leader, parentRequests=0, childRequests=0, finalCount=0
  const contexts={get:()=>task,record:()=>row,async changeRecord(_id,fn){row=fn(row);return row}}
  const children=[], gates=Array.from({length:count},()=>Promise.withResolvers())
  const held=Array.from({length:count},()=>Promise.withResolvers()), allocated=Promise.withResolvers()
  const relayGate=Promise.withResolvers()
  const terminal=i=>({status:'COMPLETED',requestId:'REQ_20261018T000000Z_000'+i,
    result:{ok:true,requestId:'REQ_20261018T000000Z_000'+i,source:'bell',reportedOutcome:'DONE',evidenceState:'REPORTED_NOT_VERIFIED'}})
  let allocations=0
  const jobs=createPostmanBridgeJobs(ctx,{run:(_s,fn)=>fn(),dispose(){}},null,contexts,null,{
    async start(options){
      const i=children.findIndex(c=>c.id===options.sessionId), requestId=terminal(i).requestId
      await options.onRequestAllocated(requestId,'C:/synthetic/private')
      if(++allocations===count)allocated.resolve()
      return {requestId}
    },
    wait:id=>held[children.findIndex(c=>c.id===id)].promise,
    dispose(){held.forEach((p,i)=>p.resolve(terminal(i)))},
  })
  let adapter, unregister
  const refresh=()=>{
    unregister?.()
    adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,readWait:()=>row.waitingForEvent===true,writeWait:async(_agent,waitingForEvent)=>{row={...row,waitingForEvent}}})
    unregister=ctx.tools.register(adapter.tool); if(leader)adapter.refresh(leader)
  }
  refresh(); ctx.tools.register(createPostmanBridgeTool(ctx,jobs,contexts))
  ctx.on('postman/subagent-report-defer',(p,c,parts)=>jobs.canDeferLunaBootstrapReport(p,c,parts)?true:undefined)
  ctx.on('postman/subagent-settlement-defer',(p,c,value)=>{
    children.find(entry=>entry.id===c.id)?.settlement.resolve()
    return jobs.canDeferLunaBootstrapSettlement(p,c,value)?true:undefined
  })
  const start=ctx.subagents.startContinuable.bind(ctx.subagents)
  let childStart=Promise.resolve()
  ctx.subagents.startContinuable=spec=>{
    const entry={id:spec.childId,settlement:Promise.withResolvers(),modelStarted:Promise.withResolvers(),steps:0}; children.push(entry)
    // Serialize native persistence setup, as the production launch coordinator
    // does; the inert coordinator deliberately has no wall-clock launch delay.
    entry.handle=childStart.then(async()=>{
      await ctx.sessions.flush(leader.session)
      const handle=await start({...spec,request:{...spec.request,agentOptions:{provider:'fixture',model:'inert'}}})
      await entry.modelStarted.promise
      await ctx.sessions.flush(ctx.agents.get(spec.childId).session)
      return handle
    })
    childStart=entry.handle.then(()=>{})
    return entry.handle
  }
  ctx.on('tools/execute',async(exec,next)=>{
    const result=await next()
    if(ackDuringDispatch && exec.agent===leader && exec.name==='ptc_execute'){
      ackDuringDispatch=false;gates.forEach(p=>p.resolve())
      await Promise.all(children.map(async child=>{await (await child.handle).result;await child.settlement.promise}))
    }
    return result
  })
  class Model extends LlmAdapter {
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      if(request.sessionId==='leader') {
        parentRequests++; if(parentRequests>12)throw Error('bounded model requests')
        const goal=ctx.goals.get(leader), last=leader.session.events.findLast(e=>e.type==='user/message' &&
          e.data.source.form!=='postman-deferred' && (['user','goal','subagent-settled','subagent-report'].includes(e.data.source.kind) ||
          e.data.source.form==='bridge-ready'))?.data
        if(parentRequests===1){
          ctx.goals.create(leader,{objective:'explicit synthetic goal',maxGoalRounds:24})
          yield ptc('const jobs=[];for(let i=0;i<'+count+';i++)jobs.push(await tools.postman_bridge({message:"@PostmanDevspace inert held fixture",devspace_mode:"WRITE_TEST"}));return jobs')
        } else if(last?.source.kind==='goal') {
          // Bound RED to the same three unwanted rounds as the archived session.
          if(goal.roundsStarted===1)yield ptc('return await tools.get_goal({})')
          else { if(goal.roundsStarted===3)ctx.goals.pause(leader,goal); yield text('Still waiting') }
        } else if(last?.source.kind==='subagent-settled' || last?.source.kind==='subagent-report') {
          await duringAck?.(ctx,leader); yield text('ACK is not READY; waiting')
        } else if(jobs.hasActiveWork(leader))yield ptc('return {waiting:true}')
        else {
          if(goal?.phase==='active')ctx.goals.complete(leader,goal)
          finalCount++; yield text('All exact READY results reviewed once')
        }
      } else {
        childRequests++
        const i=children.findIndex(c=>c.id===request.sessionId)
        children[i].modelStarted.resolve()
        await gates[i].promise
        // Keep the independent post-terminal Luna relay in flight: measure the
        // trusted READY admission separately from that later substantive report.
        if(children[i].steps++>0)await relayGate.promise
        // Exact native payload found in the archive: an empty reasoning block
        // precedes the sole visible ACK text. No mocked settlement envelope.
        yield {type:'block-end',index:0,block:{type:'reasoning',text:reasoning}}
        yield {type:'block-end',index:1,block:{type:'text',text:ack}}
      }
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model())
  leader=ctx.agentLoop.create('leader',{provider:'fixture',model:'inert'},{cwd:dir,agentPreset:'postman-leader-ptc'})
  adapter.refresh(leader)
  t.after(async()=>{gates.forEach(p=>p.resolve());relayGate.resolve();await jobs.dispose();await adapter.dispose();await ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true})})
  await ctx.sessions.flush(leader.session)
  leader.followup(human('Start explicit synthetic goal'));await drain(leader)
  assert.equal(children.length,count,JSON.stringify({row,counts:{parentRequests,childRequests},events:leader.session.events.filter(e=>e.type==='tool/result')}))
  await allocated.promise
  assert.equal(parentRequests,expectedInitialRequests,'explicit waiting does not add a model request')
  return {ctx,leader,jobs,children,held,terminal,refresh,
    get adapter(){return adapter},
    counts:()=>({leader:parentRequests,luna:childRequests,final:finalCount}),
    async ack(i){gates[i].resolve();await (await children[i].handle).result;await children[i].settlement.promise;await drain(leader)},
    async ready(i){
      const ready=Promise.withResolvers()
      const stop=ctx.on('agent/inbox/inserted',({agent,message})=>{if(agent===leader&&message.source.form==='bridge-ready'&&message.source.bridgeJobId===Object.keys(row.bridgeOperations)[i])ready.resolve()})
      held[i].resolve(terminal(i));await ready.promise;stop();await drain(leader)
    },
  }
}

for(const state of ['active','pause','clear','cold'])test('native empty-reasoning ACK with goal '+state,{timeout:20000},async t=>{
  const f=await fixture(t,{count:3}), {ctx,leader}=f
  if(state==='pause')ctx.goals.pause(leader,ctx.goals.get(leader))
  if(state==='clear')ctx.goals.clear(leader,ctx.goals.get(leader))
  if(state==='cold'){
    // A fresh service folds the real durable history; activation is never durable.
    const cold=new Context();cold.agents={get:()=>leader}
    assert.equal(new GoalService(cold).get(leader).activation,'disarmed');await cold.fiber.dispose()
    ctx.emit('agent/session-start',{agent:leader});await f.adapter.dispose();f.refresh()
  }
  for(let i=0;i<3;i++)await f.ack(i)
  const rounds=leader.session.events.filter(e=>e.type==='user/message'&&e.data.source.kind==='goal'&&e.data.source.round>0)
  console.log(JSON.stringify({scenario:state,requests:f.counts(),goal:ctx.goals.get(leader),goalRounds:rounds.map(e=>e.data.source.round)}))
  assert.equal(f.counts().leader,1,'0 additional Leader requests for three sequential technical ACKs')
  assert.equal(rounds.length,0,'ACK never permits automatic goal admission')
  assert.ok([...leader.inbox.nextStep,...leader.inbox.nextTurn].every(m=>m.source.form==='postman-deferred'))
  // Cold activation and paused/deleted goals retain ordinary inbox processing.
  leader.followup(human('Required human review'));await drain(leader)
  assert.equal(f.counts().leader,2,'one real human review')
  for(let i=0;i<3;i++){
    await f.ready(i)
    assert.equal(f.counts().leader,3+i,'each genuine READY has exactly one review')
  }
  assert.equal(f.counts().final,1,'one final, no automatic duplicate')
  await drain(leader);assert.equal(f.counts().leader,5)
})

test('a real Luna decision still wakes a waiting Leader',{timeout:20000},async t=>{
  const f=await fixture(t,{ack:'NEEDS_PARENT_GUIDANCE: choose the permitted scope',
    duringAck:(ctx,leader)=>ctx.goals.pause(leader,ctx.goals.get(leader))})
  await f.ack(0)
  assert.equal(f.counts().leader,2,'one necessary decision request')
  assert.equal(f.leader.session.events.filter(e=>e.type==='user/message'&&e.data.source.form==='postman-deferred').length,0)
})

test('internal reasoning does not turn an exact visible ACK into a decision',{timeout:20000},async t=>{
  const f=await fixture(t,{reasoning:'Acknowledge this bootstrap; the Host is still running'})
  await f.ack(0)
  assert.equal(f.counts().leader,1,'no additional request for the same sole visible ACK')
})

test('native ACK during the dispatch result does not open an empty model step',{timeout:20000},async t=>{
  const f=await fixture(t,{ackDuringDispatch:true})
  await f.ack(0)
  assert.equal(f.counts().leader,1,'the ACK arrived before authoritative outer PTC completion, without another request')
  assert.equal(f.ctx.goals.get(f.leader).roundsStarted,0)
  assert.equal(f.adapter.isWaitingForExternalEvent(f.leader),true)
})

for(const action of ['pause','clear'])test('goal '+action+' during an already started round admits no later request',{timeout:15000},async t=>{
  const ctx=new Context(), entered=Promise.withResolvers(), release=Promise.withResolvers()
  new AgentRegistry(ctx);new SessionStore(ctx);new SystemPrompt(ctx,{})
  new ToolRuntime(ctx);new LlmRuntime(ctx);new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1});new GoalService(ctx)
  goalTools(ctx,{});goalDriver(ctx)
  for(const name of ['read','grep'])ctx.tools.register(defineTool({name,description:name,parameters:{},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},execute:()=>({fixture:true})}))
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader})
  ctx.tools.register(adapter.tool)
  ctx.tools.register(defineTool({name:'fixture_work',description:'Useful inert action',parameters:{},
    output:{schema:{type:'object',additionalProperties:true},render:()=>[]},
    execute:(_args,exec)=>{exec.concludeTurn();return {worked:true}}}))
  let requests=0, leader
  class Model extends LlmAdapter {
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(){
      requests++;if(requests>2)throw Error('unwanted model request after '+action)
      if(requests===1){
        ctx.goals.create(leader,{objective:'explicit useful continuation',maxGoalRounds:24})
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'work',name:'fixture_work',arguments:'{}'}}
      }else{
        entered.resolve();await release.promise
        yield text('Result of already started request delivered once')
        // Match the archive: pause/clear happens before an already in-flight
        // response returns a PTC tool call. Its existing producer still runs.
        yield {...ptc('return await tools.get_goal({})'),index:1}
      }
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model())
  leader=ctx.agentLoop.create('round-race',{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'})
  adapter.refresh(leader)
  t.after(async()=>{release.resolve();await adapter.dispose();await ctx.fiber.dispose()})
  leader.followup(human('Explicit goal with useful automatic work'));await entered.promise
  assert.equal(ctx.goals.get(leader).roundsStarted,1,'a useful automatic round actually started')
  ctx.goals[action](leader,ctx.goals.get(leader));release.resolve();await drain(leader)
  assert.equal(requests,2,'initial work + the request already in flight, no third request')
  assert.equal(ctx.goals.get(leader)?.phase,action==='pause'?'paused':undefined)
  assert.equal(leader.session.events.filter(e=>e.type==='assistant/message'&&
    e.data.message.content.some(b=>b.type==='text')).length,1,'no duplicate final')
})
