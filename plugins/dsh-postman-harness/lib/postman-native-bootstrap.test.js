import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'

const sdk = createRequire(join(process.env.DSH_ROOT,'package.json'))
const pkg = async name => import(pathToFileURL(sdk.resolve('@deepseek-ai/'+name)).href)
const {Context}=await pkg('cordis')
const {AgentRegistry}=await pkg('dsh-agent')
const {SessionStore}=await pkg('dsh-session')
const {SessionProjectionRegistry}=await pkg('dsh-session-projection')
const {SystemPrompt}=await pkg('dsh-system-prompt')
const {JsonlSessionPersistence}=await pkg('dsh-session-persistence-jsonl')
const {ToolRuntime}=await pkg('dsh-tools')
const {LlmRuntime,LlmAdapter,createUserMessage}=await pkg('dsh-llm')
const {AgentLoop}=await pkg('dsh-agent-loop')
const {SubagentRuntime}=await pkg('dsh-subagent')
const {apply:spawn}=await pkg('dsh-subagent-spawn-in-process')
const {apply:installReport}=await pkg('dsh-tool-subagent-report')
const content=text=>[{type:'text',text}]

for(const report of [true,false])test('native bootstrap '+(report?'report+settled':'text-only settled')+' stays in inbox, one Bridge READY wakes model',{timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'native-bootstrap-'))
  const ctx=new Context()
  new AgentRegistry(ctx);new SessionStore(ctx);new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx,{});new ToolRuntime(ctx);new LlmRuntime(ctx)
  new JsonlSessionPersistence(ctx,{root:join(dir,'sessions')})
  new SubagentRuntime(ctx);spawn(ctx,{providerName:'spawn'});installReport(ctx,{reportDelivery:'next-step'})
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
  const requests=[],counts=new Map()
  class Controlled extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      const agent=ctx.agents.currentInitiator()
      const n=(counts.get(agent.id)??0)+1;counts.set(agent.id,n)
      if(agent.id==='leader'){
        requests.push(request)
        yield{type:'block-end',index:0,block:{type:'text',text:'Trusted READY reviewed'}}
      }else if(n===1&&report)yield{type:'block-end',index:0,block:{type:'tool-call',id:'bootstrap-report',
        name:'report',arguments:JSON.stringify({output:'POSTMAN_LUNA_BOOTSTRAP_ACK'})}}
      else yield{type:'block-end',index:0,block:{type:'text',text:'POSTMAN_LUNA_BOOTSTRAP_ACK'}}
      yield{type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Controlled())
  const leader=ctx.agentLoop.create('leader',{provider:'fixture',model:'inert'},{cwd:dir,agentPreset:'postman-leader'})
  await Promise.resolve() // Let Cordis inject the native Agents/continuations services.
  const task=Object.freeze({worktree:dir,repositoryPath:dir,branch:'task/synthetic'})
  let row={leaderSessionId:'leader',bridgeOperations:{}}
  const contexts={get:()=>task,record:()=>row,async changeRecord(_id,fn){row=fn(row);return row}}
  const held=Promise.withResolvers(), allocated=Promise.withResolvers()
  const terminal={status:'COMPLETED',requestId:'REQ_20261014T000000Z_0001',result:{ok:true,requestId:'REQ_20261014T000000Z_0001',source:'bell',reportedOutcome:'DONE',evidenceState:'REPORTED_NOT_VERIFIED'}}
  const jobs=createPostmanBridgeJobs(ctx,{run:(_s,fn)=>fn(),dispose(){}},null,contexts,null,{
    async start(options){const requestId=terminal.requestId;await options.onRequestAllocated(requestId,'C:/synthetic/private');allocated.resolve();return {requestId}},
    wait:()=>held.promise,dispose(){held.resolve(terminal)}})
  let reportHooks=0,settlementHooks=0,settlementProof
  const settlementObserved=Promise.withResolvers()
  ctx.on('postman/subagent-report-defer',(parent,child,parts)=>{
    reportHooks++
    return jobs.canDeferLunaBootstrapReport(parent,child,parts)?true:undefined
  })
  ctx.on('postman/subagent-settlement-defer',(parent,child,terminal)=>{
    settlementHooks++
    settlementProof={removed:ctx.agents.get(child.id)===undefined,retained:ctx.sessions.get(child.id)===child.session,
      impostor:jobs.canDeferLunaBootstrapSettlement(parent,{...child,session:{...child.session}},terminal),
      deferred:jobs.canDeferLunaBootstrapSettlement(parent,child,terminal)}
    settlementObserved.resolve()
    return settlementProof.deferred?true:undefined
  })
  t.after(async()=>{held.resolve(terminal);await jobs.dispose();await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
  const childFinished=Promise.withResolvers()
  ctx.on('agent/disposed',({agent})=>{if(agent.id!=='leader')childFinished.resolve()})
  const start=ctx.subagents.startContinuable.bind(ctx.subagents)
  let nativeHandle
  ctx.subagents.startContinuable=spec=>start({...spec,request:{...spec.request,agentOptions:{provider:'fixture',model:'inert'}}}).then(h=>(nativeHandle=h,h))
  const accepted=await jobs.accept(leader,'@PostmanDevspace synthetic held task','devspace',undefined,undefined,'WRITE_TEST')
  assert.equal(accepted.status,'POSTMAN_BRIDGE_ACCEPTED')
  await allocated.promise;await childFinished.promise;await nativeHandle.result;await settlementObserved.promise
  assert.deepEqual(settlementProof,{removed:true,retained:false,impostor:false,deferred:true})
  const childId=nativeHandle.childId
  await leader.whenIdle()
  assert.equal(requests.length,0,'bootstrap report and native settlement have no parent model wake')
  const queued=[...leader.inbox.nextStep,...leader.inbox.nextTurn]
  assert.equal(reportHooks,report?1:0,'native report route called exact Host veto')
  assert.equal(settlementHooks,1,'native settlement route called exact Host veto')
  assert.deepEqual(queued.map(m=>m.source.kind),report?['subagent-report','subagent-settled']:['subagent-settled'])
  assert.ok(queued.every(m=>m.source.senderSessionId===childId))
  const woke=Promise.withResolvers()
  ctx.on('session/event',(session,event)=>{if(session===leader.session&&event.type==='turn/end')woke.resolve()})
  held.resolve(terminal)
  await woke.promise;await leader.whenIdle()
  assert.equal(requests.length,1,'one genuine Bridge READY starts one model request')
  const events=leader.session.events.filter(e=>e.type==='user/message')
  assert.equal(events.filter(e=>e.data.source?.kind==='subagent-report').length,report?1:0)
  assert.equal(events.filter(e=>e.data.source?.kind==='subagent-settled').length,1)
  assert.equal(events.filter(e=>e.data.source?.form==='bridge-ready'&&e.data.source.bridgeJobId===accepted.bridgeJobId).length,1)
})
