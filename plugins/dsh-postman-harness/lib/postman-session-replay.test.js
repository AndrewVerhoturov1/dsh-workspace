import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {capabilityRuntime, native} from './fixtures/postman-capability-runtime.js'

const ptc = program => ({program, description:'Verify exact durable replay and retirement'})
const unwrap = result => {
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.status, 'ok', JSON.stringify(result.value))
  return result.value.value
}

test('legacy informational cost events survive real cold continuation and native retirement without journal rewrite', {timeout:30000}, async t => {
  const dir=await mkdtemp(join(tmpdir(),'postman-session-replay-'))
  let f
  t.after(async()=>{await f?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  const options={plan:a=>a.id==='leader'?null:{name:'report',args:{output:'Finite assignment completed; exact native history retained.'}}}
  f=await capabilityRuntime(dir,options)
  await f.prepare();await f.turn(f.leader)
  // The historical writer emitted informational snapshots without ignorable.
  // Real Agent Loop turns/report results, never synthetic turn/end evidence.
  f.ctx.on('llm/stream',(request,next)=>(async function*(){
    const session=f.ctx.sessions.get(request.sessionId)
    session?.append('cost-panel/attempt',{id:session.events.length,provider:request.provider,model:request.model,purpose:'conversation',usage:null,status:'started'})
    yield* next()
  })())
  const call=async(name,args={})=>unwrap(await f.execute(f.leader,'ptc_execute',ptc('return await tools.'+name+'('+JSON.stringify(args)+')')))
  const first=await call('postman_worker',{task:'Bounded journal compatibility evidence'})
  assert.equal(first.status,'POSTMAN_WORKER_TASK_ACCEPTED')
  const id=first.workerSessionId
  await f.childDone(id);await f.turn(f.leader,'Consume exact first report')
  const before=await f.ctx.sessionPersistence.inspect(id)
  const cost=before.events.filter(e=>e.type==='cost-panel/attempt')
  assert.ok(cost.length);assert.ok(cost.every(e=>e.ignorable===undefined))
  const log=f.ctx.sessionPersistence.locate(before.meta).path
  const original=await readFile(log)
  await f.dispose();f=await capabilityRuntime(dir,{...options,resume:true})
  await f.prepare();await f.turn(f.leader,'Continue same approved assignment after cold resume')
  const cold=await f.ctx.sessionPersistence.inspect(id)
  assert.deepEqual(cold.events,before.events);assert.deepEqual(await readFile(log),original)
  const next=await call('postman_worker',{workerSessionId:id,task:'Same finite assignment after native cold continuation'})
  assert.equal(next.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(next));assert.equal(next.workerSessionId,id)
  await f.childDone(id);await f.turn(f.leader,'Consume exact continued report')
  const continued=await f.ctx.sessionPersistence.inspect(id)
  assert.deepEqual(continued.events.slice(0,before.events.length),before.events)
  assert.equal((await call('postman_worker_stop',{workerSessionId:id,mode:'close'})).status,'POSTMAN_WORKER_STOPPED')
  assert.equal(await f.ctx.subagents.inspectClosedContinuableChild(f.leader,id),true)
  await assert.rejects(f.ctx.subagents.followup(f.leader,id,[{type:'text',text:'late'}],{source:{kind:'user'},signal:new AbortController().signal}),/closed/)
})

test('known informational cost type does not allow an unknown required event or alter saved bytes',async t=>{
  const {Context}=await native('cordis')
  const {Session,SessionStore}=await native('dsh-session')
  const {JsonlSessionPersistence}=await native('dsh-session-persistence-jsonl')
  const dir=await mkdtemp(join(tmpdir(),'postman-session-unknown-'))
  const ctx=new Context();new SessionStore(ctx)
  const persistence=new JsonlSessionPersistence(ctx,{root:dir,compression:'none'})
  t.after(async()=>{await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true})})
  const session=Session.create('unknown',[],{id:'unknown',version:0,createdAt:Date.now(),cwd:dir})
  session.append('cost-panel/attempt',{id:0,usage:null,status:'started'})
  session.append('extension/required-unknown',{required:true})
  await persistence.create(session.header);await persistence.append(session.id,session.events)
  const log=persistence.locate(session.header).path, before=await readFile(log)
  await assert.rejects(persistence.inspect(session.id),/extension\/required-unknown.*unknown to this harness/)
  assert.deepEqual(await readFile(log),before)
})
