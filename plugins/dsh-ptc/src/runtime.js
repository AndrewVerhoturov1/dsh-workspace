import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { types } from 'node:util'
import { validatePtcProfile, ownData, plain } from './profiles.js'
import { boundedJson, JsonLimitError } from './json.js'
import { FrameReader, checkMessage, encodeFrame, message, writer, ProtocolError } from './protocol.js'

const ENTRY = new URL('./executor.mjs', import.meta.url)
const MAX_PROCESSES = 2, MAX_OUTSTANDING = 64, START_MS = 3000, STOP_MS = 750
function outcome(status, code, detail, extra = {}) {
  return { status, ...(code ? { error:{code,message:String(detail ?? code).slice(0,1024)} } : {}), ...extra }
}
function errorText(error) {
  if (types.isProxy(error) || !(error instanceof Error)) return 'Host callback failed'
  const d=Object.getOwnPropertyDescriptor(error,'message')
  return d && typeof d.value==='string' ? d.value.slice(0,1024) : 'Host callback failed'
}
export function createPtcRuntime(options = {}) {
  return makeRuntime(options, ENTRY)
}
// Internal test seam, deliberately absent from the package entry/exports.
export function createPtcRuntimeForTest(executor, removeTemp = rm, spawnChild = spawn) { return makeRuntime({}, executor, removeTemp, spawnChild) }
function makeRuntime(options, entry, removeTemp = rm, spawnChild = spawn) {
  if (Object.keys(plain(options)).length) throw new TypeError('No runtime options supported in v1')
  let disposed = false, disposePromise
  const active = new Set(), outstanding = new Set()
  function run(input = {}) {
    if (disposed) return Promise.resolve(outcome('invalid-input','disposed','Runtime disposed'))
    let profile, bindings, program, language, signal
    try {
      plain(input)
      if (Object.keys(input).some(k=>!['program','language','profile','bindings','signal'].includes(k))) throw new TypeError('Unknown run field')
      program=ownData(input,'program'); language=Object.hasOwn(input,'language')?ownData(input,'language'):'javascript'
      profile=validatePtcProfile(ownData(input,'profile'))
      bindings=plain(ownData(input,'bindings'))
      signal=Object.hasOwn(input,'signal')?ownData(input,'signal'):undefined
      if (typeof program !== 'string' || !['javascript','typescript'].includes(language) ||
          Buffer.byteLength(program,'utf8') > profile.limits.maxProgramBytes ||
          (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function' || typeof signal?.aborted !== 'boolean'))) throw new TypeError('Invalid program/language/signal')
      const selected = Object.create(null)
      for (const name of profile.tools) {
        const fn=ownData(bindings,name)
        if (typeof fn !== 'function') throw new TypeError('Missing binding function: '+name)
        selected[name]=fn
      }
      bindings=Object.freeze(selected)
    } catch(error) { return Promise.resolve(outcome('invalid-input','validation',errorText(error))) }
    if (signal?.aborted) return Promise.resolve(outcome('cancelled','aborted','Already aborted'))
    if (active.size>=MAX_PROCESSES) return Promise.resolve(outcome('limit-exceeded','maxProcesses','Active process limit'))
    if (outstanding.size>=MAX_OUTSTANDING) return Promise.resolve(outcome('limit-exceeded','maxOutstanding','Unsettled callback limit'))
    const state = { cancel:null }
    active.add(state)
    return execute(state,{profile,bindings,program,language,signal},outstanding,entry,removeTemp,spawnChild).finally(()=>{ if (!state.uncertain) active.delete(state) })
  }
  function dispose() {
    if (!disposePromise) {
      disposed=true
      disposePromise=Promise.all([...active].map(s=>s.cancel?.('cancelled','disposed','Runtime disposed'))).then(()=>{})
    }
    return disposePromise
  }
  return Object.freeze({run,dispose})
}

async function execute(state,{profile,bindings,program,language,signal},outstanding,entry,removeTemp,spawnChild) {
  const limits=profile.limits, runId=randomUUID(), controller=new AbortController()
  let child, directory, preparing, reader, send, ready=false, accepted=false, finished=false
  let stderrBytes=0, count=0, nextId=1, logBytes=0, logs=[]
  let incoming=0, outgoing=0, wallTimer, startTimer
  const calls=new Map(), queue=[]
  let resolveResult
  const done=new Promise(resolve=>{resolveResult=resolve})
  function snapshot() {
    const entries=[...calls.values()].map(c=>({callId:c.id,name:c.name,state:c.state}))
    return {calls:entries,completed:entries.filter(c=>c.state==='completed').length,failed:entries.filter(c=>c.state==='failed').length,pending:entries.filter(c=>c.state==='running').length}
  }
  function launchQueued() {
    if(finished)return
    while(queue.length && [...calls.values()].filter(c=>c.state==='running'||c.state==='scheduled').length<limits.maxConcurrentToolCalls){
      const call=queue.shift()
      if(!call || call.state!=='queued')continue
      call.state='scheduled'
      let token
      // The callback starts only here; a combined call/done frame can close delivery first.
      Promise.resolve().then(()=>{
        if(finished) return
        if(outstanding.size>=MAX_OUTSTANDING) {void finish(outcome('limit-exceeded','maxOutstanding','Unsettled callback limit'));return}
        call.state='running'
        token={runId,callId:call.id};outstanding.add(token)
        return bindings[call.name](call.arg,{signal:controller.signal,runId,callId:call.id})
      }).then(value=>{if(token)finishCall(call,true,value)},error=>{if(token)finishCall(call,false,error)})
        .finally(()=>{if(token)outstanding.delete(token)})
    }
  }
  function finishCall(call,ok,value) {
    if(call.state!=='running')return
    let reply
    if(ok && !finished){
      try {
        const payload=boundedJson(value,limits).value
        reply=message('reply',runId,{callId:call.id,ok:true,value:payload})
        encodeFrame(reply,limits) // The envelope, including JSON escaping, must fit too.
      } catch(error) {
        if(error instanceof JsonLimitError || error instanceof ProtocolError){
          call.state='failed'
          void finish(outcome('limit-exceeded',error instanceof JsonLimitError?error.code:'maxMessageBytes',errorText(error)))
          return
        }
        ok=false;value=error
      }
    }
    call.state=ok?'completed':'failed'
    if(!finished){
      reply ||= message('reply',runId,{callId:call.id,ok:false,error:errorText(value)})
      void emit(reply).catch(error=>void finish(outcome('protocol-error','outbound',errorText(error))))
      launchQueued()
    }
  }
  function handle(data) {
    if(finished)return
    checkMessage(data,'parent',runId,limits)
    if(data.type==='ready') {
      if(ready) throw new ProtocolError('Duplicate ready')
      ready=true;clearTimeout(startTimer)
      return
    }
    if(!ready || !accepted) throw new ProtocolError('Message before start')
    if(data.type==='call') {
      if(data.callId!==nextId++ || !Object.hasOwn(bindings,data.name) || !profile.tools.includes(data.name)) throw new ProtocolError('Invalid/duplicate call or ungranted name')
      try { boundedJson(data.arg,limits) } catch(error) {throw new ProtocolError('Invalid argument: '+errorText(error))}
      if(++count>limits.maxToolCalls) {void finish(outcome('limit-exceeded','maxToolCalls','Call limit'));return}
      const running=[...calls.values()].filter(c=>c.state==='running'||c.state==='scheduled').length
      if(running>=limits.maxConcurrentToolCalls && queue.length>=limits.maxQueuedToolCalls){void finish(outcome('limit-exceeded','maxQueuedToolCalls','Queue limit'));return}
      if(outstanding.size+[...calls.values()].filter(c=>c.state==='scheduled').length>=MAX_OUTSTANDING) {void finish(outcome('limit-exceeded','maxOutstanding','Unsettled callback limit'));return}
      const call={id:data.callId,name:data.name,arg:data.arg,state:'queued'}
      calls.set(call.id,call);queue.push(call);launchQueued();return
    }
    if(data.type==='log') {
      const bytes=Buffer.byteLength(data.text,'utf8')
      if(logs.length>=limits.maxLogEntries || logBytes+bytes>limits.maxOutputBytes) {void finish(outcome('limit-exceeded','maxOutputBytes','Log limit'));return}
      logs.push(data.text);logBytes+=bytes;return
    }
    if(data.type==='done') {
      if(!['ok','syntax-error','runtime-error','invalid-output','invalid-input','cleanup-error','process-error','limit-exceeded','unawaited-calls'].includes(data.status)) throw new ProtocolError('Invalid terminal status')
      if(data.status==='ok') {boundedJson(data.value,limits); if(Buffer.byteLength(JSON.stringify(data.value),'utf8')>limits.maxOutputBytes) {void finish(outcome('limit-exceeded','maxOutputBytes','Result limit'));return}}
      const incomplete=[...calls.values()].some(c=>c.state==='running'||c.state==='queued'||c.state==='scheduled')
      const result=data.status==='ok'&&incomplete?outcome('unawaited-calls','incomplete','Program returned with outstanding calls'):data.status==='ok'?{status:'ok',value:data.value}:outcome(data.status,data.error?.code||data.status,data.error?.message||data.status)
      if(data.cleanupError)result.cleanupError=data.cleanupError
      void finish(result);return
    }
  }
  async function emit(data) {
    checkMessage(data,'child',runId,limits)
    const size=Buffer.byteLength(JSON.stringify(data),'utf8')+4
    outgoing+=size
    if(incoming+outgoing>limits.maxTotalBridgeBytes) throw new ProtocolError('Combined bridge budget')
    await send.send(data)
    if(data.type==='start') accepted=true
  }
  async function stop() {
    if(!child)return true
    if(state.closed)return true
    let exited=false
    const closed=new Promise(resolve=>child.once('close',()=>{exited=true;resolve(true)}))
    try {child.kill()} catch {}
    await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,STOP_MS))])
    if(exited)return true
    if(process.platform==='win32') {
      // taskkill is only a fallback for this exact owned PID; no shell or inherited env.
      await Promise.race([new Promise(resolve=>{
        try {const killer=spawn(join(process.env.SystemRoot||'C:/Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot||'C:/Windows'}});killer.once('error',resolve);killer.once('close',resolve)}catch{resolve()}
      }),new Promise(resolve=>setTimeout(resolve,STOP_MS))])
    } else try { child.kill('SIGKILL') } catch {}
    await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,STOP_MS))])
    return exited || state.closed
  }
  async function finish(result) {
    if(finished)return done
    finished=true;controller.abort()
    clearTimeout(wallTimer);clearTimeout(startTimer)
    signal?.removeEventListener('abort',onAbort)
    // An abort during mkdtemp must still wait for that directory to be removed.
    if(preparing)try{await preparing}catch{}
    const stopped=await stop()
    if(!stopped) state.uncertain=true
    try { if(stopped && directory) await removeTemp(directory,{recursive:true,force:true}) } catch(error) {result.cleanupError={code:'temp-cleanup',message:errorText(error)}}
    if(!stopped) {
      const failure={code:'unconfirmed-exit',message:'Child exit not confirmed after termination',pid:child?.pid}
      result.cleanupError=failure
    }
    // Closing delivery does not freeze Host callbacks that settle during cleanup.
    for(const call of calls.values()) if(call.state==='queued'||call.state==='scheduled')call.state='not-started'
    if(result.cleanupError && result.status==='ok') {
      const failure=result.cleanupError
      result=outcome('cleanup-error',failure.code,failure.message,{cleanupError:failure})
    }
    resolveResult({...result,logs,effects:snapshot()})
    return done
  }
  const onAbort=()=>void finish(outcome('cancelled','aborted','AbortSignal'))
  state.cancel=(status,code,detail)=>finish(outcome(status,code,detail))
  wallTimer=setTimeout(()=>void finish(outcome('limit-exceeded','maxWallMs','Wall time exceeded')),limits.maxWallMs)
  startTimer=setTimeout(()=>void finish(outcome('process-error','start-timeout','Child did not become ready')),Math.min(START_MS,limits.maxWallMs))
  signal?.addEventListener('abort',onAbort,{once:true})
  if(signal?.aborted)onAbort()
  try {
    if(finished)return done
    preparing=mkdtemp(join(tmpdir(),'dsh-ptc-')).then(path=>{directory=path})
    await preparing
    if(finished)return done
    child=spawnChild(process.execPath, [fileURLToPath(entry)], {cwd:directory,execArgv:[],env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot||'C:/Windows',TEMP:directory,TMP:directory}:{TMPDIR:directory},stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false})
    reader=new FrameReader(limits,obj=>{try {handle(obj)}catch(error){void finish(outcome('protocol-error','message',errorText(error))) }},error=>void finish(outcome('protocol-error','frame',errorText(error))))
    child.stdout.on('data',chunk=>{incoming+=chunk.length;if(incoming+outgoing>limits.maxTotalBridgeBytes){void finish(outcome('limit-exceeded','maxTotalBridgeBytes','Bridge budget'));return}reader.push(chunk)})
    child.stdout.once('end',()=>reader.end())
    child.stdout.on('error',error=>void finish(outcome('process-error','stdout',errorText(error))))
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>4096)void finish(outcome('limit-exceeded','stderrBytes','stderr budget'))})
    child.stderr.on('error',error=>void finish(outcome('process-error','stderr',errorText(error))))
    child.once('error',error=>void finish(outcome('process-error','spawn',errorText(error))))
    child.once('close',(code,why)=>{state.closed=true;if(!finished)void finish(outcome('process-error','exit',`Child exited `+code+'/'+why))})
    send=writer(child.stdin,limits,error=>void finish(outcome('process-error','stdin',errorText(error))))
    accepted=true
    void emit(message('start',runId,{program,language,profile})).catch(error=>void finish(outcome('protocol-error','outbound',errorText(error))))
  } catch(error){void finish(outcome('process-error','spawn',errorText(error)))}
  return done
}
