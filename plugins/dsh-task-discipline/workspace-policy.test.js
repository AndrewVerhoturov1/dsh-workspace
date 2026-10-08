import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn as processSpawn } from 'node:child_process'
import { apply as policy } from './workspace-policy.js'
import { apply as discipline, TASK_DISCIPLINE } from './index.js'

// Installed production SDK/loop, real FS, instructions, skill provider, presets,
// Jsonl continuation and compactor. Only model output/tool effects are inert.
// No live LLM, Postman transport, hired agent, or user workspace mutations.
const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA,'npm/node_modules/@deepseek-ai/dsh')
const modulePath = name => join(installed,'node_modules/@deepseek-ai',name,'lib/index.js')
const pkg = name => import(pathToFileURL(modulePath(name)).href)
const { Context } = await pkg('cordis')
const { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session')
const { SessionProjectionRegistry } = await pkg('dsh-session-projection')
const { JsonlSessionPersistence } = await pkg('dsh-session-persistence-jsonl')
const { SystemPrompt } = await pkg('dsh-system-prompt')
const { ToolRuntime, defineTool } = await pkg('dsh-tools')
const { LlmRuntime, LlmAdapter, createUserMessage } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop')
const { SubagentRuntime } = await pkg('dsh-subagent')
const { apply: spawn } = await pkg('dsh-subagent-spawn-in-process')
const { LocalFileSystem } = await pkg('dsh-fs-local')
const { SkillRegistry } = await pkg('dsh-skill')
const { apply: instructions } = await pkg('dsh-agent-instructions')
const { apply: skills } = await pkg('dsh-skill-filesystem')
const { default: Loader } = await pkg('cordis-plugin-loader')
const { AgentPresets } = await pkg('dsh-agent-presets')
const { TokenMeter } = await pkg('dsh-token-meter')
const { BasicCompactionEngine } = await pkg('dsh-compaction-basic')
const repo = resolve(fileURLToPath(new URL('../..',import.meta.url)))
const signal = () => new AbortController().signal
const input = text => createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})
const body = request => request.messages.map(m=>JSON.stringify(m.content)).join('\n')
const latest = (ctx, agent) => agent.session.deriveMessages().findLast(m=>m.source?.plugin==='@deepseek-ai/dsh-system-prompt')?.source.sections ?? []

async function fixture(dir) {
  for (const path of ['.git','docs/workflow','docs/subprojects/postman','docs/subprojects/ptc','plugins/dsh-ptc','.agents/skills/postman-leader','nested','sibling','home']) await mkdir(join(dir,path),{recursive:true})
  for (const path of ['AGENTS.md','REPO_POLICY.md','docs/workflow/TASK_CONTRACT.md','docs/subprojects/postman/SUBPROJECT.md','docs/subprojects/ptc/SUBPROJECT.md','.agents/skills/postman-leader/SKILL.md']) await copyFile(join(repo,path),join(dir,path))
  await writeFile(join(dir,'nested/AGENTS.md'),'NESTED_ONLY: applies only under nested/')
  await writeFile(join(dir,'sibling/AGENTS.md'),'SIBLING_ONLY: applies only under sibling/')
  await writeFile(join(dir,'nested/a.txt'),'a'); await writeFile(join(dir,'plugins/dsh-ptc/a.txt'),'a')
}
async function runtime(dir, observe = () => {}) {
  const ctx = new Context(), requests = [], effects = []
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx,{}); new ToolRuntime(ctx); new LlmRuntime(ctx)
  const persistence = new JsonlSessionPersistence(ctx,{root:join(dir,'sessions'),compression:'none'})
  new LocalFileSystem(ctx,{cwd:dir,diffBasisMaxBytes:1048576}); new SkillRegistry(ctx)
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
  new SubagentRuntime(ctx); spawn(ctx,{providerName:'spawn'})
  new TokenMeter(ctx)
  const compactor = new BasicCompactionEngine(ctx,{auto:false})
  compactor.summarize = async () => ({summary:'Task checkpoint.',provider:'fixture',model:'inert'})
  discipline(ctx); policy(ctx)
  skills(ctx,{includeDefaultRoots:true,dshHome:join(dir,'home'),watch:false})
  await ctx.plugin(Loader,{baseUrl:pathToFileURL(join(installed,'lib/bin.js')).href})
  const presetDir = join(dir,'presets/postman-leader')
  await mkdir(presetDir,{recursive:true})
  await writeFile(join(presetDir,'agent.cordis.yml'),JSON.stringify([
    {id:'persona',name:pathToFileURL(modulePath('dsh-persona')).href,config:{text:'Shared composition marker {{cwd}}'}},
    {id:'instructions',name:pathToFileURL(modulePath('dsh-agent-instructions')).href,config:{dshHome:join(dir,'home'),maxBytes:65536}},
  ]))
  new AgentPresets(ctx,{default:'postman-leader',includeUserRoot:false,roots:[{path:join(dir,'presets'),trust:'system'}]})
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx,'postman-leader') }
  const output = {schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}
  for (const name of ['read','write','pwsh']) ctx.tools.register(defineTool({name,description:'Inert '+name,parameters:{file_path:{type:'string'},content:{type:'string'},workdir:{type:'string'}},output,execute:(args,exec)=>{effects.push({name,args,agent:exec.agent.id});return {ok:true}}}))
  class Model extends LlmAdapter {
    async resolveModel(provider,id) { return {provider,id,name:id,inputModalities:['text'],contextWindow:1000000} }
    async *stream(request) {
      const agent = ctx.agents.currentInitiator()
      assert.equal(request.system.split(TASK_DISCIPLINE).length-1,1)
      requests.push({agent,request})
      const block = await observe({ctx,agent,request,requests,effects}) ?? {type:'text',text:'done'}
      yield {type:'block-end',index:0,block}; yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['fixture'],new Model())
  const create = async id => (await ctx.agents.create({setup,sessionId:id,meta:{cwd:dir,agentPreset:'postman-leader'},agentOptions:{provider:'fixture',model:'inert'}})).agent
  return {ctx,requests,effects,setup,create,persistence,compactor}
}

async function phase(dir, resumed) {
  const r = await runtime(dir)
  const {ctx,requests,setup,create,persistence,compactor} = r
  try {
    const leader = resumed ? (await ctx.agents.resume({setup,resumeSessionId:'leader',agentOptions:{provider:'fixture',model:'inert'}})).agent : await create('leader')
    leader.followup(input('Bounded fixture task')); await leader.whenIdle()
    if (!resumed) {
      const result = await ctx.tools.execute({callId:'project-touch',name:'read',arguments:{file_path:'plugins/dsh-ptc/a.txt'},agent:leader,signal:signal()})
      assert.equal(result.isError,false,'expected managed Leader subproject delivered before first read')
    }
    const projectText = await readFile(join(dir,'docs/subprojects/ptc/SUBPROJECT.md'),'utf8')
    assert.ok(latest(ctx,leader).some(s=>s.text.endsWith(projectText)),'subproject hints survive separate process')
    const first = requests.at(-1).request
    assert.ok(body(first).includes('Общие правила агента'))
    assert.ok(body(first).includes('POSTMAN_LEADER_SKILL_VERSION: 31'))
    for (const path of ['REPO_POLICY.md','docs/workflow/TASK_CONTRACT.md']) {
      const text = await readFile(join(dir,path),'utf8')
      assert.ok(latest(ctx,leader).some(s=>s.text.endsWith(text)))
    }
    const ended = Promise.withResolvers()
    ctx.on('session/event',(session,event)=>{if(session.id==='worker'&&event.type==='turn/end') event.data.reason.kind==='error'?ended.reject(Error(JSON.stringify(event.data))):ended.resolve()})
    if (!resumed) await ctx.subagents.startContinuable({provider:'spawn',label:'fixture Worker',childId:'worker',signal:signal(),request:{parent:leader,prompt:[{type:'text',text:'Bounded Worker task'}],signal:signal(),agentOptions:{provider:'fixture',model:'inert'},persona:'Worker persona',maxDepth:2}})
    else { assert.equal(ctx.agents.get('worker'),undefined); await ctx.subagents.followup(leader,'worker',[{type:'text',text:'Resume exact child'}],{source:{kind:'user'},signal:signal()}) }
    await ended.promise
    const request = requests.findLast(row=>row.agent.id==='worker')
    assert.equal(request.agent.session.header.cwd,dir)
    assert.equal(request.agent.session.header.agentPreset,'postman-leader')
    assert.equal(ctx.agentPresets.composedPreset(request.agent.ctx),'postman-leader')
    assert.match(request.request.system,/Worker persona/)
    assert.ok(!body(request.request).includes('POSTMAN_LEADER_SKILL_VERSION: 31'),'Leader role does not leak into child')
    assert.ok(body(request.request).includes('Общие правила агента'))
    for (const path of ['REPO_POLICY.md','docs/workflow/TASK_CONTRACT.md']) {
      const text = await readFile(join(dir,path),'utf8')
      assert.ok(latest(ctx,request.agent).some(s=>s.text.endsWith(text)))
    }
    if (!resumed) {
      const generation = leader.session.surface.replaceGeneration
      assert.ok(await compactor.compactNow(leader,signal()))
      assert.ok(leader.session.surface.replaceGeneration>generation)
      assert.ok(!body({messages:leader.session.deriveMessages()}).includes('POSTMAN_LEADER_SKILL_VERSION: 31'))
      leader.followup(input('Continue after native compaction')); await leader.whenIdle()
      assert.ok(body(requests.at(-1).request).includes('POSTMAN_LEADER_SKILL_VERSION: 31'))
      assert.ok(body(requests.at(-1).request).includes('Общие правила агента'))
      assert.ok(latest(ctx,leader).some(s=>s.text.endsWith(projectText)),'subproject context restored after real compaction')
    }
    await ctx.sessions.flush(leader.session)
    console.log(JSON.stringify({phase:resumed?'resumed':'fresh',pid:process.pid,leader:true,worker:true,inheritedPreset:true,modelFacing:true,nativeCompaction:!resumed}))
  } finally { await ctx.fiber.dispose() }
}

if (process.env.DSH_POLICY_PHASE) await phase(process.env.DSH_POLICY_DIR,process.env.DSH_POLICY_PHASE==='resumed')
else {
  test('actual model requests: Leader -> continuable Worker -> native compaction -> cold resume in a second process',{timeout:60000},async t=>{
    const dir = await mkdtemp(join(tmpdir(),'dsh-policy-roundtrip-')); await fixture(dir)
    t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
    for (const phase of ['fresh','resumed']) await new Promise((resolve,reject)=>{
      const child = processSpawn(process.execPath,[fileURLToPath(import.meta.url)],{stdio:'inherit',env:{...process.env,DSH_POLICY_PHASE:phase,DSH_POLICY_DIR:dir}})
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(phase+' exited '+code)))
    })
  })
  test('before-action delivery, scoped subproject, nested AGENTS and fail-closed sources',{timeout:20000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-boundary-'));await fixture(dir)
    const r=await runtime(dir);const {ctx,requests,effects,create}=r
    t.after(async()=>{await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
    const agent=await create('leader')
    agent.followup(input('Small task'));await agent.whenIdle()
    assert.ok(body(requests.at(-1).request).includes('Current focus'),'known supervisor subprojects proactively delivered')
    // New/unexpected subprojects remain first-touch fail-closed.
    await mkdir(join(dir,'docs/subprojects/agents-nods-by-andrew'),{recursive:true})
    await mkdir(join(dir,'plugins/dsh-nodes-agent-by-andrew'),{recursive:true})
    await writeFile(join(dir,'docs/subprojects/agents-nods-by-andrew/SUBPROJECT.md'),'UNKNOWN_PROJECT_CONTEXT')
    const execute = (name,args) => ctx.tools.execute({callId:'fixture-'+effects.length,name,arguments:args,agent,signal:signal()})
    // Even another middleware forcing allow cannot override the monotonic gate.
    ctx.on('tools/pre-execute',async (_exec,next)=>{await next();return {kind:'allow'}})
    const denied = await execute('write',{file_path:'plugins/dsh-nodes-agent-by-andrew/a.txt',content:'b'})
    assert.equal(denied.isError,true);assert.match(denied.error.message,/WORKSPACE_POLICY_REQUIRED/);assert.equal(effects.length,0)
    agent.followup(input('Deliver Host context'));await agent.whenIdle()
    const subproject = await readFile(join(dir,'docs/subprojects/ptc/SUBPROJECT.md'),'utf8')
    assert.ok(latest(ctx,agent).some(s=>s.text.endsWith(subproject)))
    assert.equal((await execute('write',{file_path:'plugins/dsh-nodes-agent-by-andrew/a.txt',content:'b'})).isError,false)
    assert.equal(effects.length,1)
    await writeFile(join(dir,'docs/subprojects/ptc/SUBPROJECT.md'),'Fresh PTC instructions')
    assert.equal((await execute('read',{file_path:'plugins/dsh-ptc/a.txt'})).isError,true,'known project freshness still fail-closed')
    agent.followup(input('Deliver fresh project instructions'));await agent.whenIdle()
    assert.ok(body(requests.at(-1).request).includes('Fresh PTC instructions'))
    assert.equal((await execute('read',{file_path:'nested/a.txt'})).isError,false)
    agent.followup(input('Next nested instruction step'));await agent.whenIdle()
    assert.ok(body(requests.at(-1).request).includes('NESTED_ONLY'))
    assert.ok(!body(requests.at(-1).request).includes('SIBLING_ONLY'))
    await writeFile(join(dir,'REPO_POLICY.md'),'Fresh policy revision')
    assert.equal((await execute('pwsh',{})).isError,true,'stale policy blocks action')
    agent.followup(input('Refresh changed policy'));await agent.whenIdle()
    assert.equal((await execute('pwsh',{})).isError,false)
    await rm(join(dir,'REPO_POLICY.md'))
    assert.equal((await execute('pwsh',{})).isError,true,'missing required policy blocks action')
    assert.equal(effects.length,3)
    await rm(join(dir,'docs/workflow/TASK_CONTRACT.md'))
    assert.equal((await execute('pwsh',{})).isError,true,'both missing required documents do not turn off workspace policy')
    await writeFile(join(dir,'docs/workflow/TASK_CONTRACT.md'),'Restored task contract')
    await writeFile(join(dir,'REPO_POLICY.md'),'Fresh policy revision')
    await rm(join(dir,'.agents/skills/postman-leader/SKILL.md'))
    const scoped = await ctx.systemPrompt.assemble({agent,scope:agent,signal:signal()}).catch(error=>error)
    assert.ok(scoped instanceof Error,'missing required Leader skill fails closed')
  })
  test('exact Leader role does not preload Postman projects into unrelated repository',{timeout:20000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-unrelated-'));await fixture(dir)
    await writeFile(join(dir,'AGENTS.md'),'Unrelated repository instructions')
    await writeFile(join(dir,'REPO_POLICY.md'),'Unrelated repository policy')
    await writeFile(join(dir,'docs/workflow/TASK_CONTRACT.md'),'Unrelated repository contract')
    const r=await runtime(dir)
    t.after(async()=>{await r.ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
    const agent=await r.create('leader');agent.followup(input('Bounded unrelated task'));await agent.whenIdle()
    assert.ok(!latest(r.ctx,agent).some(s=>s.name.includes('docs'+(process.platform==='win32'?'\\':'/')+'subprojects')))
  })

}