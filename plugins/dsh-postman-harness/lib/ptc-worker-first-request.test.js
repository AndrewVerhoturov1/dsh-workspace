import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {stage1Runtime} from './fixtures/postman-stage1-runtime.js'

// Replaces the old Worker PTC-first contract. Even an experimental Leader's
// child is FAST/direct; no generic spawning or nested PTC bypass.
test('first native Worker request rejects generic delegation and PTC but executes direct read',{timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-fast-first-'))
  const f=await stage1Runtime(dir,{plan:(_a,_r,n)=>n===1?{name:'subagent',args:{}}:n===2?{name:'ptc_execute',args:{program:'return 1',description:'forbidden',boundary:'task_complete'}}:n===3?{name:'read',args:{}}:{name:'report',args:{output:'direct evidence delivered'}}})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  const accepted=await f.run(f.worker.taskTool,{task:'bounded direct read only'});assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED')
  const child=await f.settled(accepted.workerSessionId)
  const results=child.session.events.filter(e=>e.type==='tool/result')
  assert.equal(results[0].data.message.content[0].isError,true)
  assert.equal(results[1].data.message.content[0].isError,true)
  assert.ok(f.calls.some(c=>c.name==='read'))
  assert.ok(!f.calls.some(c=>['subagent','ptc_execute'].includes(c.name)))
  assert.equal(f.requests[0].request.reasoningEffort,'low')
})
