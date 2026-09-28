import { Worker } from 'node:worker_threads'
import { stripTypeScriptTypes } from 'node:module'

const WORKER_URL = new URL('./quickjs-lab-worker.mjs', import.meta.url)
const MAX_PROGRAM_BYTES = 256 * 1024
const MAX_BRIDGE_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_BINDING_NAMESPACES = 16
const MAX_BINDINGS_PER_NAMESPACE = 64
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const FORBIDDEN_BINDING_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

export class QuickJSLabRuntime {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? 2_000
    this.memoryLimitBytes = options.memoryLimitBytes ?? 32 * 1024 * 1024
    this.maxWallMs = options.maxWallMs ?? 5_000
    this.disposed = false
    this.workers = new Set()
  }

  async run({ program, bindings, signal } = {}) {
    if (this.disposed) throw new Error('QuickJSLabRuntime is disposed')
    if (typeof program !== 'string') throw new TypeError('program must be a string')
    if (!Array.isArray(bindings)) throw new TypeError('bindings must be an array')
    if (Buffer.byteLength(program, 'utf8') > MAX_PROGRAM_BYTES) return failure('exception', 'Program limit exceeded')
    if (signal?.aborted) return failure('abort', 'Execution aborted')

    // TypeScript stripping happens on the trusted host before any untrusted JS is passed to QuickJS.
    let javascript
    try { javascript = stripTypeScriptTypes(`async function __dsh_main__() {\n${program}\n}`, { mode: 'strip' }) }
    catch (error) { return failure('exception', error.message) }
    const bodyStart = javascript.indexOf('{') + 1
    const bodyEnd = javascript.lastIndexOf('}')
    javascript = javascript.slice(bodyStart, bodyEnd)

    const namespaceData = []
    const functionMap = new Map()
    try {
      if (bindings.length > MAX_BINDING_NAMESPACES) throw new TypeError('too many binding namespaces')
      const seenGlobals = new Set()
      for (const namespace of bindings) {
        if (!namespace || typeof namespace !== 'object' || !BINDING_NAME.test(namespace.global) || namespace.global === 'console' || FORBIDDEN_BINDING_NAMES.has(namespace.global)) throw new TypeError('invalid binding namespace')
        if (seenGlobals.has(namespace.global)) throw new TypeError(`duplicate binding namespace ${namespace.global}`)
        seenGlobals.add(namespace.global)
        if (!namespace.functions || typeof namespace.functions !== 'object' || Array.isArray(namespace.functions)) throw new TypeError('binding functions must be an object')
        const names = Object.keys(namespace.functions)
        if (names.length > MAX_BINDINGS_PER_NAMESPACE) throw new TypeError('too many bindings in namespace')
        const perNamespace = Object.create(null)
        for (const name of names) {
          if (!BINDING_NAME.test(name) || FORBIDDEN_BINDING_NAMES.has(name)) throw new TypeError(`invalid binding name ${JSON.stringify(name)}`)
          const fn = namespace.functions[name]
          if (typeof fn !== 'function') throw new TypeError(`binding ${name} must be a function`)
          perNamespace[name] = fn
        }
        namespaceData.push({ global: namespace.global, functions: names })
        functionMap.set(namespace.global, perNamespace)
      }
    } catch (error) { return failure('exception', error.message) }

    return await new Promise(resolve => {
      const worker = new Worker(WORKER_URL, {
        type: 'module',
        execArgv: [],
        workerData: { program: javascript, namespaces: namespaceData, timeoutMs: this.timeoutMs, memoryLimitBytes: this.memoryLimitBytes },
        resourceLimits: { maxOldGenerationSizeMb: Math.max(16, Math.floor(this.memoryLimitBytes / 1024 / 1024)), stackSizeMb: 2 },
      })
      this.workers.add(worker)
      let settled = false
      let calls = 0
      const cleanup = async result => {
        if (settled) return
        settled = true
        clearTimeout(wallTimer)
        signal?.removeEventListener('abort', onAbort)
        this.workers.delete(worker)
        try { await worker.terminate() } catch {}
        resolve(result)
      }
      const onAbort = () => void cleanup(failure('abort', 'Execution aborted'))
      const wallTimer = setTimeout(() => void cleanup(failure('timeout', 'Execution wall-time limit exceeded')), this.maxWallMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.on('message', message => {
        if (message.type === 'call') {
          if (settled) return
          calls += 1
          if (calls > 256) {
            worker.postMessage({ type: 'reply', id: message.id, ok: false, error: 'Tool call count limit exceeded' })
            return
          }
          const namespaceFunctions = functionMap.get(message.global)
          const fn = namespaceFunctions && Object.hasOwn(namespaceFunctions, message.name) ? namespaceFunctions[message.name] : undefined
          if (!fn) {
            worker.postMessage({ type: 'reply', id: message.id, ok: false, error: 'Unknown binding' })
            return
          }
          const respond = (ok, value) => {
            if (settled) return
            if (!ok) {
              worker.postMessage({ type: 'reply', id: message.id, ok: false, error: value instanceof Error ? value.message : String(value) })
              return
            }
            try {
              const json = JSON.stringify(value)
              if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_BRIDGE_BYTES) throw new TypeError('binding result is not bounded JSON')
              worker.postMessage({ type: 'reply', id: message.id, ok: true, value: JSON.parse(json) })
            } catch (error) {
              worker.postMessage({ type: 'reply', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
            }
          }
          try {
            const json = JSON.stringify(message.args)
            if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_BRIDGE_BYTES) throw new TypeError('binding arguments exceed JSON limit')
            Promise.resolve(fn(JSON.parse(json))).then(value => respond(true, value), error => respond(false, error))
          } catch (error) { respond(false, error) }
          return
        }
        if (message.type === 'done') void cleanup({ ...(message.value === undefined ? {} : { value: message.value }), logs: Array.isArray(message.logs) ? message.logs : [], ...(message.error ? { error: message.error } : {}) })
      })
      worker.once('error', error => void cleanup(failure('worker-exit', error.message)))
      worker.once('exit', code => {
        if (!settled) void cleanup(failure('worker-exit', `Worker exited (${code}) without result`))
      })
    })
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.workers].map(worker => worker.terminate().catch(() => {})))
    this.workers.clear()
  }
}

function failure(kind, message) { return { logs: [], error: { kind, message } } }
