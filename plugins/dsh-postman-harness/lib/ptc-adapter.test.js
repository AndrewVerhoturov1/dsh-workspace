import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createPtcAdapter, PILOT_PROFILE, WORKER_MUTATION_PROFILE } from './ptc-adapter.js'
import { POSTMAN_PTC_DISCIPLINE } from './ptc-discipline.js'
import { postmanBridgeRestrictionForAgent, isTopLevelPostmanPtcLeader, postmanPtcDirectCallGuard, POSTMAN_PTC_ONLY_LEADER_TOOLS } from './postman-bridge-core.js'

import { apply as applyFs } from '@deepseek-ai/dsh-tool-fs'
import { applyGrepTool, RAW_OUTPUT_MAX_BYTES, GREP_MAX_MATCHES, GREP_MAX_LINE_BYTES, SEARCH_META_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES, SEARCH_TIMEOUT_MS } from '@deepseek-ai/dsh-tool-fs-search'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { apply as applyGoal } from '@deepseek-ai/dsh-tool-goal'
import { applyWebFetchTool } from '@deepseek-ai/dsh-tool-web'
const output = { schema: { type:'object', additionalProperties:true }, render: (_a, value) => [{type:'text',text:JSON.stringify(value)}] }
function fixture(dir, { real = false, readMaxBytes = 51200, runtime, resolveAssignment, workerContextOf } = {}) {
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
    applyFs(ctx,{readLimit:2000,readMaxLineLength:2000,readMaxBytes,readStreamMinSize:10485760})
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
  const adapter = createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader, runtime, resolveAssignment, workerContextOf})
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
    return ctx.tools.execute({callId:'root-'+ ++n,name:'ptc_execute',arguments:{program,description:'Test one program',boundary:'semantic_decision'},agent:a,signal:controller.signal})
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
    assert.deepEqual(events.map(e=>e.type),[...Array.from({length:4},()=>['tool/code-dispatch-start','tool/code-dispatch']).flat(), 'postman/ptc-run'])
    const invalid=await f.execute(a,"try { await tools.read({wrong:'argument'}); return 'bypass' } catch (e) { return String(e).includes('file_path') }")
    assert.equal(invalid.value.value,true)
    assert.equal(invalid.value.effects.failed,1)
    await f.adapter.dispose()
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('helpers page and batch sequentially within one outer PTC call in JS and TS', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ptc-helpers-'))
  try {
    await writeFile(join(dir,'first.txt'),'alpha\nbeta\ngamma\ndelta\n','utf8')
    await writeFile(join(dir,'second.txt'),'MARKER\n','utf8')
    const f=fixture(dir,{real:true}), {a,sections}=f.agent('helpers')
    a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
    assert.match(sections[0].text({scope:a}),/ptc.readAllText.*ptc.readMany.*ptc.grepMany/)
    for (const language of ['javascript','typescript']) {
      const program="const first"+(language==='typescript'?': string':'')+" = await ptc.readAllText({file_path:'first.txt',page_limit:2}); const many=await ptc.readMany({files:['first.txt','second.txt'],page_limit:2}); const matches=await ptc.grepMany({queries:[{pattern:'alpha',path:'first.txt'},{pattern:'MARKER',path:'second.txt'}]}); return {first,many,matches:matches.map(x=>x.result.matches.length),names:Object.keys(ptc).sort()}"
      const result=await f.ctx.tools.execute({callId:'helpers-'+language,name:'ptc_execute',arguments:{program,language,description:'Test sequential helpers',boundary:'semantic_decision'},agent:a,signal:new AbortController().signal})
      assert.equal(result.isError,false,result.error?.message)
      assert.equal(result.value.status,'ok',JSON.stringify(result.value))
      assert.equal(result.value.value.first,'alpha\nbeta\ngamma\ndelta')
      assert.deepEqual(result.value.value.many.map(x=>x.text),['alpha\nbeta\ngamma\ndelta','MARKER'])
      assert.deepEqual(result.value.value.matches,[1,1])
      assert.deepEqual(result.value.value.names,['expectStatus','grepMany','jsonBytes','mapTextFiles','readAllText','readMany','utf8Bytes'])
    }
    const outer=f.traces.filter(x=>x[0]==='pre' && x[1]==='ptc_execute')
    const nested=f.traces.filter(x=>x[0]==='pre' && ['read','grep'].includes(x[1]))
    assert.equal(outer.length,2)
    assert.equal(nested.length,14)
    assert.deepEqual(nested.slice(0,7).map(x=>x[1]),['read','read','read','read','read','grep','grep'])
    assert.ok(nested.every((x,i)=>x[3]===outer[Math.floor(i/7)][5]))
    await f.adapter.dispose()
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('real read canonical JSON above 64 KiB returns a compact summary', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ptc-large-read-'))
  try {
    await writeFile(join(dir,'large.txt'),('x'.repeat(1500)+'\n').repeat(48),'utf8')
    const f=fixture(dir,{real:true,readMaxBytes:120000}), {a}=f.agent('large-read')
    a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
    // Raise only the fixture's ordinary read cap so its canonical JSON crosses 64 KiB.
    // The PTC profile and 1 MiB message cap remain unchanged.
    const result=await f.execute(a,"const first=await tools.read({file_path:'large.txt',limit:48}); return {canonicalBytes:JSON.stringify(first).length,lines:first.lines.length,last:first.lines.at(-1).number}")
    assert.equal(result.isError,false,result.error?.message)
    assert.equal(result.value.status,'ok',JSON.stringify(result.value))
    assert.ok(result.value.value.canonicalBytes>65536)
    assert.equal(result.value.value.lines,48)
    assert.equal(result.value.value.last,48)
    const truncated=await f.execute(a,"return await ptc.readAllText({file_path:'large.txt',page_limit:4})")
    assert.equal(truncated.value.status,'ok',JSON.stringify(truncated.value))
    assert.equal(truncated.value.value.length,48*1500+47)
    await writeFile(join(dir,'long-line.txt'),'x'.repeat(2500),'utf8')
    const lineTruncated=await f.execute(a,"return await ptc.readAllText({file_path:'long-line.txt'})")
    assert.equal(lineTruncated.value.status,'runtime-error')
    assert.match(lineTruncated.value.error.message,/line truncated/)
    await f.adapter.dispose()
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('helper exposure follows ordinary visibility and no hidden grants', async()=>{
  const f=fixture(process.cwd()), {a}=f.agent('visibility')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  f.adapter.setProfile({...PILOT_PROFILE,revision:6,tools:['read']})
  const first=await f.execute(a,"return {names:Object.keys(ptc),grep:typeof tools.grep}")
  assert.equal(first.value.status,'ok',JSON.stringify(first.value))
  assert.deepEqual(first.value.value,{names:['expectStatus','utf8Bytes','jsonBytes','readAllText','readMany','mapTextFiles'],grep:'undefined'})
  f.adapter.setProfile({...PILOT_PROFILE,revision:7,tools:['read','grep']})
  const hidden=a.ctx.tools.restrict({deny:['grep']})
  assert.equal((await f.execute(a,'return Object.keys(ptc)')).value.status,'PTC_REQUIRED_TOOL_UNAVAILABLE')
  hidden()
  const clean=await f.execute(a,"return {names:Object.keys(ptc),fs:typeof require,write:typeof tools.write}")
  assert.equal(clean.value.status,'ok',JSON.stringify(clean.value))
  assert.deepEqual(clean.value.value.names,['expectStatus','utf8Bytes','jsonBytes','readAllText','readMany','mapTextFiles','grepMany'])
  assert.equal(clean.value.value.fs,'undefined')
  assert.equal(clean.value.value.write,'undefined')
  await f.adapter.dispose()
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
  assert.doesNotMatch(one.sections[0].text({scope:one.a}).split('Current nested argument schemas: ')[1],/web_fetch/)
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
  assert.equal(events.at(-1).type,'postman/ptc-run')
  assert.match(events.at(-2).data.content[0].text,/pending|unknown/)
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
  assert.equal(PILOT_PROFILE.revision, 6)
  assert.equal(PILOT_PROFILE.limits.maxWallMs, 300000)
  assert.equal(PILOT_PROFILE.limits.maxToolCalls, 256)
  assert.equal(PILOT_PROFILE.limits.quickjsMemoryBytes, 67108864)
  assert.equal(PILOT_PROFILE.limits.maxTotalBridgeBytes, 16777216)
  assert.equal(PILOT_PROFILE.limits.maxMessageBytes, 1048576)
  assert.equal(PILOT_PROFILE.limits.maxValueDepth, 32)
  assert.equal(PILOT_PROFILE.limits.maxValueNodes, 10000)
  assert.equal(PILOT_PROFILE.limits.maxOutputBytes, 524288)
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

test('canonical discipline follows exact PTC assignment and ordinary visibility only', async () => {
  const contexts = new Map()
  let assigned
  const f = fixture(process.cwd(), { resolveAssignment: (agent, profile) => isTopLevelPostmanPtcLeader(agent)
    ? { profile, role: 'leader' } : agent === assigned ? { profile: WORKER_MUTATION_PROFILE, role: 'worker' } : null,
    workerContextOf: agent => contexts.get(agent) })
  try {
    const pilot = f.agent('discipline')
    f.adapter.refresh(pilot.a)
    const worker = f.agent('confirmed', 'standard')
    assigned = worker.a; contexts.set(worker.a, { worktree: process.cwd() })
    f.ctx.tools.register(defineTool({ name:'glob', description:'glob', parameters:{}, output, execute(){return {name:'glob'}} }))
    f.adapter.refresh(worker.a)
    const plain = f.agent('plain', 'standard'); f.adapter.refresh(plain.a)
    const production = f.agent('production', 'postman-leader'); f.adapter.refresh(production.a)
    for (const { a, sections } of [pilot, worker]) {
      assert.ok(sections[0].text({ scope: a }).includes(POSTMAN_PTC_DISCIPLINE))
      assert.equal(sections[0].text({ scope: plain.a }), '')
      const hide = a.ctx.tools.restrict({ deny: ['ptc_execute'] })
      assert.equal(sections[0].text({ scope: a }), '')
      hide()
    }
    assert.equal(plain.sections.length, 0)
    assert.equal(production.sections.length, 0)
    assigned = null
    assert.equal(worker.sections[0].text({ scope: worker.a }), '')
    assert.equal((await f.execute(worker.a, 'return 1')).value.status, 'PTC_CALLER_REJECTED')
  } finally { await f.adapter.dispose() }
})

test('boundary required and yield_on_success is exact boolean, external_event, Leader only', async () => {
  const f = fixture(process.cwd()), { a } = f.agent('validation')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a)
  const invoke = args => f.ctx.tools.execute({ callId: 'validation', name: 'ptc_execute',
    arguments: { program: 'return 1', description: 'Wait for an external report', ...args }, agent: a, signal: new AbortController().signal })
  try {
    for (const args of [{}, { boundary: 'mechanical_step' }, { boundary: null }]) assert.equal((await invoke(args)).isError, true)
    for (const boundary of ['semantic_decision', 'user_input', 'approval_boundary', 'task_complete']) {
      assert.equal((await invoke({ boundary, yield_on_success: true })).value.status, 'PTC_YIELD_INVALID')
      const ordinary = await invoke({ boundary, yield_on_success: false })
      assert.equal(ordinary.value.status, 'ok'); assert.equal(!!ordinary.concludesTurn, false)
    }
    assert.equal((await invoke({ boundary: 'external_event', yield_on_success: 'true' })).isError, true)
    await assert.rejects(f.adapter.tool.execute({ program: 'return 1', description: 'missing', boundary: 'invalid' },
      { agent: a, signal: new AbortController().signal }), /boundary.*must be one of/)
    const w = f.agent('w', 'standard')
    f.ctx.tools.register(defineTool({ name:'glob', description:'glob', parameters:{}, output, execute(){return {name:'glob'}} }))
    const workerAdapter = createPtcAdapter(f.ctx, { resolveAssignment: agent => agent === w.a
      ? { role: 'worker', profile: WORKER_MUTATION_PROFILE } : null, workerContextOf: () => ({ worktree: process.cwd() }) })
    workerAdapter.refresh(w.a)
    assert.equal((await workerAdapter.tool.execute({ program: 'return 1', description: 'worker', boundary: 'external_event', yield_on_success: true },
      { agent: w.a, signal: new AbortController().signal })).status, 'PTC_YIELD_INVALID')
    await workerAdapter.dispose()
  } finally { await f.adapter.dispose() }
})

test('one program validates prepare and Worker acceptance, auto-concludes and records compact diagnostics', async () => {
  const f = fixture(process.cwd()), { a, events } = f.agent('auto-yield')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a)
  const order = []
  f.ctx.on('tools/execute', async (exec, next) => {
    const values = { postman_task_prepare: { status: 'TASK_CONTEXT_READY' },
      postman_worker: { status: 'POSTMAN_WORKER_TASK_ACCEPTED', workerSessionId: 'worker-1' } }
    if (exec.parent && values[exec.name]) { order.push(exec.name); return { isError: false, value: values[exec.name] } }
    return next()
  })
  try {
    const program = "const prep=ptc.expectStatus(await tools.postman_task_prepare({}), ['TASK_CONTEXT_READY']); const worker=ptc.expectStatus(await tools.postman_worker({}), ['POSTMAN_WORKER_TASK_ACCEPTED']); return {taskStatus:prep.status,workerSessionId:worker.workerSessionId}"
    const result = await f.ctx.tools.execute({ callId: 'auto-yield', name: 'ptc_execute', arguments: { program,
      description: 'Dispatch then wait for Worker report', boundary: 'external_event' }, agent: a, signal: new AbortController().signal })
    assert.equal(result.value.status, 'ok', JSON.stringify(result.value))
    assert.equal(result.concludesTurn, true)
    assert.deepEqual(order, ['postman_task_prepare', 'postman_worker'])
    const event = events.at(-1)
    assert.equal(event.type, 'postman/ptc-run')
    assert.deepEqual({ ...event.data, toolCounts: {...event.data.toolCounts}, durationMs: 0 }, { role: 'leader', description: 'Dispatch then wait for Worker report',
      boundary: 'external_event', status: 'ok', durationMs: 0, nestedToolCalls: 2,
      toolCounts: { postman_task_prepare: 1, postman_worker: 1 }, resultBytes: Buffer.byteLength(JSON.stringify(result.value.value)),
      yieldRequested: false, yieldApplied: true, underbatchedCandidate: false, oversizedResultCandidate: false })
    assert.ok(event.data.durationMs >= 0)
    assert.doesNotMatch(JSON.stringify(event), /program|arguments|content|taskText/)
  } finally { await f.adapter.dispose() }
})

test('error, caught failure, unawaited pending and unexpected status never auto-yield', async () => {
  const f = fixture(process.cwd()), { a, events } = f.agent('no-yield')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a)
  let release
  const held = new Promise(resolve => release = resolve)
  f.ctx.on('tools/execute', async (exec, next) => {
    if (exec.parent && exec.name === 'postman_task_prepare') return { isError: false, value: { status: 'NEW_UNKNOWN_STATUS' } }
    if (exec.parent && exec.name === 'postman_worker') return { isError: false, value: await held }
    if (exec.parent && exec.name === 'read') throw new Error('nested fixture failure')
    return next()
  })
  try {
    for (const program of ["throw Error('program failure')", "try { await tools.read({invalid:true}) } catch {} return 1",
      "ptc.expectStatus(await tools.postman_task_prepare({}), ['TASK_CONTEXT_READY']); return 1",
      "tools.postman_worker({}); return 1", "return {needsModelDecision:true, reason:'unexpected_status'}"]) {
      const result = await f.ctx.tools.execute({ callId: 'no-yield', name: 'ptc_execute', arguments: { program,
        description: 'Stop on unexpected evidence', boundary: 'external_event', yield_on_success: true }, agent: a, signal: new AbortController().signal })
      assert.equal(!!result.concludesTurn, false, program)
    }
    assert.ok(events.filter(event => event.type === 'postman/ptc-run').every(event => !event.data.yieldApplied))
  } finally { release({ status: 'POSTMAN_WORKER_TASK_ACCEPTED' }); await f.adapter.dispose() }
})

test('auto-yield fails closed on unsuccessful runtime statuses and incomplete or unknown effects', async () => {
  let terminal
  const runtime = { run: async ({bindings,signal}) => {
    await bindings.postman_worker({}, {signal,callId:'producer'})
    return terminal
  }, dispose: async () => {} }
  const f = fixture(process.cwd(), { runtime }), { a, events } = f.agent('effects')
  f.ctx.on('tools/execute', async (exec,next) => exec.parent && exec.name==='postman_worker'
    ? {isError:false,value:{status:'POSTMAN_WORKER_TASK_ACCEPTED'}} : next())
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a)
  try {
    for (terminal of [
      { status: 'limit-exceeded', error: { code: 'maxWallMs' } }, { status: 'cancelled' }, { status: 'unknown' },
      { status: 'ok', value: 1 },
      ...['running', 'queued', 'unknown', 'failed', 'not-started'].map(state => ({ status: 'ok', value: 1,
        effects: { calls: [{ name: 'read', state }], completed: 0, pending: state === 'running' ? 1 : 0, failed: state === 'failed' ? 1 : 0 } })),
      { status: 'ok', value: 1, cleanupError: {}, effects: { calls: [{name:'postman_worker',state:'completed'}], completed: 1, pending: 0, failed: 0 } },
      { status:'ok',value:{needsModelDecision:true},effects:{calls:[{name:'postman_worker',state:'completed'}],completed:1,pending:0,failed:0} },
    ]) {
      const result = await f.ctx.tools.execute({ callId: 'effects', name: 'ptc_execute', arguments: { program: 'return 1',
        description: 'Fail closed on uncertain effects', boundary: 'external_event', yield_on_success: true }, agent: a, signal: new AbortController().signal })
      assert.equal(!!result.concludesTurn, false)
      const event = events.at(-1).data
      assert.equal(event.yieldApplied, false)
      if (terminal.status === 'limit-exceeded') assert.equal(event.limitCode, 'maxWallMs')
    }
  } finally { await f.adapter.dispose() }
})


test('known stop refusal remains deterministic inside PTC and bookkeeping still completes', async () => {
  const f=fixture(process.cwd()), {a}=f.agent('known-refusal'), order=[]
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  f.ctx.on('tools/execute', async (exec,next)=>{
    if(exec.parent && exec.name==='postman_worker_stop') {order.push(exec.name);return {isError:false,value:{status:'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT'}}}
    if(exec.parent && exec.name==='todo_write') {order.push(exec.name);return {isError:false,value:{status:'ok'}}}
    return next()
  })
  try {
    const result=await f.execute(a,"const s=ptc.expectStatus(await tools.postman_worker_stop({}),['POSTMAN_WORKER_STOPPED','POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT']); const cleanupDeferred=s.status==='POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT'; await tools.todo_write({}); return {cleanupDeferred,status:'task_complete'}")
    assert.equal(result.value.status,'ok')
    assert.deepEqual(result.value.value,{cleanupDeferred:true,status:'task_complete'})
    assert.deepEqual(order,['postman_worker_stop','todo_write'])
  } finally {await f.adapter.dispose()}
})

test('oversized model-facing PTC result is diagnostic only, without result content', async () => {
  const f=fixture(process.cwd()), {a,events}=f.agent('large-result')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  try {
    const result=await f.execute(a,"return {privateResult:'SECRET_RESULT_'.repeat(6000)}")
    assert.equal(result.value.status,'ok')
    const diagnostic=events.findLast(e=>e.type==='postman/ptc-run').data
    assert.equal(diagnostic.oversizedResultCandidate,true)
    assert.ok(diagnostic.resultBytes>64*1024)
    assert.doesNotMatch(JSON.stringify(diagnostic),/SECRET_RESULT_|privateResult/)
  } finally {await f.adapter.dispose()}
})

test('ordinary JSON refused/unknown async acceptance is not concealed by auto-yield; one-tool runs remain allowed', async () => {
  const f = fixture(process.cwd()), { a, events } = f.agent('acceptance')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a)
  let status
  f.ctx.on('tools/execute', async (exec,next) => exec.parent && ['postman_worker','postman_worker_interrupt','postman_bridge','postman_task_prepare'].includes(exec.name)
    ? { isError:false,value:{status} } : next())
  try {
    for (const [name, statuses] of [
      ['postman_worker', ['POSTMAN_WORKER_BINDING_UNCERTAIN','POSTMAN_WORKER_DELIVERY_UNKNOWN','POSTMAN_WORKER_TASK_ACCEPTED_EXTRA','POSTMAN_WORKER_TASK_ACCEPTED']],
      ['postman_worker_interrupt', ['POSTMAN_WORKER_INTERRUPT_DELIVERY_FAILED','POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED_EXTRA','POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED']],
      ['postman_bridge', ['POSTMAN_BRIDGE_START_FAILED','POSTMAN_BRIDGE_OUTCOME_UNKNOWN','POSTMAN_BRIDGE_ACCEPTED']],
      ['postman_task_prepare', ['POSTMAN_TASK_CONTEXT_BUSY','NEW_PREPARE_STATUS','TASK_CONTEXT_READY']],
    ]) for (status of statuses) for (const yieldFlag of [undefined,false,true]) {
      const result = await f.ctx.tools.execute({ callId:'acceptance',name:'ptc_execute',agent:a,signal:new AbortController().signal,
        arguments:{program:'return await tools.'+name+'({})',description:'One dispatch is the external event boundary',boundary:'external_event',...(yieldFlag===undefined?{}:{yield_on_success:yieldFlag})} })
      assert.equal(result.value.status,'ok',JSON.stringify(result.value))
      assert.equal(!!result.concludesTurn,name !== 'postman_task_prepare' && status === statuses.at(-1), status)
      assert.equal(events.at(-1).data.underbatchedCandidate,true)
      assert.equal(events.at(-1).data.nestedToolCalls,1)
      assert.deepEqual({...events.at(-1).data.toolCounts},{[name]:1})
    }
  } finally { await f.adapter.dispose() }
})

