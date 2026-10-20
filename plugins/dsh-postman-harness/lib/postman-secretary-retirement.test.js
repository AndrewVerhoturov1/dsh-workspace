import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'
const value=result=>{assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.status,'ok',JSON.stringify(result));return result.value.value}
for(const cold of [false,true]) test('Secretary retirement preserves ledger without Git '+(cold?'after reload':'in the same runtime'),{timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-secretary-retire-'));let f
  const counts=new Map(),options={plan:agent=>{
    if(agent.id==='leader')return null
    const n=(counts.get(agent.id)??0)+1;counts.set(agent.id,n)
    return n===1?{name:'postman_secretary_ledger',args:{revision:0,content:'Preserved exact research facts'}}:{name:'report',args:{output:'Research finished'}}
  }}
  t.after(async()=>{await f?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
  f=await capabilityRuntime(dir,options);await f.turn(f.leader)
  const execute=program=>f.execute(f.leader,'ptc_execute',{program}).then(value)
  const accepted=await execute('return await tools.postman_secretary({task:"Collect bounded facts",createNew:true})')
  assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED');await f.childDone(accepted.workerSessionId);await f.leader.whenIdle()
  assert.equal(f.registry.readLedger('leader').revision,1)
  if(cold){await f.dispose();f=await capabilityRuntime(dir,{...options,resume:true})}
  const before=f.requests.length
  const result=await execute('return await tools.postman_worker_stop('+JSON.stringify({workerSessionId:accepted.workerSessionId,mode:'close'})+')')
  assert.equal(result.status,'POSTMAN_WORKER_STOPPED',JSON.stringify(result));assert.equal(result.taskCompleted,false)
  assert.equal(f.registry.get('leader').workers[accepted.workerSessionId],undefined)
  assert.equal(await f.ctx.subagents.inspectClosedContinuableChild(f.leader,accepted.workerSessionId),true)
  assert.equal(f.registry.readLedger('leader').content,'Preserved exact research facts')
  assert.equal(f.requests.length,before,'retirement does not invoke a model')
})
