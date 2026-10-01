import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createPostmanChildNotifyTool } from './postman-bridge.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPtcAdapter, WORKER_MUTATION_PROFILE } from './ptc-adapter.js'
import { createPostmanBridgeBoundaryManager, isTopLevelPostmanPtcLeader, postmanPtcDirectCallGuard, POSTMAN_LEADER_TOOL_ALLOWLIST } from './postman-bridge-core.js'

// Use one installed SDK identity throughout this disposable tree (no mixed Scope symbols).
// Only the model and data tools are stubs; child creation, prompt/request assembly,
// continuation, Agent loop, ToolRuntime and QuickJS execute their real implementations.
const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  'npm/node_modules/@deepseek-ai/dsh')
const pkg = name => import(pathToFileURL(join(installed, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const { Context } = await import(pathToFileURL(join(installed, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
const { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session')
const { JsonlSessionPersistence } = await pkg('dsh-session-persistence-jsonl')
const { SystemPrompt } = await pkg('dsh-system-prompt')
const { ToolRuntime, defineTool } = await pkg('dsh-tools')
const { LlmRuntime, LlmAdapter } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop')
const { SubagentRuntime } = await pkg('dsh-subagent')
const { SessionProjectionRegistry } = await pkg('dsh-session-projection')
const { apply: spawn } = await pkg('dsh-subagent-spawn-in-process')

test('fresh Worker FIRST model request has PTC/discipline/max and batches four calls', {timeout:15000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ptc-first-request-'))
  const ctx = new Context(), diagnostics = []
  ctx.logger.exporter({ export: message => {
    if (message.name === 'postman-ptc') diagnostics.push(message.args[1])
  } })
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LlmRuntime(ctx); new JsonlSessionPersistence(ctx, {root:join(dir,'sessions')})
  new SubagentRuntime(ctx); spawn(ctx, {providerName:'spawn'})
  new AgentLoop(ctx, {agents:[],maxParallelToolCalls:1})
  await writeFile(join(dir,'a.txt'),'A'); await writeFile(join(dir,'b.txt'),'B')
  const registry = createMemoryTaskRegistry(), context = Object.freeze({branch:'task/test',worktree:dir})
  await registry.create('leader', {stage:'ready',workers:{},runner:{state:'none'}})
  const contexts = {get:id=>id==='leader'?context:null,child:()=>null,record:registry.get,changeRecord:registry.change}
  let adapter, boundaries
  const refresh = id => { const a=ctx.agents.get(id); if (a && boundaries && adapter) {
    boundaries.refreshSession(id); adapter.refresh(a)
  } }
  const worker = createPostmanWorkerTools(ctx, undefined, contexts, {onBindingChange:refresh})
  const owns = a => worker.ownsLiveWorker(a) && isTopLevelPostmanPtcLeader(ctx.agents.get(a.session.header.parentSession))
  adapter = createPtcAdapter(ctx, {workerContextOf:a=>owns(a)?worker.ptcContextOf(a):null,
    resolveAssignment:(a,p)=>isTopLevelPostmanPtcLeader(a)?{profile:p,role:'leader'}:
      owns(a)?{profile:WORKER_MUTATION_PROFILE,role:'worker'}:null})
  boundaries = createPostmanBridgeBoundaryManager(id=>ctx.agents.get(id), owns)
  ctx.tools.register(adapter.tool); ctx.tools.register(worker.taskTool)
  ctx.tools.register(createPostmanChildNotifyTool(ctx, contexts, worker))
  ctx.tools.guard(exec=>postmanPtcDirectCallGuard(exec,id=>ctx.agents.get(id),owns))
  ctx.on('agent/created', async ({agent}) => {
    const activation=worker.confirmActivation(agent)
    boundaries.install(agent); adapter.refresh(agent)
    await activation; boundaries.refreshSession(agent.id); adapter.refresh(agent)
  })
  const released = [], requests = [], nested = []
  const disposed = Promise.withResolvers(), firstRequest = Promise.withResolvers()
  ctx.on('session/event', (_session,event)=>{if(event.type==='turn/end' && event.data.reason.kind==='error') firstRequest.resolve()})
  ctx.on('agent/disposed', ({agent})=>{
    worker.releaseActivation(agent); adapter.remove(agent); boundaries.disposeAgent(agent)
    if (agent.id!=='leader') { released.push(agent); disposed.resolve() }
  })
  const output={schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}
  for (const name of ['glob','read','grep']) ctx.tools.register(defineTool({name,description:name,
    parameters:name==='glob'?{pattern:{type:'string'}}:name==='read'?{file_path:{type:'string'}}:{pattern:{type:'string'}},output,
    execute(args,exec) {
      nested.push({name,agent:exec.agent,parent:exec.parent,root:exec.rootCallId})
      return name==='glob'?{paths:['a.txt','b.txt']} : name==='read'?{lines:[{number:1,text:args.file_path.endsWith('a.txt')?'A':'B'}]}:{matches:[{line:'A'}]}
    }
  }))
  for (const name of POSTMAN_LEADER_TOOL_ALLOWLIST) if (!ctx.tools.get(name))
    ctx.tools.register(defineTool({name,description:name,parameters:{},output,execute(){return {name}}}))
  class FakeAdapter extends LlmAdapter {
    async resolveModel(provider,model) { return {provider,id:model,name:model,inputModalities:['text'],reasoning:{efforts:[{id:'max',name:'Max'}]}} }
    async *stream(request) {
      const a=ctx.agents.currentInitiator(), count=requests.filter(r=>r.agent===a).length+1
      if(a.id==='leader') { yield {type:'block-end',index:0,block:{type:'text',text:'Worker event'}}; yield {type:'finish',reason:{kind:'stop'}}; return }
      firstRequest.resolve()
      requests.push({agent:a,request})
      assert.equal(request.provider,'codex'); assert.equal(request.model,'gpt-6-luna')
      assert.equal(request.reasoningEffort,'max')
      assert.ok(request.tools.some(s=>s.name==='ptc_execute'))
      assert.match(request.system,/Postman PTC programming discipline/)
      if (count===1) {
        // The start wrapper keeps Host admission pending until this real request.
        const binding=registry.get('leader').workers[a.id]
        assert.equal(binding.delivery,'pending')
        assert.equal(binding.lifecycle.admissions.at(-1).state,'pending')
        assert.ok(request.tools.some(s=>s.name==='notify_parent'))
        for (const message of ['progress: still working', ' NEEDS_LEADER_GUIDANCE: blocker', 'needs_leader_guidance: blocker', 'NEEDS_LEADER_GUIDANCE: blocker']) {
          const notification = await ctx.tools.execute({callId:'early-notify',name:'notify_parent',arguments:{message},agent:a,signal:request.signal})
          assert.equal(notification.isError,false,notification.error?.message)
          assert.equal(notification.value.status,message.startsWith('NEEDS_LEADER_GUIDANCE:')
            ? 'PARENT_NOTIFICATION_ACCEPTED' : 'POSTMAN_WORKER_NOTIFICATION_REJECTED')
        }
        const direct=await ctx.tools.execute({callId:'early-direct-read',name:'read',arguments:{file_path:'a.txt'},agent:a,signal:request.signal})
        assert.equal(direct.isError,true)
        assert.match(direct.error.message,/POSTMAN_PTC_DIRECT_CALL_REJECTED: use ptc_execute/)
      }
      yield {type:'block-end',index:0,block:count===1?{type:'tool-call',id:'batch',name:'ptc_execute',arguments:JSON.stringify({
        description:'Discover and reduce files',boundary:'semantic_decision',
        program:"const g=await tools.glob({pattern:'*.txt'}); const a=await tools.read({file_path:g.paths[0]}); const b=await tools.read({file_path:g.paths[1]}); const m=await tools.grep({pattern:'A'}); return {lines:[a.lines[0].text,b.lines[0].text],matches:m.matches.length}"
      })}:{type:'text',text:'done'}}
      yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['codex'],new FakeAdapter())
  const start=ctx.subagents.startContinuable.bind(ctx.subagents)
  ctx.subagents.startContinuable=async spec=>{const result=await start(spec);await firstRequest.promise;return result}
  t.after(async()=>{firstRequest.resolve();worker.dispose();boundaries.disposeAll();await adapter.dispose();await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true})})
  const leader=ctx.agentLoop.create('leader',{provider:'codex',model:'gpt-6-sol'},{cwd:dir,agentPreset:'postman-leader-ptc'})
  const exec={agent:leader,signal:new AbortController().signal}
  const fresh=await worker.taskTool.execute({task:'discover',createNew:true},exec)
  assert.equal(fresh.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(fresh))
  await disposed.promise
  assert.equal(requests.length,2) // one batch tool request, then one semantic result request
  assert.deepEqual(nested.map(x=>x.name),['glob','read','read','grep'])
  assert.ok(nested.every(x=>x.agent===requests[0].agent && x.parent && x.root==='batch'))
  assert.deepEqual(requests[0].agent.session.events.filter(e=>e.type==='tool/call').map(e=>e.data.name),['ptc_execute'])
  assert.equal(requests[0].agent.session.events.some(e=>e.type==='postman/ptc-run'),false)
  assert.equal(diagnostics.find(d=>d.sessionId===fresh.workerSessionId).nestedToolCalls,4)
  assert.equal(worker.ownsLiveWorker(released[0]),false)
})
