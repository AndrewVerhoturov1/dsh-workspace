import assert from 'node:assert/strict'
import test from 'node:test'
import { createPtcRuntime, DEFAULT_LIMITS } from 'dsh-ptc'
import { buildPtcHelperPrelude, ptcHelperGuidance } from './ptc-helpers.js'

const helper = (tools, fullTextRead = false) => new Function('tools', buildPtcHelperPrelude(Object.keys(tools), undefined, fullTextRead) + '\nreturn ptc')(tools)
const read = documents => async ({ file_path, offset, limit }) => {
  const lines = documents[file_path].split('\n')
  return { totalLines: lines.length, lines: lines.slice(offset - 1, offset - 1 + limit).map((text, i) => ({ number: offset + i, text })) }
}

test('expectStatus accepts exact statuses and preserves the original object', () => {
  const ptc = helper({})
  const result = { status: 'TASK_CONTEXT_READY', evidence: 1 }
  assert.equal(ptc.expectStatus(result, ['TASK_CONTEXT_READY']), result)
  for (const status of ['task_context_ready', 'TASK_CONTEXT_READY_EXTRA', ' TASK_CONTEXT_READY', 'NEW_STATUS'])
    assert.throws(() => ptc.expectStatus({ status }, ['TASK_CONTEXT_READY']), /unexpected status/)
  for (const result of [null, [], {}, { status: 1 }, 'READY', Object.create({ status: 'READY' })])
    assert.throws(() => ptc.expectStatus(result, ['READY']), /object with a string status/)
  for (const statuses of [null, 'READY', [], [''], [1], ['READY', null], Array(2)])
    assert.throws(() => ptc.expectStatus({ status: 'READY' }, statuses), /non-empty list|unknown or unavailable tool/)
})

test('utf8Bytes and jsonBytes count Cyrillic, emoji, escaping and lone surrogates exactly', () => {
  const ptc = helper({})
  for (const text of ['', 'ascii', 'кириллица', '中文', 'a😀я', '\ud800', '\udfff', '\n"\\']) {
    assert.equal(ptc.utf8Bytes(text), Buffer.byteLength(text, 'utf8'), text)
    const value = { text, count: 3, list: [true, null] }
    assert.equal(ptc.jsonBytes(value), Buffer.byteLength(JSON.stringify(value), 'utf8'))
  }
  assert.throws(() => ptc.utf8Bytes(3), /requires a string/)
  for (const value of [undefined, () => {}, { missing: undefined }, { n: NaN }, new Date(), Array(2)])
    assert.throws(() => ptc.jsonBytes(value), /JSON-compatible/)
  const cycle = {}; cycle.self = cycle
  assert.throws(() => ptc.jsonBytes(cycle), /circular/i)
})

test('readAllText reads >512 KiB internally, pages in order and uses UTF-8 byte bounds', async () => {
  const text = Array.from({ length: 2000 }, (_, i) => 'я'.repeat(350) + i).join('\n')
  const calls = []
  const ptc = helper({ read: args => { calls.push(args); return read({ large: text })(args) } })
  assert.equal(await ptc.readAllText({ file_path: 'large', page_limit: 100 }), text)
  assert.equal(calls.length, 20)
  assert.deepEqual(calls.map(call => call.offset), Array.from({ length: 20 }, (_, i) => 1 + i * 100))
  await assert.rejects(ptc.readAllText({ file_path: 'large', max_bytes: text.length }), /max_bytes exceeded/)
  await assert.rejects(ptc.readAllText({ file_path: 'large', max_chars: 10 }), /max_chars exceeded/)
  const exact = helper({ read: read({ exact: 'я\n😀' }) })
  assert.equal(await exact.readAllText({ file_path: 'exact', page_limit: 1, max_bytes: 7 }), 'я\n😀')
  await assert.rejects(exact.readAllText({ file_path: 'exact', page_limit: 1, max_bytes: 6 }), /max_bytes/)
  const tooBig = helper({ read: read({ huge: 'я'.repeat(2100000) }) })
  await assert.rejects(tooBig.readAllText({ file_path: 'huge' }), /max_bytes exceeded/)
})

test('readMany counts aggregate UTF-8 JSON including metadata and escaping, not per-file chars alone', async () => {
  const text = 'я'.repeat(150000)
  const ptc = helper({ read: read({ a: text, b: text }) })
  await assert.rejects(ptc.readMany({ files: ['a', 'b'], max_chars_per_file: 150000 }), /max_total_bytes exceeded/)
  const many = await ptc.readMany({ files: ['a', 'b'], max_total_bytes: 700000 })
  assert.equal(many.length, 2); assert.equal(many[1].text, text)
  const expected = Buffer.byteLength(JSON.stringify([{ file_path: 'a', text }]), 'utf8')
  assert.equal((await ptc.readMany({ files: ['a'], max_total_bytes: expected })).length, 1)
  await assert.rejects(ptc.readMany({ files: ['a'], max_total_bytes: expected - 1 }), /max_total_bytes/)
  const escaped = helper({ read: read({ a: '"'.repeat(100), b: '"'.repeat(100) }) })
  await assert.rejects(escaped.readMany({ files: ['a', 'b'], max_total_bytes: 300 }), /max_total_bytes/)
})

test('mapTextFiles reads sequentially, reduces each file before the next, and bounds retained JSON', async () => {
  const order = [], documents = { a: '# Заголовок\nWorker\nтекст', b: '# Другой\nBridge' }
  const ptc = helper({ read: args => { order.push('read:' + args.file_path); return read(documents)(args) } })
  const result = await ptc.mapTextFiles({ files: ['a', 'b'], page_limit: 10 }, ({ file_path, text }) => {
    order.push('map:' + file_path)
    return { file_path, headings: text.split('\n').filter(line => /^# /.test(line)) }
  })
  assert.deepEqual(order, ['read:a', 'map:a', 'read:b', 'map:b'])
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { file_path: 'a', headings: ['# Заголовок'] }, { file_path: 'b', headings: ['# Другой'] },
  ])
  await assert.rejects(ptc.mapTextFiles({ files: ['a'] }, null), /local function/)
  await assert.rejects(ptc.mapTextFiles({ files: ['a'] }, () => undefined), /JSON-compatible/)
  await assert.rejects(ptc.mapTextFiles({ files: ['a'], max_total_bytes: 10 }, () => 'x'.repeat(20)), /max_total_bytes/)
  for (const options of [null, {}, { files: [] }, { files: ['a', 3] }, { files: Array(2) }])
    await assert.rejects(ptc.readMany(options), /options|files/)
  for (const options of [{ file_path: '' }, { file_path: 'a', page_limit: 0 }, { file_path: 'a', max_bytes: -1 }])
    await assert.rejects(ptc.readAllText(options), /file_path|positive integer/)
})

test('mapTextFiles rejects direct full-text retention; readMany remains the raw reader', async () => {
  const text = '# heading\nfull source', ptc = helper({ read: read({ a: text }) })
  for (const mapper of [({text}) => text, ({file_path,text}) => ({file_path,text}), ({text}) => ({raw:text}), ({text}) => [text]])
    await assert.rejects(ptc.mapTextFiles({files:['a']}, mapper), /must reduce text.*readMany/)
  assert.deepEqual(await ptc.mapTextFiles({files:['a']}, ({file_path,text}) => ({file_path,matches:text.split('\n').filter(x=>x.startsWith('#'))})),
    [{file_path:'a',matches:['# heading']}])
  assert.equal((await ptc.readMany({files:['a']}))[0].text, text)
})

test('incomplete, changing or truncated ordinary reads are never presented as full text', async () => {
  const cases = [
    { totalLines: 1, lines: [] },
    { totalLines: 2, lines: [{ number: 2, text: 'skipped' }] },
    { totalLines: 1, lines: [{ number: 1, text: '... (line truncated to 2000 chars)' }] },
    { totalLines: 2, lines: [{ number: 1, text: 'repeat' }] },
    { totalLines: 1, lines: [{ number: 2, text: 'beyond EOF' }] },
    { totalLines: 1, lines: [{ number: 1, text: null }] },
    { totalLines: -1, lines: [] },
  ]
  for (const value of cases) await assert.rejects(helper({ read: async () => value }).readAllText({ file_path: 'a' }), /progress|truncated|invalid|incomplete/)
  let calls = 0
  await assert.rejects(helper({ read: async () => ++calls === 1
    ? { totalLines: 2, lines: [{ number: 1, text: 'first' }] }
    : { totalLines: 3, lines: [{ number: 2, text: 'changed' }] } }).readAllText({ file_path: 'a' }), /changing/)
  assert.equal(await helper({ read: async () => ({ totalLines: 0, lines: [] }) }).readAllText({ file_path: 'empty' }), '')
})

test('internal text pages advance by received characters and reject explicit incomplete results', async()=>{
  const calls=[], text='я😀\nsecond'
  const reader=helper({read:async args=>{
    calls.push(args)
    const offset=args.__ptc_text.offset, chunk=text.slice(offset,offset+2)
    return {version:'stable',text:chunk,nextOffset:offset+chunk.length,eof:offset+chunk.length===text.length,
      totalChars:text.length,totalBytes:Buffer.byteLength(text),nextLine:args.offset+(chunk.includes('\n')?1:0)}
  }},true)
  assert.equal(await reader.readAllText({file_path:'a',page_limit:100}),text)
  assert.deepEqual(calls.map(x=>x.__ptc_text.offset),[0,2,4,6,8])
  for (const page of [
    {version:'stable',text:'',nextOffset:0,eof:false,totalChars:1,totalBytes:1,nextLine:1},
    {version:'stable',text:'a',nextOffset:1,eof:true,totalChars:2,totalBytes:2,nextLine:1},
    {version:'stable',text:'a',nextOffset:2,eof:false,totalChars:3,totalBytes:3,nextLine:1},
    {totalLines:1,lines:[{number:1,text:'ordinary'}]},
  ]) await assert.rejects(helper({read:async()=>page},true).readAllText({file_path:'a'}),/incomplete/)
  await assert.rejects(helper({read:async()=>{throw Error('ACCESS_DENIED')}},true).readAllText({file_path:'a'}),/ACCESS_DENIED/)
  let n=0
  await assert.rejects(helper({read:async()=>({version:''+(n++),text:'a',nextOffset:n,eof:n===2,totalChars:2,totalBytes:2,nextLine:1})},true).readAllText({file_path:'a'}),/changing.*incomplete/)
  assert.throws(()=>helper({}).jsonBytes({files:[null,null,{testEvidence:undefined}]}),
    {message:'value.files[2].testEvidence: undefined is not JSON-compatible.'})
})

test('ordinary short pages advance by actual lines rather than requested limit', async()=>{
  const calls=[], source=read({a:'one\ntwo\nthree\nfour\nfive'})
  const ptc=helper({read:args=>{calls.push(args.offset);return source({...args,limit:2})}})
  assert.equal(await ptc.readAllText({file_path:'a',page_limit:100}),'one\ntwo\nthree\nfour\nfive')
  assert.deepEqual(calls,[1,3,5])
})

test('actual QuickJS processes multiple >512 KiB Cyrillic files but returns compact mapped evidence', async () => {
  const runtime = createPtcRuntime()
  const text = ('я'.repeat(1000) + '\n').repeat(400) + '# PTC\nWorker'
  const profile = { schemaVersion: 1, id: 'helper-tests', revision: 1, tools: ['read'], limits: { ...DEFAULT_LIMITS, maxConcurrentToolCalls: 1 } }
  try {
    const program = buildPtcHelperPrelude(['read']) + `
      const evidence = await ptc.mapTextFiles({files:['a','b'],page_limit:50}, ({file_path,text}) => ({
        file_path, bytes:ptc.utf8Bytes(text), matches:text.split('\\n').filter(line => /PTC|Worker/.test(line))
      })); return {evidence}
    `
    const result = await runtime.run({ program, profile, bindings: { read: read({ a: text, b: text }) } })
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.value.evidence.length, 2)
    assert.ok(result.value.evidence.every(file => file.bytes > 512 * 1024))
    assert.deepEqual(result.value.evidence[0].matches, ['# PTC', 'Worker'])
    assert.ok(Buffer.byteLength(JSON.stringify(result.value)) < 1024)
    assert.equal(result.effects.completed, 18)
    const guidance = ptcHelperGuidance(['read'])
    assert.match(guidance, /4 MiB.*480 KiB.*512 KiB/)
  } finally { await runtime.dispose() }
})

test('expectStatus tool-name form shares exact current statuses and visibility', () => {
  const tools={postman_worker:()=>{},postman_worker_interrupt:()=>{},postman_bridge:()=>{},postman_task_prepare:()=>{}}
  const ptc=helper(tools)
  const table={postman_task_prepare:['TASK_CONTEXT_READY','POSTMAN_TASK_CONTEXT_ALREADY_READY'],postman_worker:['POSTMAN_WORKER_TASK_ACCEPTED'],postman_worker_interrupt:['POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED'],postman_bridge:['POSTMAN_BRIDGE_ACCEPTED']}
  for (const [name,statuses] of Object.entries(table)) {
    for (const status of statuses) assert.equal(ptc.expectStatus({status},name).status,status)
    for (const status of ['NEW_STATUS',statuses[0]+'_EXTRA',statuses[0].toLowerCase(),'POSTMAN_WORKER_INTERRUPT_ACCEPTED'])
      assert.throws(()=>ptc.expectStatus({status},name),/unexpected status/)
  }
  assert.throws(()=>helper({}).expectStatus({status:'POSTMAN_BRIDGE_ACCEPTED'},'postman_bridge'),/unavailable tool/)
})

test('existing helper argument/result shapes fail clearly without iterable guesses or partial input validation', async () => {
  let calls=0
  const ptc=helper({grep:async()=>{calls++;return {matches:[]}}})
  for (const options of [null,{}, {queries:Array(2)}, {queries:[{pattern:'ok'},null]}, {queries:[{pattern:1}]}])
    await assert.rejects(ptc.grepMany(options),/queries|each query/)
  assert.equal(calls,0)
  const reader=helper({read:async()=>{calls++;return {totalLines:1,lines:[{number:1,text:'a'}]}}})
  for (const options of [{files:['a',null]},{files:Array(2)},{files:['a'],page_limit:'invalid'}])
    await assert.rejects(reader.readMany(options),/files|positive integer/)
  assert.equal(calls,0)
  for (const value of [null,[],{}, {matches:null}, {matches:'raw'}])
    await assert.rejects(helper({grep:async()=>value}).grepMany({queries:[{pattern:'ok'}]}),/expected tools.grep result.*matches/)
  const result=await ptc.grepMany({queries:[{pattern:'ok'}]})
  assert.equal(Array.isArray(result),true);assert.equal(Array.isArray(result[0].result.matches),true)
  for (const value of [null,[],{}, {lines:{},totalLines:1}])
    await assert.rejects(helper({read:async()=>value}).readAllText({file_path:'a'}),/invalid.*read result/)
  const getter={};Object.defineProperty(getter,'text',{enumerable:true,get(){throw Error('must not run')}})
  const extra=['x'];extra.hidden='raw'
  for (const value of [getter,extra, {toJSON:()=>({})}]) assert.throws(()=>ptc.jsonBytes(value),/JSON-compatible/)
})

test('readMany/mapTextFiles restore 480 KiB defaults; grepMany has no separate byte ceiling', async () => {
  const budget=480*1024, text='я'.repeat(120000), ptc=helper({read:read({a:text,b:text})})
  const many=await ptc.readMany({files:['a','b']})
  assert.equal(many.length,2)
  assert.equal(many[1].text,text)
  assert.ok(ptc.jsonBytes(many)>400*1024)
  const overhead=ptc.jsonBytes([{file_path:'edge',text:''}])
  const edge='x'.repeat(budget-overhead)
  assert.equal(ptc.jsonBytes(await helper({read:read({edge})}).readMany({files:['edge']})),budget)
  await assert.rejects(helper({read:read({edge:edge+'x'})}).readMany({files:['edge']}),/max_total_bytes/)
  await assert.rejects(ptc.readMany({files:['a','b'],max_total_bytes:400000}),/max_total_bytes/)
  const escaped=helper({read:read({a:'"'.repeat(120000),b:'"'.repeat(120000)})})
  assert.equal((await escaped.readMany({files:['a','b']})).length,2)
  const map=helper({read:read({a:'source'})})
  for (const kib of [20,50,150]) {
    const reduced=await map.mapTextFiles({files:['a']},()=>({data:'x'.repeat(kib*1024)}))
    assert.equal(reduced[0].data.length,kib*1024)
  }
  const mapOverhead=map.jsonBytes([{data:''}])
  assert.equal(map.jsonBytes(await map.mapTextFiles({files:['a']},()=>({data:'x'.repeat(budget-mapOverhead)}))),budget)
  await assert.rejects(map.mapTextFiles({files:['a']},()=>({data:'x'.repeat(budget-mapOverhead+1)})),/max_total_bytes/)
  const grep=helper({grep:async()=>({matches:[{line:'"'.repeat(140000)}]})})
  const matches=await grep.grepMany({queries:[{pattern:'x'},{pattern:'y'}]})
  assert.equal(matches.length,2)
  assert.ok(grep.jsonBytes(matches)>512*1024) // Internal data remains available for reduction.
})

test('actual QuickJS readMany retains formerly allowed raw data inside PTC and can return it when needed', async () => {
  const runtime=createPtcRuntime(), text='я'.repeat(100000)
  const profile={schemaVersion:1,id:'raw-helper-tests',revision:1,tools:['read'],limits:{...DEFAULT_LIMITS,maxConcurrentToolCalls:1}}
  try {
    const program=buildPtcHelperPrelude(['read'])+"return await ptc.readMany({files:['a','b']})"
    const result=await runtime.run({program,profile,bindings:{read:read({a:text,b:text})}})
    assert.equal(result.status,'ok',JSON.stringify({status:result.status,error:result.error}))
    assert.equal(result.value[1].text,text)
    assert.ok(Buffer.byteLength(JSON.stringify(result.value))>350*1024)
  } finally {await runtime.dispose()}
})

test('mapTextFiles catches deeply wrapped full sources without rejecting empty or compact extraction', async () => {
  const text='full source\n'.repeat(2000), ptc=helper({read:read({a:text,empty:''})})
  for (const mapper of [({text})=>({nested:[{raw:text}]}),({text})=>({nested:{raw:'prefix:'+text+':suffix'}})])
    await assert.rejects(ptc.mapTextFiles({files:['a'],max_total_bytes:100000},mapper),/must reduce text/)
  const result=await ptc.mapTextFiles({files:['a']},({text})=>({chars:text.length,excerpt:text.slice(0,20)}))
  assert.deepEqual(result,[{chars:text.length,excerpt:text.slice(0,20)}])
  assert.deepEqual(await ptc.mapTextFiles({files:['empty']},()=>({excerpt:'',count:0})),[{excerpt:'',count:0}])
})

test('read once, reuse locally; helpers never cache across mutation or external changes', async () => {
  let text='alpha\nbeta',calls=0
  const ptc=helper({read:args=>{calls++;return read({a:text})(args)}})
  const source=await ptc.readAllText({file_path:'a'})
  assert.equal(source.includes('alpha'),true);assert.equal(source.split('\n').length,2);assert.equal(calls,1)
  text='after edit'
  assert.equal(await ptc.readAllText({file_path:'a'}),'after edit');assert.equal(calls,2)
  text='external change'
  assert.equal(await ptc.readAllText({file_path:'a'}),'external change');assert.equal(calls,3)
})

