import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'
import {assertManagementRequest} from './fixtures/postman-stage3-contract.js'

const ptc = program => ({name:'ptc_execute',args:{program,
  description:'Collect exact phase evidence; stop at controlled review',boundary:'semantic_decision'}})
const small = "await tools.read({file_path:'a.txt'}); return {count:1}"
const batch = "await tools.read({file_path:'a.txt'}); await tools.read({file_path:'b.txt'}); await tools.grep({pattern:'A',path:'a.txt'}); return {ready:true}"
const ok = r => {assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.value.status,'ok',JSON.stringify(r.value));return r.value.value}
const notices = /PTC EFFICIENCY NOTICE|PTC UNDERBATCH STREAK/
const assertStep = (role,request,n) => {
  assertManagementRequest(role,request)
  if (n===2) assert.match(request.system,/PTC EFFICIENCY NOTICE/)
  else if (n===3) {
    assert.match(request.system,/PTC UNDERBATCH STREAK: 2/)
    assert.match(request.system,/Do not use semantic_decision as a tool-call boundary/)
  } else assert.doesNotMatch(request.system,notices)
}

for (const preset of ['postman-leader','postman-leader-ptc'])
test('Stage 3.5A next actual model request receives ephemeral feedback: '+preset,{timeout:45000},async t => {
  const dir=await mkdtemp(join(tmpdir(),'stage35a-leader-'))
  const diagnostics=[]
  const f=await capabilityRuntime(dir,{preset,plan:async (agent,request,n)=>{
    assertStep('leader',request,n)
    return n<=2 ? ptc(small) : n===3 ? ptc(batch) : null
  }})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  f.ctx.logger.exporter({export: m=>{if(m.name==='postman-ptc')diagnostics.push(m.args[1])}})
  await writeFile(join(dir,'a.txt'),'A');await writeFile(join(dir,'b.txt'),'B')
  await f.turn(f.leader)
  assert.deepEqual(diagnostics.map(d=>[d.nestedToolCalls,d.underbatchedCandidate,d.underbatchedStreak]),
    [[1,true,1],[1,true,2],[3,false,0]])
  assert.equal(f.requests.length,4)
  assert.ok(f.results.every(r=>!r.result.isError))
  assert.equal(f.leader.session.events.some(e=>e.type==='postman/ptc-run'),false)
  assert.ok(!f.leader.session.events.filter(e=>e.type==='user/message').some(e=>JSON.stringify(e.data).includes('PTC UNDERBATCH STREAK: 2'))) // Native model-request audit may record system text; no durable instruction message.
})

test('Stage 3.5A exact Sol gets next-request feedback; FAST and Leader do not inherit it',{timeout:60000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stage35a-sol-'))
  const diagnostics=[], gate=Promise.withResolvers(), warned=Promise.withResolvers()
  t.after(()=>gate.resolve())
  const f=await capabilityRuntime(dir,{preset:'postman-leader',plan:async(agent,request,n)=>{
    if(agent.id==='leader') {assertManagementRequest('leader',request);assert.doesNotMatch(request.system,notices);return null}
    if(agent.options.model==='gpt-6.1-sol') {
      assertStep('sol',request,n)
      if(n===3) {warned.resolve(agent);await gate.promise}
      return n<=2 ? ptc(small) : n===3 ? ptc(batch) : {name:'report',args:{output:'PASS controlled engineering phase evidence'}}
    }
    const role=agent.session.events.some(e=>e.type==='subagent/descriptor'&&e.data.label==='Secretary')?'secretary':'luna'
    assertManagementRequest(role,request);assert.doesNotMatch(request.system,notices)
    return {name:'report',args:{output:'PASS controlled bounded facts'}}
  }})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  f.ctx.logger.exporter({export:m=>{if(m.name==='postman-ptc')diagnostics.push(m.args[1])}})
  await f.turn(f.leader);await f.prepare();await writeFile(join(f.worktree,'a.txt'),'A');await writeFile(join(f.worktree,'b.txt'),'B')
  const dispatch=async(name,args)=>ok(await f.execute(f.leader,'ptc_execute',ptc('return await tools.'+name+'('+JSON.stringify(args)+')').args))
  const accepted=await dispatch('postman_sol_worker',{task:'Explicit user-selected Sol Worker. Controlled bounded exact evidence.'})
  const sol=await warned.promise
  assert.equal(accepted.workerSessionId,sol.id)
  const own=await f.execute(sol,'postman_worker',{task:'Bounded owned FAST facts',hardBudget:15})
  assert.equal(own.isError,false,JSON.stringify(own));await f.childDone(own.value.workerSessionId)
  for(const name of ['postman_worker','postman_secretary']) {
    const child=await dispatch(name,{task:'Bounded FAST facts',hardBudget:15});await f.childDone(child.workerSessionId)
  }
  gate.resolve();await f.childDone(sol.id)
  const runs=diagnostics.filter(d=>d.sessionId===sol.id)
  assert.deepEqual(runs.map(d=>[d.nestedToolCalls,d.underbatchedCandidate,d.underbatchedStreak]),
    [[1,true,1],[1,true,2],[3,false,0]])
  assert.ok(diagnostics.filter(d=>d.role==='leader').every(d=>!d.underbatchedCandidate)) // accepted async dispatch exemption
  assert.ok(f.requests.some(r=>r.agent.id===own.value.workerSessionId))
})
