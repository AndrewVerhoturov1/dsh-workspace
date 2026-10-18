import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'

test('runtime status inspects the actual Host without calling a model',{timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-runtime-identity-'))
  const f=await capabilityRuntime(dir,{taskContextOptions:{writerControlFile:join(dir,'missing-controller.json')}})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true})})
  const result=await f.execute(f.leader,'ptc_execute',{program:'return await tools.postman_team_status({runtime:true})',description:'Read loaded Host identity',boundary:'semantic_decision'})
  const identity=result.value.value.runtime?.host
  assert.equal(identity?.status,'RUNTIME_IDENTITY_PROVEN',JSON.stringify(result))
  assert.equal(identity.pid,process.pid)
  assert.equal(identity.source,'v8_loaded_script')
  assert.match(identity.sha256,/^[a-f0-9]{64}$/)
  assert.ok(identity.modules.some(module=>module.name==='ptc-adapter.js'))
  assert.equal(f.requests.length,0,'read-only identity must not call the LLM adapter')
  assert.equal(result.value.value.runtime.devspace.status,'RUNTIME_SHA_UNPROVEN','missing isolated controller must stay unproven')
})
