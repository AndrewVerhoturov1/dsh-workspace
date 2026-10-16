import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPtcAdapter, SOL_WORKER_PROFILE } from './ptc-adapter.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { isTopLevelPostmanPtcLeader, postmanBridgeRestrictionForAgent } from './postman-bridge-core.js'

// Run against the real isolated SDK prepared by test:install-production-postman-goal.
// Never patch the installed/live SDK from a test or contact a model/transport.
assert.ok(process.env.DSH_ROOT, 'an isolated DSH_ROOT is required')
const requireSdk = createRequire(join(process.env.DSH_ROOT, 'package.json'))
const pkg = name => import(pathToFileURL(realpathSync(requireSdk.resolve('@deepseek-ai/' + name))).href)
const driverPath = realpathSync(requireSdk.resolve('@deepseek-ai/dsh-goal-round-driver'))
assert.match(readFileSync(driverPath, 'utf8'), /goal\/continuation-defer/, 'installer overlay must be present')
console.log('isolated goal driver: ' + driverPath)
const { Context } = await pkg('cordis')
const { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session')
const { SystemPrompt } = await pkg('dsh-system-prompt')
const { ToolRuntime, defineTool } = await pkg('dsh-tools')
const { LlmRuntime, LlmAdapter, createUserMessage } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop')
const { GoalService, foldGoal } = await pkg('dsh-goal')
const driver = await pkg('dsh-goal-round-driver')
const output = { schema: { type:'object', additionalProperties:true }, render: (_a,v) => [{type:'text',text:JSON.stringify(v)}] }
const message = text => createUserMessage({content:[{type:'text',text}],source:{kind:'user',form:'direct'}})
const call = program => ({type:'block-end',index:0,block:{type:'tool-call',id:'ptc',name:'ptc_execute',arguments:JSON.stringify({program,description:'Inert goal admission and external event proof',boundary:'external_event'})}})
async function drain(agent) {
  await agent.whenIdle()
  // Bounded in-process microtask/checkpoint drains, not live work polling.
  for (let i=0;i<8;i++) { await new Promise(resolve=>setImmediate(resolve)); await agent.whenIdle() }
}
function base() {
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SystemPrompt(ctx,{})
  new ToolRuntime(ctx); new LlmRuntime(ctx); new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1}); new GoalService(ctx)
  for (const name of ['read','glob','grep']) ctx.tools.register(defineTool({name,description:name,parameters:{},output,execute:()=>({fixture:true})}))
  return ctx
}

for (const kind of ['worker','bridge','existing-bridge','sol','no-goal']) test('armed goal holds at exact safe wait: '+kind,{timeout:15000},async t=>{
  const ctx=base(), requests=[]
  const context=Object.freeze({worktree:process.cwd(),branch:'task/fixture'}), contexts={get:()=>context}
  ctx.subagents={startContinuable:async spec=>({childId:spec.childId,messageId:'accepted'}),followup:async()=>'followup',drainContinuableChildren:async()=>{}}
  const worker=createPostmanWorkerTools(ctx,undefined,contexts)
  const held=Promise.withResolvers()
  const jobs=createPostmanBridgeJobs(ctx,{run:()=>held.promise,dispose(){held.resolve({status:'fixture-stopped'})}},undefined,contexts)
  let agent, activeSol=true, producerLive=true
  let adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,
    resolveAssignment:(candidate,profile)=>candidate===agent && kind==='sol'?{profile:SOL_WORKER_PROFILE,role:'sol'}:isTopLevelPostmanPtcLeader(candidate)?{profile,role:'leader'}:null,
    workerContextOf:()=>context,hasActiveWork:candidate=>producerLive && (kind==='sol'?activeSol:['worker','no-goal'].includes(kind)||jobs.hasActiveWork(candidate))})
  for (const tool of [adapter.tool,worker.taskTool,createPostmanBridgeTool(ctx,jobs,contexts)])ctx.tools.register(tool)
  if(kind==='sol')ctx.on('tools/execute',async(exec,next)=>exec.parent && exec.name==='postman_worker'?{isError:false,value:{status:'POSTMAN_WORKER_TASK_ACCEPTED'}}:next())
  driver.apply(ctx)
  class Model extends LlmAdapter {
    async resolveModel(provider,id){return {provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      requests.push(request); if(requests.length>4)throw Error('bounded request cap')
      if(requests.length===1 && kind!=='no-goal')ctx.goals.create(agent,{objective:'isolated inert counter',maxGoalRounds:2})
      const program=requests.length===1 && kind!=='existing-bridge'?
        kind==='bridge'?'return await tools.postman_bridge({message:"@PostmanAsk inert fixture"})':'return await tools.postman_worker({task:"inert fixture",createNew:true})':
        'return {waiting:true}'
      yield call(program); yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model())
  agent=ctx.agentLoop.create('waiting-'+kind,{provider:'fixture',model:'inert'},{cwd:process.cwd(),...(kind==='sol'?{}:{agentPreset:'postman-leader-ptc'})})
  if(kind!=='sol')agent.ctx.tools.restrict({allow:postmanBridgeRestrictionForAgent(agent).allow.filter(name=>ctx.tools.get(name))})
  adapter.refresh(agent)
  if(kind==='existing-bridge')await createPostmanBridgeTool(ctx,jobs,contexts).execute({message:'@PostmanAsk existing inert fixture'},{agent,signal:new AbortController().signal})
  t.after(async()=>{worker.dispose();await adapter.dispose();await jobs.dispose();await ctx.fiber.dispose()})
  agent.followup(message('start')); await drain(agent)
  assert.equal(requests.length,1); assert.equal(adapter.isWaitingForExternalEvent(agent),true)
  if(kind!=='no-goal')assert.deepEqual([ctx.goals.get(agent).phase,ctx.goals.get(agent).activation,ctx.goals.get(agent).roundsStarted],['active','armed',0])
  // Real native inbox input must start a new review turn; proven active empty PTC holds again.
  agent.followup(message('explicit human review')); await drain(agent)
  assert.equal(requests.length,2);assert.equal(adapter.isWaitingForExternalEvent(agent),true)
  if(kind!=='no-goal')assert.equal(ctx.goals.get(agent).roundsStarted,0)
  assert.deepEqual(agent.session.events.filter(e=>e.type==='turn/start').map(e=>e.data.turn),[1,2])
  if(kind==='bridge'){
    assert.equal(Object.hasOwn(foldGoal(agent.session.events),'activation'),false)
    const coldCtx=new Context();coldCtx.agents={get:()=>agent};const cold=new GoalService(coldCtx).get(agent)
    assert.equal(cold.phase,'active');assert.equal(cold.activation,'disarmed');await coldCtx.fiber.dispose()
    ctx.emit('agent/session-start',{agent});assert.equal(ctx.goals.get(agent).activation,'disarmed')
    const goal=ctx.goals.get(agent);ctx.goals.resume(agent,{id:goal.id,revision:goal.revision})
    await drain(agent);assert.equal(requests.length,2,'resume cannot invent a turn during confirmed wait')
    agent.followup(message('explicit resumed human review'));await drain(agent)
    assert.equal(requests.length,3);assert.equal(ctx.goals.get(agent).activation,'armed');assert.equal(ctx.goals.get(agent).roundsStarted,0)
  }
  if (kind==='bridge') {
    await adapter.dispose()
    adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,
      hasActiveWork:candidate=>producerLive && jobs.hasActiveWork(candidate)})
    adapter.refresh(agent)
    assert.equal(adapter.isWaitingForExternalEvent(agent),true,'fresh adapter restores exact wait from native durable events')
  }
  agent.inject(createUserMessage({content:[{type:'text',text:'retained technical native fact'}],
    source:{kind:'subagent-settled',form:'postman-deferred',senderSessionId:'synthetic-child'}}))
  assert.equal(adapter.isWaitingForExternalEvent(agent),true,'deferred technical inbox fact is not a goal wake')
  // A stale binding or lost completion source cannot hold an armed goal forever.
  producerLive=false
  assert.equal(adapter.isWaitingForExternalEvent(agent),false)
  assert.notEqual(ctx.bail('goal/continuation-defer',agent),true)
  if(kind==='sol'){ activeSol=false; adapter.remove(agent); assert.notEqual(ctx.bail('goal/continuation-defer',agent),true) }
})

test('actual Bridge READY wakes one review and next safe dispatch holds',{timeout:15000},async t=>{
  const ctx=base(),requests=[],held=[Promise.withResolvers(),Promise.withResolvers()],ready=Promise.withResolvers()
  const context=Object.freeze({worktree:process.cwd(),branch:'task/fixture'})
  const contexts={get:()=>context}
  let runs=0, agent
  const jobs=createPostmanBridgeJobs(ctx,{run:()=>held[runs++].promise,dispose(){held.forEach(p=>p.resolve({status:'fixture-stopped'}))}},undefined,contexts)
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,hasActiveWork:a=>jobs.hasActiveWork(a)})
  for(const tool of [adapter.tool,createPostmanBridgeTool(ctx,jobs,contexts)])ctx.tools.register(tool)
  driver.apply(ctx)
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){requests.push(request);if(requests.length>2)throw Error('bounded cap');if(requests.length===1)ctx.goals.create(agent,{objective:'inert Bridge counter',maxGoalRounds:2});yield call('return await tools.postman_bridge({message:"@PostmanAsk inert fixture"})');yield{type:'finish',reason:{kind:'stop'}}}
  }
  ctx.llm.registerAdapter(['fixture'],new Model());agent=ctx.agentLoop.create('bridge',{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'});adapter.refresh(agent)
  ctx.on('agent/inbox/inserted',({agent:a,message:m})=>{if(a===agent&&m.source.form==='bridge-ready')ready.resolve(m)})
  t.after(async()=>{await adapter.dispose();await jobs.dispose();await ctx.fiber.dispose()})
  agent.followup(message('start'));await drain(agent);assert.equal(requests.length,1);assert.equal(ctx.goals.get(agent).roundsStarted,0)
  held[0].resolve({status:'POSTMAN_BRIDGE_TERMINAL'});const notice=await ready.promise;await drain(agent)
  assert.equal(notice.source.form,'bridge-ready');assert.equal(requests.length,2);assert.equal(ctx.goals.get(agent).roundsStarted,0);assert.equal(adapter.isWaitingForExternalEvent(agent),true)
  assert.equal(agent.session.events.filter(e=>e.type==='user/message'&&e.data.id===notice.id).length,1)
})

test('actual native Worker report wakes one review and empty active wait holds',{timeout:15000},async t=>{
  const {SubagentRuntime}=await pkg('dsh-subagent'),{apply:spawn}=await pkg('dsh-subagent-spawn-in-process'),{apply:report}=await pkg('dsh-tool-subagent-report'),{JsonlSessionPersistence}=await pkg('dsh-session-persistence-jsonl')
  const ctx=base(),requests=[],release=Promise.withResolvers(),finishChild=Promise.withResolvers(),reported=Promise.withResolvers(),sessions=mkdtempSync(join(tmpdir(),'goal-native-report-'))
  let childRequests=0
  new JsonlSessionPersistence(ctx,{root:sessions});new SubagentRuntime(ctx);spawn(ctx,{providerName:'spawn'});report(ctx,{reportDelivery:'next-step'})
  const contexts={get:()=>Object.freeze({worktree:process.cwd(),branch:'task/fixture'})}
  const worker=createPostmanWorkerTools(ctx,undefined,contexts)
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,hasActiveWork:()=>true})
  for(const tool of [worker.taskTool,adapter.tool])ctx.tools.register(tool)
  driver.apply(ctx);let agent
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text'],reasoning:{efforts:[{id:'low',name:'low'}]}}}
    async *stream(request){
      if(request.sessionId==='native-parent'){
        requests.push(request);if(requests.length>2)throw Error('bounded cap')
        if(requests.length===1)ctx.goals.create(agent,{objective:'inert native report counter',maxGoalRounds:2})
        yield call(requests.length===1?'return await tools.postman_worker({task:"held inert Worker",createNew:true})':'return {reviewed:true}')
      }else if(++childRequests===1){await release.promise;yield{type:'block-end',index:0,block:{type:'tool-call',id:'report',name:'report',arguments:JSON.stringify({output:'REAL_NATIVE_REPORT'})}}}
      // Hold later child output/settlement separately: it is a distinct native
      // lifecycle event, not a duplicate report and must not be suppressed.
      else {await finishChild.promise;yield{type:'block-end',index:0,block:{type:'text',text:'child finished'}}}
      yield{type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture','codex'],new Model());agent=ctx.agentLoop.create('native-parent',{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'});adapter.refresh(agent)
  ctx.on('agent/inbox/inserted',({agent:a,message:m})=>{if(a===agent&&m.source.kind==='subagent-report')reported.resolve(m)})
  await ctx.sessionPersistence.append(agent.id,[])
  t.after(async()=>{release.resolve();finishChild.resolve();worker.dispose();await adapter.dispose();await ctx.fiber.dispose();rmSync(sessions,{recursive:true,force:true})})
  agent.followup(message('start'));await drain(agent);assert.equal(requests.length,1);assert.equal(ctx.goals.get(agent).roundsStarted,0)
  release.resolve();const notice=await reported.promise;await drain(agent)
  assert.equal(requests.length,2);assert.equal(notice.source.kind,'subagent-report');assert.equal(ctx.goals.get(agent).roundsStarted,0);assert.equal(adapter.isWaitingForExternalEvent(agent),true)
  assert.equal(agent.session.events.filter(e=>e.type==='user/message'&&e.data.id===notice.id).length,1)
})

for(const race of ['dispatch','turn-stopping','idle'])test('native inbox event at '+race+' is neither dropped nor duplicated',{timeout:15000},async t=>{
  const ctx=base(),requests=[];let agent,inserted=false
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,hasActiveWork:()=>true})
  ctx.tools.register(adapter.tool);driver.apply(ctx)
  const notice=createUserMessage({content:[{type:'text',text:'race evidence'}],source:{kind:'plugin',plugin:'fixture',form:'bridge-ready'}})
  const send=()=>{if(!inserted){inserted=true;agent.followup(notice)}}
  if(race==='dispatch')ctx.on('tools/execute',async(exec,next)=>{const result=await next();if(exec.name==='ptc_execute')send();return result})
  // Session append observers forbid reentrant inbox appends; use the native
  // awaited stop hook where waking delivery is actually supported.
  if(race==='turn-stopping')ctx.on('agent/turn-stopping',({agent:a})=>{if(a===agent)send()})
  if(race==='idle')ctx.on('agent/status',({agent:a,status})=>{if(a===agent&&status==='idle')send()})
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){requests.push(request);if(requests.length>2)throw Error('bounded cap');if(requests.length===1)ctx.goals.create(agent,{objective:'inert race counter',maxGoalRounds:2});yield call('return {review:true}');yield{type:'finish',reason:{kind:'stop'}}}
  }
  ctx.llm.registerAdapter(['fixture'],new Model());agent=ctx.agentLoop.create('race-'+race,{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'});adapter.refresh(agent)
  t.after(async()=>{await adapter.dispose();await ctx.fiber.dispose()})
  agent.followup(message('start'));await drain(agent)
  assert.equal(requests.length,2);assert.equal(ctx.goals.get(agent).roundsStarted,0)
  assert.equal(agent.session.events.filter(e=>e.type==='user/message'&&e.data.id===notice.id).length,1)
  assert.deepEqual(agent.session.events.filter(e=>e.type==='turn/start').map(e=>e.data.turn),[1,2])
})

for(const veto of [undefined,false,'true',true])test('only exact true admission veto holds useful goals: '+String(veto),{timeout:15000},async t=>{
  const ctx=base(),requests=[];let agent
  ctx.on('goal/continuation-defer',()=>veto);driver.apply(ctx)
  ctx.tools.register(defineTool({name:'fixture_work',description:'Inert useful round',parameters:{},output,execute:(_args,exec)=>{exec.concludeTurn();return {worked:true}}}))
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){requests.push(request);if(requests.length>3)throw Error('bounded cap');if(requests.length===1)ctx.goals.create(agent,{objective:'normal useful goal',maxGoalRounds:2});yield{type:'block-end',index:0,block:{type:'tool-call',id:'work-'+requests.length,name:'fixture_work',arguments:'{}'}};yield{type:'finish',reason:{kind:'stop'}}}
  }
  ctx.llm.registerAdapter(['fixture'],new Model());agent=ctx.agentLoop.create('normal',{provider:'fixture',model:'inert'},{cwd:process.cwd()})
  t.after(()=>ctx.fiber.dispose());agent.followup(message('start'));await drain(agent)
  assert.equal(requests.length,veto===true?1:3);assert.equal(ctx.goals.get(agent).roundsStarted,veto===true?0:2)
})

test('admission veto is rechecked after awaited durability checkpoint',{timeout:15000},async t=>{
  const ctx=base(),requests=[],checkpoint=Promise.withResolvers(),flushing=Promise.withResolvers();let agent,defer=false
  ctx.on('goal/continuation-defer',()=>defer?true:undefined)
  const flush=ctx.sessions.flush.bind(ctx.sessions)
  ctx.sessions.flush=async session=>{flushing.resolve();await checkpoint.promise;return flush(session)}
  driver.apply(ctx)
  ctx.tools.register(defineTool({name:'fixture_work',description:'Inert checkpoint action',parameters:{},output,execute:(_args,exec)=>{exec.concludeTurn();return {worked:true}}}))
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){requests.push(request);if(requests.length>4)throw Error('bounded cap');if(requests.length===1)ctx.goals.create(agent,{objective:'checkpoint race',maxGoalRounds:2});yield{type:'block-end',index:0,block:{type:'tool-call',id:'work-'+requests.length,name:'fixture_work',arguments:'{}'}};yield{type:'finish',reason:{kind:'stop'}}}
  }
  ctx.llm.registerAdapter(['fixture'],new Model());agent=ctx.agentLoop.create('checkpoint',{provider:'fixture',model:'inert'},{cwd:process.cwd()})
  t.after(async()=>{checkpoint.resolve();await ctx.fiber.dispose()})
  agent.followup(message('start'));await flushing.promise;defer=true;checkpoint.resolve();await drain(agent)
  assert.equal(requests.length,1);assert.equal(ctx.goals.get(agent).roundsStarted,0);assert.equal(ctx.goals.get(agent).activation,'armed')
  // Input arriving after the checkpoint still uses native delivery and useful goals resume.
  defer=false;agent.followup(message('actual event'));await drain(agent)
  assert.equal(requests.length,4);assert.equal(ctx.goals.get(agent).roundsStarted,2)
})
// Outer policy vetoes and unsafe runtime outcomes must never fabricate a wait.
for(const kind of ['pre-veto','post-veto','unknown-status','refused-status','program-error','needs-decision','cleanup-error','pending-effects','aborted-runtime'])test('unsafe PTC does not suppress armed goal admission: '+kind,{timeout:15000},async t=>{
  const ctx=base(),requests=[];let agent
  const runtime=['cleanup-error','pending-effects','aborted-runtime'].includes(kind)?{
    async run({bindings,signal}){
      await bindings.postman_worker({}, {signal,callId:'accepted'})
      const effects={calls:[{callId:'accepted',name:'postman_worker',state:'completed'}],completed:1,failed:0,pending:0}
      return kind==='aborted-runtime'?{status:'cancelled',effects}:kind==='cleanup-error'?{status:'ok',value:1,cleanupError:{message:'fixture'},effects}:{status:'ok',value:1,effects:{...effects,pending:1}}
    },async dispose(){}
  }:undefined
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,hasActiveWork:()=>true,runtime})
  ctx.tools.register(adapter.tool)
  ctx.tools.register(defineTool({name:'postman_worker',description:'inert acceptance',parameters:{},output,execute:()=>({status:kind==='unknown-status'?'NEW_STATUS':kind==='refused-status'?'POSTMAN_WORKER_BINDING_UNCERTAIN':'POSTMAN_WORKER_TASK_ACCEPTED'})}))
  if(kind==='pre-veto')ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='ptc_execute'?{kind:'deny',reason:'fixture veto'}:next())
  if(kind==='post-veto')ctx.on('tools/post-execute',async(exec,result,next)=>exec.name==='ptc_execute'?{kind:'block',feedback:'fixture veto'}:next())
  driver.apply(ctx)
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      requests.push(request);if(requests.length>4)throw Error('bounded cap')
      if(requests.length===1){ctx.goals.create(agent,{objective:'unsafe admission counter',maxGoalRounds:2});yield call(kind==='program-error'?'throw Error("fixture error")':kind==='needs-decision'?'return {needsModelDecision:true}':'return await tools.postman_worker({})')}
      else yield{type:'block-end',index:0,block:{type:'text',text:'useful recovery'}}
      yield{type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model());agent=ctx.agentLoop.create('unsafe-'+kind,{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'});adapter.refresh(agent)
  t.after(async()=>{await adapter.dispose();await ctx.fiber.dispose()})
  agent.followup(message('start'));await drain(agent)
  assert.equal(requests.length,3);assert.equal(ctx.goals.get(agent).roundsStarted,1)
  assert.equal(adapter.isWaitingForExternalEvent(agent),false);assert.notEqual(ctx.bail('goal/continuation-defer',agent),true)
})

// Regression: a real Leader turn can inspect state through several PTC calls
// and dispatch its exact live producer only in the final PTC. Earlier successes
// must never authorize a refused final dispatch.
for (const outcome of ['accepted','refused']) test('multiple PTC calls, last external wait '+outcome,{timeout:15000},async t=>{
  const ctx=base(),requests=[]
  let agent
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,hasActiveWork:()=>true})
  ctx.tools.register(adapter.tool)
  ctx.tools.register(defineTool({name:'postman_worker',description:'inert accepted producer',parameters:{},output,
    execute:()=>({status:outcome==='accepted'?'POSTMAN_WORKER_TASK_ACCEPTED':'POSTMAN_WORKER_BINDING_UNCERTAIN'})}))
  driver.apply(ctx)
  const phase=(id,program,boundary)=>({type:'block-end',index:0,block:{type:'tool-call',id,name:'ptc_execute',
    arguments:JSON.stringify({program,description:'Exact multiple-PTC wait regression',boundary})}})
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      requests.push(request)
      if(requests.length>6)throw Error('bounded model requests')
      if(requests.length===1){
        ctx.goals.create(agent,{objective:'wait for one exact producer',maxGoalRounds:3})
        yield phase('inspect','return {preflight:true}','semantic_decision')
      }else if(requests.length===2){
        yield phase('dispatch','return await tools.postman_worker({task:"inert"})','external_event')
      }else yield {type:'block-end',index:0,block:{type:'text',text:'Waiting for existing producer'}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model())
  agent=ctx.agentLoop.create('multi-ptc-'+outcome,{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'})
  adapter.refresh(agent)
  t.after(async()=>{await adapter.dispose();await ctx.fiber.dispose()})
  agent.followup(message('start'));await drain(agent)
  const events=agent.session.events
  assert.equal(events.filter(e=>e.type==='tool/call'&&e.data.name==='ptc_execute').length,2)
  if(outcome==='accepted'){
    assert.equal(requests.length,2,'confirmed last dispatch must prevent a new goal injection')
    assert.equal(ctx.goals.get(agent).roundsStarted,0)
    assert.equal(adapter.isWaitingForExternalEvent(agent),true)
    assert.equal(ctx.bail('goal/continuation-defer',agent),true)
  }else{
    assert.ok(ctx.goals.get(agent).roundsStarted>=1,'refused last dispatch must not borrow an earlier result')
    assert.ok(requests.length>2,'goal still admits useful retry after refusal')
  }
})

test('goal-only text after transiently lost, then re-proven live wait does not loop',{timeout:15000},async t=>{
  const ctx=base(),requests=[]
  let agent,producerLive=true
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,hasActiveWork:()=>producerLive})
  ctx.tools.register(adapter.tool)
  ctx.tools.register(defineTool({name:'postman_worker',description:'inert accepted producer',parameters:{},output,
    execute:()=>({status:'POSTMAN_WORKER_TASK_ACCEPTED'})}))
  driver.apply(ctx)
  const phase=(id,program,boundary)=>({type:'block-end',index:0,block:{type:'tool-call',id,name:'ptc_execute',
    arguments:JSON.stringify({program,description:'Temporarily lost wait proof',boundary})}})
  // Producer temporarily vanishes at admission, then reappears while the first
  // already-admitted goal round responds with text. Avoid a second goal round.
  ctx.on('agent/turn-stopping',({agent:a})=>{if(a===agent&&requests.length===2)producerLive=false})
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      requests.push(request)
      if(requests.length>3)throw Error('redundant goal woke the model')
      if(requests.length===1){
        ctx.goals.create(agent,{objective:'unchanged waiting goal',maxGoalRounds:3})
        yield phase('preflight','return {checked:true}','semantic_decision')
      }else if(requests.length===2){
        yield phase('producer','return await tools.postman_worker({task:"inert"})','external_event')
      }else{
        producerLive=true
        yield {type:'block-end',index:0,block:{type:'text',text:'Waiting for admitted producer'}}
      }
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model())
  agent=ctx.agentLoop.create('recovered-goal-only-wait',{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'})
  adapter.refresh(agent)
  t.after(async()=>{await adapter.dispose();await ctx.fiber.dispose()})
  agent.followup(message('start'));await drain(agent)
  const goal=ctx.goals.get(agent)
  assert.equal(requests.length,3,'one genuine goal round may recover the wait, but must not loop')
  assert.equal(goal.roundsStarted,1)
  assert.equal(goal.phase,'active')
  assert.equal(adapter.isWaitingForExternalEvent(agent),true)
  assert.equal(ctx.bail('goal/continuation-defer',agent),true)
})

test('text-only turn without proven wait does not invent automatic work',{timeout:15000},async t=>{
  const ctx=base(),requests=[]
  let agent
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,hasActiveWork:()=>true})
  ctx.tools.register(adapter.tool);driver.apply(ctx)
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      requests.push(request)
      if(requests.length>4)throw Error('bounded goal rounds')
      if(requests.length===1)ctx.goals.create(agent,{objective:'unproven wait',maxGoalRounds:3})
      yield {type:'block-end',index:0,block:{type:'text',text:'Unproven waiting claim'}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model())
  agent=ctx.agentLoop.create('unproven-goal-only-wait',{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'})
  adapter.refresh(agent)
  t.after(async()=>{await adapter.dispose();await ctx.fiber.dispose()})
  agent.followup(message('start'));await drain(agent)
  const goal=ctx.goals.get(agent)
  assert.equal(requests.length,1)
  assert.equal(goal.roundsStarted,0)
  assert.equal(goal.phase,'active')
  assert.equal(adapter.isWaitingForExternalEvent(agent),false)
})

// Native AgentLoop, native Worker report, and the installed goal-round driver.
// A report still wakes the parent for review; the remaining exact live Worker
// supplies the event source without asking the model for an empty waiting PTC.
for(const quietOrder of ['none','dispatch','turn-stopping'])test('goal waits after text-only A report review while exact Worker B remains active, quiet='+quietOrder, {timeout:15000}, async t=>{
  const {SubagentRuntime}=await pkg('dsh-subagent')
  const {apply:spawn}=await pkg('dsh-subagent-spawn-in-process')
  const {apply:report}=await pkg('dsh-tool-subagent-report')
  const {JsonlSessionPersistence}=await pkg('dsh-session-persistence-jsonl')
  const {SessionProjectionRegistry}=await pkg('dsh-session-projection')
  const sessions=mkdtempSync(join(tmpdir(),'goal-two-reports-'))
  const ctx=base(), parentRequests=[], ptcEffects=[], initialResults=[], ids=[]
  let quietFact
  const release=[Promise.withResolvers(),Promise.withResolvers()]
  const holdSettlement=Promise.withResolvers(), delivered=Promise.withResolvers()
  new JsonlSessionPersistence(ctx,{root:sessions})
  new SessionProjectionRegistry(ctx)
  new SubagentRuntime(ctx);spawn(ctx,{providerName:'spawn'});report(ctx,{reportDelivery:'next-step'})
  const registry=createMemoryTaskRegistry()
  const context=Object.freeze({worktree:process.cwd(),branch:'task/fixture'})
  const contexts={get:()=>context,record:registry.get,changeRecord:registry.change}
  const worker=createPostmanWorkerTools(ctx,undefined,contexts)
  const start=ctx.subagents.startContinuable.bind(ctx.subagents)
  ctx.subagents.startContinuable=async spec=>{ids.push(spec.childId);return start(spec)}
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,hasActiveWork:a=>worker.hasActiveWork(a)})
  for(const tool of [worker.taskTool,adapter.tool])ctx.tools.register(tool)
  driver.apply(ctx)
  ctx.on('tools/result',(exec,result)=>{if(exec.name==='ptc_execute'&&exec.agent===parent){
    ptcEffects.push(result.value?.effects)
    initialResults.push({isError:result.isError,concludesTurn:result.concludesTurn,status:result.value?.status,error:result.error,effects:result.value?.effects})
  }})
  const injectQuiet=()=>{
    if(quietFact)return
    // Match the real native quiet-delivery envelope, after initial admission.
    // Classification itself is covered by the native bootstrap suite.
    quietFact=createUserMessage({content:[{type:'text',text:'exact technical settlement'}],source:{kind:'subagent-settled',senderSessionId:'technical-bootstrap',form:'postman-deferred'}})
    parent.inject(quietFact)
  }
  if(quietOrder==='dispatch')ctx.on('tools/result',(exec)=>{if(exec.name==='ptc_execute'&&exec.agent===parent)injectQuiet()})
  if(quietOrder==='turn-stopping')ctx.on('agent/turn-stopping',({agent})=>{if(agent===parent)injectQuiet()})
  ctx.on('tools/execute',async(exec,next)=>{
    const result=await next()
    if(exec.name==='report'&&exec.agent.id===ids[0]){delivered.resolve();await holdSettlement.promise}
    return result
  })
  let parent
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text'],reasoning:{efforts:[{id:'low',name:'low'}]}}}
    async *stream(request){
      if(request.sessionId==='goal-two-workers'){
        parentRequests.push(request)
        if(parentRequests.length===1)ctx.goals.create(parent,{objective:'review both exact reports',maxGoalRounds:1})
        const block=parentRequests.length===1?{type:'tool-call',id:'dispatch',name:'ptc_execute',
          arguments:JSON.stringify({description:'Dispatch two independent native Workers',boundary:'external_event',
            program:'const a=await tools.postman_worker({task:"A",createNew:true});const b=await tools.postman_worker({task:"B",createNew:true});return {a,b}'})}:
          {type:'text',text:'Worker A report reviewed; waiting for B event'}
        yield{type:'block-end',index:0,block}
      }else{
        const i=ids.indexOf(request.sessionId)
        assert.ok(i>=0,'exact native Worker identity')
        await release[i].promise
        yield{type:'block-end',index:0,block:{type:'tool-call',id:'report-'+i,name:'report',
          arguments:JSON.stringify({output:'PASS synthetic Worker '+i})}}
      }
      yield{type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture','codex'],new Model())
  parent=ctx.agentLoop.create('goal-two-workers',{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'})
  adapter.refresh(parent)
  await registry.create(parent.id,{workers:{}})
  t.after(async()=>{release.forEach(p=>p.resolve());holdSettlement.resolve();worker.dispose();await adapter.dispose();await ctx.fiber.dispose();rmSync(sessions,{recursive:true,force:true})})
  parent.followup(message('start'));await drain(parent)
  const evidence=()=>JSON.stringify({quietOrder,results:initialResults,goal:ctx.goals.get(parent),phase:parent.phase.kind,active:worker.hasActiveWork(parent),inbox:[...parent.inbox.nextStep,...parent.inbox.nextTurn].map(m=>m.source),events:parent.session.events.filter(e=>['turn/start','turn/end','user/message'].includes(e.type)).map(e=>({type:e.type,turn:e.data.turn,reason:e.data.reason,source:e.data.source}))})
  assert.deepEqual(initialResults.map(r=>[r.isError,r.concludesTurn,r.status]),[[false,true,'ok']],evidence())
  assert.equal(parentRequests.length,1,evidence())
  assert.equal(ids.length,2)
  assert.equal(worker.hasActiveWork(parent),true)
  assert.equal(ctx.goals.get(parent).roundsStarted,0,evidence())
  if(quietFact)assert.equal([...parent.inbox.nextStep,...parent.inbox.nextTurn].filter(m=>m.id===quietFact.id).length,1)
  release[0].resolve();await delivered.promise;await drain(parent)
  assert.equal(worker.hasActiveWork(parent),true,'B is exact active producer after A report')
  assert.equal(parentRequests.length,2,'one required report review, no extra goal wake')
  assert.equal(adapter.isWaitingForExternalEvent(parent),true,'known active B defers goal after A text-only review')
  assert.equal(ctx.bail('goal/continuation-defer',parent),true)
  assert.equal(ctx.goals.get(parent).roundsStarted,0)
  assert.equal(ptcEffects.filter(e=>e?.calls?.length===0).length,0,'zero empty waiting PTC')
  if(quietFact)assert.equal(parent.session.events.filter(e=>e.type==='user/message'&&e.data.id===quietFact.id).length,1,'technical fact delivered once alongside real A review')
})


// Real adapter request counts: no live model, transport, or user goal state.
for(const scenario of ['final-text','goal-read','goal-ptc','empty-ptc','finished-ptc','complete-ready','complete-needed','blocked-ready','blocked-needed','useful','pause-resume'])test('quiescent native requests: '+scenario,{timeout:15000},async t=>{
  const ctx=base(),requests=[],turnSteps=new Map()
  const adapter=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader});ctx.tools.register(adapter.tool)
  const {apply:goalTools}=await pkg('dsh-tool-goal');goalTools(ctx,{blockedAfterConsecutiveRounds:3});driver.apply(ctx)
  let agent,actions=0
  ctx.tools.register(defineTool({name:'fixture_work',description:'An inert useful action',parameters:{},output,execute:()=>({action:++actions})}))
  const text=value=>({type:'block-end',index:0,block:{type:'text',text:value}})
  const tool=(name,args)=>({type:'block-end',index:1,block:{type:'tool-call',id:'fixture-'+requests.length,name,arguments:JSON.stringify(args)}})
  class Model extends LlmAdapter{
    async resolveModel(provider,id){return{provider,id,name:id,inputModalities:['text']}}
    async *stream(request){
      requests.push(request);if(requests.length>16)throw Error('bounded actual model requests')
      if(!ctx.goals.get(agent))ctx.goals.create(agent,{objective:'same unchanged objective',maxGoalRounds:5})
      const g=ctx.goals.get(agent),turn=agent.session.events.findLast(e=>e.type==='turn/start').data.turn
      const step=(turnSteps.get(turn)||0)+1;turnSteps.set(turn,step)
      if(scenario==='final-text')yield text('Outcome already delivered')
      else if(scenario==='goal-read'){if(step===1)yield tool('get_goal',{});else yield text('No new action or decision')}
      else if(['goal-ptc','empty-ptc','finished-ptc'].includes(scenario)){
        if(step===1)yield tool('ptc_execute',{program:scenario==='goal-ptc'?'return await tools.get_goal({})':scenario==='empty-ptc'?'return {waiting:true}':'return await tools.read({})',description:'Native completion boundary',boundary:scenario==='finished-ptc'?'task_complete':'semantic_decision'})
        else yield text('Outcome already delivered')
      }
      else if(scenario==='pause-resume'){
        if(turn===1&&step===1)yield tool('update_goal',{goal_id:g.id,revision:g.revision,action:'pause'})
        else if(turn===2&&step===1)yield tool('update_goal',{goal_id:g.id,revision:g.revision,action:'resume'})
        else yield text('Human request addressed')
      }else if(scenario==='useful'){
        if(g.roundsStarted<2&&step===1)yield tool('fixture_work',{})
        else if(g.roundsStarted===2&&g.phase==='active')yield tool('update_goal',{goal_id:g.id,revision:g.revision,action:'complete'})
        else yield text('Useful action verified')
      }else{
        const blocked=scenario.startsWith('blocked'),terminalRound=blocked?3:1
        if(g.phase!=='active')yield text('Final outcome supplied once')
        else if(g.roundsStarted<terminalRound){if(step===1)yield tool('fixture_work',{});else yield text('Useful work verified')}
        else{
          if(scenario.endsWith('-ready'))yield text('Final outcome already supplied')
          yield tool('update_goal',{goal_id:g.id,revision:g.revision,action:blocked?'blocked':'complete',...(blocked?{blocked_reason:'Concrete user dependency persists'}:{})})
        }
      }
      yield{type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model());agent=ctx.agentLoop.create('quiescent-'+scenario,{provider:'fixture',model:'inert'},{cwd:process.cwd(),agentPreset:'postman-leader-ptc'})
  adapter.refresh(agent)
  t.after(async()=>{await adapter.dispose();await ctx.fiber.dispose()});agent.followup(message('start'));await drain(agent)
  if(scenario==='pause-resume'){
    assert.equal(requests.length,2);assert.equal(ctx.goals.get(agent).phase,'paused')
    ctx.emit('agent/session-start',{agent});await drain(agent);assert.equal(requests.length,2)
    agent.followup(message('resume this exact objective'));await drain(agent)
    assert.equal(ctx.goals.get(agent).phase,'active');assert.equal(ctx.goals.get(agent).activation,'armed')
  }
  const expected={'final-text':1,'goal-read':2,'goal-ptc':2,'empty-ptc':2,'finished-ptc':2,'complete-ready':3,'complete-needed':4,'blocked-ready':7,'blocked-needed':8,useful:6,'pause-resume':4}[scenario]
  console.log(JSON.stringify({scenario,actualRequests:requests.length,autoRounds:ctx.goals.get(agent).roundsStarted,actions,phase:ctx.goals.get(agent).phase}))
  assert.equal(requests.length,expected,'no empty continuation or duplicate final')
  if(scenario==='useful')assert.equal(actions,2,'unchanged objective still admits useful autonomous work')
  if(scenario==='final-text'){
    ctx.emit('agent/session-start',{agent});await drain(agent);assert.equal(requests.length,1,'cold active restore is disarmed')
    agent.followup(message('ordinary human message'));await drain(agent);assert.equal(requests.length,2,'ordinary input is not vetoed')
  }
})

