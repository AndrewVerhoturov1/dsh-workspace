import { newQuickJSWASMModule, RELEASE_SYNC } from 'quickjs-emscripten'
import { newVariant } from 'quickjs-emscripten-core'

const quickjsSyncVariant = typeof self === 'undefined'
  ? RELEASE_SYNC
  : newVariant(RELEASE_SYNC, {
      wasmLocation: new URL('/plugins/dsh-postman-harness/emscripten-module.wasm', self.location.origin).href,
    })

const MAX_PROGRAM_BYTES = 256 * 1024
const MAX_RESULT_BYTES = 64 * 1024
const MAX_CALLS = 64
const ROLES = Object.freeze({
  leader: Object.freeze({
    plan: args => ({ role: 'leader', accepted: Boolean(args?.intent) }),
    delegateWorker: args => ({ delegated: Boolean(args?.task) }),
    delegateBridge: args => ({ delegated: Boolean(args?.request) }),
  }),
  worker: Object.freeze({
    executeLocal: args => ({ role: 'worker', value: args ?? null }),
  }),
  bridge: Object.freeze({
    inspectReceipt: args => ({ requestId: String(args?.requestId ?? ''), state: 'diagnostic-only' }),
  }),
})
export const PTC_LAB_SAMPLE_PROGRAM = `console.log('simulation only');\nconst report = await tools.plan({intent: 'inspect'});\nreturn {role: 'leader', report};`

export function demoBindingsForRole(role) { return ROLES[role] ?? null }

const bytes = value => new TextEncoder().encode(value).byteLength
function jsonText(value, label, cap = MAX_RESULT_BYTES) {
  const json = JSON.stringify(value)
  if (json === undefined || bytes(json) > cap) throw new Error(`${label} exceeds the JSON limit`)
  return json
}
function message(error) { return error instanceof Error ? error.message : String(error) }

export async function runBrowserLabProgram({ role, program, onLog = () => {}, isAborted = () => false, timeoutMs = 5_000 }) {
  let runtime
  let context
  let aborted = false
  let logs = []
  let outcome
  let timedOut = false
  let calls = 0
  let logBytes = 0
  try {
    if (!Object.hasOwn(ROLES, role)) throw new Error('Unknown lab role')
    if (typeof program !== 'string' || bytes(program) > MAX_PROGRAM_BYTES) throw new Error('Program exceeds the lab input limit')
    const quickjs = await newQuickJSWASMModule(quickjsSyncVariant)
    if (isAborted()) throw new Error('Execution aborted')
    runtime = quickjs.newRuntime({ memoryLimitBytes: 16 * 1024 * 1024, maxStackSizeBytes: 512 * 1024 })
    context = runtime.newContext()
    const requestedTimeout = Number(timeoutMs)
    const boundedTimeout = Number.isFinite(requestedTimeout) ? Math.max(1, Math.min(requestedTimeout, 30_000)) : 5_000
    const deadline = performance.now() + boundedTimeout
    runtime.setInterruptHandler(() => aborted || isAborted())

    const namespace = context.newObject()
    for (const [name, hostFunction] of Object.entries(ROLES[role])) {
      const fn = context.newFunction(name, argsHandle => {
        calls += 1
        if (calls > MAX_CALLS) throw new Error('Lab call limit exceeded')
        const argsJson = argsHandle ? jsonText(context.dump(argsHandle), 'binding arguments') : 'null'
        const resultJson = jsonText(hostFunction(JSON.parse(argsJson)), 'binding result')
        const jsonObject = context.getProp(context.global, 'JSON')
        const parse = context.getProp(jsonObject, 'parse')
        const text = context.newString(resultJson)
        try {
          const parsed = context.callFunction(parse, jsonObject, text)
          if (parsed.error) {
            const detail = context.dump(parsed.error)?.message ?? 'JSON.parse failed'
            parsed.error.dispose()
            throw new Error(detail)
          }
          return parsed.value
        } finally { text.dispose(); parse.dispose(); jsonObject.dispose() }
      })
      context.setProp(namespace, name, fn)
      fn.dispose()
    }
    context.setProp(context.global, 'tools', namespace)
    namespace.dispose()

    const log = context.newFunction('log', (...handles) => {
      for (const handle of handles) {
        const entry = JSON.stringify(context.dump(handle)) ?? 'undefined'
        logBytes += bytes(entry)
        if (logBytes > MAX_RESULT_BYTES) throw new Error('Lab log limit exceeded')
        logs.push(entry); onLog(entry)
      }
      return context.undefined
    })
    const consoleObject = context.newObject()
    for (const key of ['log', 'info', 'warn', 'error']) context.setProp(consoleObject, key, log)
    context.setProp(context.global, 'console', consoleObject)
    log.dispose(); consoleObject.dispose()

    const evaluated = context.evalCode(`"use strict"; (async function __lab_main__() { ${program}\n})()`, 'ptc-lab-program.js')
    if (evaluated.error) {
      const detail = context.dump(evaluated.error)?.message ?? 'Program failed'
      evaluated.error.dispose()
      throw new Error(detail)
    }
    const promise = evaluated.value
    let promiseDisposed = false
    const disposePromise = () => { if (!promiseDisposed) { promiseDisposed = true; promise.dispose() } }
    let state = context.getPromiseState(promise)
    while (state.type === 'pending' && performance.now() < deadline && !isAborted()) {
      runtime.executePendingJobs()
      await new Promise(resolve => setTimeout(resolve, 1))
      state = context.getPromiseState(promise)
    }
    if (isAborted()) { aborted = true; disposePromise(); throw new Error('Execution aborted') }
    if (timedOut || state.type === 'pending' || performance.now() >= deadline) { timedOut = true; disposePromise(); throw new Error('Execution timed out') }
    if (state.type === 'rejected') {
      const detail = context.dump(state.error)?.message ?? 'Program rejected'
      state.error.dispose(); disposePromise()
      throw new Error(detail)
    }
    const resultJson = jsonText(context.dump(state.value), 'program result')
    state.value.dispose(); disposePromise()
    outcome = { result: JSON.parse(resultJson), logs }
  } catch (error) {
    outcome = { logs, error: { kind: isAborted() ? 'abort' : timedOut ? 'timeout' : 'exception', message: message(error) } }
  } finally {
    try { if (context?.alive) context.dispose() } catch (error) {
      outcome = { logs, error: { kind: 'cleanup', message: `context.dispose: ${message(error)}` } }
    }
    try { if (runtime?.alive) runtime.dispose() } catch (error) {
      outcome = { logs, error: { kind: 'cleanup', message: `${outcome?.error?.message ? `${outcome.error.message}; ` : ''}runtime.dispose: ${message(error)}` } }
    }
  }
  return outcome
}

if (typeof self !== 'undefined') self.onmessage = async ({ data }) => {
  if (!data || data.type !== 'run') return
  let aborted = false
  const { runId } = data
  self.onmessage = event => {
    if (event.data?.type === 'abort' && event.data.runId === runId) aborted = true
  }
  const outcome = await runBrowserLabProgram({ ...data, isAborted: () => aborted })
  self.postMessage({ type: 'done', runId, ...outcome })
}
