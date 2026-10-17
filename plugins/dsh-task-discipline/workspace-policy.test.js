import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn as processSpawn, execFileSync } from 'node:child_process'
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
  for (const path of ['docs/workflow','docs/subprojects/postman','docs/subprojects/ptc','plugins/dsh-ptc','.agents/skills/ordinary-fixture','nested','sibling','home']) await mkdir(join(dir,path),{recursive:true})
  execFileSync('git',['init','-q'],{cwd:dir})
  for (const path of ['AGENTS.md','REPO_POLICY.md','docs/workflow/TASK_CONTRACT.md','docs/subprojects/postman/SUBPROJECT.md','docs/subprojects/ptc/SUBPROJECT.md']) await copyFile(join(repo,path),join(dir,path))
  await writeFile(join(dir,'.agents/skills/ordinary-fixture/SKILL.md'),'---\nname: ordinary-fixture\ndescription: Ordinary project skill\n---\n\nORDINARY_PROJECT_SKILL')
  await writeFile(join(dir,'nested/AGENTS.md'),'NESTED_ONLY: applies only under nested/')
  await writeFile(join(dir,'sibling/AGENTS.md'),'SIBLING_ONLY: applies only under sibling/')
  await writeFile(join(dir,'nested/a.txt'),'a'); await writeFile(join(dir,'plugins/dsh-ptc/a.txt'),'a')
}
async function runtime(dir, observe = () => {}, { applyPolicy = policy, sessionCwd = dir } = {}) {
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
  discipline(ctx); applyPolicy(ctx)
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
  const create = async id => (await ctx.agents.create({setup,sessionId:id,meta:{cwd:sessionCwd,agentPreset:'postman-leader'},agentOptions:{provider:'fixture',model:'inert'}})).agent
  return {ctx,requests,effects,setup,create,persistence,compactor}
}

async function phase(dir, resumed) {
  const r = await runtime(dir)
  const {ctx,requests,setup,create,persistence,compactor} = r
  try {
    const leader = resumed ? (await ctx.agents.resume({setup,resumeSessionId:'leader',agentOptions:{provider:'fixture',model:'inert'}})).agent : await create('leader')
    // Real Host registry sees the canonical skill at the installed Host root;
    // the unrelated Git repository has no copied Postman role skills.
    const canonical = await ctx.skills.get('postman-leader',{cwd:repo,scope:leader,signal:signal()})
    assert.equal(canonical?.resourceBase?.path,join(repo,'.agents/skills/postman-leader'))
    assert.match(canonical.content,/POSTMAN_LEADER_SKILL_VERSION: 33/)
    const ordinary = await ctx.skills.get('ordinary-fixture',{cwd:dir,scope:leader,signal:signal()})
    assert.match(ordinary.content,/ORDINARY_PROJECT_SKILL/)
    leader.followup(input('Bounded fixture task')); await leader.whenIdle()
    if (!resumed) {
      const result = await ctx.tools.execute({callId:'project-touch',name:'read',arguments:{file_path:'plugins/dsh-ptc/a.txt'},agent:leader,signal:signal()})
      assert.equal(result.isError,false,'expected managed Leader subproject delivered before first read')
    }
    const projectText = await readFile(join(dir,'docs/subprojects/ptc/SUBPROJECT.md'),'utf8')
    assert.ok(latest(ctx,leader).some(s=>s.text.endsWith(projectText)),'subproject hints survive separate process')
    const first = requests.at(-1).request
    assert.ok(body(first).includes('Общие правила агента'))
    assert.ok(body(first).includes('POSTMAN_LEADER_SKILL_VERSION: 33'))
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
    assert.ok(!body(request.request).includes('POSTMAN_LEADER_SKILL_VERSION: 33'),'Leader role does not leak into child')
    assert.ok(body(request.request).includes('Общие правила агента'))
    for (const path of ['REPO_POLICY.md','docs/workflow/TASK_CONTRACT.md']) {
      const text = await readFile(join(dir,path),'utf8')
      assert.ok(latest(ctx,request.agent).some(s=>s.text.endsWith(text)))
    }
    if (!resumed) {
      const generation = leader.session.surface.replaceGeneration
      assert.ok(await compactor.compactNow(leader,signal()))
      assert.ok(leader.session.surface.replaceGeneration>generation)
      assert.ok(!body({messages:leader.session.deriveMessages()}).includes('POSTMAN_LEADER_SKILL_VERSION: 33'))
      leader.followup(input('Continue after native compaction')); await leader.whenIdle()
      assert.ok(body(requests.at(-1).request).includes('POSTMAN_LEADER_SKILL_VERSION: 33'))
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
  test('non-blocking delivery, scoped subproject, nested AGENTS and unavailable sources',{timeout:20000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-boundary-'));await fixture(dir)
    const r=await runtime(dir);const {ctx,requests,effects,create}=r
    t.after(async()=>{await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
    const agent=await create('leader')
    agent.followup(input('Small task'));await agent.whenIdle()
    assert.ok(body(requests.at(-1).request).includes('Current focus'),'known supervisor subprojects proactively delivered')
    // First touch executes and schedules instructions for the next model step.
    await mkdir(join(dir,'docs/subprojects/agents-nods-by-andrew'),{recursive:true})
    await mkdir(join(dir,'plugins/dsh-nodes-agent-by-andrew'),{recursive:true})
    await writeFile(join(dir,'docs/subprojects/agents-nods-by-andrew/SUBPROJECT.md'),'UNKNOWN_PROJECT_CONTEXT')
    const execute = (name,args) => ctx.tools.execute({callId:'fixture-'+effects.length,name,arguments:args,agent,signal:signal()})
    const first = await execute('write',{file_path:'plugins/dsh-nodes-agent-by-andrew/a.txt',content:'b'})
    assert.equal(first.isError,false,JSON.stringify(first));assert.equal(effects.length,1)
    agent.followup(input('Deliver Host context'));await agent.whenIdle()
    assert.ok(body(requests.at(-1).request).includes('UNKNOWN_PROJECT_CONTEXT'))
    const subproject = await readFile(join(dir,'docs/subprojects/ptc/SUBPROJECT.md'),'utf8')
    assert.ok(latest(ctx,agent).some(s=>s.text.endsWith(subproject)))
    assert.equal((await execute('write',{file_path:'plugins/dsh-nodes-agent-by-andrew/a.txt',content:'b'})).isError,false)
    assert.equal(effects.length,2)
    await writeFile(join(dir,'docs/subprojects/ptc/SUBPROJECT.md'),'Fresh PTC instructions')
    assert.equal((await execute('read',{file_path:'plugins/dsh-ptc/a.txt'})).isError,false,'changed project instructions do not reject reads')
    agent.followup(input('Deliver fresh project instructions'));await agent.whenIdle()
    assert.ok(body(requests.at(-1).request).includes('Fresh PTC instructions'))
    assert.equal((await execute('read',{file_path:'nested/a.txt'})).isError,false)
    agent.followup(input('Next nested instruction step'));await agent.whenIdle()
    assert.ok(body(requests.at(-1).request).includes('NESTED_ONLY'))
    assert.ok(!body(requests.at(-1).request).includes('SIBLING_ONLY'))
    await writeFile(join(dir,'REPO_POLICY.md'),'Fresh policy revision')
    assert.equal((await execute('pwsh',{})).isError,false,'stale policy does not block action')
    agent.followup(input('Refresh changed policy'));await agent.whenIdle()
    assert.equal((await execute('pwsh',{})).isError,false)
    await rm(join(dir,'REPO_POLICY.md'))
    assert.equal((await execute('pwsh',{})).isError,false,'missing policy does not block action')
    assert.equal(effects.length,7)
    await rm(join(dir,'docs/workflow/TASK_CONTRACT.md'))
    assert.equal((await execute('pwsh',{})).isError,false,'missing documents do not reject ordinary tools')
    agent.followup(input('Show unavailable instructions'));await agent.whenIdle()
    assert.ok(body(requests.at(-1).request).includes('WORKSPACE_INSTRUCTION_UNAVAILABLE'))
    assert.ok(!latest(ctx,agent).some(s=>s.text.endsWith('Fresh policy revision')))
    await writeFile(join(dir,'docs/workflow/TASK_CONTRACT.md'),'Restored task contract')
    await writeFile(join(dir,'REPO_POLICY.md'),'Fresh policy revision')
    const scoped = await ctx.systemPrompt.assemble({agent,scope:agent,signal:signal()})
    assert.ok(scoped.contexts.some(s=>s.name==='dsh:workspace-policy:skill:postman-leader' &&
      s.text.includes('POSTMAN_LEADER_SKILL_VERSION: 33')),'project has no copied role skill; Host still supplies canonical source')
  })
  test('real Host assembly/pre-execute respects partial generic rules and preserves mandatory DSH contract',{timeout:60000},async t=>{
    const docs=['AGENTS.md','REPO_POLICY.md','docs/workflow/TASK_CONTRACT.md']
    for (const [kind,present] of [
      ['none',[]], ['agents',['AGENTS.md']], ['policy',['REPO_POLICY.md']],
      ['contract',['docs/workflow/TASK_CONTRACT.md']],
    ]) {
      const dir=await mkdtemp(join(tmpdir(),'dsh-policy-generic-'+kind+'-'))
      await fixture(dir)
      for (const path of docs) if (!present.includes(path)) await rm(join(dir,path))
      if (present.includes('AGENTS.md')) await writeFile(join(dir,'AGENTS.md'),'GENERIC_AGENTS_ONLY')
      if (present.includes('REPO_POLICY.md')) await writeFile(join(dir,'REPO_POLICY.md'),'GENERIC_POLICY_ONLY')
      if (present.includes('docs/workflow/TASK_CONTRACT.md')) await writeFile(join(dir,'docs/workflow/TASK_CONTRACT.md'),'GENERIC_CONTRACT_ONLY')
      const r=await runtime(dir)
      try {
        const agent=await r.create('leader')
        agent.followup(input('Generic repository operation'));await agent.whenIdle()
        const sections=latest(r.ctx,agent)
        for (const [path,marker] of [['REPO_POLICY.md','GENERIC_POLICY_ONLY'],['docs/workflow/TASK_CONTRACT.md','GENERIC_CONTRACT_ONLY']])
          assert.equal(sections.some(s=>s.text.includes(marker)),present.includes(path),kind+': '+path)
        assert.ok(!sections.some(s=>s.name.includes('docs/subprojects')),kind+': DSH subprojects must not leak')
        const result=await r.ctx.tools.execute({callId:'generic-'+kind,name:'pwsh',arguments:{},agent,signal:signal()})
        assert.equal(result.isError,false,kind+': missing optional companion must not block pre-execute')
        if (kind==='agents') assert.ok(body(r.requests.at(-1).request).includes('GENERIC_AGENTS_ONLY'))
      } finally {await r.ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})}
    }
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-mandatory-'))
    await fixture(dir)
    await rm(join(dir,'docs/workflow/TASK_CONTRACT.md'))
    const r=await runtime(dir)
    try {
      const agent=await r.create('leader')
      const assembled=await r.ctx.systemPrompt.assemble({agent,scope:agent,signal:signal()})
      assert.ok(assembled.contexts.some(s=>s.text.includes('WORKSPACE_INSTRUCTION_UNAVAILABLE') && s.name.includes('TASK_CONTRACT')))
    } finally {await r.ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})}
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

  test('path observation refreshes context without an inbox wake or extra model turn',{timeout:20000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-no-wake-'));await fixture(dir)
    const r=await runtime(dir,({requests})=>requests.length===1
      ? {type:'tool-call',id:'observe-path',name:'read',arguments:JSON.stringify({file_path:'plugins/dsh-ptc/a.txt'})}
      : {type:'text',text:'finished requested read'})
    t.after(async()=>{await r.ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
    const agent=await r.create('leader')
    agent.followup(input('Read the exact named file once'));await agent.whenIdle()
    assert.equal(r.effects.length,1)
    assert.equal(r.requests.length,2,'one tool request and one normal completion')
    assert.equal(agent.inbox.nextStep.some(m=>m.source?.plugin==='dsh-workspace-policy'),false)
    assert.ok(!agent.session.events.some(e=>e.type==='user/message' && e.data.source?.plugin==='dsh-workspace-policy'))
  })

  test('real Host registry: external Git cwd cannot replace canonical Leader skill',{timeout:30000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-decoy-'));await fixture(dir)
    await mkdir(join(dir,'.agents/skills/postman-leader'),{recursive:true})
    await writeFile(join(dir,'.agents/skills/postman-leader/SKILL.md'),
      '---\nname: postman-leader\ndescription: Project-owned decoy\n---\n\nPROJECT_DECOY_NOT_CANONICAL')
    const r=await runtime(dir)
    t.after(async()=>{await r.ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
    const agent=await r.create('leader')
    const decoy=await r.ctx.skills.get('postman-leader',{cwd:dir,scope:agent,signal:signal()})
    assert.equal(decoy?.resourceBase?.path,join(dir,'.agents/skills/postman-leader'))
    assert.match(decoy.content,/PROJECT_DECOY_NOT_CANONICAL/)
    agent.followup(input('Work in this unrelated Git repository'));await agent.whenIdle()
    const sections=latest(r.ctx,agent)
    const role=sections.find(s=>s.name==='dsh:workspace-policy:skill:postman-leader')
    assert.ok(role,'actual Host assembly includes top-level Leader role')
    assert.ok(role.text.includes('Base directory: '+join(repo,'.agents/skills/postman-leader')))
    assert.match(body(r.requests.at(-1).request),/POSTMAN_LEADER_SKILL_VERSION: 33/)
    assert.doesNotMatch(body(r.requests.at(-1).request),/PROJECT_DECOY_NOT_CANONICAL/)
    const ordinary=await r.ctx.skills.get('ordinary-fixture',{cwd:dir,scope:agent,signal:signal()})
    assert.match(ordinary.content,/ORDINARY_PROJECT_SKILL/)
    assert.ok(sections.some(s=>s.name.endsWith('REPO_POLICY.md')),'project policy remains available')
  })

  test('real Host assembly: Leader startup from DSH checkout reads canonical source',{timeout:30000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-host-start-'));await fixture(dir)
    const r=await runtime(dir,()=>{}, {sessionCwd:repo})
    t.after(async()=>{await r.ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
    const agent=await r.create('leader')
    agent.followup(input('Start inside DSH checkout'));await agent.whenIdle()
    assert.match(body(r.requests.at(-1).request),/POSTMAN_LEADER_SKILL_VERSION: 33/)
    assert.ok(latest(r.ctx,agent).some(s=>s.name==='dsh:workspace-policy:'+join(repo,'REPO_POLICY.md')))
  })

  test('missing canonical Leader skill is diagnosed without loading project decoy',{timeout:30000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-missing-project-'));await fixture(dir)
    await mkdir(join(dir,'.agents/skills/postman-leader'),{recursive:true})
    await writeFile(join(dir,'.agents/skills/postman-leader/SKILL.md'),
      '---\nname: postman-leader\ndescription: Project-owned decoy\n---\n\nPROJECT_DECOY_NOT_CANONICAL')
    const host=await mkdtemp(join(tmpdir(),'dsh-policy-missing-host-'))
    const moduleDir=join(host,'plugins/dsh-task-discipline')
    await mkdir(moduleDir,{recursive:true})
    await writeFile(join(host,'package.json'),'{"type":"module"}')
    await copyFile(join(repo,'plugins/dsh-task-discipline/workspace-policy.js'),join(moduleDir,'workspace-policy.js'))
    const missing=await import(pathToFileURL(join(moduleDir,'workspace-policy.js')).href)
    const r=await runtime(dir,()=>{}, {applyPolicy:missing.apply})
    t.after(async()=>{await r.ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5});await rm(host,{recursive:true,force:true,maxRetries:5})})
    const agent=await r.create('leader')
    const assembled=await r.ctx.systemPrompt.assemble({agent,scope:agent,signal:signal()})
    assert.ok(assembled.contexts.some(s=>s.text.includes('WORKSPACE_INSTRUCTION_UNAVAILABLE: canonical postman-leader skill unavailable from Host installation')))
  })

  test('real Host registry preserves distinct Worker, Secretary and Sol canonical skills',{timeout:20000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'dsh-policy-role-registry-'));await fixture(dir)
    const r=await runtime(dir)
    t.after(async()=>{await r.ctx.fiber.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
    const agent=await r.create('leader')
    for (const [type,name] of [['luna','postman-worker'],['secretary','postman-secretary'],['sol','postman-sol-worker']]) {
      const skill=await r.ctx.skills.get(name,{cwd:repo,scope:agent,signal:signal()})
      assert.equal(skill?.resourceBase?.path,join(repo,'.agents/skills',name),type+' must come from installed Host')
      const canonical=await readFile(join(repo,'.agents/skills',name,'SKILL.md'),'utf8')
      assert.ok(canonical.includes(skill.content),type+' parsed registry content matches Host source')
      assert.ok(!skill.content.includes('POSTMAN_LEADER_SKILL_VERSION: 33'),type+' must not inherit Leader instructions')
    }
    const workerModule=await readFile(join(repo,'plugins/dsh-postman-harness/lib/postman-worker.js'),'utf8')
    assert.ok(workerModule.includes("readFileSync(new URL('../../../.agents/skills/'"),
      'existing role loader remains Host-module-relative')
  })

}
