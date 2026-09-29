import test from 'node:test'
import assert from 'node:assert/strict'
import { createPtcRuntimeForTest } from '../src/runtime.js'
import { DEFAULT_LIMITS } from '../src/profiles.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { encodeFrame, message } from '../src/protocol.js'
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

test('broken pipe during large start cannot crash parent; next run succeeds',()=>{
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./pipe-parent.mjs',import.meta.url))],{encoding:'utf8',timeout:10000})
  assert.equal(child.status,0,child.stderr || child.stdout)
})

test('abort settles a start send blocked by an unread child pipe',async()=>{
  const r=createPtcRuntimeForTest(new URL('./stalled-input.mjs',import.meta.url))
  const controller=new AbortController()
  try {
    const work=r.run({program:' '.repeat(250000),profile,bindings:{echo:()=>3},signal:controller.signal})
    setTimeout(()=>controller.abort(),100)
    const x=await work
    assert.equal(x.status,'cancelled',JSON.stringify(x))
  }finally{await r.dispose()}
})

test('abort settles a callback reply blocked by an unread child pipe',async()=>{
  const r=createPtcRuntimeForTest(entry),controller=new AbortController()
  let called
  const began=new Promise(resolve=>called=resolve)
  try {
    const work=r.run({program:'reply-stall',profile,bindings:{echo:()=>{called();return 'x'.repeat(900000)}},signal:controller.signal})
    await began;setTimeout(()=>controller.abort(),100)
    const x=await work;assert.equal(x.status,'cancelled',JSON.stringify(x));assert.equal(x.effects.completed,1)
  }finally{await r.dispose()}
})

test('parent handles a child that closes stdin before its callback reply',async()=>{
  const r=createPtcRuntimeForTest(entry)
  try {
    const x=await r.run({program:'close-stdin',profile,bindings:{echo:()=>3}})
    assert.notEqual(x.status,'ok',JSON.stringify(x))
    const next=await r.run({program:'good',profile,bindings:{echo:()=>3}})
    assert.equal(next.status,'ok',JSON.stringify(next))
  }finally{await r.dispose()}
})

test('Host effect snapshot observes completion during abort cleanup',async()=>{
  const r=createPtcRuntimeForTest(entry),controller=new AbortController()
  let began,settled=false
  const started=new Promise(resolve=>began=resolve)
  try {
    const work=r.run({program:'abort-settle',profile,bindings:{echo:(_,ctx)=>new Promise(resolve=>{began();ctx.signal.addEventListener('abort',()=>{settled=true;resolve(3)},{once:true})})},signal:controller.signal})
    await started;controller.abort()
    const x=await work
    assert.equal(x.status,'cancelled');assert.equal(settled,true)
    assert.equal(x.effects.completed,1,JSON.stringify(x));assert.equal(x.effects.pending,0)
  }finally{await r.dispose()}
})

test('combined call/done frame never marks an unstarted Host effect as running',async()=>{
  const r=createPtcRuntimeForTest(entry);let invoked=0
  try{
    const x=await r.run({program:'call-done',profile,bindings:{echo:()=>{invoked++;return 3}}})
    assert.equal(invoked,0,JSON.stringify(x));assert.equal(x.status,'unawaited-calls',JSON.stringify(x))
    assert.equal(x.effects.pending,0);assert.equal(x.effects.calls[0].state,'not-started')
  }finally{await r.dispose()}
})

test('cleanup failures cannot accompany success; original failure remains primary',async()=>{
  const r=createPtcRuntimeForTest(entry)
  try{
    const contradicted=await r.run({program:'contradicted-done',profile,bindings:{echo:()=>3}})
    assert.equal(contradicted.status,'cleanup-error',JSON.stringify(contradicted))
    assert.equal(contradicted.cleanupError.code,'child-cleanup')
    const failed=await r.run({program:'failed-done',profile,bindings:{echo:()=>3}})
    assert.equal(failed.status,'runtime-error');assert.equal(failed.error.code,'program');assert.equal(failed.cleanupError.code,'child-cleanup')
  }finally{await r.dispose()}
  const cleanup=createPtcRuntimeForTest(entry,async(dir,options)=>{await rm(dir,options);throw Error('forced cleanup')})
  try{
    const x=await cleanup.run({program:'good',profile,bindings:{echo:()=>3}})
    assert.equal(x.status,'cleanup-error',JSON.stringify(x));assert.equal(x.cleanupError.code,'temp-cleanup')
  }finally{await cleanup.dispose()}
})

test('an unconfirmed child exit demotes success and retains the active slot',async()=>{
  const directories=[], fallbackCalls=[]
  const fakeFallback=(exe,args,options)=>{
    fallbackCalls.push({exe,args,options})
    const killer=new EventEmitter()
    queueMicrotask(()=>killer.emit('close',0))
    return killer
  }
  const fakeSpawn=(_exe,_args,options)=>{
    directories.push(options.cwd)
    const child=new EventEmitter()
    child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough()
    child.stdin=new Writable({write(chunk,_encoding,callback){
      const runId=JSON.parse(chunk.subarray(4).toString('utf8')).runId
      queueMicrotask(()=>{
        child.stdout.write(encodeFrame(message('ready',runId),DEFAULT_LIMITS))
        child.stdout.write(encodeFrame(message('done',runId,{status:'ok',value:3}),DEFAULT_LIMITS))
      })
      callback()
    }})
    child.kill=()=>true // Reports a signal request, never confirms close.
    return child
  }
  const r=createPtcRuntimeForTest(entry,rm,fakeSpawn,fakeFallback)
  try {
    const x=await r.run({program:'good',profile,bindings:{echo:()=>3}})
    assert.equal(x.status,'cleanup-error',JSON.stringify(x));assert.equal(x.cleanupError.code,'unconfirmed-exit')
    const second=await r.run({program:'good',profile,bindings:{echo:()=>3}})
    assert.equal(second.status,'cleanup-error')
    assert.equal((await r.run({program:'good',profile,bindings:{echo:()=>3}})).error.code,'maxProcesses')
    if(process.platform==='win32') {
      assert.equal(fallbackCalls.length,2)
      for(const call of fallbackCalls) {
        assert.equal(call.exe,join(process.env.SystemRoot||'C:/Windows','System32','taskkill.exe'))
        assert.deepEqual(call.args,['/PID','12345','/T','/F'])
        assert.deepEqual(call.options,{windowsHide:true,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot||'C:/Windows'}})
      }
    } else assert.equal(fallbackCalls.length,0)
  }finally {await r.dispose();for(const dir of directories)await rm(dir,{recursive:true,force:true})}
})

test('concurrent and repeated dispose wait until ongoing cleanup finishes',async()=>{
  let started,cleaning,release
  const began=new Promise(resolve=>started=resolve)
  const cleanupBegan=new Promise(resolve=>cleaning=resolve)
  const releaseCleanup=new Promise(resolve=>release=resolve)
  const r=createPtcRuntimeForTest(entry,async(dir,options)=>{cleaning();await releaseCleanup;await rm(dir,options)})
  const work=r.run({program:'abort-settle',profile,bindings:{echo:(_,ctx)=>{started();return new Promise(resolve=>ctx.signal.addEventListener('abort',()=>resolve(3),{once:true}))}}})
  await began
  const a=r.dispose(), b=r.dispose()
  assert.equal(a,b)
  let settled=false;b.then(()=>{settled=true})
  await cleanupBegan;assert.equal(settled,false)
  release();await Promise.all([a,b]);assert.equal((await work).status,'cancelled')
  assert.equal(r.dispose(),a)
})
