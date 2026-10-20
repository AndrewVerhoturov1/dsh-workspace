import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync,realpathSync} from 'node:fs'
import {createRequire} from 'node:module'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createPtcAdapter} from './ptc-adapter.js'
import {isTopLevelPostmanPtcLeader} from './postman-bridge-core.js'

// This suite is run by the isolated production installer; it never patches a live SDK.
assert.ok(process.env.DSH_ROOT,'isolated DSH_ROOT required')
const sdk=createRequire(join(process.env.DSH_ROOT,'package.json'))
const pkg=name=>import(pathToFileURL(realpathSync(sdk.resolve('@deepseek-ai/'+name))).href)
const source=readFileSync(sdk.resolve('@deepseek-ai/dsh-goal-round-driver'),'utf8')
const legacySdk=source.includes('function hasWorkToContinue(agent)')
if(!legacySdk){
 assert.match(source,/goal\/continuation-defer/)
 assert.doesNotMatch(source,/hasWorkToContinue|needsModelDecision|\.boundary/)
 assert.doesNotMatch(readFileSync(sdk.resolve('@deepseek-ai/dsh-tool-goal'),'utf8'),/finalReady/)
}
const {Context}=await pkg('cordis'),{AgentRegistry}=await pkg('dsh-agent')
const {SessionStore}=await pkg('dsh-session'),{SystemPrompt}=await pkg('dsh-system-prompt')
const {ToolRuntime}=await pkg('dsh-tools'),{LlmRuntime,LlmAdapter,createUserMessage}=await pkg('dsh-llm')
const {AgentLoop}=await pkg('dsh-agent-loop'),{GoalService}=await pkg('dsh-goal'),driver=await pkg('dsh-goal-round-driver')
const message=text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user',form:'direct'}})
async function drain(agent){await agent.whenIdle();for(let i=0;i<8;i++){await new Promise(resolve=>setImmediate(resolve));await agent.whenIdle()}}

test('explicit wait defers automatic goals without producer proofs and survives adapter reload',{timeout:15000,skip:legacySdk?'installed SDK still has the legacy goal patch; the isolated production installer checks the new SDK':false},async t=>{
 const ctx=new Context(),requests=[],saved=new Map()
 new AgentRegistry(ctx);new SessionStore(ctx);new SystemPrompt(ctx,{})
 new ToolRuntime(ctx);new LlmRuntime(ctx);new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1});new GoalService(ctx)
 const options={authorize:isTopLevelPostmanPtcLeader,readWait:a=>saved.get(a.id)===true,writeWait:async(a,value)=>saved.set(a.id,value)}
 let adapter=createPtcAdapter(ctx,options),unregister=ctx.tools.register(adapter.tool),agent
 driver.apply(ctx)
 class Model extends LlmAdapter{
  async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
  async *stream(request){
   requests.push(request);assert.ok(requests.length<=3,'bounded request count')
   assert.notEqual(saved.get(agent.id),true,'new genuine input clears wait before reasoning')
   if(!ctx.goals.get(agent))ctx.goals.create(agent,{objective:'inert explicit waiting',maxGoalRounds:2})
   yield{type:'block-end',index:0,block:{type:'tool-call',id:'wait',name:'ptc_execute',arguments:JSON.stringify({program:'return {status:"NO_PRODUCER_NEEDED"}',wait_for_event:true})}}
   yield{type:'finish',reason:{kind:'stop'}}
  }
 }
 ctx.llm.registerAdapter(['fixture'],new Model())
 agent=ctx.agentLoop.create('goal-explicit-wait',{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader'})
 adapter.refresh(agent)
 t.after(async()=>{unregister();await adapter.dispose();await ctx.fiber.dispose()})
 agent.followup(message('start'));await drain(agent)
 assert.equal(requests.length,1);assert.equal(ctx.goals.get(agent).roundsStarted,0)
 assert.equal(adapter.isWaitingForExternalEvent(agent),true)
 unregister();await adapter.dispose()
 adapter=createPtcAdapter(ctx,options);unregister=ctx.tools.register(adapter.tool);adapter.refresh(agent)
 assert.equal(adapter.isWaitingForExternalEvent(agent),true,'only persisted boolean restores waiting')
 assert.equal(ctx.bail('goal/continuation-defer',agent),true)
 agent.inject(createUserMessage({content:[{type:'text',text:'retained diagnostic'}],source:{kind:'subagent-settled',form:'postman-deferred',senderSessionId:'own-child'}}))
 await drain(agent);assert.equal(requests.length,1)
 agent.followup(message('human asks for review'));await drain(agent)
 assert.equal(requests.length,2);assert.equal(ctx.goals.get(agent).roundsStarted,0)
 agent.steer(createUserMessage({content:[{type:'text',text:'executor result'}],source:{kind:'subagent-report',senderSessionId:'own-child'}}))
 await drain(agent);assert.equal(requests.length,3);assert.equal(ctx.goals.get(agent).roundsStarted,0)
})
