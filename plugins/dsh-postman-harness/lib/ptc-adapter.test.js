import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createPtcAdapter, PILOT_PROFILE } from './ptc-adapter.js'
import { postmanBridgeRestrictionForAgent, isTopLevelPostmanPtcLeader, postmanPtcDirectCallGuard, POSTMAN_PTC_ONLY_LEADER_TOOLS } from './postman-bridge-core.js'

import { apply as applyFs } from '@deepseek-ai/dsh-tool-fs'
import { applyGrepTool, RAW_OUTPUT_MAX_BYTES, GREP_MAX_MATCHES, GREP_MAX_LINE_BYTES, SEARCH_META_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES, SEARCH_TIMEOUT_MS } from '@deepseek-ai/dsh-tool-fs-search'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { apply as applyGoal } from '@deepseek-ai/dsh-tool-goal'
import { applyWebFetchTool } from '@deepseek-ai/dsh-tool-web'
const output = { schema: { type:'object', additionalProperties:true }, render: (_a, value) => [{type:'text',text:JSON.stringify(value)}] }
function fixture(dir, { real = false } = {}) {
  const ctx = new Context()
  ctx.systemPrompt = { tools() {}, section() { return () => {} } }
  new ToolRuntime(ctx)
  const agents = new Map(), presets = new WeakMap()
  ctx.agentPresets = { composedPreset: agentCtx => presets.get(agentCtx) }
  ctx.agents = { get:id=>agents.get(id), list:()=>[...agents.values()] }
  const traces = []
  ctx.on('tools/pre-execute', async (exec,next)=> { traces.push(['pre',exec.name,exec.agent,exec.parent,exec.rootCallId,exec.token]); return next() })
  ctx.on('tools/result', (exec, result)=>traces.push(['result',exec.name,exec.agent,result.isError]))
  ctx.tools.guard(exec => postmanPtcDirectCallGuard(exec, id => agents.get(id)))
  if (real) {
    ctx.fs = new LocalFileSystem(ctx,{cwd:dir,diffBasisMaxBytes:1048576})
    ctx.subprocess = new LocalSubprocessRuntime(ctx)
    applyFs(ctx,{readLimit:2000,readMaxLineLength:2000,readMaxBytes:51200,readStreamMinSize:10485760})
    applyGrepTool(ctx,{maxMatches:GREP_MAX_MATCHES,maxLineBytes:GREP_MAX_LINE_BYTES,maxMetaBytes:SEARCH_META_MAX_BYTES,rawOutputMaxBytes:RAW_OUTPUT_MAX_BYTES,graceMs:SEARCH_GRACE_MS,stderrMaxBytes:SEARCH_STDERR_MAX_BYTES,timeoutMs:SEARCH_TIMEOUT_MS})
  } else for (const name of ['read','grep']) ctx.tools.register(defineTool({name,description:name,parameters:{},output,async execute(){return {name}}}))
  if (real) {
    ctx.agents.currentInitiator = () => ctx.__initiator
    ctx.goals = { get: () => undefined }
    applyGoal(ctx,{blockedAfterConsecutiveRounds:3})
    ctx.web = { fetch: async ({url},signal) => { if(signal.aborted) throw new Error('aborted'); return {url,statusCode:200,body:{kind:'text',content:'local controlled response'},truncated:false} } }
    applyWebFetchTool(ctx,30000,200000)
  } else for (const name of ['get_goal','web_fetch']) ctx.tools.register(defineTool({name,description:name,parameters:{},output,async execute(){return {name}}}))
  // Register inert names so the real registry can validate the full preset restriction.
  for (const name of postmanBridgeRestrictionForAgent({session:{header:{agentPreset:'postman-leader-ptc'}}}).allow)
    if (name !== 'ptc_execute' && !ctx.tools.get(name)) ctx.tools.register(defineTool({name,description:name,parameters:{},output,async execute(){return {name}}}))
  const adapter = createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader})
  ctx.tools.register(adapter.tool)
  function agent(id,preset='postman-leader-ptc',extra={}) {
    const events = [], sections = []
    const a = { id, status:'running', session:{events:[{type:'turn/start'}],header:{agentPreset:preset,delegationDepth:0,cwd:dir,...extra},append(type,data){events.push({type,data})}} }
    const agentCtx=createScope(ctx, a).ctx
    a.ctx=agentCtx
    presets.set(agentCtx,preset)
    agentCtx.systemPrompt.section = s=>{sections.push(s);return ()=>sections.splice(sections.indexOf(s),1)}
    agents.set(id,a)
    return {a,events,sections}
  }
  let n=0
  function execute(a,program,controller=new AbortController()) {
    return ctx.tools.execute({callId:'root-'+ ++n,name:'ptc_execute',arguments:{program,description:'Test one program'},agent:a,signal:controller.signal})
  }
  return {ctx,agents,traces,adapter,agent,execute}
}

test('ordinary ptc_execute passes actual QuickJS to real Harness read and grep',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ptc-integration-'))
  try {
    await writeFile(join(dir,'proof.txt'),'первая строка\nМАРКЕР цепочки\nпоследняя строка\n','utf8')
    const f=fixture(dir,{real:true}), {a,events}=f.agent('pilot')
    a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a))
    f.adapter.refresh(a)
    f.ctx.__initiator = a
    const result=await f.execute(a,"const r = await tools.read({file_path:'proof.txt',limit:3}); const g = await tools.grep({pattern:'МАРКЕР',path:'proof.txt'}); const goal = await tools.get_goal({}); const web = await tools.web_fetch({url:'http://127.0.0.1/controlled'}); return {line:r.lines[1].text,matched:g.matches[0].line,count:g.matches.length,goal:goal.goal,body:web.body.content}")
    assert.equal(result.isError,false,result.error?.message)
    assert.equal(result.value.status,'ok',JSON.stringify(result.value))
    assert.equal(result.value.value.line,'МАРКЕР цепочки')
    assert.equal(result.value.value.count,1)
    assert.match(result.value.value.matched,/МАРКЕР/)
    assert.equal(result.value.value.goal,null)
    assert.equal(result.value.value.body,'local controlled response')
    assert.equal(f.traces.filter(e=>e[0]==='pre' && ['read','grep','get_goal','web_fetch'].includes(e[1])).length,4)
    assert.ok(f.traces.filter(e=>e[0]==='pre' && ['read','grep'].includes(e[1])).every(e=>e[2]===a && e[3] !== undefined && e[4]===f.traces.find(e=>e[1]==='ptc_execute')[4]))
    assert.deepEqual(events.map(e=>e.type),Array.from({length:4},()=>['tool/code-dispatch-start','tool/code-dispatch']).flat())
    const invalid=await f.execute(a,"try { await tools.read({wrong:'argument'}); return 'bypass' } catch (e) { return String(e).includes('file_path') }")
    assert.equal(invalid.value.value,true)
    assert.equal(invalid.value.effects.failed,1)
    await f.adapter.dispose()
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('abort during real read reaches the local filesystem provider',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ptc-read-abort-'))
  try {
    await writeFile(join(dir,'slow.txt'),'UTF-8 проба\n','utf8')
    const f=fixture(dir,{real:true}), {a}=f.agent('read-abort')
    a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
    let enter
    const entered=new Promise(resolve=>enter=resolve)
    const read=f.ctx.fs.readText.bind(f.ctx.fs)
    let sawAbort=false
    f.ctx.fs.readText=async (target,signal)=>{
      enter()
      await new Promise(resolve=>signal.addEventListener('abort',()=>{sawAbort=true;resolve()},{once:true}))
      if (signal.aborted) throw new Error('read aborted')
      return read(target,signal)
    }
    const controller=new AbortController()
    const running=f.execute(a,"return await tools.read({file_path:'slow.txt'})",controller)
    await entered;controller.abort()
    const result=await running
    assert.equal(result.isError,true)
    assert.equal(sawAbort,true)
    await f.adapter.dispose()
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('pilot alone sees and executes; production, Worker, Bridge, replacement cannot',async()=>{
  const f=fixture(process.cwd()), pilot=f.agent('pilot'), production=f.agent('production','postman-leader'), standard=f.agent('standard','standard'),worker=f.agent('worker','postman-leader-ptc',{origin:'subagent',delegationDepth:1}),bridge=f.agent('bridge','postman-leader-ptc',{origin:'subagent',delegationDepth:0})
  for(const {a} of [pilot,production,standard,worker,bridge]){ a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a) }
  assert.equal((await f.execute(pilot.a,'return 7')).value.value,7)
  for(const {a} of [production,standard,worker,bridge]){
    assert.equal(f.ctx.tools.schemas(a).some(s=>s.name==='ptc_execute'),false)
    const result=await f.execute(a,'return 3')
    assert.equal(result.isError,true)
  }
  // Even a scoped shadow registration cannot make the execute body authorize a non-pilot.
  standard.a.ctx.tools.register(f.adapter.tool)
  assert.equal((await f.execute(standard.a,'return 17')).value.status,'PTC_CALLER_REJECTED')
  const original=pilot.a, replacement={...original}
  f.agents.set('pilot',replacement)
  assert.equal((await f.execute(original,'return 5')).value.status,'PTC_CALLER_REJECTED')
  await f.adapter.dispose()
})

test('pilot uses native tool mode while other agents keep their code-mode declaration',async()=>{
  const f=fixture(process.cwd()), pilot=f.agent('native'), other=f.agent('code','standard')
  pilot.a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(pilot.a));f.adapter.refresh(pilot.a)
  other.a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(other.a));f.adapter.refresh(other.a)
  other.a.ctx.tools.presentAs('code')
  assert.equal(f.ctx.tools.schemas(pilot.a).some(s=>s.name==='ptc_execute'),true)
  assert.equal(f.ctx.tools.schemas(other.a).some(s=>s.name==='ptc_execute'),false)
  assert.equal((await f.execute(pilot.a,'return 18')).value.value,18)
  await f.adapter.dispose()
})

test('profile intersection, invalid args, revocation and independent owners',async()=>{
  const f=fixture(process.cwd()), one=f.agent('a')
  one.a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(one.a));f.adapter.refresh(one.a)
  assert.equal(one.sections.length,1)
  assert.equal(one.sections[0].text({scope:{}}),'')
  const hint=one.sections[0].text({scope:one.a})
  assert.match(hint,/read.*grep.*get_goal.*web_fetch/)
  assert.match(hint,/parameters/)
  assert.match(hint,/postman_worker.*parameters/)
  assert.doesNotMatch(hint,/description.*parameters/)
  const two=f.agent('b')
  two.a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(two.a));f.adapter.refresh(two.a)
  assert.equal((await f.execute(one.a,'return await tools.write({})')).value.status,'runtime-error')
  assert.equal((await f.execute(one.a,'return await tools.read({})')).value.value.name,'read')
  const hideOptional=one.a.ctx.tools.restrict({deny:['web_fetch']})
  assert.doesNotMatch(one.sections[0].text({scope:one.a}),/web_fetch/)
  assert.equal((await f.execute(one.a,"return typeof tools.web_fetch")).value.value,'undefined')
  hideOptional()
  const hideRequired=one.a.ctx.tools.restrict({deny:['grep']})
  assert.equal((await f.execute(one.a,'return 1')).value.status,'PTC_REQUIRED_TOOL_UNAVAILABLE')
  hideRequired()
  const controller=new AbortController();controller.abort()
  assert.equal((await f.execute(one.a,'return 1',controller)).isError,true)
  assert.throws(()=>f.adapter.setProfile({...PILOT_PROFILE,revision:4,tools:['write']}),/not allowed/)
  f.adapter.setProfile({...PILOT_PROFILE,revision:4,tools:['read','grep']})
  assert.equal((await f.execute(one.a,'return 4')).value.value,4)
  f.adapter.remove(one.a)
  assert.equal((await f.execute(one.a,'return 1')).value.status,'PTC_CALLER_REJECTED')
  assert.equal((await f.execute(two.a,'return 9')).value.value,9)
  await f.adapter.dispose()
})

test('nested ordinary approval is not bypassed by ptc_execute',async()=>{
  const f=fixture(process.cwd()), {a}=f.agent('approval')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  f.ctx.on('tools/pre-execute',async (exec,next)=>exec.name==='read' && exec.parent ? {kind:'ask',reason:'requires confirmation'} : next())
  const result=await f.execute(a,"try { await tools.read({}); return 'unexpected' } catch(e) { return String(e).includes('requires confirmation') }")
  assert.equal(result.value.status,'ok')
  assert.equal(result.value.value,true)
  assert.equal(result.value.effects.failed,1)
  await f.adapter.dispose()
})

test('ordinary permission and preset revocation stop a running program',async()=>{
  const f=fixture(process.cwd()), one=f.agent('revoked'), two=f.agent('independent')
  for (const {a} of [one,two]) {a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)}
  let entered
  const started=new Promise(resolve=>{entered=resolve})
  f.ctx.tools.guard(exec => {if(exec.name==='read' && exec.agent===one.a) entered(); return undefined})
  const running=f.execute(one.a,"await tools.read({}); await new Promise(() => {}); return 'wrong'")
  await started
  f.adapter.remove(one.a)
  const cancelled=await running
  assert.notEqual(cancelled.value.status,'ok')
  assert.equal((await f.execute(two.a,'return 11')).value.value,11)
  one.a.session.header.agentPreset='standard'
  f.adapter.refresh(one.a)
  assert.equal((await f.execute(one.a,'return 1')).value.status,'PTC_CALLER_REJECTED')
  await f.adapter.dispose()
})

test('queued dispatch stays cancelled after a permission is revoked',async()=>{
  const f=fixture(process.cwd()), {a}=f.agent('queue')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  let enter,release
  const entered=new Promise(r=>enter=r), gate=new Promise(r=>release=r)
  f.ctx.on('tools/pre-execute',async (exec,next)=>{if(exec.name==='read' && exec.parent){enter();await gate}return next()})
  const running=f.execute(a,"return await tools.read({})")
  await entered
  const deny=a.ctx.tools.restrict({deny:['read']})
  release()
  const cancelled=await running
  assert.notEqual(cancelled.value.status,'ok')
  deny()
  assert.equal((await f.execute(a,'return 12')).value.value,12)
  await f.adapter.dispose()
})

test('noncooperative nested operation remains pending without a false success',async()=>{
  const f=fixture(process.cwd()), {a,events}=f.agent('hanging')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  let entered,finish
  const started=new Promise(resolve=>entered=resolve), held=new Promise(resolve=>finish=resolve)
  f.ctx.on('tools/execute',async (exec,next)=>{
    if(exec.name==='read' && exec.parent){entered();await held}
    return next()
  })
  const running=f.execute(a,"return await tools.read({})")
  await started;f.adapter.remove(a)
  const result=await running
  assert.notEqual(result.value.status,'ok')
  assert.equal(result.value.effects.pending,1)
  assert.equal(events.at(-1).type,'tool/code-dispatch')
  assert.match(events.at(-1).data.content[0].text,/pending|unknown/)
  f.adapter.refresh(a)
  assert.equal((await f.execute(a,'return 14')).value.value,14)
  finish()
  await f.adapter.dispose()
})

test('PTC-first Leader direct tools fail closed while exceptions and production stay direct', async () => {
  const f = fixture(process.cwd()), pilot = f.agent('ptc-first'), production = f.agent('direct', 'postman-leader')
  for (const {a} of [pilot, production]) { a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a) }
  assert.deepEqual(PILOT_PROFILE.tools, POSTMAN_PTC_ONLY_LEADER_TOOLS)
  assert.equal(PILOT_PROFILE.id, 'postman-leader-supervisor')
  assert.equal(PILOT_PROFILE.revision, 3)
  assert.equal(PILOT_PROFILE.limits.maxWallMs, 30000)
  assert.equal(PILOT_PROFILE.limits.maxConcurrentToolCalls, 1)
  for (const name of ['ptc_execute', 'skill', 'ask_user_question', 'exit_plan_mode', 'read_image', 'postman_yield'])
    assert.equal(f.ctx.tools.schemas(pilot.a).some(s => s.name === name), true, name)
  for (const name of POSTMAN_PTC_ONLY_LEADER_TOOLS) {
    assert.equal(f.ctx.tools.schemas(pilot.a).some(s => s.name === name), true, name)
    const denied = await f.ctx.tools.execute({callId:'direct-'+name,name,arguments:{},agent:pilot.a,signal:new AbortController().signal})
    assert.equal(denied.isError, true, name)
    assert.match(denied.error.message, /POSTMAN_PTC_DIRECT_CALL_REJECTED.*ptc_execute/, name)
    const allowed = await f.ctx.tools.execute({callId:'production-'+name,name,arguments:{},agent:production.a,signal:new AbortController().signal})
    assert.equal(allowed.isError, false, name)
  }
  for (const name of ['skill', 'ask_user_question', 'exit_plan_mode', 'read_image', 'postman_yield']) {
    const direct = await f.ctx.tools.execute({callId:'exception-'+name,name,arguments:{},agent:pilot.a,signal:new AbortController().signal})
    assert.equal(direct.isError, false, name)
  }
  assert.equal(f.ctx.tools.schemas(production.a).some(s=>s.name==='ptc_execute'),false)
  assert.equal(f.ctx.tools.schemas(pilot.a).some(s=>s.name==='run_code'),false)
  await f.adapter.dispose()
})

test('one PTC outer call batches supervisor operations with native parent and root linkage', async () => {
  const f=fixture(process.cwd()), {a,events}=f.agent('batch')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a)
  const program = "const goal = await tools.get_goal({}); const task = await tools.postman_task_prepare({}); const worker = await tools.postman_worker({task:'fixture task',createNew:true,label:'fixture'}); const workers = await tools.postman_worker_list({}); return {goal,task,worker,workers}"
  const result=await f.execute(a,program)
  assert.equal(result.isError,false,result.error?.message)
  assert.equal(result.value.status,'ok',JSON.stringify(result.value))
  assert.deepEqual(Object.keys(result.value.value),['goal','task','worker','workers'])
  assert.deepEqual(Object.values(result.value.value).map(v=>v.name),['get_goal','postman_task_prepare','postman_worker','postman_worker_list'])
  const outer=f.traces.filter(e=>e[0]==='pre' && e[1]==='ptc_execute')
  const nested=f.traces.filter(e=>e[0]==='pre' && ['get_goal','postman_task_prepare','postman_worker','postman_worker_list'].includes(e[1]))
  assert.equal(outer.length,1)
  assert.equal(nested.length,4)
  assert.ok(nested.every(e=>e[2]===a && e[3]===outer[0][5] && e[4]===outer[0][4]))
  assert.equal(events.filter(e=>e.type==='tool/code-dispatch-start').length,4)
  assert.equal(events.filter(e=>e.type==='tool/code-dispatch').length,4)
  const optional=await f.execute(a,"return {interrupt:(await tools.postman_worker_interrupt({})).name,bridge:(await tools.postman_bridge({})).name,status:(await tools.postman_bridge_status({})).name}")
  assert.equal(optional.value.status,'ok',JSON.stringify(optional.value))
  assert.deepEqual(optional.value.value,{interrupt:'postman_worker_interrupt',bridge:'postman_bridge',status:'postman_bridge_status'})
  const revoked=a.ctx.tools.restrict({deny:['postman_bridge_status']})
  const unavailable=await f.execute(a,"return typeof tools.postman_bridge_status")
  assert.equal(unavailable.value.value,'undefined')
  revoked()
  await f.adapter.dispose()
})
