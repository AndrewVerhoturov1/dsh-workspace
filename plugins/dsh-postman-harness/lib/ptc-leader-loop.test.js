import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createPtcAdapter, SOL_WORKER_PROFILE } from './ptc-adapter.js'
import { isTopLevelPostmanPtcLeader } from './postman-bridge-core.js'

const installed=process.env.DSH_ROOT ?? join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh')
const sdk=createRequire(process.env.DSH_CAPABILITY_SDK ?? join(installed,'package.json'))
const pkg=name=>import(pathToFileURL(sdk.resolve('@deepseek-ai/'+name)).href)
const {Context}=await pkg('cordis'), {AgentRegistry}=await pkg('dsh-agent')
const {SessionStore}=await pkg('dsh-session'), {SystemPrompt}=await pkg('dsh-system-prompt')
const {ToolRuntime,defineTool}=await pkg('dsh-tools')
const {LlmRuntime,LlmAdapter,createUserMessage}=await pkg('dsh-llm'), {AgentLoop}=await pkg('dsh-agent-loop')
const output={schema:{type:'object',additionalProperties:true},render:(_a,value)=>[{type:'text',text:JSON.stringify(value)}]}

for(const role of ['leader','sol'])for(const queued of ['none','report','quiet'])test('explicit native PTC wait: '+role+' / '+queued,{timeout:15000},async t=>{
 const ctx=new Context(),requests=[],saved=new Map(),events=[]
 new AgentRegistry(ctx);new SessionStore(ctx);new SystemPrompt(ctx,{})
 new ToolRuntime(ctx);new LlmRuntime(ctx);new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
 const name=role==='sol'?'postman_worker':'postman_bridge'
 ctx.tools.register(defineTool({name,description:'inert operation',parameters:{},output,execute:()=>({status:'UNFAMILIAR_STATUS'})}))
 let agent
 const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,
  resolveAssignment:(a,profile)=>a===agent?{profile:role==='sol'?SOL_WORKER_PROFILE:profile,role}:null,
  readWait:a=>saved.get(a.id)===true,writeWait:async(a,value)=>saved.set(a.id,value)})
 ctx.tools.register(adapter.tool)
 class Model extends LlmAdapter{
  async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
  async *stream(request){
   requests.push(request);assert.ok(requests.length<=3,'bounded model requests')
   if(requests.length===1)yield{type:'block-end',index:0,block:{type:'tool-call',id:'dispatch',name:'ptc_execute',arguments:JSON.stringify({program:'return await tools.'+name+'({})',wait_for_event:true})}}
   else yield{type:'block-end',index:0,block:{type:'text',text:'New input reviewed'}}
   yield{type:'finish',reason:{kind:'stop'}}
  }
 }
 ctx.llm.registerAdapter(['fixture'],new Model())
 agent=ctx.agentLoop.create('wait-'+role+queued,{provider:'fixture',model:'inert'},{cwd:process.cwd(),...(role==='leader'?{agentPreset:'postman-leader'}:{})})
 adapter.refresh(agent)
 if(queued!=='none')ctx.on('tools/result',exec=>{
  if(exec.name!=='ptc_execute')return
  const message=createUserMessage({content:[{type:'text',text:'exact queued fact'}],source:{kind:'subagent-report',senderSessionId:'own-child',...(queued==='quiet'?{form:'postman-deferred'}:{})}})
  events.push(message)
  queued==='quiet'?agent.inject(message):agent.steer(message)
 })
 t.after(async()=>{await adapter.dispose();await ctx.fiber.dispose()})
 agent.followup(createUserMessage({content:[{type:'text',text:'start'}]}));await agent.whenIdle()
 assert.equal(requests.length,queued==='report'?2:1)
 assert.equal(adapter.isWaitingForExternalEvent(agent),queued!=='report')
 if(queued==='quiet')assert.equal([...agent.inbox.nextStep,...agent.inbox.nextTurn].filter(m=>m.id===events[0].id).length,1)
 agent.followup(createUserMessage({content:[{type:'text',text:'human input'}]}));await agent.whenIdle()
 assert.equal(requests.length,queued==='report'?3:2)
 assert.equal(saved.get(agent.id),false,'real input clears explicit wait')
})
