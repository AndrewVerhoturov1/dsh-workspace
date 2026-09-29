import test from 'node:test'
import assert from 'node:assert/strict'
import { FrameReader, encodeFrame, checkMessage, message, writer, ProtocolError } from '../src/protocol.js'
import { boundedJson } from '../src/json.js'
import { DEFAULT_LIMITS } from '../src/profiles.js'
import { PassThrough } from 'node:stream'
const lim={...DEFAULT_LIMITS,maxMessageBytes:4096,maxTotalBridgeBytes:8192}
const rid='test-run'

test('framing reassembles split/combined messages and rejects truncated/oversized/invalid',()=>{
  const frames=[],errors=[]
  const r=new FrameReader(lim,x=>frames.push(x),e=>errors.push(e))
  const a=encodeFrame(message('ready',rid),lim),b=encodeFrame(message('log',rid,{text:'é'}),lim)
  r.push(a.subarray(0,1));r.push(Buffer.concat([a.subarray(1),b]));r.end()
  assert.deepEqual(frames,[message('ready',rid),message('log',rid,{text:'é'})]);assert.equal(errors.length,0)
  for(const bad of [Buffer.from([0,0,0,0]),Buffer.from([255,255,255,255])]){
    const failures=[];new FrameReader(lim,()=>{},e=>failures.push(e)).push(bad);assert.equal(failures.length,1)
  }
  const short=[];const cut=new FrameReader(lim,()=>{},e=>short.push(e));cut.push(a.subarray(0,a.length-1));cut.end();assert.equal(short.length,1)
  const invalid=[];const bad=new FrameReader(lim,()=>{},e=>invalid.push(e));bad.push(Buffer.from([0,0,0,1,0xff]));assert.equal(invalid.length,1)
})

test('version, direction, fields and call IDs are strict',()=>{
  assert.deepEqual(checkMessage(message('ready',rid),'parent',rid,lim),message('ready',rid))
  for(const m of [
    {...message('ready',rid),v:2},message('ready','other'),
    {...message('ready',rid),extra:1},message('call',rid,{callId:0,name:'x',arg:null}),
    message('call',rid,{callId:1,name:'x'}),
    message('reply',rid,{callId:1,ok:true,error:'bad'}),
    message('done',rid,{status:'ok'}),
  ])assert.throws(()=>checkMessage(m,m.type==='reply'?'child':'parent',rid,lim),ProtocolError)
  assert.throws(()=>checkMessage(message('call',rid,{callId:1,name:'x',arg:null}),'child',rid,lim),ProtocolError)
})

test('host JSON validation rejects getters, toJSON, cycles, unsafe keys and non-JSON',()=>{
  for(const v of [undefined,NaN,Infinity,3n,()=>1,Symbol(),new Date(),[,],{toJSON(){return 1}},JSON.parse('{"__proto__":1}')])assert.throws(()=>boundedJson(v,lim))
  const getter={};Object.defineProperty(getter,'x',{enumerable:true,get(){throw Error('should not execute')}});assert.throws(()=>boundedJson(getter,lim))
  const cycle={};cycle.self=cycle;assert.throws(()=>boundedJson(cycle,lim))
  const trapped=new Proxy({}, {get(){throw Error('trap must not run')}});assert.throws(()=>boundedJson(trapped,lim),/Unsupported JSON value/)
  assert.deepEqual(boundedJson({nested:[1,'é',null]},lim).value.nested,[1,'é',null])
})

test('writer rejects pending sends on stream error or close',async()=>{
  const stream=new PassThrough({highWaterMark:1})
  let failed=0
  const send=writer(stream,lim,()=>failed++)
  const one=send.send(message('start',rid,{program:'x'.repeat(3000),language:'javascript',profile:null}))
  const two=send.send(message('start',rid,{program:'y',language:'javascript',profile:null}))
  const closed=new Promise(resolve=>stream.once('close',resolve))
  stream.destroy(Error('broken pipe'))
  await assert.rejects(one);await assert.rejects(two)
  await closed
  assert.equal(failed,1)
  await assert.rejects(send.send(message('ready',rid)))
})

test('fixed envelopes do not consume user depth/nodes; payload and escaped bytes remain bounded',()=>{
  const minimal={...lim,maxValueDepth:1,maxValueNodes:1}
  const start=message('start',rid,{program:'return 3',language:'javascript',profile:{schemaVersion:1,id:'p',revision:1,tools:[],limits:minimal}})
  assert.equal(checkMessage(start,'child',rid,minimal),start)
  assert.ok(encodeFrame(start,minimal).length<minimal.maxMessageBytes+4)
  const scalar=message('call',rid,{callId:1,name:'echo',arg:3})
  assert.equal(checkMessage(scalar,'parent',rid,minimal),scalar)
  assert.throws(()=>checkMessage(message('call',rid,{callId:1,name:'echo',arg:[3]}),'parent',rid,minimal),ProtocolError)
  const escaped=message('reply',rid,{callId:1,ok:true,value:'\n'.repeat(3000)})
  assert.throws(()=>encodeFrame(escaped,minimal),ProtocolError)
  assert.throws(()=>checkMessage(escaped,'child',rid,minimal),ProtocolError)
})
