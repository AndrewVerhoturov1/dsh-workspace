import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn as spawnProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPostmanWorkerTools } from './postman-worker.js'
import { apply as postmanHarness } from './index.js'
import { apply as taskDiscipline, TASK_DISCIPLINE } from '../../dsh-task-discipline/index.js'
import { openPostmanTaskRegistry } from './postman-task-registry.js'
import { createPtcAdapter, WORKER_MUTATION_PROFILE } from './ptc-adapter.js'
import { createPostmanBridgeBoundaryManager, isTopLevelPostmanPtcLeader, postmanPtcDirectCallGuard, POSTMAN_LEADER_TOOL_ALLOWLIST } from './postman-bridge-core.js'

// Separate Node processes: only existing JSON task storage and native Jsonl logs cross phases.
// The provider and data tool are stubs; Agent, persistence, continuation, report and QuickJS are native.
const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh')
const pkg = name => import(pathToFileURL(join(installed, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const { Context } = await pkg('cordis')
const { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session')
const { JsonlSessionPersistence } = await pkg('dsh-session-persistence-jsonl')
const { SessionProjectionRegistry } = await pkg('dsh-session-projection')
const { SystemPrompt } = await pkg('dsh-system-prompt')
const { ToolRuntime, defineTool } = await pkg('dsh-tools')
const { LlmRuntime, LlmAdapter, createUserMessage } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop')
const { SubagentRuntime } = await pkg('dsh-subagent')
const { apply: spawn } = await pkg('dsh-subagent-spawn-in-process')
const { apply: report } = await pkg('dsh-tool-subagent-report')
const { JsonStorageBackend } = await pkg('dsh-storage-json')
const { DomainFacility } = await pkg('dsh-storage-domain')
const { default: Loader } = await pkg('cordis-plugin-loader')
const { AgentPresets } = await pkg('dsh-agent-presets')

async function runPhase(dir, phase, workerType = 'luna') {
  const sol = workerType === 'sol'
  const model = sol ? 'gpt-6.1-sol' : 'gpt-6-luna', reasoning = sol ? 'xhigh' : 'max'
  const ctx = new Context(), diagnostics = [], requests = [], disposed = Promise.withResolvers(), firstRequest = Promise.withResolvers()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new LlmRuntime(ctx)
  const persistence = new JsonlSessionPersistence(ctx, {root:join(dir,'sessions'),compression:'none'})
  new SubagentRuntime(ctx); spawn(ctx,{providerName:'spawn'}); report(ctx,{reportDelivery:'quiet'})
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
  taskDiscipline(ctx) // Independent global plugin, reloaded in each process.
  postmanHarness(ctx)
  const leaderRequests = []
  // Native standing preset mount/bind/reconstruction, with only a persona
  // fixture rather than unrelated production shell/browser services.
  const presetDir = join(dir,'presets','postman-leader-ptc')
  await mkdir(presetDir,{recursive:true})
  await writeFile(join(presetDir,'agent.cordis.yml'),JSON.stringify([{id:'persona',name:pathToFileURL(join(installed,'node_modules/@deepseek-ai/dsh-persona/lib/index.js')).href,config:{text:'Shared preset fixture {{cwd}}'}}]))
  await ctx.plugin(Loader,{baseUrl:pathToFileURL(join(installed,'lib/bin.js')).href})
  new AgentPresets(ctx,{default:'postman-leader-ptc',includeUserRoot:false,roots:[{path:join(dir,'presets'),trust:'system'}]})
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx,'postman-leader-ptc') }
  const backend = new JsonStorageBackend(join(dir,'tasks'))
  const domain = new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json',routes:{}})
  const registry = await openPostmanTaskRegistry(domain)
  if (phase === 'fresh') await registry.create('leader', {leaderSessionId:'leader',repository:'andrewverhoturov1/dsh-workspace',repositoryPath:dir,
    originUrl:'https://github.com/AndrewVerhoturov1/dsh-workspace.git',baseCommit:'a'.repeat(40),branch:'task/cold',worktree:dir,
    stage:'ready',diagnostic:null,workers:{},runner:{state:'none',requestId:null},bridge:null})
  const context = Object.freeze({branch:registry.get('leader').branch,worktree:dir})
  const contexts = {get:id=>id==='leader'?context:null,record:registry.get,changeRecord:registry.change}
  let adapter, boundaries
  const refresh = id => {const a=ctx.agents.get(id);if(a && adapter && boundaries){boundaries.refreshSession(id);adapter.refresh(a)}}
  const worker = createPostmanWorkerTools(ctx,undefined,contexts,{onBindingChange:refresh})
  const owns = a => worker.ownsLiveWorker(a) && isTopLevelPostmanPtcLeader(ctx.agents.get(a.session.header.parentSession))
  adapter = createPtcAdapter(ctx,{workerContextOf:a=>owns(a)?worker.ptcContextOf(a):null,
    resolveAssignment:(a,p)=>isTopLevelPostmanPtcLeader(a)?{profile:p,role:'leader'}:owns(a)?{profile:WORKER_MUTATION_PROFILE,role:'worker'}:null})
  boundaries = createPostmanBridgeBoundaryManager(id=>ctx.agents.get(id),owns)
  ctx.tools.register(adapter.tool); ctx.tools.register(worker.taskTool); ctx.tools.register(worker.solTaskTool)
  ctx.tools.guard(exec=>postmanPtcDirectCallGuard(exec,id=>ctx.agents.get(id),owns))
  ctx.logger.exporter({export:message=>{if(message.name==='postman-ptc')diagnostics.push(message.args[1])}})
  ctx.on('agent/created',async ({agent})=>{const activation=worker.confirmActivation(agent);boundaries.install(agent);adapter.refresh(agent);
    await activation;boundaries.refreshSession(agent.id);adapter.refresh(agent)})
  ctx.on('agent/disposed',({agent})=>{worker.releaseActivation(agent);adapter.remove(agent);boundaries.disposeAgent(agent);
    if(agent.id!=='leader')disposed.resolve(agent)})
  ctx.on('session/event',(_session,event)=>{if(event.type==='turn/end' && event.data.reason.kind==='error'){firstRequest.resolve();disposed.reject(Error(JSON.stringify(event.data)))}})
  const output={schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}
  ctx.tools.register(defineTool({name:'read',description:'fixture read',parameters:{file_path:{type:'string',required:true}},output,
    execute(_args,exec){assert.ok(exec.parent);assert.ok(owns(exec.agent));return {lines:[{number:1,text:'PTC evidence'}]}}}))
  for(const name of ['glob','grep',...POSTMAN_LEADER_TOOL_ALLOWLIST]) if(!ctx.tools.get(name))
    ctx.tools.register(defineTool({name,description:name,parameters:{},output,execute(){return {name}}}))
  class FakeAdapter extends LlmAdapter {
    async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text'],reasoning:{efforts:[{id:'max',name:'Max'},{id:'xhigh',name:'Very high'}]}}}
    async *stream(request){
      const agent=ctx.agents.currentInitiator()
      assert.equal(request.system.split(TASK_DISCIPLINE).length - 1, 1, 'one full discipline block in every actual model request')
      // Native child persona shadows the preset persona, not other sections.
      if(agent.id==='leader') assert.match(request.system,/Shared preset fixture/)
      assert.ok(!JSON.stringify(request.messages).includes(TASK_DISCIPLINE), 'discipline is not conversation history')
      assert.equal(agent.session.header.cwd, dir)
      assert.equal(agent.session.header.agentPreset,'postman-leader-ptc')
      assert.equal(ctx.agentPresets.composedPreset(agent.ctx),'postman-leader-ptc')
      if(agent.id==='leader'){
        leaderRequests.push(request)
        const workerId = Object.keys(registry.get('leader').workers)[0]
        const block = sol && leaderRequests.length === 1 ? {type:'tool-call',id:phase+'-sol',name:'postman_sol_worker',
          arguments:JSON.stringify({task:'Verify '+phase,...(workerId?{workerSessionId:workerId}:{createNew:true})})} : {type:'text',text:'Worker event'}
        yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}};return
      }
      requests.push({agent,request});const count=requests.length
      assert.equal(request.provider,'codex');assert.equal(request.model,model);assert.equal(request.reasoningEffort,reasoning)
      assert.ok(request.tools.some(s=>s.name==='ptc_execute'));assert.match(request.system,/Postman PTC programming discipline/)
      if(count===1){
        assert.equal(registry.get('leader').workers[agent.id].delivery,'pending')
        assert.equal(registry.get('leader').workers[agent.id].lifecycle.admissions.at(-1).state,'pending')
        firstRequest.resolve()
      }
      const block=count===1?{type:'tool-call',id:phase+'-ptc',name:'ptc_execute',arguments:JSON.stringify({description:'Cold resume evidence',boundary:'semantic_decision',
        program:"const r=await tools.read({file_path:'proof.txt'}); return {lines:r.lines.length}"})}:
        count===2?{type:'tool-call',id:phase+'-report',name:'report',arguments:JSON.stringify({output:'PTC verified '+phase})}:{type:'text',text:'done'}
      yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['codex'],new FakeAdapter())
  let diskReads=0
  const loadStored=persistence.loadStored.bind(persistence)
  persistence.loadStored=async (...args)=>{diskReads++;return loadStored(...args)}
  const start=ctx.subagents.startContinuable.bind(ctx.subagents),follow=ctx.subagents.followup.bind(ctx.subagents)
  ctx.subagents.startContinuable=async spec=>{const result=await start(spec);await firstRequest.promise;return result}
  ctx.subagents.followup=async (...args)=>{const result=await follow(...args);await firstRequest.promise;return result}
  try {
    let leader, inspection, workerId
    if(phase==='fresh'){
      const handle=await ctx.agents.create({setup,sessionId:'leader',meta:{cwd:dir,agentPreset:'postman-leader-ptc'},agentOptions:{provider:'codex',model:'gpt-6-sol'}})
      leader=handle.agent
    }else{
      workerId=Object.keys(registry.get('leader').workers)[0]
      assert.ok(workerId);assert.equal(ctx.agents.get(workerId),undefined);assert.equal(ctx.sessions.get(workerId),undefined)
      inspection=await persistence.load(workerId)
      assert.ok(diskReads>0,'Jsonl backend must read the previous process log')
      assert.equal(inspection.meta.id,workerId)
      assert.ok(inspection.events.some(e=>e.type==='tool/call' && e.data.name==='ptc_execute'))
      assert.equal(inspection.events.some(e=>e.type==='postman/ptc-run'),false)
      const handle=await ctx.agents.resume({setup,resumeSessionId:'leader',agentOptions:{provider:'codex',model:'gpt-6-sol'}})
      leader=handle.agent
    }
    leader.followup(createUserMessage({content:[{type:'text',text:'Verify Leader '+phase}],source:{kind:'user'}}))
    await leader.whenIdle()
    assert.ok(leaderRequests.length >= 1, 'top-level Leader request reached the adapter')
    const accepted=sol ? JSON.parse(leader.session.events.find(e=>e.type==='tool/result' && e.data.message.source.callId===phase+'-sol').data.message.content[0].content[0].text) :
      await worker.taskTool.execute({task:'Verify '+phase,...(workerId?{workerSessionId:workerId}:{createNew:true})},{agent:leader,signal:new AbortController().signal})
    if(sol){
      assert.equal(registry.get('leader').workers[accepted.workerSessionId].workerType,'sol')
    }
    assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(accepted))
    if(workerId)assert.equal(accepted.workerSessionId,workerId)
    assert.equal(accepted.created,phase==='fresh')
    const released=await disposed.promise
    assert.equal(ctx.agents.get(released.id),undefined);assert.equal(worker.ownsLiveWorker(released),false)
    assert.equal(requests.length,3)
    const ptcResult=released.session.events.findLast(e=>e.type==='tool/result' && e.data.message.source.callId===phase+'-ptc')
    assert.equal(ptcResult.data.message.content[0].isError,false)
    const result=JSON.parse(ptcResult.data.message.content[0].content[0].text)
    assert.equal(result.status,'ok');assert.equal(result.value.lines,1)
    assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].sessionId,released.id);assert.equal(diagnostics[0].nestedToolCalls,1)
    assert.doesNotMatch(JSON.stringify(diagnostics),/"program"|"value"|"content"|PTC evidence|proof.txt/)
    const raw=await readFile(persistence.locate({id:released.id,cwd:dir}).path,'utf8')
    assert.ok(raw.includes('ptc_execute'));assert.ok(!raw.includes('postman/ptc-run'))
    if(inspection)assert.notEqual(released.session,inspection)
    await writeFile(join(dir,phase+'.json'),JSON.stringify({pid:process.pid,workerId:released.id,diskReads,modelCalls:requests.length,
      ptc:true,discipline:true,taskDiscipline:true,leaderCalls:leaderRequests.length,reasoningEffort:requests[0].request.reasoningEffort,diagnostic:diagnostics.length,ptcResult:result.status}))
  } finally {
    firstRequest.resolve();worker.dispose();boundaries.disposeAll();await adapter.dispose();await ctx.fiber.dispose();await registry.close()
  }
}

if(process.env.DSH_PTC_COLD_PHASE){
  await runPhase(process.env.DSH_PTC_COLD_DIR,process.env.DSH_PTC_COLD_PHASE,process.env.DSH_PTC_COLD_WORKER_TYPE)
}else{
  for(const workerType of ['luna','sol']) test('native Jsonl persistence round-trip and exact cold '+workerType+' Worker resume after PTC across two Node processes',{timeout:60000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'ptc-cold-roundtrip-'))
    t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
    for(const phase of ['fresh','resumed'])await new Promise((resolve,reject)=>{
      const child=spawnProcess(process.execPath,[fileURLToPath(import.meta.url)],{stdio:'inherit',env:{...process.env,DSH_PTC_COLD_PHASE:phase,DSH_PTC_COLD_DIR:dir,DSH_PTC_COLD_WORKER_TYPE:workerType}})
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(phase+' process exit '+code)))
    })
    const fresh=JSON.parse(await readFile(join(dir,'fresh.json'),'utf8')),resumed=JSON.parse(await readFile(join(dir,'resumed.json'),'utf8'))
    assert.notEqual(fresh.pid,resumed.pid);assert.equal(fresh.workerId,resumed.workerId)
    assert.ok(resumed.diskReads>0);assert.equal(resumed.reasoningEffort,workerType==='sol'?'xhigh':'max');assert.equal(resumed.ptcResult,'ok')
    assert.equal(fresh.taskDiscipline,true);assert.equal(resumed.taskDiscipline,true)
    assert.ok(fresh.leaderCalls>0);assert.ok(resumed.leaderCalls>0)
    t.diagnostic(JSON.stringify({fresh,resumed}))
  })
}
