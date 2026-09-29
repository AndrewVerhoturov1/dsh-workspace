import test from 'node:test'
import assert from 'node:assert/strict'
import { createPtcRuntimeForTest } from '../src/runtime.js'
import { DEFAULT_LIMITS } from '../src/profiles.js'
const entry=new URL('./fake-executor.mjs',import.meta.url)
const profile={schemaVersion:1,id:'fixture',revision:1,tools:['echo'],limits:DEFAULT_LIMITS}

test('parent rejects forged frames before any forged callback',async()=>{
  const r=createPtcRuntimeForTest(entry);let called=0
  try {
    for(const program of ['invalid-version','foreign-run','duplicate-ready','duplicate-call','ungranted-call','terminal-early','truncated','oversized']){
      const x=await r.run({program,profile,bindings:{echo:()=>{called++;return 1}}})
      assert.equal(x.status,'protocol-error',program+': '+JSON.stringify(x))
    }
    assert.equal(called,1,'first valid call before duplicate may execute')
  }finally{await r.dispose()}
})

test('parent distinguishes crash, abort before readiness and a healthy next run',async()=>{
  const r=createPtcRuntimeForTest(entry);try{
    const crash=await r.run({program:'crash',profile,bindings:{echo:()=>1}});assert.equal(crash.status,'process-error')
    const controller=new AbortController()
    const pending=r.run({program:'pending-ready',profile,bindings:{echo:()=>1},signal:controller.signal})
    controller.abort();assert.equal((await pending).status,'cancelled')
    const fine=await r.run({program:'good',profile,bindings:{echo:()=>1}});assert.equal(fine.value,3)
  }finally{await r.dispose()}
})
