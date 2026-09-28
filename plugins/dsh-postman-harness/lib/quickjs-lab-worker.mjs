import { parentPort, workerData } from 'node:worker_threads'
import { newQuickJSWASMModule } from 'quickjs-emscripten'

const MAX_BRIDGE_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_PROGRAM_BYTES = 256 * 1024
const MAX_CALLS = 256

function safeJson(value, label) {
  let encoded
  try { encoded = JSON.stringify(value) } catch (error) { throw new Error(`${label} is not JSON: ${error.message}`) }
  if (encoded === undefined) throw new Error(`${label} is not JSON`)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BRIDGE_BYTES) throw new Error(`${label} exceeds bridge limit`)
  return encoded
}
function toError(error) { return error instanceof Error ? error.message : String(error) }
const { program, namespaces } = workerData
const calls = new Map()
let nextCallId = 1
let callCount = 0
let outputBytes = 0
const logs = []
let timedOut = false
let runtime
let context

function finishCall(message) {
  const entry = calls.get(message.id)
  if (!entry) return
  calls.delete(message.id)
  if (message.ok) entry.resolve(message.value)
  else entry.reject(new Error(message.error || 'Tool call failed'))
  parentPort.postMessage({ type: 'host-replied', id: message.id })
}
parentPort.on('message', finishCall)

let terminal = { error: { kind: 'exception', message: 'Worker did not finish' } }
try {
  const quickjs = await newQuickJSWASMModule()
  const deadline = Date.now() + workerData.timeoutMs
  runtime = quickjs.newRuntime({ memoryLimitBytes: workerData.memoryLimitBytes, maxStackSizeBytes: 512 * 1024 })
  context = runtime.newContext()
  runtime.setInterruptHandler(() => { const expired = Date.now() >= deadline; timedOut ||= expired; return expired })

  const makeNamespace = (globalName, funcs) => {
    const object = context.newObject()
    for (const methodName of funcs) {
      const fn = context.newFunction(methodName, argsHandle => {
        callCount += 1
        if (callCount > MAX_CALLS) throw new Error('Tool call count limit exceeded')
        const args = JSON.parse(safeJson(context.dump(argsHandle), 'binding arguments'))
        const id = nextCallId++
        const deferred = context.newPromise()
        calls.set(id, { resolve(value) {
          let jsonObject
          let parse
          let text
          let parsedValue
          let parseError
          try {
            const encoded = safeJson(value, 'binding result')
            jsonObject = context.getProp(context.global, 'JSON')
            parse = context.getProp(jsonObject, 'parse')
            text = context.newString(encoded)
            const parsed = context.callFunction(parse, jsonObject, text)
            if (parsed.error) { parseError = parsed.error; throw new Error(context.dump(parseError)?.message ?? 'JSON.parse failed') }
            parsedValue = parsed.value
            deferred.resolve(parsedValue)
          } catch (error) {
            const errorHandle = context.newError({ name: 'Error', message: String(error?.message ?? error) })
            try { deferred.reject(errorHandle) } finally { errorHandle.dispose() }
          } finally {
            text?.dispose()
            parsedValue?.dispose()
            parseError?.dispose()
            parse?.dispose()
            jsonObject?.dispose()
            deferred.dispose()
          }
        }, reject(error) {
          const errorHandle = context.newError({ name: 'Error', message: String(error?.message ?? error) })
          try { deferred.reject(errorHandle) } finally { errorHandle.dispose(); deferred.dispose() }
        } })
        parentPort.postMessage({ type: 'call', id, global: globalName, name: methodName, args })
        return deferred.handle
      })
      context.setProp(object, methodName, fn)
      fn.dispose()
    }
    context.setProp(context.global, globalName, object)
    object.dispose()
  }
  for (const ns of namespaces) makeNamespace(ns.global, ns.functions)

  const logFn = context.newFunction('log', (...handles) => {
    for (const value of handles) {
      const dumped = context.dump(value)
      const text = JSON.stringify(dumped) ?? String(dumped)
      const bytes = Buffer.byteLength(text, 'utf8')
      if (outputBytes + bytes > MAX_OUTPUT_BYTES) throw new Error('Output limit exceeded')
      outputBytes += bytes
      logs.push(text)
    }
    return context.undefined
  })
  const consoleObj = context.newObject()
  for (const key of ['log', 'info', 'warn', 'error', 'debug']) context.setProp(consoleObj, key, logFn)
  context.setProp(context.global, 'console', consoleObj)
  consoleObj.dispose(); logFn.dispose()

  if (Buffer.byteLength(program, 'utf8') > MAX_PROGRAM_BYTES) throw new Error('Program limit exceeded')
  const source = `"use strict"; (async function __dsh_main__() { ${program}\n })()`
  const evaluated = context.evalCode(source, 'model-program.js')
  if (evaluated.error) {
    const error = context.dump(evaluated.error)
    terminal = { logs, error: { kind: timedOut ? 'timeout' : 'exception', message: error?.message || String(error) } }
    evaluated.error.dispose()
  } else {
    const promise = evaluated.value
    const deadlineWall = Date.now() + workerData.timeoutMs
    let state = context.getPromiseState(promise)
    while (state.type === 'pending' && Date.now() < deadlineWall) {
      runtime.executePendingJobs()
      await new Promise(resolve => setTimeout(resolve, 1))
      state = context.getPromiseState(promise)
    }
    if (state.type === 'pending') {
      terminal = { logs, error: { kind: 'timeout', message: 'Execution wall-time limit exceeded' } }
    } else if (state.type === 'rejected') {
      const error = context.dump(state.error)
      terminal = { logs, error: { kind: timedOut ? 'timeout' : 'exception', message: error?.message || String(error) } }
      state.error.dispose()
    } else {
      const dumped = context.dump(state.value)
      const json = dumped === undefined ? undefined : JSON.stringify(dumped)
      if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_BRIDGE_BYTES) terminal = { logs, error: { kind: 'invalid-output', message: 'Completion value is not bounded JSON' } }
      else terminal = { logs, value: JSON.parse(json) }
      state.value.dispose()
    }
    promise.dispose()
  }
} catch (error) {
  terminal = { logs, error: { kind: timedOut ? 'timeout' : 'exception', message: toError(error) } }
}

const cleanupErrors = []
if (context?.alive) {
  try { context.dispose() } catch (error) { cleanupErrors.push(`context.dispose: ${toError(error)}`) }
}
if (runtime?.alive) {
  try { runtime.dispose() } catch (error) { cleanupErrors.push(`runtime.dispose: ${toError(error)}`) }
}
if (cleanupErrors.length) terminal = { logs, error: { kind: 'cleanup', message: cleanupErrors.join('; ') } }
parentPort.postMessage({ type: 'done', ...terminal })
