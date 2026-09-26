import { Worker as NodeWorker } from 'node:worker_threads'
import test from 'node:test'
import assert from 'node:assert/strict'
import { demoBindingsForRole, PTC_LAB_SAMPLE_PROGRAM, runBrowserLabProgram } from './ptc-lab-browser-worker.mjs'
import { PtcLabBrowserRuntime } from './ptc-lab-browser-runtime.js'

test('browser lab grants only role-specific demo JSON bindings', () => {
  assert.deepEqual(Object.keys(demoBindingsForRole('leader')), ['plan', 'delegateWorker', 'delegateBridge'])
  assert.deepEqual(Object.keys(demoBindingsForRole('worker')), ['executeLocal'])
  assert.deepEqual(Object.keys(demoBindingsForRole('bridge')), ['inspectReceipt'])
  assert.equal(demoBindingsForRole('unknown'), null)
  assert.deepEqual(demoBindingsForRole('leader').plan({ intent: 'inspect' }), { role: 'leader', accepted: true })
  assert.deepEqual(demoBindingsForRole('worker').executeLocal({ item: 7 }), { role: 'worker', value: { item: 7 } })
  assert.deepEqual(demoBindingsForRole('bridge').inspectReceipt({ requestId: 'REQ-1' }), { requestId: 'REQ-1', state: 'diagnostic-only' })
})

test('QuickJS browser worker executes sample through JSON bridge and captures logs', async () => {
  const result = await runBrowserLabProgram({ role: 'leader', program: PTC_LAB_SAMPLE_PROGRAM })
  assert.deepEqual(result.result, { role: 'leader', report: { role: 'leader', accepted: true } })
  assert.deepEqual(result.logs, ['"simulation only"'])
})

test('QuickJS browser worker rejects unavailable bindings and disposes', async () => {
  const result = await runBrowserLabProgram({ role: 'worker', program: `return await tools.delegateBridge({request:'x'})` })
  assert.equal(result.error?.kind, 'exception')
  assert.match(result.error?.message ?? '', /not a function/)
})

test('QuickJS browser worker timeout disposes context and reports timeout', async () => {
  const result = await runBrowserLabProgram({ role: 'bridge', program: `return await new Promise(() => {})`, timeoutMs: 30 })
  assert.equal(result.error?.kind, 'timeout')
})

function installWorkerHarness({ responsive }) {
  const originalWorker = globalThis.Worker
  const originalWindow = globalThis.window
  const workers = []
  globalThis.window = { location: { origin: 'http://localhost' } }
  globalThis.Worker = class {
    constructor() {
      workers.push(this)
      this.terminated = false
      this.inner = new NodeWorker(new URL('./ptc-lab-node-worker-fixture.mjs', import.meta.url), { type: 'module' })
      this.inner.on('message', data => { if (!this.terminated) this.onmessage?.({ data }) })
    }
    postMessage(message) {
      this.lastMessage = message
      if (responsive || message.type === 'abort') this.inner.postMessage(message)
    }
    terminate() { this.terminated = true; void this.inner.terminate() }
  }
  return {
    workers,
    restore() {
      globalThis.Worker = originalWorker
      if (originalWindow === undefined) delete globalThis.window
      else globalThis.window = originalWindow
    },
  }
}

test('main-thread watchdog terminates a CPU-looping isolated Worker and permits another run', async () => {
  const harness = installWorkerHarness({ responsive: true })
  try {
    const runtime = new PtcLabBrowserRuntime()
    const cpuLoop = runtime.run({ role: 'bridge', program: 'while (true) {}', timeoutMs: 40 })
    const timedOut = await Promise.race([cpuLoop, new Promise((_, reject) => setTimeout(() => reject(new Error('main-thread watchdog failed to return')), 1_500))])
    assert.equal(timedOut.error.kind, 'timeout')
    assert.equal(harness.workers[0].terminated, true)
    assert.equal(runtime.worker, undefined)
    const next = await runtime.run({ role: 'bridge', program: 'return 7', timeoutMs: 500 })
    assert.equal(next.result, 7)
    assert.equal(harness.workers[1].terminated, true)
    assert.equal(runtime.worker, undefined)
  } finally { harness.restore() }
})

test('main-thread watchdog terminates an unresponsive worker; abort and retry leave no active runtime', async () => {
  const harness = installWorkerHarness({ responsive: false })
  try {
    const runtime = new PtcLabBrowserRuntime()
    const first = await runtime.run({ role: 'bridge', program: '', timeoutMs: 1 })
    assert.equal(first.error.kind, 'timeout')
    assert.equal(harness.workers[0].terminated, true)
    assert.equal(runtime.worker, undefined)
    assert.equal(runtime.cancelCurrent, undefined)
    const controller = new AbortController()
    const secondRun = runtime.run({ role: 'bridge', program: '', signal: controller.signal, timeoutMs: 10_000 })
    controller.abort()
    const second = await secondRun
    assert.equal(second.error.kind, 'abort')
    assert.equal(harness.workers[1].terminated, true)
    assert.equal(runtime.worker, undefined)
    const nextRun = runtime.run({ role: 'bridge', program: '', timeoutMs: 10_000 })
    runtime.dispose()
    assert.equal((await nextRun).error.kind, 'abort')
    assert.equal(harness.workers[2].terminated, true)
  } finally { harness.restore() }
})

test('QuickJS browser worker observes abort during pending await', async () => {
  let aborted = false
  const running = runBrowserLabProgram({ role: 'bridge', program: `return await new Promise(() => {})`, isAborted: () => aborted })
  setTimeout(() => { aborted = true }, 40)
  const result = await running
  assert.equal(result.error?.kind, 'abort')
})
