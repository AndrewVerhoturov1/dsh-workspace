import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createPtcAdapter, LEADER_SUPERVISOR_PROFILE } from './ptc-adapter.js'
import { isTopLevelPostmanPtcLeader } from './postman-bridge-core.js'

assert.ok(process.env.DSH_ROOT, 'isolated DSH_ROOT required')
const sdk = createRequire(join(process.env.DSH_ROOT, 'package.json'))
const pkg = name => import(pathToFileURL(realpathSync(sdk.resolve('@deepseek-ai/' + name))).href)
const { Context } = await pkg('cordis'), { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session'), { SystemPrompt } = await pkg('dsh-system-prompt')
const { ToolRuntime, defineTool } = await pkg('dsh-tools')
const { LlmRuntime, LlmAdapter, createUserMessage } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop'), { GoalService, foldGoal } = await pkg('dsh-goal')
const { JsonlSessionPersistence } = await pkg('dsh-session-persistence-jsonl')
const driver = await pkg('dsh-goal-round-driver')
const output = { schema: { type:'object', additionalProperties:true }, render: (_a,v) => [{type:'text',text:JSON.stringify(v)}] }
const human = text => createUserMessage({content:[{type:'text',text}],source:{kind:'user',form:'direct'}})
const invalid = 'await tools.read(undefined); return 1'
const useful = 'await tools.read({}); return {useful:true}'
const {createPtcRuntimeForTest}=await import('../../dsh-ptc/src/runtime.js')
function channelFault(kind='invalid-json', recoverAt=Infinity) {
  const runtime=createPtcRuntimeForTest(new URL('../../dsh-ptc/test/fake-executor.mjs',import.meta.url))
  let count=0
  return {run:input=>runtime.run({...input,program:++count>=recoverAt?'ok':kind}),dispose:()=>runtime.dispose()}
}
async function drain(agent) {
  await agent.whenIdle()
  for (let i=0;i<8;i++) { await agent.ctx.sessions.flush(agent.session).catch(()=>{}); await new Promise(resolve=>setImmediate(resolve)); await agent.whenIdle() }
}
async function fixture(t, { program=()=>useful, setup, rounds=4, profile, runtime=channelFault() }={}) {
  const ctx = new Context(), requests=[], results=[], counts=new Map()
  new AgentRegistry(ctx); new SessionStore(ctx); new SystemPrompt(ctx,{})
  new ToolRuntime(ctx); new LlmRuntime(ctx); new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1}); new GoalService(ctx)
  const dir=mkdtempSync(join(tmpdir(),'postman-goal-breaker-'))
  // Native persistence is installed after the in-memory driver fixtures, as in production composition.
  new JsonlSessionPersistence(ctx,{root:dir})
  for (const name of ['read','glob','grep']) ctx.tools.register(defineTool({name,description:name,parameters:{},output,execute:()=>({fixture:true})}))
  let agent, created=false
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader, ...(profile?{profile}:{}), ...(runtime?{runtime}:{})})
  ctx.tools.register(adapter.tool); driver.apply(ctx)
  ctx.on('tools/result',(exec,result)=>{if(exec.name==='ptc_execute')results.push({exec,result})})
  class Model extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      requests.push(request); if(requests.length>24)throw Error('controlled model safety cap')
      if(request.sessionId!==agent.id){yield {type:'block-end',index:0,block:{type:'text',text:'independent exact child done'}};yield {type:'finish',reason:{kind:'stop'}};return}
      if(!created){created=true;ctx.goals.create(agent,{objective:'preserve this objective and children',maxGoalRounds:rounds})}
      const turn=agent.session.events.findLast(e=>e.type==='turn/start').data.turn
      const n=(counts.get(turn)??0)+1;counts.set(turn,n)
      const round=ctx.goals.get(agent).roundsStarted
      if(n===1){
        const source=program(round,agent,ctx)
        yield {type:'block-end',index:0,block:{type:'tool-call',id:'ptc-'+turn,name:'ptc_execute',arguments:JSON.stringify({program:source,description:'Controlled useful work or exact fatal failure',boundary:'semantic_decision'})}}
      }else yield {type:'block-end',index:0,block:{type:'text',text:'Review exact trusted tool outcome'}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model())
  agent=ctx.agentLoop.create('breaker',{provider:'fixture',model:'controlled'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'})
  adapter.refresh(agent); await ctx.sessionPersistence.append(agent.id,[])
  if (setup)await setup({ctx,agent,adapter})
  t.after(async()=>{await adapter.dispose();await ctx.fiber.dispose();rmSync(dir,{recursive:true,force:true})})
  return {ctx,agent,adapter,requests,results,dir,async run(){agent.followup(human('approved controlled start'));await drain(agent)}}
}
const paused = f => {
  const goal=f.ctx.goals.get(f.agent)
  assert.equal(goal.phase,'paused');assert.equal(goal.activation,'disarmed');assert.equal(goal.roundsStarted,2)
  assert.equal(goal.objective,'preserve this objective and children')
  assert.equal(f.agent.session.events.filter(e=>e.type==='goal/change'&&e.data.operation==='pause').length,1)
  return goal
}
test('normal real PTC keeps native admission until configured round limit', {timeout:20000}, async t=>{
  const f=await fixture(t,{program:()=>useful,rounds:2,runtime:null});await f.run()
  assert.equal(f.results.length,3,JSON.stringify({goal:f.ctx.goals.get(f.agent),state:f.ctx.fiber.state,status:f.agent.status,events:f.agent.session.events.filter(e=>['turn/start','turn/end','user/message'].includes(e.type)).map(e=>({type:e.type,data:e.data})),results:f.results.map(x=>x.result)}));assert.ok(f.results.every(x=>x.result.value.status==='ok'))
  assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
})
test('one transient failure followed by useful work does not trip', {timeout:20000}, async t=>{
  const fault=channelFault(), real=createPtcRuntimeForTest(new URL('./executor.mjs',import.meta.resolve('dsh-ptc')))
  let calls=0
  const f=await fixture(t,{runtime:{run:input=>++calls===1?fault.run(input):real.run(input),
    dispose:async()=>{await fault.dispose();await real.dispose()}},rounds:3});await f.run()
  assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
  assert.equal(f.results.filter(x=>x.result.value.error?.code==='invalid-json').length,1)
  assert.equal(f.results.length,4,'initial fault followed by three useful autonomous rounds')
  assert.ok(f.results.slice(1).every(x=>x.result.value.status==='ok'&&x.result.value.effects.calls.length===1&&
    x.result.value.effects.calls[0].name==='read'&&x.result.value.effects.calls[0].state==='completed'))
  assert.equal(f.agent.session.events.some(e=>e.type==='user/message'&&e.data.source?.form==='ptc-goal-safety-stop'),false)
})
for(const [kind,scenario] of [['invalid-json','invalid-json'],['maxMessageBytes','oversized']])
  test('two consecutive proven no-action '+kind+' failures stop before round three', {timeout:20000}, async t=>{
    const f=await fixture(t,{runtime:channelFault(scenario)});await f.run();paused(f)
    assert.equal(f.results.length,3,'initial human + exactly two auto rounds')
    assert.ok(f.results.every(x=>x.result.value.error.code===kind))
    assert.ok(f.results.every(x=>x.result.value.effects.calls.length===0))
    console.log(JSON.stringify({scenario:'fatal-bounded',kind,autoRounds:2,nestedActions:0,phase:'paused'}))
  })
test('nested action before invalid JSON is never classified as absent', {timeout:20000}, async t=>{
  const f=await fixture(t,{runtime:null,program:()=> 'await tools.read({}); '+invalid,rounds:2});await f.run()
  assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
  assert.ok(f.results.every(x=>x.result.value.effects.calls.length===1))
})
test('ordinary model program errors are not fatal runtime infrastructure', {timeout:20000}, async t=>{
  const f=await fixture(t,{runtime:null,program:()=> 'throw Error("ordinary model exception")',rounds:2});await f.run()
  assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
  assert.ok(f.results.every(x=>x.result.value.error.code==='runtime'))
})
test('permission denial and replaced outer result cannot forge fatal evidence', {timeout:20000}, async t=>{
  const f=await fixture(t,{rounds:2,setup:({ctx})=>ctx.on('tools/post-execute',async(exec,result,next)=>exec.name==='ptc_execute'?{kind:'block',feedback:'controlled permission denial'}:next())});await f.run()
  assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
  assert.ok(f.results.every(x=>x.result.isError))
})
test('goal ref changed during result refuses stale breaker ownership', {timeout:20000}, async t=>{
  const f=await fixture(t,{rounds:2,setup:({ctx,agent})=>ctx.on('tools/result',exec=>{
    if(exec.name==='ptc_execute'&&ctx.goals.get(agent).roundsStarted===2){const g=ctx.goals.get(agent);ctx.goals.edit(agent,{id:g.id,revision:g.revision},{objective:'new revision'})}
  })});await f.run()
  assert.notEqual(f.ctx.goals.get(f.agent).phase,'paused')
  const g=f.ctx.goals.get(f.agent)
  assert.throws(()=>f.ctx.goals.pause({...f.agent},{id:g.id,revision:g.revision}),/not live/)
  assert.throws(()=>f.ctx.goals.pause(f.agent,{id:'wrong',revision:g.revision}),/stale/)
  assert.throws(()=>f.ctx.goals.pause(f.agent,{id:g.id,revision:g.revision-1}),/stale/)
})
test('native pause append failure revokes automatic authority locally', {timeout:20000}, async t=>{
  const f=await fixture(t,{setup:({agent})=>{
    const append=agent.session.append.bind(agent.session)
    agent.session.append=(type,data,...args)=>{if(type==='goal/change'&&data.operation==='pause')throw Error('controlled append failure');return append(type,data,...args)}
  }});await f.run()
  const g=f.ctx.goals.get(f.agent);assert.equal(g.phase,'active');assert.equal(g.activation,'disarmed');assert.equal(g.roundsStarted,2)
  assert.equal(f.ctx.bail('goal/continuation-defer',f.agent),true)
  assert.equal(f.results.length,3);assert.equal(f.agent.session.events.some(e=>e.type==='goal/change'&&e.data.operation==='pause'),false)
})
test('native durable checkpoint failure is not reported as durable pause', {timeout:20000}, async t=>{
  const f=await fixture(t,{setup:({ctx,agent})=>{
    const flush=ctx.sessions.flush.bind(ctx.sessions)
    ctx.sessions.flush=async session=>{if(ctx.goals.get(agent)?.phase==='paused')throw Error('controlled flush failure');return flush(session)}
  }});await f.run();paused(f);assert.equal(f.results.length,3)
  const notice=f.agent.session.events.find(e=>e.type==='user/message'&&e.data.source?.form==='ptc-goal-safety-stop')
  assert.match(JSON.stringify(notice.data.content),/сохранность паузы НЕ подтверждена/)
})
test('meaningful exact Bridge event remains reviewable after fatal stop', {timeout:20000}, async t=>{
  const f=await fixture(t);await f.run();paused(f)
  const event=createUserMessage({content:[{type:'text',text:'actual controlled Bridge READY evidence'}],source:{kind:'plugin',plugin:'dsh-postman-harness-bridge',form:'bridge-ready',targetSessionId:f.agent.id,bridgeJobId:'controlled-job'}})
  f.agent.followup(event);await drain(f.agent)
  assert.equal(f.results.length,4);assert.equal(f.ctx.goals.get(f.agent).phase,'paused')
  assert.equal(f.agent.session.events.filter(e=>e.type==='user/message'&&e.data.id===event.id).length,1)
})
test('durable native pause survives adapter replacement, session-start and cold goal replay', {timeout:20000}, async t=>{
  const f=await fixture(t);await f.run();const g=paused(f)
  await f.ctx.sessions.flush(f.agent.session)
  const persisted=await f.ctx.sessionPersistence.inspect(f.agent.id)
  assert.equal(foldGoal(persisted.events).goal.phase,'paused')
  await f.adapter.dispose()
  const replacement=createPtcAdapter(f.ctx,{authorize:isTopLevelPostmanPtcLeader});replacement.refresh(f.agent)
  t.after(()=>replacement.dispose())
  f.ctx.emit('agent/session-start',{agent:f.agent});await drain(f.agent)
  assert.equal(f.results.length,3);assert.equal(f.ctx.goals.get(f.agent).activation,'disarmed')
  const cold=new Context();cold.agents={get:id=>id===f.agent.id?f.agent:undefined}
  const restored=new GoalService(cold).get(f.agent)
  assert.deepEqual([restored.id,restored.revision,restored.phase,restored.activation],[g.id,g.revision,'paused','disarmed'])
  await cold.fiber.dispose()
})
test('later explicit human native resume works without automatic breaker rearm', {timeout:20000}, async t=>{
  let recovering=false
  const fault=channelFault(); const baseRun=fault.run; const real=createPtcRuntimeForTest(new URL('./executor.mjs',import.meta.resolve('dsh-ptc')));
  const f=await fixture(t,{runtime:{run:input=>recovering?real.run(input):baseRun(input),dispose:async()=>{await fault.dispose();await real.dispose()}},program:()=>useful,rounds:3});await f.run();const g=paused(f)
  recovering=true
  f.agent.followup(human('resume approved task'))
  f.ctx.goals.resume(f.agent,{id:g.id,revision:g.revision})
  await drain(f.agent)
  assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
  assert.ok(f.results.slice(3).every(x=>x.result.value.status==='ok'),JSON.stringify(f.results.slice(3).map(x=>x.result.value)))
})
// Real Host callback remains outstanding when the real QuickJS process is cut off.
// It must never be relabelled "no action" even though the guest cannot observe it.
test('pending nested outcome stays UNKNOWN and never trips no-action breaker', {timeout:20000}, async t=>{
  const pending=[]
  const profile={...LEADER_SUPERVISOR_PROFILE,limits:{...LEADER_SUPERVISOR_PROFILE.limits,maxWallMs:500}}
  const f=await fixture(t,{runtime:null,profile,rounds:2,program:()=> 'await tools.read({}); return 1',setup:({ctx})=>{
    ctx.on('tools/execute',async(exec,next)=>exec.name==='read'&&exec.parent?new Promise(resolve=>pending.push(()=>resolve({isError:false,value:{settled:true},content:[]}))):next())
  }})
  t.after(()=>pending.forEach(resolve=>resolve()))
  await f.run()
  assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
  assert.ok(f.results.every(x=>x.result.value.effects.pending===1))
  assert.ok(f.results.every(x=>x.result.value.effects.calls.length===1))
  assert.equal(f.agent.session.events.filter(e=>e.type==='tool/code-dispatch'&&JSON.stringify(e.data).includes('outcome unknown')).length,3)
  pending.forEach(resolve=>resolve())
})
test('proven fatal child process crash is bounded using actual Host runtime', {timeout:20000}, async t=>{
  const runtime=createPtcRuntimeForTest(new URL('../../dsh-ptc/test/fake-executor.mjs',import.meta.url))
  // This controlled executor really exits; it ignores the helper-prelude payload.
  const run=runtime.run.bind(runtime)
  const f=await fixture(t,{runtime:{run:input=>run({...input,program:'crash'}),dispose:()=>runtime.dispose()}})
  await f.run();paused(f)
  assert.ok(f.results.every(x=>x.result.value.status==='process-error'))
  assert.ok(f.results.every(x=>x.result.value.effects.calls.length===0))
})
test('actual native compact and cold Host resume cannot rearm durable pause', {timeout:20000}, async t=>{
 const f=await fixture(t);await f.run();const before=paused(f)
 const {TokenMeter}=await pkg('dsh-token-meter'),{BasicCompactionEngine}=await pkg('dsh-compaction-basic')
 new TokenMeter(f.agent.ctx)
 class ControlledSummary extends BasicCompactionEngine {
   async summarize(){return {summary:[{type:'text',text:'Exact task paused safely.'}],provider:'fixture',model:'controlled'}}
 }
 const engine=new ControlledSummary(f.agent.ctx,{auto:false})
 const compacted=await engine.compactNow(f.agent,new AbortController().signal)
 assert.ok(compacted);assert.ok(f.agent.session.events.some(e=>e.type==='compaction/summary'))
 assert.deepEqual([f.ctx.goals.get(f.agent).phase,f.ctx.goals.get(f.agent).revision],['paused',before.revision])
 await f.ctx.sessions.flush(f.agent.session)
 const cold=new Context();new AgentRegistry(cold);new SessionStore(cold);new SystemPrompt(cold,{})
 new ToolRuntime(cold);new LlmRuntime(cold);new AgentLoop(cold,{agents:[]});new GoalService(cold)
 new JsonlSessionPersistence(cold,{root:f.dir});driver.apply(cold)
 const adapter=createPtcAdapter(cold,{authorize:isTopLevelPostmanPtcLeader});cold.tools.register(adapter.tool)
 t.after(async()=>{await adapter.dispose();await cold.fiber.dispose()})
 const handle=await cold.agents.resume({resumeSessionId:f.agent.id,agentOptions:{provider:'fixture',model:'controlled',agentPreset:'postman-leader-ptc'}})
 adapter.refresh(handle.agent);await drain(handle.agent)
 const goal=cold.goals.get(handle.agent)
 assert.deepEqual([goal.id,goal.revision,goal.phase,goal.activation],[before.id,before.revision,'paused','disarmed'])
 assert.equal(handle.agent.session.events.filter(e=>e.type==='turn/start').length,3)
 await handle.dispose()
})
test('separate Host process restores native paused goal without a model request', {timeout:20000}, async t=>{
 const f=await fixture(t);await f.run();const goal=paused(f)
 await f.ctx.sessions.flush(f.agent.session)
 const code = [
  "import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url'; import {join} from 'node:path';",
  "const sdk=createRequire(join(process.env.DSH_ROOT,'package.json'));const pkg=n=>import(pathToFileURL(sdk.resolve('@deepseek-ai/'+n)).href);",
  "const {Context}=await pkg('cordis'),{AgentRegistry}=await pkg('dsh-agent'),{SessionStore}=await pkg('dsh-session'),{SystemPrompt}=await pkg('dsh-system-prompt'),{ToolRuntime}=await pkg('dsh-tools'),{LlmRuntime}=await pkg('dsh-llm'),{AgentLoop}=await pkg('dsh-agent-loop'),{GoalService}=await pkg('dsh-goal'),{JsonlSessionPersistence}=await pkg('dsh-session-persistence-jsonl'),driver=await pkg('dsh-goal-round-driver');",
  "const {createPtcAdapter}=await import("+JSON.stringify(new URL('./ptc-adapter.js',import.meta.url).href)+");const {isTopLevelPostmanPtcLeader}=await import("+JSON.stringify(new URL('./postman-bridge-core.js',import.meta.url).href)+");",
  "const ctx=new Context();new AgentRegistry(ctx);new SessionStore(ctx);new SystemPrompt(ctx,{});new ToolRuntime(ctx);new LlmRuntime(ctx);new AgentLoop(ctx,{agents:[]});new GoalService(ctx);new JsonlSessionPersistence(ctx,{root:"+JSON.stringify(f.dir)+"});driver.apply(ctx);",
  "let requests=0;ctx.on('llm/request',()=>{requests++});const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader});ctx.tools.register(adapter.tool);",
  "const h=await ctx.agents.resume({resumeSessionId:"+JSON.stringify(f.agent.id)+",agentOptions:{provider:'fixture',model:'controlled',agentPreset:'postman-leader-ptc'}});adapter.refresh(h.agent);await h.agent.whenIdle();await ctx.sessions.flush(h.agent.session);await new Promise(r=>setImmediate(r));await h.agent.whenIdle();",
  "console.log(JSON.stringify({pid:process.pid,goal:ctx.goals.get(h.agent),turns:h.agent.session.events.filter(e=>e.type==='turn/start').length,requests}));await h.dispose();await adapter.dispose();await ctx.fiber.dispose();"
 ].join('\n')
 const result=spawnSync(process.execPath,['--input-type=module','--eval',code],{encoding:'utf8',timeout:10000,env:{...process.env}})
 assert.equal(result.status,0,result.stderr)
 const restored=JSON.parse(result.stdout.trim())
 assert.notEqual(restored.pid,process.pid);assert.equal(restored.requests,0);assert.equal(restored.turns,3)
 assert.deepEqual([restored.goal.id,restored.goal.revision,restored.goal.phase,restored.goal.activation],[goal.id,goal.revision,'paused','disarmed'])
})
test('fatal supervisor pause preserves exact native child lineage and continuation ownership', {timeout:20000}, async t=>{
 const {SubagentRuntime}=await pkg('dsh-subagent'),{apply:spawn}=await pkg('dsh-subagent-spawn-in-process')
 let accepted
 const f=await fixture(t,{setup:async({ctx,agent})=>{
   new SubagentRuntime(ctx);spawn(ctx,{providerName:'spawn'})
   await Promise.resolve()
   accepted=await ctx.subagents.startContinuable({provider:'spawn',label:'preserved-child',signal:new AbortController().signal,
     request:{parent:agent,prompt:[{type:'text',text:'bounded independent work'}],agentOptions:{provider:'fixture',model:'controlled'}}})
   await new Promise(resolve=>setImmediate(resolve));await ctx.agents.get(accepted.childId)?.whenIdle()
 }})
 await f.ctx.sessions.flush(f.ctx.sessions.get(accepted.childId))
 await new Promise(resolve=>setImmediate(resolve))
 const savedBefore=await f.ctx.sessionPersistence.inspect(accepted.childId)
 assert.equal(savedBefore.meta.parentSession,f.agent.id)
 await f.run();paused(f)
 const savedAfter=await f.ctx.sessionPersistence.inspect(accepted.childId)
 assert.equal(savedAfter.meta.parentSession,savedBefore.meta.parentSession)
 assert.equal(savedAfter.events.some(e=>e.type==='subagent/closed'),false)
 assert.equal(f.agent.session.events.some(e=>e.type==='subagent/closed'),false)
 assert.equal(await f.ctx.subagents.inspectOpenContinuableChild({...f.agent},accepted.childId),false)
 const continued=await f.ctx.subagents.followup(f.agent,accepted.childId,[{type:'text',text:'approved exact related child continuation'}],{source:{kind:'user'},signal:new AbortController().signal})
 assert.equal(typeof continued,'string')
 await new Promise(resolve=>setImmediate(resolve));await f.ctx.agents.get(accepted.childId)?.whenIdle()

 await f.ctx.subagents.closeContinuableChild(f.agent,accepted.childId,async()=>true)
})
for(const [name,program] of [
 ['explicit undefined',invalid],
 ['unsupported console value','console.log(undefined); return 1'],
 ['invalid output','return {value:undefined}'],
 ['oversized guest arguments',"await tools.read({value:'x'.repeat(1048576)}); return 1"],
 ['spoofed rejected error code',"throw {code:'invalid-json',failureOrigin:{kind:'host-runtime',stage:'channel-frame'}}"],
 ['model-authored fatal JSON',"return {status:'runtime-error',error:{code:'invalid-json'},failureOrigin:{kind:'host-runtime',stage:'channel-frame'}}"],
]) test('repeated guest '+name+' is not infrastructure proof', {timeout:20000},async t=>{
 const f=await fixture(t,{runtime:null,rounds:2,program:()=>program});await f.run()
 if(name==='model-authored fatal JSON'){
  const goal=f.ctx.goals.get(f.agent)
  assert.equal(goal.phase,'active');assert.equal(goal.blockedReason,undefined);assert.equal(goal.roundsStarted,0)
  assert.equal(f.requests.length,2,'one PTC response and one review, no empty automatic rounds')
  assert.equal(f.results.length,1);assert.equal(f.results[0].result.value.status,'ok')
  assert.equal(f.results[0].result.value.effects.calls.length,0)
 }else assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
 assert.ok(f.results.every(x=>!x.result.value.failureOrigin))
 assert.equal(f.agent.session.events.some(e=>e.type==='user/message'&&e.data.source?.form==='ptc-goal-safety-stop'),false)
})
test('genuine Host fault pause has accessible native plugin reason without synthetic user action', {timeout:20000},async t=>{
 const f=await fixture(t);await f.run();paused(f)
 const notice=f.agent.session.events.find(e=>e.type==='user/message'&&e.data.source?.form==='ptc-goal-safety-stop')
 assert.ok(notice,JSON.stringify(f.agent.session.events.slice(-7)));assert.equal(notice.data.source.kind,'plugin');assert.match(JSON.stringify(notice.data.content),/Пауза цели сохранена/)
 assert.equal(f.results.length,3,'notice never queues a new turn')
})
test('executor terminal cannot forge parent-only fatal provenance', {timeout:20000},async t=>{
 const f=await fixture(t,{runtime:channelFault('spoof-fatal-origin'),rounds:2});await f.run()
 assert.equal(f.ctx.goals.get(f.agent).blockedReason.code,'round-limit')
 assert.ok(f.results.every(x=>x.result.value.error.code==='message'&&x.result.value.failureOrigin.stage==='channel-message'))
 assert.equal(f.agent.session.events.some(e=>e.type==='user/message'&&e.data.source?.form==='ptc-goal-safety-stop'),false)
})
test('genuine Host spawn failure is bounded before any nested dispatch', {timeout:20000},async t=>{
 const runtime=createPtcRuntimeForTest(new URL('../../dsh-ptc/test/fake-executor.mjs',import.meta.url),undefined,()=>{throw Error('controlled Host spawn failure')})
 const f=await fixture(t,{runtime});await f.run();paused(f)
 assert.equal(f.results.length,3);assert.ok(f.results.every(x=>x.result.value.effects.calls.length===0))
 assert.ok(f.results.every(x=>x.result.value.error.code==='spawn'&&x.result.value.failureOrigin.stage==='start'))
})
