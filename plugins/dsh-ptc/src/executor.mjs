import { stripTypeScriptTypes } from 'node:module'
import { newQuickJSWASMModule } from 'quickjs-emscripten'
import { FrameReader, checkMessage, message, writer } from './protocol.js'
import { boundedJson, createJsonCodec, JsonLimitError } from './json.js'
import { validatePtcProfile } from './profiles.js'

// One process, one program. This file is a fixed trusted entry point, not a loader.
const ABSOLUTE = { maxMessageBytes: 1048576, maxTotalBridgeBytes: 16777216, maxValueDepth: 32, maxValueNodes: 10000, maxToolCalls: 256 }
let started = false, terminal = false, runId, limits, send, runtime, context, promise
let nextCallId = 0, logs = 0, bytes = 0, violation = null, violationStatus = 'limit-exceeded', internalExpired = false
const calls = new Map()
const stdin = new FrameReader(ABSOLUTE, data => {
  try {
    if (!started) {
      if (data?.type !== 'start') throw new Error('Expected start')
      runId = data.runId
      checkMessage(data, 'child', runId, ABSOLUTE)
      started = true
      data.profile = validatePtcProfile(data.profile)
      limits = data.profile.limits
      send = writer(process.stdout, limits)
      void send.send(message('ready',runId)).then(() => execute(data), fatal)
      return
    }
    checkMessage(data,'child',runId,limits)
    if (terminal || data.type !== 'reply' || !calls.has(data.callId)) throw new Error('Unexpected reply')
    const entry=calls.get(data.callId); calls.delete(data.callId)
    if (data.ok) entry.resolve(data.value)
    else entry.reject(data.error)
  } catch (error) { fatal(error) }
}, fatal)
process.stdin.on('data', chunk => stdin.push(chunk))
process.stdin.on('end', () => { stdin.end(); if (!terminal) process.exitCode=1; process.stdin.pause() })
process.stdin.on('error', fatal)
process.stdout.on('error', fatal)

function text(error) { return error?.message || String(error) }
function fatal(error) {
  if (terminal) return
  terminal=true
  process.exit(1)
}
function errorResult(code, error) { return { code, message: String(text(error)).slice(0,1024) } }
async function cleanup() {
  for (const entry of calls.values()) { try { entry.deferred.dispose() } catch {} }
  calls.clear()
  try { promise?.dispose() } catch {}
  try { context?.dispose() } catch (error) { return errorResult('cleanup',error) }
  try { runtime?.dispose() } catch (error) { return errorResult('cleanup',error) }
  return undefined
}
async function execute(start) {
  let result
  try { result=await evaluate(start) }
  catch (error) { result={ status: 'runtime-error', error: errorResult('runtime',error) } }
  if (result.status==='ok' && calls.size) result={status:'unawaited-calls',error:errorResult('incomplete','Program returned with outstanding calls')}
  const cleanupError=await cleanup()
  if (internalExpired) result={status:'limit-exceeded',error:errorResult('maxWallMs','QuickJS interrupt deadline')}
  if (violation) result={status:violationStatus,error:violation}
  if (cleanupError) result.cleanupError=cleanupError
  if (terminal) return
  terminal=true
  // Keep the cleanup detail when success is demoted; failures retain their cause.
  if (cleanupError && result.status === 'ok') result={ status:'cleanup-error', error:cleanupError, cleanupError }
  try { await send.send(message('done',runId,result)); send.close() }
  catch { process.exitCode=1 }
  process.stdin.pause()
}
async function evaluate({ program, language, profile }) {
  if (language === 'typescript') {
    if (typeof stripTypeScriptTypes !== 'function') return {status:'invalid-input',error:errorResult('typescript-unavailable','Node stripTypeScriptTypes unavailable')}
    try {
      const wrapped = stripTypeScriptTypes('async function __ptc_main__() {\n'+program+'\n}',{mode:'strip'})
      program = wrapped.slice(wrapped.indexOf('{')+1,wrapped.lastIndexOf('}'))
    } catch (error) { return {status:'syntax-error',error:errorResult('syntax',error)} }
  }
  if(Buffer.byteLength(program,'utf8')>profile.limits.maxProgramBytes) return {status:'limit-exceeded',error:errorResult('maxProgramBytes','Stripped source exceeds limit')}
  const module=await newQuickJSWASMModule()
  runtime=module.newRuntime({memoryLimitBytes:profile.limits.quickjsMemoryBytes,maxStackSizeBytes:profile.limits.maxStackBytes})
  const deadline=Date.now()+profile.limits.maxWallMs
  runtime.setInterruptHandler(() => { internalExpired ||= Date.now()>=deadline; return internalExpired })
  context=runtime.newContext()
  // A private serializer closes over pristine intrinsics before model code runs.
  const serializerSource = `(${createJsonCodec.toString()})().encode`
  const evalSerializer=context.evalCode(serializerSource,'ptc-internal.js')
  if (evalSerializer.error) { const err=context.dump(evalSerializer.error); evalSerializer.error.dispose(); throw new Error(text(err)) }
  const serializer=evalSerializer.value
  const jsonObject=context.getProp(context.global,'JSON')
  const parser=context.getProp(jsonObject,'parse')
  function encodeGuest(handle, maxBytes=limits.maxMessageBytes) {
    const settings=context.newObject()
    for (const name of ['maxValueDepth','maxValueNodes']) {
      const h=context.newNumber(limits[name]); context.setProp(settings,name,h); h.dispose()
    }
    const cap=context.newNumber(maxBytes), code=context.newString(maxBytes===limits.maxOutputBytes?'maxOutputBytes':'maxMessageBytes')
    let s
    try {
      const encoded=context.callFunction(serializer,context.undefined,handle,settings,cap,code)
      if(encoded.error){
        const e=context.dump(encoded.error);encoded.error.dispose()
        if (['maxValueDepth','maxValueNodes','maxMessageBytes','maxOutputBytes'].includes(e.code)) throw new JsonLimitError(e.code,text(e))
        throw new TypeError(text(e))
      }
      const h=context.getProp(encoded.value,'text')
      try {s=context.getString(h)}finally{h.dispose();encoded.value.dispose()}
    } finally {settings.dispose();cap.dispose();code.dispose()}
    return boundedJson(JSON.parse(s),limits,maxBytes).value
  }
  function rejectDeferred(entry, reason) {
    const h=context.newError({name:'Error',message:String(reason).slice(0,1024)})
    try {entry.deferred.reject(h)}finally{h.dispose();entry.deferred.dispose()}
  }
  function resolveDeferred(entry, value) {
    let h, parsed, errorHandle
    try {
      const data=boundedJson(value,limits).text
      h=context.newString(data)
      parsed=context.callFunction(parser,jsonObject,h)
      if(parsed.error){errorHandle=parsed.error;throw new Error(text(context.dump(errorHandle)))}
      entry.deferred.resolve(parsed.value)
    } catch(error) { rejectDeferred(entry,text(error)); return }
    finally {h?.dispose();parsed?.value?.dispose();errorHandle?.dispose()}
    entry.deferred.dispose()
  }
  for(const name of profile.tools){
    const fn=context.newFunction(name, argHandle => {
      if(terminal) throw new Error('Execution closed')
      if(violation) throw new Error('Execution limit exceeded')
      if(nextCallId>=limits.maxToolCalls) {violation=errorResult('maxToolCalls','Call limit exceeded');throw new Error('Call limit exceeded')}
      let arg
      try { arg=encodeGuest(argHandle) }
      catch(error) {violationStatus=error instanceof JsonLimitError?'limit-exceeded':'runtime-error';violation=errorResult(error instanceof JsonLimitError?error.code:'invalid-json',error);throw error}
      const callId=++nextCallId
      const deferred=context.newPromise()
      // The returned handle and the retained deferred have independent ownership.
      const returned=deferred.handle.dup()
      calls.set(callId,{deferred,resolve(value){resolveDeferred(this,value)},reject(reason){rejectDeferred(this,reason)}})
      void send.send(message('call',runId,{callId,name,arg})).catch(fatal)
      return returned
    })
    if (!globalThis._ptcTools) globalThis._ptcTools=context.newObject()
    context.setProp(globalThis._ptcTools,name,fn); fn.dispose()
  }
  const toolsObject=globalThis._ptcTools ?? context.newObject()
  context.setProp(context.global,'tools',toolsObject); toolsObject.dispose(); globalThis._ptcTools=undefined
  const logFn=context.newFunction('log',(...values)=>{
    for(const h of values){
      if(violation) throw new Error('Execution limit exceeded')
      let v
      try {v=encodeGuest(h,limits.maxOutputBytes)}
      catch(error) {violationStatus=error instanceof JsonLimitError?'limit-exceeded':'runtime-error';violation=errorResult(error instanceof JsonLimitError?error.code:'invalid-json',error);throw error}
      const text=JSON.stringify(v), size=Buffer.byteLength(text,'utf8')
      if(logs+1>limits.maxLogEntries || bytes+size>limits.maxOutputBytes){violation=errorResult('maxOutputBytes','Output limit exceeded');throw new Error('Output limit exceeded')}
      logs++;bytes+=size
      void send.send(message('log',runId,{text})).catch(fatal)
    }
    return context.undefined
  })
  const consoleObj=context.newObject()
  for(const key of ['log','info','warn','error','debug'])context.setProp(consoleObj,key,logFn)
  context.setProp(context.global,'console',consoleObj);consoleObj.dispose();logFn.dispose()
  let final
  try {
    const evaluated=context.evalCode('"use strict"; (async function __ptc_main__() {\n'+program+'\n})()','ptc-program.js')
    if(evaluated.error){
      const err=context.dump(evaluated.error);evaluated.error.dispose()
      const code=String(err?.message||err).includes('SyntaxError') || err?.name==='SyntaxError'?'syntax-error':'runtime-error'
      return {status:code,error:errorResult(code,err?.message||err)}
    }
    promise=evaluated.value
    let state=context.getPromiseState(promise)
    while(state.type==='pending' && !terminal){
      const jobs=runtime.executePendingJobs()
      if(jobs.error){const err=context.dump(jobs.error);jobs.error.dispose();return {status:'runtime-error',error:errorResult('pending-job',err?.message||err)}}
      state=context.getPromiseState(promise)
      if(state.type==='pending') await new Promise(resolve=>setTimeout(resolve,1))
    }
    if(state.type==='rejected'){const err=context.dump(state.error);state.error.dispose();const limited=['maxValueDepth','maxValueNodes','maxMessageBytes','maxOutputBytes'].includes(err?.code);return {status:limited?'limit-exceeded':'runtime-error',error:errorResult(limited?err.code:'runtime',err?.message||err)}}
    if(state.type==='fulfilled'){
      try {final=encodeGuest(state.value,limits.maxOutputBytes)}
      catch(error){return {status:error instanceof JsonLimitError?'limit-exceeded':'invalid-output',error:errorResult(error instanceof JsonLimitError?error.code:'invalid-output',error)}}
      finally {state.value.dispose()}
      return {status:'ok',value:final}
    }
    return {status:'process-error',error:errorResult('closed','Channel closed')}
  } finally {serializer.dispose();parser.dispose();jsonObject.dispose()}
}
