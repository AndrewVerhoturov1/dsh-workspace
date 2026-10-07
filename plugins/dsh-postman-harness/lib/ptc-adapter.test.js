import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { DEFAULT_LIMITS } from 'dsh-ptc'
import { createPtcAdapter, PILOT_PROFILE, WORKER_MUTATION_PROFILE, SOL_WORKER_PROFILE } from './ptc-adapter.js'
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
  ctx.tools.guard(exec => postmanPtcDirectCallGuard(exec, id => agents.get(id), agent => resolveAssignment?.(agent)?.role === 'sol'))
  if (real) {
    new LocalFileSystem(ctx,{cwd:dir,diffBasisMaxBytes:1048576})
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
    const events = [], sections = [], diagnostics = []
    ctx.logger.exporter({ export: message => {
      if (message.name === 'postman-ptc' && message.args[1]?.sessionId === id)
        diagnostics.push({ type: message.args[0], data: message.args[1] })
    } })
    const a = { id, status:'running', session:{events:[{type:'turn/start'}],header:{agentPreset:preset,delegationDepth:0,cwd:dir,...extra},append(type,data){events.push({type,data})}} }
    const agentCtx=createScope(ctx, a).ctx
    a.ctx=agentCtx
    presets.set(agentCtx,preset)
    agentCtx.systemPrompt.section = s=>{sections.push(s);return ()=>sections.splice(sections.indexOf(s),1)}
    agents.set(id,a)
    return {a,events,sections,diagnostics}
  }
  let n=0
  function execute(a,program,controller=new AbortController()) {
    return ctx.tools.execute({callId:'root-'+ ++n,name:'ptc_execute',arguments:{program,description:'Test one program',boundary:'semantic_decision'},agent:a,signal:controller.signal})
  }
  return {ctx,agents,traces,adapter,agent,execute}
}

test('Stage 3.5A real PTC: candidate streak, reset and conservative semantic exemption', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ptc-efficiency-'))
  const f = fixture(dir, {real:true}), {a,sections,diagnostics,events} = f.agent('efficiency')
  t.after(async () => {await f.adapter.dispose(); await rm(dir, {recursive:true,force:true})})
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a)
  await writeFile(join(dir,'a.txt'),'A'); await writeFile(join(dir,'b.txt'),'B')
  const small = "await tools.read({file_path:'a.txt'}); return {count:1}"
  for (const streak of [1,2]) {
    assert.equal((await f.execute(a,small)).value.status,'ok') // No hard rejection.
    const d = diagnostics.at(-1).data
    assert.equal(d.underbatchedCandidate,true); assert.equal(d.underbatchedStreak,streak)
    assert.equal(d.underbatchedReason,'small-semantic-phase'); assert.equal(d.nestedToolCalls,1)
    assert.equal(d.needsModelDecision,false); assert.equal(d.decisionQuestionPresent,false)
  }
  assert.match(sections[0].text({scope:a}), /PTC UNDERBATCH STREAK: 2/)
  const batch = "await tools.read({file_path:'a.txt'}); await tools.read({file_path:'b.txt'}); await tools.grep({pattern:'A',path:'a.txt'}); return {ready:true}"
  assert.equal((await f.execute(a,batch)).value.status,'ok')
  assert.equal(diagnostics.at(-1).data.nestedToolCalls,3)
  assert.equal(diagnostics.at(-1).data.underbatchedCandidate,false)
  assert.equal(diagnostics.at(-1).data.underbatchedStreak,0)
  assert.doesNotMatch(sections[0].text({scope:a}), /PTC EFFICIENCY NOTICE|PTC UNDERBATCH STREAK/)
  await f.execute(a,small)
  const unexpected = "const r=await tools.read({file_path:'a.txt'}); return {needsModelDecision:true,decisionQuestion:'Is this incompatible evidence safe to use? SECRET_QUESTION',evidence:{private:'SECRET_EVIDENCE'}}"
  assert.equal((await f.execute(a,unexpected)).value.status,'ok')
  const d = diagnostics.at(-1).data
  assert.equal(d.needsModelDecision,true); assert.equal(d.decisionQuestionPresent,true)
  assert.equal(d.underbatchedCandidate,false); assert.equal(d.underbatchedStreak,0)
  assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET_QUESTION|SECRET_EVIDENCE/)
  // Host deliberately cannot prove prose semantic correctness. Old compact
  // needsModelDecision results are conservatively exempt without a new protocol.
  await f.execute(a,"await tools.read({file_path:'a.txt'}); return {needsModelDecision:true,reason:'unexpected_status'}")
  assert.equal(diagnostics.at(-1).data.underbatchedCandidate,false)
  assert.equal(diagnostics.at(-1).data.decisionQuestionPresent,false)
  await f.execute(a,"await tools.read({file_path:'a.txt'}); await tools.read({file_path:'b.txt'}); return {ready:true}")
  assert.equal(diagnostics.at(-1).data.nestedToolCalls,2)
  assert.equal(diagnostics.at(-1).data.underbatchedCandidate,false)
  await f.execute(a,'return {empty:true}')
  assert.equal(diagnostics.at(-1).data.underbatchedCandidate,true)
  assert.equal(diagnostics.at(-1).data.nestedToolCalls,0)
  // Removal/re-assignment does not recover telemetry from durable events.
  f.adapter.remove(a); f.adapter.refresh(a)
  assert.doesNotMatch(sections[0].text({scope:a}), /PTC EFFICIENCY NOTICE|PTC UNDERBATCH STREAK/)
  assert.ok(events.every(e => e.type !== 'postman/ptc-run'))
})

test('Stage 3.5A failed, pending and aborted mechanics are not candidates', async t => {
  const f = fixture(process.cwd()), {a,diagnostics} = f.agent('efficiency-errors')
  f.adapter.refresh(a)
  const release = Promise.withResolvers()
  t.after(async () => {release.resolve({name:'read'}); await f.adapter.dispose()})
  f.ctx.on('tools/execute', async (exec,next) => exec.parent && exec.name === 'read' ?
    exec.arguments.held ? {isError:false,value:await release.promise} : Promise.reject(new Error('unexpected read failure')) : next())
  for (const program of ["try {await tools.read({})} catch {} return 1", 'tools.read({held:true}); return 1', "throw Error('failed phase')"]) {
    await f.execute(a,program)
    assert.equal(diagnostics.at(-1).data.underbatchedCandidate,false)
    assert.equal(diagnostics.at(-1).data.underbatchedStreak,0)
  }
  const controller = new AbortController(), entered = Promise.withResolvers()
  f.ctx.on('tools/pre-execute',async (exec,next)=>{if(exec.parent && exec.name==='read')entered.resolve();return next()})
  const pending = f.execute(a,'await tools.read({held:true}); return 1',controller)
  await entered.promise // Abort an actual run, not native pre-admission.
  controller.abort()
  const result = await pending
  assert.equal(result.isError,true) // Native ToolRuntime preserves cancellation as an outer error.
  assert.equal(diagnostics.at(-1).data.status,'cancelled')
  assert.equal(diagnostics.at(-1).data.underbatchedCandidate,false)
})

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
    assert.deepEqual(events.map(e=>e.type),[...Array.from({length:4},()=>['tool/code-dispatch-start','tool/code-dispatch']).flat()])
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
      const program="const many"+(language==='typescript'?': {file_path:string,text:string}[]':'')+" = await ptc.readMany({files:['first.txt','second.txt'],page_limit:2}); const firstText=many[0].text; const matches=await ptc.grepMany({queries:[{pattern:'alpha',path:'first.txt'},{pattern:'MARKER',path:'second.txt'}]}); return {first:firstText,many,matches:matches.map(x=>x.result.matches.length),names:Object.keys(ptc).sort()}"
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
    assert.equal(nested.length,10) // Each page is read once, then text is reused.
    assert.deepEqual(nested.slice(0,5).map(x=>x[1]),['read','read','read','grep','grep'])
    assert.ok(nested.every((x,i)=>x[3]===outer[Math.floor(i/5)][5]))
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
    const raw=await f.execute(a,"return await ptc.readAllText({file_path:'large.txt',page_limit:4})")
    assert.equal(raw.value.status,'ok')
    assert.equal(raw.value.value.length,48*1500+47)
    const reduced=await f.execute(a,"const text=await ptc.readAllText({file_path:'large.txt',page_limit:4}); return {chars:text.length,lines:text.split('\\n').length}")
    assert.equal(reduced.value.status,'ok',JSON.stringify(reduced.value))
    assert.deepEqual(reduced.value.value,{chars:48*1500+47,lines:48})
    await writeFile(join(dir,'long-line.txt'),'x'.repeat(2500),'utf8')
    const lineTruncated=await f.execute(a,"return await ptc.readAllText({file_path:'long-line.txt'})")
    assert.equal(lineTruncated.value.status,'ok',JSON.stringify(lineTruncated.value))
    assert.equal(lineTruncated.value.value,'x'.repeat(2500))
    await f.adapter.dispose()
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('full PTC reads survive display caps and long UTF-8 lines; denied reads never reach internal provider', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ptc-full-read-'))
  try {
    const long='кириллица😀'.repeat(70000) // Single line larger than one bridge frame.
    const marker='... (line truncated to 2000 chars)'
    const text=long+'\n'+Array.from({length:45},(_,i)=>'я'.repeat(1800)+i).join('\n')+'\n'+marker+'\n'
    await writeFile(join(dir,'large.txt'),text,'utf8')
    const f=fixture(dir,{real:true}),{a,events}=f.agent('full-read')
    a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
    const ordinary=await f.execute(a,"const r=await tools.read({file_path:'large.txt'});return {line:r.lines[0].text,lines:r.lines.length}")
    assert.equal(ordinary.value.status,'ok');assert.match(ordinary.value.value.line,/line truncated/)
    let streamed=0
    const stream=f.ctx.fs.streamText.bind(f.ctx.fs)
    f.ctx.fs.streamText=async (...args)=>{streamed++;return stream(...args)}
    const result=await f.execute(a,"const text=await ptc.readAllText({file_path:'large.txt',page_limit:2000});let checksum=0;for(let i=0;i<text.length;i++)checksum=(checksum*31+text.charCodeAt(i))>>>0;return {checksum,chars:text.length,bytes:ptc.utf8Bytes(text),lines:text.split('\\n').length,last:text.split('\\n').at(-1)}")
    assert.equal(result.value.status,'ok',JSON.stringify(result.value))
    const expected=text.slice(0,-1)
    let checksum=0;for(let i=0;i<expected.length;i++)checksum=(checksum*31+expected.charCodeAt(i))>>>0
    assert.deepEqual(result.value.value,{checksum,chars:expected.length,bytes:Buffer.byteLength(expected),lines:47,last:marker})
    assert.ok(result.value.effects.completed>1) // First page is shorter than requested, including a partial line.
    assert.equal(streamed,result.value.effects.completed)
    assert.ok(events.filter(x=>x.type==='tool/code-dispatch').every(x=>JSON.stringify(x.data.content).length<60000))
    assert.ok(events.some(x=>x.type==='tool/code-dispatch'&&JSON.stringify(x.data.content).includes('line truncated')))
    const limit=await f.execute(a,"return await ptc.readAllText({file_path:'large.txt',max_bytes:100})")
    assert.equal(limit.value.status,'runtime-error');assert.match(limit.value.error.message,/max_bytes.*incomplete/)
    const before=streamed
    const stop=f.ctx.tools.guard(exec=>exec.name==='read'?'FULL_READ_DENIED':undefined)
    const denied=await f.execute(a,"return await ptc.readAllText({file_path:'large.txt'})")
    assert.equal(denied.value.status,'runtime-error');assert.match(denied.value.error.message,/FULL_READ_DENIED/)
    assert.equal(denied.value.effects.failed,1);assert.equal(streamed,before)
    stop()
    const stopPost=f.ctx.on('tools/post-execute',async(exec,_result,next)=>exec.name==='read'?{kind:'block',feedback:[{type:'text',text:'POST_READ_DENIED'}]}:next())
    const post=await f.execute(a,"return await ptc.readAllText({file_path:'large.txt'})")
    assert.equal(post.value.status,'runtime-error');assert.match(post.value.error.message,/POST_READ_DENIED/)
    stopPost()
    const replace=f.ctx.on('tools/post-execute',async(exec,result,next)=>exec.name==='read'?
      {kind:'accept',value:{...result.value,lines:[]}}:next())
    const replaced=await f.execute(a,"return await ptc.readAllText({file_path:'large.txt'})")
    assert.equal(replaced.value.status,'runtime-error');assert.match(replaced.value.error.message,/replaced.*incomplete/)
    replace()
    for (const [source,expected] of [['я\r\n😀\r\n','я\n😀'],['one\n\n','one\n'],['','']]) {
      await writeFile(join(dir,'edge.txt'),source,'utf8')
      const edge=await f.execute(a,'return await ptc.readAllText('+JSON.stringify({file_path:'edge.txt',page_limit:1,max_bytes:Math.max(1,Buffer.byteLength(expected)),max_chars:Math.max(1,expected.length)})+')')
      assert.equal(edge.value.status,'ok',JSON.stringify(edge.value));assert.equal(edge.value.value,expected)
    }
    await f.adapter.dispose()
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('outer PTC keeps JSON helper/final diagnostics and completed tool effects', async()=>{
  const f=fixture(process.cwd()),{a}=f.agent('json-boundary')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  const bad="{files:[null,null,{testEvidence:undefined}],secret:'DO_NOT_PRINT'}"
  for (const [tail,status,code] of [['return '+bad,'invalid-output','invalid-output'],['return ptc.jsonBytes('+bad+')','runtime-error','runtime']]) {
    const result=await f.execute(a,'await tools.read({}); '+tail)
    assert.equal(result.isError,false);assert.equal(result.value.status,status)
    assert.equal(result.value.error.code,code)
    assert.equal(result.value.error.message,'value.files[2].testEvidence: undefined is not JSON-compatible.')
    assert.equal(result.value.effects.completed,1);assert.equal(result.value.effects.pending,0)
    assert.match(result.content[0].text,/value.files\[2\].testEvidence/)
    assert.doesNotMatch(result.content[0].text,/DO_NOT_PRINT/)
  }
  assert.equal(f.traces.filter(x=>x[0]==='pre'&&x[1]==='read').length,2)
  await f.adapter.dispose()
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

test('both Leader IDs execute; ordinary roles and replacement cannot',async()=>{
  const f=fixture(process.cwd()), pilot=f.agent('pilot'), production=f.agent('production','postman-leader'), standard=f.agent('standard','standard'),worker=f.agent('worker','postman-leader-ptc',{origin:'subagent',delegationDepth:1}),bridge=f.agent('bridge','postman-leader-ptc',{origin:'subagent',delegationDepth:0})
  for(const {a} of [pilot,production,standard,worker,bridge]){ a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a) }
  assert.equal((await f.execute(pilot.a,'return 7')).value.value,7)
  assert.equal((await f.execute(production.a,'return 7')).value.value,7)
  for(const {a} of [standard,worker,bridge]){
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
  assert.equal(events.at(-1).type,'tool/code-dispatch')
  assert.match(events.at(-1).data.content[0].text,/pending|unknown/)
  f.adapter.refresh(a)
  assert.equal((await f.execute(a,'return 14')).value.value,14)
  finish()
  await f.adapter.dispose()
})

test('PTC-first Leader direct tools fail closed for both preset IDs while UI exceptions stay direct', async () => {
  const f = fixture(process.cwd()), pilot = f.agent('ptc-first'), production = f.agent('direct', 'postman-leader')
  for (const {a} of [pilot, production]) { a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a)); f.adapter.refresh(a) }
  assert.deepEqual(PILOT_PROFILE.tools, POSTMAN_PTC_ONLY_LEADER_TOOLS)
  assert.equal(PILOT_PROFILE.id, 'postman-leader-supervisor')
  assert.equal(PILOT_PROFILE.revision, 9)
  assert.equal(PILOT_PROFILE.limits.maxWallMs, 300000)
  assert.equal(PILOT_PROFILE.limits.maxToolCalls, 256)
  assert.equal(PILOT_PROFILE.limits.quickjsMemoryBytes, 67108864)
  assert.equal(PILOT_PROFILE.limits.maxTotalBridgeBytes, 16777216)
  assert.equal(PILOT_PROFILE.limits.maxMessageBytes, 1048576)
  assert.equal(PILOT_PROFILE.limits.maxValueDepth, 32)
  assert.equal(PILOT_PROFILE.limits.maxValueNodes, 10000)
  assert.equal(PILOT_PROFILE.limits.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes)
  assert.equal(PILOT_PROFILE.limits.maxConcurrentToolCalls, 1)
  for (const name of ['ptc_execute', 'skill', 'ask_user_question', 'exit_plan_mode', 'read_image'])
    assert.equal(f.ctx.tools.schemas(pilot.a).some(s => s.name === name), true, name)
  for (const name of POSTMAN_PTC_ONLY_LEADER_TOOLS) {
    assert.equal(f.ctx.tools.schemas(pilot.a).some(s => s.name === name), true, name)
    const denied = await f.ctx.tools.execute({callId:'direct-'+name,name,arguments:{},agent:pilot.a,signal:new AbortController().signal})
    assert.equal(denied.isError, true, name)
    assert.match(denied.error.message, /POSTMAN_PTC_DIRECT_CALL_REJECTED.*ptc_execute/, name)
    const allowed = await f.ctx.tools.execute({callId:'production-'+name,name,arguments:{},agent:production.a,signal:new AbortController().signal})
    assert.equal(allowed.isError, true, name)
    assert.match(allowed.error.message, /POSTMAN_PTC_DIRECT_CALL_REJECTED/, name)
  }
  for (const name of ['skill', 'ask_user_question', 'exit_plan_mode', 'read_image']) {
    const direct = await f.ctx.tools.execute({callId:'exception-'+name,name,arguments:{},agent:pilot.a,signal:new AbortController().signal})
    assert.equal(direct.isError, false, name)
  }
  assert.equal(f.ctx.tools.schemas(production.a).some(s=>s.name==='ptc_execute'),true)
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

test('canonical discipline follows exact Leader PTC assignment; Worker assignment rejected', async () => {
  const f=fixture(process.cwd(),{resolveAssignment:(a,p)=>isTopLevelPostmanPtcLeader(a)?{profile:p,role:'leader'}:{profile:WORKER_MUTATION_PROFILE,role:'worker'}})
  try {
    const pilot=f.agent('discipline');f.adapter.refresh(pilot.a)
    const worker=f.agent('worker','standard')
    f.adapter.refresh(pilot.a);assert.equal(f.adapter.refresh(worker.a),false)
    assert.ok(pilot.sections[0].text({scope:pilot.a}).includes(POSTMAN_PTC_DISCIPLINE))
    const hide=pilot.a.ctx.tools.restrict({deny:['ptc_execute']});assert.equal(pilot.sections[0].text({scope:pilot.a}),'');hide()
    assert.equal(worker.sections.length,0)
    assert.equal((await f.execute(worker.a,'return 1')).value.status,'PTC_CALLER_REJECTED')
  } finally {await f.adapter.dispose()}
})

test('boundary required and yield_on_success is exact boolean, external_event', async () => {
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
      { agent: w.a, signal: new AbortController().signal })).status, 'PTC_CALLER_REJECTED')
    await workerAdapter.dispose()
  } finally { await f.adapter.dispose() }
})

test('one program validates prepare and Worker acceptance, auto-concludes and records compact diagnostics', async () => {
  const f = fixture(process.cwd()), { a, events, diagnostics } = f.agent('auto-yield')
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
    assert.equal(events.some(e => e.type === 'postman/ptc-run'), false)
    const event = diagnostics.at(-1)
    assert.equal(event.type, 'postman/ptc-run')
    assert.deepEqual({ ...event.data, toolCounts: {...event.data.toolCounts}, durationMs: 0 }, { sessionId: a.id, role: 'leader', description: 'Dispatch then wait for Worker report',
      boundary: 'external_event', status: 'ok', durationMs: 0, nestedToolCalls: 2,
      toolCounts: { postman_task_prepare: 1, postman_worker: 1 }, resultBytes: Buffer.byteLength(JSON.stringify(result.value.value)),
      yieldRequested: false, yieldApplied: true, smallSemanticPhase: false, thinSemanticPhase: false, underbatchedCandidate: false,
      underbatchedReason: null, underbatchedStreak: 0, oversizedResultCandidate: false })
    assert.ok(event.data.durationMs >= 0)
    assert.doesNotMatch(JSON.stringify(event), /program|arguments|content|taskText/)
  } finally { await f.adapter.dispose() }
})

test('error, caught failure, unawaited pending and unexpected status never auto-yield', async () => {
  const f = fixture(process.cwd()), { a, diagnostics } = f.agent('no-yield')
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
    assert.ok(diagnostics.length > 0)
    assert.ok(diagnostics.every(event => !event.data.yieldApplied))
  } finally { release({ status: 'POSTMAN_WORKER_TASK_ACCEPTED' }); await f.adapter.dispose() }
})

test('auto-yield fails closed on unsuccessful runtime statuses and incomplete or unknown effects', async () => {
  let terminal
  const runtime = { run: async ({bindings,signal}) => {
    await bindings.postman_worker({}, {signal,callId:'producer'})
    return terminal
  }, dispose: async () => {} }
  const f = fixture(process.cwd(), { runtime }), { a, diagnostics } = f.agent('effects')
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
      const event = diagnostics.at(-1).data
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

test('oversized model-facing PTC result is stopped before presentation, diagnostic excludes content', async () => {
  const f=fixture(process.cwd()), {a,diagnostics}=f.agent('large-result')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  try {
    const result=await f.execute(a,"return {privateResult:'SECRET_RESULT_'.repeat(45000)}")
    assert.equal(result.value.status,'limit-exceeded')
    assert.equal(result.value.error.code,'maxOutputBytes')
    assert.ok(Buffer.byteLength(JSON.stringify(result.value))<2048)
    const diagnostic=diagnostics.findLast(e=>e.type==='postman/ptc-run').data
    assert.equal(diagnostic.oversizedResultCandidate,true)
    assert.equal(diagnostic.resultBytes,0)
    assert.equal(diagnostic.limitCode,'maxOutputBytes')
    assert.doesNotMatch(JSON.stringify(diagnostic),/SECRET_RESULT_|privateResult/)
  } finally {await f.adapter.dispose()}
})

test('ordinary JSON refused/unknown async acceptance is not concealed by auto-yield; one-tool runs remain allowed', async () => {
  const f = fixture(process.cwd()), { a, diagnostics } = f.agent('acceptance')
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
      assert.equal(diagnostics.at(-1).data.underbatchedCandidate,false)
      assert.equal(diagnostics.at(-1).data.nestedToolCalls,1)
      assert.deepEqual({...diagnostics.at(-1).data.toolCounts},{[name]:1})
    }
  } finally { await f.adapter.dispose() }
})


test('long description is cosmetic: normalize, execute once, keep real program errors', async () => {
  const f=fixture(process.cwd()), {a,diagnostics}=f.agent('description')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  const invoke=(program,description)=>f.ctx.tools.execute({callId:'long',name:'ptc_execute',agent:a,signal:new AbortController().signal,
    arguments:{program,description,boundary:'semantic_decision'}})
  try {
    const long='  Читаем данные\n   и обрабатываем 😀 '.repeat(100)
    const result=await invoke('await tools.read({}); return {ok:true}',long)
    assert.equal(result.value.status,'ok')
    assert.equal(result.value.effects.completed,1)
    assert.equal(diagnostics.at(-1).data.descriptionNormalized,true)
    assert.ok(Array.from(diagnostics.at(-1).data.description).length<=160)
    assert.doesNotMatch(diagnostics.at(-1).data.description,/\s{2,}/)
    assert.equal((await invoke('throw Error("real failure")',long)).value.status,'runtime-error')
    assert.equal((await invoke('return 1','  ')).value.status,'PTC_DESCRIPTION_INVALID')
  } finally {await f.adapter.dispose()}
})

test('Host-maintained exact statuses avoid model-authored interrupt aliases', async () => {
  const f=fixture(process.cwd()), {a}=f.agent('status-table')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  const statuses={postman_worker:'POSTMAN_WORKER_TASK_ACCEPTED',postman_worker_interrupt:'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED',postman_bridge:'POSTMAN_BRIDGE_ACCEPTED'}
  let unknown=false
  f.ctx.on('tools/execute',async (exec,next)=>exec.parent && statuses[exec.name]?
    {isError:false,value:{status:unknown?'NEW_STATUS':statuses[exec.name]}}:next())
  try {
    for (const name of Object.keys(statuses)) {
      const args={program:'return ptc.expectStatus(await tools.'+name+'({}),'+JSON.stringify(name)+')',description:'Accept exact producer',boundary:'external_event'}
      const invoke=()=>f.ctx.tools.execute({callId:name,name:'ptc_execute',arguments:args,agent:a,signal:new AbortController().signal})
      const accepted=await invoke()
      assert.equal(accepted.value.status,'ok');assert.equal(accepted.concludesTurn,true)
      unknown=true
      const rejected=await invoke()
      assert.equal(rejected.value.status,'runtime-error');assert.match(rejected.value.error.message,/unexpected status: NEW_STATUS/)
      assert.equal(!!rejected.concludesTurn,false)
      unknown=false
    }
  } finally {await f.adapter.dispose()}
})

test('auto-conclude correlates exact completed effect identities, not just counters', async () => {
  let calls
  const runtime={run:async({bindings,signal})=>{await bindings.postman_bridge({}, {signal,callId:1});return {status:'ok',value:{},effects:{calls,completed:1,failed:0,pending:0}}},dispose:async()=>{}}
  const f=fixture(process.cwd(),{runtime}), {a,diagnostics}=f.agent('correlation')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  f.ctx.on('tools/execute',async(exec,next)=>exec.parent && exec.name==='postman_bridge'?{isError:false,value:{status:'POSTMAN_BRIDGE_ACCEPTED',state:'QUEUED'}}:next())
  try {
    for (calls of [[{callId:2,name:'postman_bridge',state:'completed'}],[{callId:1,name:'postman_worker',state:'completed'}],[{callId:1,name:'postman_bridge',state:'completed'}]]) {
      const result=await f.ctx.tools.execute({callId:'correlate',name:'ptc_execute',arguments:{program:'return {}',description:'Wait on confirmed effects',boundary:'external_event'},agent:a,signal:new AbortController().signal})
      const accepted=calls[0].callId===1 && calls[0].name==='postman_bridge'
      assert.equal(!!result.concludesTurn,accepted)
      assert.equal(diagnostics.at(-1).data.yieldBlockedReason,accepted?undefined:'effects-not-confirmed')
    }
  } finally {await f.adapter.dispose()}
})

test('nested conclude marker never conceals a later PTC error or model decision', async () => {
  const f=fixture(process.cwd()), {a}=f.agent('early-marker')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  a.ctx.tools.register(defineTool({name:'get_goal',description:'marker fixture',parameters:{},output,execute(_args,exec){exec.concludeTurn();return {goal:null}}}))
  try {
    for (const code of ['throw Error("later")','return {needsModelDecision:true}']) {
      const result=await f.execute(a,'await tools.get_goal({}); '+code)
      assert.equal(!!result.concludesTurn,false)
    }
    const success=await f.execute(a,'await tools.get_goal({}); return {ok:true}')
    assert.equal(success.concludesTurn,true)
  } finally {await f.adapter.dispose()}
})

test('Leader inherits standard output limits; needed larger JSON and separate logs succeed', async () => {
  for (const role of ['leader']) {
    const f=fixture(process.cwd(), {
      resolveAssignment: (_agent,leaderProfile)=>({profile:role==='leader'?leaderProfile:WORKER_MUTATION_PROFILE,role}),
      workerContextOf: ()=>({worktree:process.cwd()}),
    }), {a}=f.agent('standard-output-'+role)
    f.ctx.tools.register(defineTool({name:'glob',description:'glob fixture',parameters:{},output,execute(){return {paths:[]}}}))
    f.adapter.refresh(a)
    try {
      assert.equal(PILOT_PROFILE.limits.maxOutputBytes,DEFAULT_LIMITS.maxOutputBytes)
      assert.equal(WORKER_MUTATION_PROFILE.limits.maxOutputBytes,DEFAULT_LIMITS.maxOutputBytes)
      for (const kib of [20,40,50,150]) {
        const result=await f.execute(a,"return {nested:[{data:'я'.repeat("+(kib*512)+")}]}")
        assert.equal(result.value.status,'ok',JSON.stringify({role,kib,status:result.value.status,error:result.value.error}))
        assert.equal(Buffer.byteLength(result.value.value.nested[0].data),kib*1024)
      }
      const both=await f.execute(a,"console.log('x'.repeat(300*1024));return 'y'.repeat(300*1024)")
      assert.equal(both.value.status,'ok') // Combined size exceeds 512 KiB; budgets remain separate.
      assert.equal(JSON.parse(both.value.logs[0]).length,300*1024)
      assert.equal(both.value.value.length,300*1024)
      for (const program of ["return {nested:[{raw:'x'.repeat(512*1024)}]}","console.log('x'.repeat(512*1024));return null"]) {
        const result=await f.execute(a,program)
        assert.equal(result.value.status,'limit-exceeded')
        assert.equal(result.value.error.code,'maxOutputBytes')
      }
    } finally {await f.adapter.dispose()}
  }
})


test('compact payload remains below 50 KiB even at the Leader nested-call ceiling', async () => {
  const f=fixture(process.cwd()), {a}=f.agent('envelope')
  a.ctx.tools.restrict(postmanBridgeRestrictionForAgent(a));f.adapter.refresh(a)
  try {
    const result=await f.execute(a,"for(let i=0;i<256;i++) await tools.postman_worker_interrupt({}); return {evidence:'x'.repeat(32740)}")
    assert.equal(result.value.status,'ok',JSON.stringify(result.value))
    assert.equal(result.value.effects.completed,256)
    assert.ok(Buffer.byteLength(JSON.stringify(result.value))<50*1024)
    assert.ok(Buffer.byteLength(result.content[0].text)<50*1024)
  } finally {await f.adapter.dispose()}
})


const solFixture = (runtime) => {
  const context={worktree:process.cwd()}
  const f=fixture(process.cwd(),{runtime,workerContextOf:()=>context,
    resolveAssignment:a=>a.id==='sol-gate'?{role:'sol',profile:SOL_WORKER_PROFILE}:null})
  f.ctx.tools.register(defineTool({name:'glob',description:'glob',parameters:{},output,execute:()=>({paths:[]})}))
  const {a,diagnostics}=f.agent('sol-gate','standard',{origin:'subagent',parentSession:'leader',delegationDepth:1})
  f.adapter.refresh(a)
  const invoke=(program,controller=new AbortController(),boundary='external_event')=>f.ctx.tools.execute({
    agent:a,name:'ptc_execute',arguments:{program,description:'Prove exact owned producer safety before event boundary',boundary},
    callId:'sol-'+Math.random(),signal:controller.signal})
  return {...f,a,diagnostics,invoke}
}

test('Stage 3.5B exact Sol uses only accepted owned event producers; direct controls rejected',async t=>{
  const f=solFixture();t.after(()=>f.adapter.dispose())
  let status
  f.ctx.on('tools/execute',async(exec,next)=>exec.parent&&exec.name.startsWith('postman_worker')?{isError:false,value:{status}}:next())
  for(const name of ['postman_worker','postman_worker_interrupt','postman_worker_list','postman_worker_stop','postman_worker_compact','postman_worker_fresh']){
    const direct=await f.ctx.tools.execute({agent:f.a,name,arguments:{},callId:'direct',signal:new AbortController().signal})
    assert.equal(direct.isError,true);assert.match(direct.error.message,/PTC_DIRECT_CALL_REJECTED/)
  }
  for(const [name,accepted] of [['postman_worker','POSTMAN_WORKER_TASK_ACCEPTED'],['postman_worker_interrupt','POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED'],['postman_worker_fresh','POSTMAN_WORKER_TASK_ACCEPTED']]){
    for(status of ['POSTMAN_WORKER_BINDING_UNCERTAIN','POSTMAN_WORKER_DELIVERY_UNKNOWN',accepted+'_UNKNOWN',accepted]){
      const r=await f.invoke('return await tools.'+name+'({})')
      assert.equal(r.value.status,'ok');assert.equal(r.concludesTurn===true,status===accepted)
      const d=f.diagnostics.at(-1).data;assert.equal(d.smallSemanticPhase,false);assert.equal(d.thinSemanticPhase,false)
    }
  }
  for(const [name,accepted] of [['postman_worker_list','POSTMAN_WORKER_LIST'],['postman_worker_stop','POSTMAN_WORKER_STOPPED'],['postman_worker_compact','POSTMAN_WORKER_COMPACTED']]){
    status=accepted;const r=await f.invoke('return await tools.'+name+'({})');assert.equal(r.value.status,'ok');assert.equal(!!r.concludesTurn,false)
    assert.equal(f.diagnostics.at(-1).data.yieldBlockedReason,'no-accepted-producer')
  }
  assert.equal(!!(await f.invoke('return await tools.read({file_path:"known"})')).concludesTurn,false)
  status='POSTMAN_WORKER_TASK_ACCEPTED'
  const decision=await f.invoke('await tools.postman_worker({});return {needsModelDecision:true,decisionQuestion:"real choice"}')
  assert.equal(!!decision.concludesTurn,false);assert.equal(f.diagnostics.at(-1).data.yieldBlockedReason,'model-decision-requested')
})

test('Stage 3.5B exact Sol fails closed on correlated effects/cleanup/runtime errors',async t=>{
  let terminal
  const runtime={run:async({bindings,signal})=>{await bindings.postman_worker({}, {signal,callId:'producer'});return terminal},dispose:async()=>{}}
  const f=solFixture(runtime);t.after(()=>f.adapter.dispose())
  f.ctx.on('tools/execute',async(exec,next)=>exec.parent&&exec.name==='postman_worker'?{isError:false,value:{status:'POSTMAN_WORKER_TASK_ACCEPTED'}}:next())
  const effect={name:'postman_worker',callId:'producer',state:'completed'}
  const safe={status:'ok',value:{},effects:{calls:[effect],completed:1,pending:0,failed:0}}
  for(terminal of [
    {status:'cancelled'},{status:'runtime-error'},{status:'unknown'},
    {...safe,cleanupError:{}},{...safe,effects:undefined},
    ...['pending','unknown','failed','not-started'].map(state=>({...safe,effects:{calls:[{...effect,state}],completed:0,pending:state==='pending'?1:0,failed:state==='failed'?1:0}})),
    {...safe,effects:{...safe.effects,calls:[{...effect,name:'read'}]}},
    {...safe,effects:{...safe.effects,calls:[{...effect,callId:'foreign'}]}},
    {...safe,effects:{...safe.effects,calls:[effect,effect],completed:2}},
  ]){
    const r=await f.invoke('ignored');assert.equal(!!r.concludesTurn,false,JSON.stringify(terminal));assert.equal(f.diagnostics.at(-1).data.smallSemanticPhase,false)
  }
  terminal=safe;assert.equal((await f.invoke('ignored')).concludesTurn,true)
})

test('Stage 3.5B Sol actual nested failure/pending/abort/revocation never auto-concludes',{timeout:20000},async t=>{
  const f=solFixture(),held=Promise.withResolvers();t.after(async()=>{held.resolve();await f.adapter.dispose()})
  f.ctx.on('tools/execute',async(exec,next)=>{
    if(!exec.parent)return next()
    if(exec.name==='postman_worker')return {isError:false,value:{status:'POSTMAN_WORKER_TASK_ACCEPTED'}}
    if(exec.name==='read'){
      if(exec.arguments.held){await held.promise;return {isError:false,value:{}}}
      throw Error('actual nested failure')
    }
    return next()
  })
  for(const program of ['await tools.postman_worker({});try{await tools.read({})}catch{}return {}',
    'await tools.postman_worker({});tools.read({file_path:"held.txt",held:true});return {}']){
    const r=await f.invoke(program);assert.equal(!!r.concludesTurn,false);assert.equal(f.diagnostics.at(-1).data.yieldApplied,false)
  }
  for(const revoke of [false,true]){
    const gate=Promise.withResolvers(),controller=new AbortController()
    const stop=f.ctx.on('tools/pre-execute',async(exec,next)=>{if(exec.parent&&exec.name==='read')gate.resolve();return next()})
    const pending=f.invoke('await tools.postman_worker({});await tools.read({file_path:"held.txt",held:true});return {}',controller)
    await gate.promise
    if(revoke)f.adapter.remove(f.a);else controller.abort()
    const r=await pending;assert.equal(!!r.concludesTurn,false);assert.equal(f.diagnostics.at(-1).data.yieldApplied,false)
    stop()
  }
})

