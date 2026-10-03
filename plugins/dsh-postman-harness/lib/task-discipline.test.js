import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply as postmanHarness, TASK_DISCIPLINE } from './index.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createPostmanBridgeBoundaryManager, POSTMAN_LEADER_TOOL_ALLOWLIST } from './postman-bridge-core.js'

// As in ptc-worker-cold-resume: installed native loop and SDK, inert model.
const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh')
const pkg = name => import(pathToFileURL(join(installed, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
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
const { apply: report } = await pkg('dsh-tool-subagent-report')

const message = text => createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})
const assertDiscipline = request => {
  assert.equal(request.system.split(TASK_DISCIPLINE).length - 1, 1)
  assert.ok(!JSON.stringify(request.messages).includes(TASK_DISCIPLINE), 'no copy appended to history')
}

test('actual production Leader, fresh Worker, next step, same Worker follow-up and surface replacement', {timeout:15000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'task-discipline-'))
  const ctx = new Context(), requests = [], ended = new Map()
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}) })
  new AgentRegistry(ctx); new SessionStore(ctx); new SystemPrompt(ctx,{includeRuntimeContext:false})
  new ToolRuntime(ctx); new LlmRuntime(ctx); new AgentLoop(ctx,{agents:[],maxParallelToolCalls:1})
  new SessionProjectionRegistry(ctx); new JsonlSessionPersistence(ctx,{root:join(dir,'sessions'),compression:'none'})
  new SubagentRuntime(ctx); spawn(ctx,{providerName:'spawn'}); report(ctx,{reportDelivery:'quiet'})
  postmanHarness(ctx)
  const context = Object.freeze({branch:'task/fixture',worktree:dir})
  const contexts = {get: () => context}
  const worker = createPostmanWorkerTools(ctx, undefined, contexts)
  const boundaries = createPostmanBridgeBoundaryManager(id => ctx.agents.get(id))
  t.after(() => { worker.dispose(); boundaries.disposeAll() })
  ctx.on('agent/created', ({agent}) => { worker.confirmActivation(agent); boundaries.install(agent) })
  ctx.on('agent/disposed', ({agent}) => { worker.releaseActivation(agent); boundaries.disposeAgent(agent) })
  ctx.on('session/event', (session,event) => {
    if(event.type==='turn/end' && session.header.origin==='subagent') {
      if(event.data.reason.kind==='error') ended.get(session.id)?.reject(Error(JSON.stringify(event.data)))
      else ended.get(session.id)?.resolve(session)
    }
  })
  const output = {schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}
  ctx.tools.register(defineTool({name:'read',description:'inert fixture read',parameters:{},output,execute:()=>({ok:true})}))
  for(const name of [...POSTMAN_LEADER_TOOL_ALLOWLIST,'ptc_execute']) if(!ctx.tools.get(name))
    ctx.tools.register(defineTool({name,description:name,parameters:{},output,execute:()=>({ok:true})}))
  class Model extends LlmAdapter {
    async resolveModel(provider,id) { return {provider,id,name:id,inputModalities:['text'],reasoning:{efforts:[{id:'max',name:'Max'}]}} }
    async *stream(request) {
      const agent = ctx.agents.currentInitiator()
      assertDiscipline(request)
      requests.push({agent,request})
      const count = requests.filter(r=>r.agent.id===agent.id).length
      let block = {type:'text',text:'done'}
      if(agent.session.header.origin==='subagent') {
        assert.equal(agent.session.header.cwd,dir)
        assert.equal(agent.session.header.parentSession,'leader')
        assert.ok(request.tools.some(s=>s.name==='read'))
        assert.ok(!request.tools.some(s=>s.name.startsWith('postman_')))
        if(count===1) block = {type:'tool-call',id:'read-once',name:'read',arguments:'{}'}
      } else if(agent.id==='leader') {
        assert.ok(request.tools.some(s=>s.name==='postman_worker'))
        assert.ok(!request.tools.some(s=>s.name==='postman_send_current_turn'))
      }
      yield {type:'block-end',index:0,block}; yield {type:'finish',reason:{kind:'stop'}}
    }
  }
  ctx.llm.registerAdapter(['codex'],new Model())
  const {agent:leader} = await ctx.agents.create({sessionId:'leader',meta:{cwd:dir,agentPreset:'postman-leader'},agentOptions:{provider:'codex',model:'sol'}})
  leader.followup(message('First Leader task')); await leader.whenIdle()
  assert.equal(requests.length,1); assert.equal(requests[0].agent,leader)
  const start = ctx.subagents.startContinuable.bind(ctx.subagents)
  ctx.subagents.startContinuable = async spec => { ended.set(spec.childId,Promise.withResolvers()); return start(spec) }
  const accepted = await worker.taskTool.execute({task:'Small local task',createNew:true},{agent:leader,signal:new AbortController().signal})
  assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(accepted))
  let session = await ended.get(accepted.workerSessionId).promise
  const first = requests.filter(r=>r.agent.id===accepted.workerSessionId)
  assert.equal(first.length,2,'first request plus subsequent tool-result model step')
  const continued = Promise.withResolvers(); ended.set(accepted.workerSessionId,continued)
  const follow = await worker.interruptTool.execute({task:'Continue the same task',workerSessionId:accepted.workerSessionId},{agent:leader,signal:new AbortController().signal})
  assert.equal(follow.status,'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED',JSON.stringify(follow)); assert.equal(follow.workerSessionId,accepted.workerSessionId)
  session = await continued.promise
  assert.equal(requests.filter(r=>r.agent.id===accepted.workerSessionId).length,3)

  // Use the shipped surface operation used by compaction, not a second compactor.
  // The replacement has no policy or old user content; the next request must
  // receive the registered section independently of any visible-history retention.
  const nodes = [...session.surface.nodes]
  session.append('user/message',message('Compacted task checkpoint'),{surfaceOp:{op:'replace',start:nodes[0],end:nodes.at(-1)},sourceEventSeqs:nodes})
  assert.deepEqual(session.deriveMessages().map(m=>m.content[0].text),['Compacted task checkpoint'])
  const restored = Promise.withResolvers(); ended.set(accepted.workerSessionId,restored)
  const after = await worker.interruptTool.execute({task:'Resume after surface replacement',workerSessionId:accepted.workerSessionId},{agent:leader,signal:new AbortController().signal})
  assert.equal(after.status,'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED',JSON.stringify(after)); session = await restored.promise
  const workerRequests = requests.filter(r=>r.agent.id===accepted.workerSessionId)
  assert.equal(workerRequests.length,4)
  assert.ok(!JSON.stringify(workerRequests.at(-1).request.messages).includes('Small local task'))
  assertDiscipline(workerRequests.at(-1).request)
  assert.ok(!session.events.some(e=>e.type==='user/message' && JSON.stringify(e.data).includes(TASK_DISCIPLINE)))

  const {agent:ordinary} = await ctx.agents.create({sessionId:'ordinary',meta:{cwd:dir,agentPreset:'standard'},agentOptions:{provider:'codex',model:'sol'}})
  ordinary.followup(message('Ordinary local task')); await ordinary.whenIdle()
  assert.equal(requests.at(-1).agent,ordinary)
})

// Deterministic wording regressions only, NOT an assertion of LLM compliance.
// No stable live-model semantic eval runner exists in this package.
for(const [scenario,rule] of [
  ['small edit beside tempting refactor', /smallest sufficient change and preserve existing contracts/],
  ['adjacent issue outside scope', /adjacent issue that is not required for the task, report it instead of fixing it/],
  ['task needs no new dependency', /Do not add.*dependencies.*unless required by the current task or justified by a concrete material risk present now/],
  ['local change needs no generic abstraction', /Do not add abstractions, layers, wrappers/],
  ['PASS with unchanged inputs', /Do not repeat a successful check unless relevant inputs changed/],
  ['acceptance satisfied', /Once the acceptance criteria are satisfied and required verification passes, stop. Do not start refactoring, hardening, auditing, cleanup, or another task/],
]) test('prompt semantics fixture: '+scenario,()=>assert.match(TASK_DISCIPLINE,rule))
