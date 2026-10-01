import test from 'node:test'
import assert from 'node:assert/strict'
import { createPtcRuntime, validatePtcProfile, DEFAULT_LIMITS } from '../src/index.js'
const profile=(tools=[],limits={})=>({schemaVersion:1,id:'unit-test',revision:1,tools,limits:{...DEFAULT_LIMITS,...limits}})
const run=async(program, names=[],bindings={},more={})=>{const runtime=createPtcRuntime();try{return await runtime.run({program,profile:profile(names),bindings,...more})}finally{await runtime.dispose()}}

test('validates profile fields, names, limits, and own properties',()=>{
  assert.deepEqual(validatePtcProfile(profile()).tools,[])
  for(const altered of [
    {...profile(),schemaVersion:2},{...profile(),extra:1},{...profile(),revision:NaN},
    profile(['echo','echo']),profile(['*']),profile(['constructor']),profile(['a'.repeat(65)]),
    profile([], {maxWallMs:Infinity}),profile([], {maxWallMs:300001}),profile([], {maxMessageBytes:0}),
    profile([], {maxConcurrentToolCalls:65}),profile([], {maxTotalBridgeBytes:1024}),
  ])assert.throws(()=>validatePtcProfile(altered))
  assert.equal(DEFAULT_LIMITS.maxWallMs,120000)
  assert.equal(DEFAULT_LIMITS.maxOutputBytes,524288)
  assert.equal(DEFAULT_LIMITS.maxMessageBytes,1048576)
  assert.equal(validatePtcProfile(profile([],{maxWallMs:300000})).limits.maxWallMs,300000)
  assert.ok(DEFAULT_LIMITS.maxOutputBytes + 2048 <= DEFAULT_LIMITS.maxMessageBytes)
  const inherited=Object.create({echo:()=>1})
  assert.equal(Object.hasOwn(inherited,'echo'),false)
})

test('runs numbers, UTF-8, nested JSON, null, and fresh states',async()=>{
  const r=createPtcRuntime();try{
    const p=profile([])
    for(const [code,want] of [['return 42',42],[`return {name:'кириллица',list:[true,null,{n:3}]}`,{name:'кириллица',list:[true,null,{n:3}]}],['return null',null]]){
      const v=await r.run({program:code,profile:p,bindings:{}});assert.equal(v.status,'ok',JSON.stringify(v));assert.deepEqual(v.value,want)
    }
    assert.equal((await r.run({program:'globalThis.x=3; return x',profile:p,bindings:{}})).status,'ok')
    assert.equal((await r.run({program:'return typeof x',profile:p,bindings:{}})).value,'undefined')
  }finally{await r.dispose()}
})

test('handles TypeScript, errors, pending promise, and Node isolation',async()=>{
  assert.equal((await run('const n: number = 4; return n',[],{}, {language:'typescript'})).value,4)
  assert.equal((await run('return undefined')).status,'invalid-output')
  assert.notEqual((await run('return await import("node:fs")')).status,'ok')
  assert.equal((await run('return await Promise.reject(Error("no"))')).status,'runtime-error')
  assert.equal((await run('const n: number = 1')).status,'syntax-error')
  assert.equal((await run('return typeof process + typeof require + typeof fetch + Function("return typeof process")()')).value,'undefinedundefinedundefinedundefined')
  const t=await run('return await new Promise(()=>{})',[],{}, {profile:profile([],{maxWallMs:250})})
  assert.equal(t.status,'limit-exceeded');assert.equal(t.error.code,'maxWallMs')
})

test('sequences callbacks, bounds parallel calls, snapshots grants',async()=>{
  const r=createPtcRuntime();const order=[]
  try{
    const p=profile(['one','two'])
    const bindings={one:x=>{order.push('one');return {n:x.n+1}},two:x=>{order.push('two');return x},extra:()=>{throw Error('ungranted')}}
    const result=await r.run({program:'const a=await tools.one({n:1}); return await tools.two(a)',profile:p,bindings})
    assert.equal(result.status,'ok',JSON.stringify(result));assert.deepEqual(result.value,{n:2});assert.deepEqual(order,['one','two'])
    const denied=await r.run({program:'return typeof tools.extra',profile:p,bindings});assert.equal(denied.value,'undefined')
    assert.equal((await r.run({program:'return 1',profile:profile(['missing']),bindings})).status,'invalid-input')
    const rejected=await r.run({program:'try {await tools.one(null)} catch(e) {return e.message}',profile:profile(['one']),bindings:{one:()=>{throw Error('callback failure')}}})
    assert.equal(rejected.value,'callback failure')
    const parallel=await r.run({program:'return await Promise.all([tools.one({n:1}),tools.one({n:2})])',profile:profile(['one']),bindings});assert.deepEqual(parallel.value,[{n:2},{n:3}])
    assert.equal((await r.run({program:'return 1',profile:profile(['echo']),bindings:Object.create({echo:()=>1})})).status,'invalid-input')
  }finally{await r.dispose()}
})

test('bounds program, result, argument, log, loops and callback accumulation',async()=>{
  const r=createPtcRuntime();try{
    assert.equal((await r.run({program:'return 1;'+' '.repeat(270000),profile:profile(),bindings:{}})).status,'invalid-input')
    const p=profile(['echo'],{maxWallMs:700})
    const cases=[
      ['while(true){}','limit-exceeded'],
      [`return 'x'.repeat(600000)`,'limit-exceeded'],
      [`console.log('x'.repeat(600000));return 1`,'limit-exceeded'],
      [`return await tools.echo('x'.repeat(1100000))`,'limit-exceeded'],
      ['return await tools.echo(null)','runtime-error'],
    ]
    for(const [program,status] of cases){const x=await r.run({program,profile:p,bindings:{echo:()=>undefined}});assert.equal(x.status,status,JSON.stringify(x))}
  }finally{await r.dispose()}
})

test('large canonical tool JSON is processed in guest; 512 KiB result ceiling remains enforced', async()=>{
  const r=createPtcRuntime()
  try {
    const profileWithRead=profile(['read'])
    const bindings={read:()=>({lines:[{number:1,text:'я'.repeat(300000)}],totalLines:1})}
    const compact=await r.run({program:'const page=await tools.read({file_path:\'large.txt\'}); return {length:page.lines[0].text.length}',profile:profileWithRead,bindings})
    assert.equal(compact.status,'ok',JSON.stringify(compact))
    assert.deepEqual(compact.value,{length:300000})
    assert.equal(compact.effects.completed,1)
    const within=await r.run({program:"return 'x'.repeat(524286)",profile:profile(),bindings:{}})
    assert.equal(within.status,'ok',JSON.stringify({status:within.status,error:within.error}))
    assert.equal(within.value.length,524286)
    const beyond=await r.run({program:"return 'x'.repeat(524288)",profile:profile(),bindings:{}})
    assert.equal(beyond.status,'limit-exceeded')
    assert.equal(beyond.error.code,'maxOutputBytes')
  } finally { await r.dispose() }
})

test('reports unawaited calls and retains unresolved host work across runs',async()=>{
  const r=createPtcRuntime();let release,started;const began=new Promise(resolve=>started=resolve)
  const unresolved=new Promise(resolve=>release=resolve)
  try{
    const p=profile(['hold'],{maxWallMs:800})
    const first=await r.run({program:'tools.hold(null);return 7',profile:p,bindings:{hold:()=>{started();return unresolved}}})
    await began;assert.equal(first.status,'unawaited-calls');assert.equal(first.effects.pending,1)
    assert.equal((await r.run({program:'return 3',profile:profile(),bindings:{}})).value,3)
  }finally{release(1);await r.dispose()}
})

test('abort/dispose terminate child and do not claim pending callback cancelled',async()=>{
  const r=createPtcRuntime(),controller=new AbortController()
  const begun=new Promise(resolve=>{globalThis.__begun=resolve});let release
  const hold=new Promise(resolve=>release=resolve)
  try {
    const work=r.run({program:'return await tools.hold(null)',profile:profile(['hold']),bindings:{hold:()=>{globalThis.__begun();return hold}},signal:controller.signal})
    await begun;controller.abort()
    const x=await work;assert.equal(x.status,'cancelled');assert.equal(x.effects.pending,1)
    assert.equal((await r.run({program:'return 5',profile:profile(),bindings:{}})).value,5)
    const next=r.run({program:'while(true){}',profile:profile(),bindings:{}})
    await r.dispose();assert.equal((await next).status,'cancelled')
    await r.dispose();assert.equal((await r.run({program:'return 1',profile:profile(),bindings:{}})).status,'invalid-input')
  }finally{release(1);await r.dispose();delete globalThis.__begun}
})

test('snapshots grants and isolates two concurrent profiles, aborting one',async()=>{
  const r=createPtcRuntime(),controller=new AbortController()
  let release,started
  const began=new Promise(resolve=>started=resolve),held=new Promise(resolve=>release=resolve)
  try {
    const p=profile(['hold']);const b={hold:()=>{started();return held},extra:()=>{throw Error('ungranted')}}
    const one=r.run({program:'return await tools.hold(null)',profile:p,bindings:b,signal:controller.signal})
    await began
    p.tools[0]='extra';b.hold=()=>{throw Error('mutated')}
    const two=r.run({program:'return typeof tools.hold + await tools.echo({n:9})',profile:profile(['echo']),bindings:{echo:x=>x}})
    const third=await r.run({program:'return 1',profile:profile(),bindings:{}})
    assert.equal(third.status,'ok')
    assert.equal((await two).value,'undefined[object Object]')
    controller.abort();const a=await one;assert.equal(a.status,'cancelled');assert.equal(a.effects.pending,1)
  } finally {release(1);await r.dispose()}
})

test('pending callbacks cap accumulations and late reject is handled',async()=>{
  const r=createPtcRuntime();const releases=[]
  try{
    for(let i=0;i<64;i++){
      let reject;const pending=new Promise((_,rj)=>reject=rj);releases.push(reject)
      const x=await r.run({program:'tools.hold(null);return null',profile:profile(['hold'],{maxWallMs:800}),bindings:{hold:()=>pending}})
      assert.equal(x.status,'unawaited-calls')
    }
    const denied=await r.run({program:'return 1',profile:profile(),bindings:{}})
    assert.equal(denied.status,'limit-exceeded');assert.equal(denied.error.code,'maxOutstanding')
  }finally{for(const reject of releases)reject(Error('late'));await r.dispose()}
})

test('bounded QuickJS memory and stack failures do not poison subsequent run',async()=>{
  const r=createPtcRuntime();try{
    const p=profile([],{quickjsMemoryBytes:8388608,maxStackBytes:65536,maxWallMs:800})
    const memory=await r.run({program:`const a=[];while(true)a.push(new Array(1000).fill('x'))`,profile:p,bindings:{}})
    assert.notEqual(memory.status,'ok')
    const stack=await r.run({program:'function f(){return f()} return f()',profile:p,bindings:{}})
    assert.notEqual(stack.status,'ok')
    assert.equal((await r.run({program:'return 2',profile:p,bindings:{}})).value,2)
  }finally{await r.dispose()}
})

test('guest rejects unsupported JSON, mutation of global JSON, and callback effect before exception',async()=>{
  const r=createPtcRuntime();let count=0
  try{
    for(const program of ['return 1n','return {a:undefined}','return new Date()',`return {'__proto__':1,constructor:2}`,'return [1,,2]'])
      assert.notEqual((await r.run({program,profile:profile(),bindings:{}})).status,'ok',program)
    const x=await r.run({program:'JSON.stringify=()=>"forged"; const v=await tools.echo({n:2}); return v',profile:profile(['echo']),bindings:{echo:v=>v}})
    assert.equal(x.status,'ok',JSON.stringify(x));assert.deepEqual(x.value,{n:2})
    const err=await r.run({program:'await tools.effect(null);throw Error("later")',profile:profile(['effect']),bindings:{effect:()=>{count++;return null}}})
    assert.equal(err.status,'runtime-error');assert.equal(count,1);assert.equal(err.effects.completed,1)
  }finally{await r.dispose()}
})

test('queue limit rejects excess parallel calls before extra callback',async()=>{
  const r=createPtcRuntime();let started=0,release
  const hold=new Promise(resolve=>release=resolve)
  try{
    const p=profile(['hold'],{maxConcurrentToolCalls:1,maxQueuedToolCalls:1,maxToolCalls:4,maxWallMs:1000})
    const result=await r.run({program:'await Promise.all([tools.hold(1),tools.hold(2),tools.hold(3)]);return 1',profile:p,bindings:{hold:()=>{started++;return hold}}})
    assert.equal(result.status,'limit-exceeded',JSON.stringify(result));assert.equal(result.error.code,'maxQueuedToolCalls');assert.ok(started<=1)
  }finally{release(null);await r.dispose()}
})

test('callback response budget closes delivery even when guest catches errors',async()=>{
  for(const big of [()=>'x'.repeat(1100000),()=> '\n'.repeat(600000)]) {
    let effects=0
    const x=await run('try {await tools.big(null)} catch {} return await tools.effect(null)', ['big','effect'], {big,effect:()=>{effects++;return 3}})
    assert.equal(x.status,'limit-exceeded',JSON.stringify(x));assert.equal(x.error.code,'maxMessageBytes')
    assert.equal(x.effects.failed,1);assert.equal(effects,0)
  }
  const caught=await run('try {await tools.big(null)} catch(e) {return e.message}', ['big'], {big:()=>{throw Error('ordinary failure')}})
  assert.equal(caught.status,'ok',JSON.stringify(caught));assert.equal(caught.value,'ordinary failure')
})

test('minimum accepted value depth and nodes can still start a program',async()=>{
  const r=createPtcRuntime();try {
    const p=profile([],{maxValueDepth:1,maxValueNodes:1})
    validatePtcProfile(p)
    const x=await r.run({program:'return 3',profile:p,bindings:{}})
    assert.equal(x.status,'ok',JSON.stringify(x));assert.equal(x.value,3)
    const echo=profile(['echo'],{maxValueDepth:1,maxValueNodes:1})
    const y=await r.run({program:'return await tools.echo(2)',profile:echo,bindings:{echo:v=>v+1}})
    assert.equal(y.status,'ok',JSON.stringify(y));assert.equal(y.value,3)
  }finally{await r.dispose()}
})

test('ten active PTC processes are allowed; eleventh rejected; a freed slot is reusable', { timeout: 30000 }, async () => {
  const runtime = createPtcRuntime(), releases = [], entered = [], runs = []
  try {
    for (let i = 0; i < 10; i++) {
      let release, enter
      const held = new Promise(resolve => release = resolve)
      entered.push(new Promise(resolve => enter = resolve))
      releases.push(release)
      runs.push(runtime.run({ program: 'return await tools.hold(null)', profile: profile(['hold']),
        bindings: { hold: () => { enter(); return held } } }))
    }
    await Promise.all(entered)
    const denied = await runtime.run({ program: 'return 11', profile: profile(), bindings: {} })
    assert.equal(denied.status, 'limit-exceeded')
    assert.equal(denied.error.code, 'maxProcesses')
    releases[0](0)
    assert.equal((await runs[0]).status, 'ok')
    const replacement = await runtime.run({ program: 'return 12', profile: profile(), bindings: {} })
    assert.equal(replacement.status, 'ok')
    assert.equal(replacement.value, 12)
    releases.forEach((release, i) => release(i))
    const results = await Promise.all(runs)
    assert.ok(results.every(result => result.status === 'ok'))
    assert.deepEqual(results.map(result => result.value), Array.from({ length: 10 }, (_, i) => i))
  } finally { releases.forEach(release => release(null)); await runtime.dispose() }
})

