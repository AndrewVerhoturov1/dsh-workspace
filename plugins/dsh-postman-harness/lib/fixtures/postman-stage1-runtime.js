import { join } from 'node:path'
import {randomUUID} from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createPostmanWorkerTools } from '../postman-worker.js'
import { createPostmanBridgeBoundaryManager, POSTMAN_LEADER_TOOL_ALLOWLIST, isTopLevelPostmanPtcLeader, postmanPtcDirectCallGuard } from '../postman-bridge-core.js'
import { createPostmanChildNotifyTool, installPostmanWorkerReportObserver } from '../postman-bridge.js'
import { createPtcAdapter, SOL_WORKER_PROFILE } from '../ptc-adapter.js'
import { openPostmanTaskRegistry } from '../postman-task-registry.js'
const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh')
const requireNative = createRequire(join(installed, 'package.json'))
export const stage1Native = name => import(pathToFileURL(requireNative.resolve('@deepseek-ai/' + name)).href)
const pkg = stage1Native
const {Context} = await pkg('cordis')
const {AgentRegistry} = await pkg('dsh-agent')
const {SessionStore} = await pkg('dsh-session')
const {SessionProjectionRegistry} = await pkg('dsh-session-projection')
const {JsonlSessionPersistence} = await pkg('dsh-session-persistence-jsonl')
const {SystemPrompt} = await pkg('dsh-system-prompt')
const {ToolRuntime,defineTool} = await pkg('dsh-tools')
const {LlmRuntime,LlmAdapter} = await pkg('dsh-llm')
const {AgentLoop} = await pkg('dsh-agent-loop')
const {SubagentRuntime} = await pkg('dsh-subagent')
const {apply:spawn} = await pkg('dsh-subagent-spawn-in-process')
const {apply:nativeReport} = await pkg('dsh-tool-subagent-report')
const {JsonStorageBackend}=await pkg('dsh-storage-json')
const {DomainFacility}=await pkg('dsh-storage-domain')
const output={schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}
export async function stage1Runtime(dir, {registry,grants,fastBudget,resume=false,setupTools,toolMode='native',plan=()=>({name:'report',args:{output:'bounded task done; targeted check PASS inputs fixture'}})}={}) {
  if(!registry){const backend=new JsonStorageBackend(join(dir,'tasks'));const domain=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json',routes:{}});registry=await openPostmanTaskRegistry(domain)}
  const ctx=new Context(), requests=[], calls=[], agents=new Map(), specs=[], ends=new Map(), completions=new Map()
  new AgentRegistry(ctx);new SessionStore(ctx);new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx,{});new ToolRuntime(ctx,{mode:toolMode});new LlmRuntime(ctx)
  new JsonlSessionPersistence(ctx,{root:join(dir,'sessions')});new SubagentRuntime(ctx)
  spawn(ctx,{providerName:'spawn'});nativeReport(ctx,{reportDelivery:'quiet'})
  new AgentLoop(ctx,{agents:[],maxParallelToolCalls:2})
  if(!registry.get('leader')) await registry.create('leader',{leaderSessionId:'leader',repository:'andrewverhoturov1/dsh-workspace',
    repositoryPath:dir,originUrl:'https://github.com/AndrewVerhoturov1/dsh-workspace.git',branch:'task/postman-'+'a'.repeat(32),
    worktree:dir,baseCommit:'a'.repeat(40),stage:'ready',diagnostic:null,workers:{},runner:{state:'none',requestId:null},bridge:null})
  const context=Object.freeze({leaderSessionId:'leader',branch:'task/postman-fixture',worktree:dir})
  const contexts={get:id=>id==='leader'?context:null,record:registry.get,changeRecord:registry.change,child:()=>null}
  let boundaries,ptc
  const refresh=id=>{const agent=ctx.agents.get(id);if(agent){boundaries?.refreshSession(id);ptc?.refresh(agent);}}
  const worker=createPostmanWorkerTools(ctx,grants,contexts,{onBindingChange:refresh,fastBudget})
  for(const tool of [worker.taskTool,worker.solTaskTool,worker.secretaryTool,worker.listTool,worker.stopTool,worker.interruptTool,worker.compactTool,worker.freshTool,worker.ledgerTool])ctx.tools.register(tool)
  ctx.tools.register(createPostmanChildNotifyTool(ctx,contexts,worker));installPostmanWorkerReportObserver(ctx,worker)
  if(setupTools) await setupTools(ctx)
  for(const name of [...POSTMAN_LEADER_TOOL_ALLOWLIST,'glob','write','edit','pwsh','bash','job_output','job_kill','job_list','web_search','subagent','subagent_fork','workflow','ralph','send_message','interrupt_agent','implementation_artifact_apply','mcp__playwright__browser_snapshot'])
    if(!ctx.tools.get(name))ctx.tools.register(defineTool({name,description:name,parameters:{},output,execute(_args,exec){calls.push({name,agent:exec.agent.id});return {fixture:true}}}))
  const ownsPtcSol=agent=>worker.roleOf(agent)==='sol'&&worker.ownsLiveWorker(agent)&&Boolean(worker.ptcContextOf(agent))
  ptc=createPtcAdapter(ctx,{authorize:isTopLevelPostmanPtcLeader,workerContextOf:worker.ptcContextOf,
    resolveAssignment:(agent,profile)=>isTopLevelPostmanPtcLeader(agent)?{role:'leader',profile}:ownsPtcSol(agent)?{role:'sol',profile:SOL_WORKER_PROFILE}:null})
  ctx.tools.guard(exec=>postmanPtcDirectCallGuard(exec,id=>ctx.agents.get(id),ownsPtcSol))
  ctx.tools.register(ptc.tool)
  boundaries=createPostmanBridgeBoundaryManager(id=>ctx.agents.get(id),ownsPtcSol,worker.roleOf)
  ctx.on('agent/created',async ({agent})=>{agents.set(agent.id,agent);await worker.confirmActivation(agent);boundaries.install(agent);ptc.refresh(agent)})
  ctx.on('agent/disposed',({agent})=>{worker.releaseActivation(agent);boundaries.disposeAgent(agent);ptc.remove(agent);completions.get(agent.id)?.resolve(agent)})
  ctx.on('session/event',(session,event)=>{if(event.type==='turn/end'){ends.get(session.id)?.resolve(event)}})
  const counts=new Map()
  class Adapter extends LlmAdapter {
    async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text'],reasoning:{efforts:['low','xhigh','max'].map(id=>({id,name:id}))}}}
    async *stream(request){
      const agent=ctx.agents.currentInitiator(),n=(counts.get(agent.id)??0)+1;counts.set(agent.id,n)
      if(agent.id==='leader'){yield {type:'block-end',index:0,block:{type:'text',text:'parent reviewed'}};yield {type:'finish',reason:{kind:'stop'}};return}
      requests.push({agent,request,n})


      const action=await plan(agent,request,n,worker,ctx)
      const block=action?.name?{type:'tool-call',id:randomUUID(),name:action.name,arguments:JSON.stringify(action.args??{})}:{type:'text',text:action?.text??'done'}
      yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['codex'],new Adapter())
  const nativeStart=ctx.subagents.startContinuable.bind(ctx.subagents)
  ctx.subagents.startContinuable=async spec=>{specs.push(spec);completions.set(spec.childId,Promise.withResolvers());const result=await nativeStart(spec);await ctx.sessionPersistence.append(spec.childId,[]);return result}
  const leader=resume?(await ctx.agents.resume({resumeSessionId:'leader',agentOptions:{provider:'codex',model:'gpt-6.1-sol'}})).agent:ctx.agentLoop.create('leader',{provider:'codex',model:'gpt-6.1-sol'},{cwd:dir,agentPreset:'postman-leader-ptc'})
  await ctx.sessionPersistence.append(leader.id,[])
  const exec=agent=>({agent,signal:new AbortController().signal})
  const run=async(tool,args={},parent=leader)=>{if(args.workerSessionId && ['postman_worker','postman_sol_worker','postman_secretary','postman_worker_interrupt'].includes(tool.name))completions.set(args.workerSessionId,Promise.withResolvers());const r=await tool.execute(args,exec(parent));return r}
  const settled=async id=>{const a=await completions.get(id).promise;await ctx.sessionPersistence.append(id,[]);return a}
  const wake=async parent=>{const end=Promise.withResolvers();ends.set(parent.id,end);parent.followup({id:'wake-'+Math.random(),role:'user',source:{kind:'user',form:'direct'},content:[{type:'text',text:'Review reports'}]});await end.promise;await parent.whenIdle();await ctx.sessionPersistence.append(parent.id,[])}
  return {ctx,worker,registry,leader,run,exec,settled,wake,requests,calls,agents,specs,contexts,
    async dispose(){worker.dispose();boundaries.disposeAll();await ptc.dispose();await ctx.fiber.dispose()}}
}
