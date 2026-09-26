import test from 'node:test'
import assert from 'node:assert/strict'
import { demoBindingsForRole, PTC_LAB_SAMPLE_PROGRAM, runBrowserLabProgram } from './ptc-lab-browser-worker.mjs'

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

test('QuickJS browser worker observes abort during pending await', async () => {
  let aborted = false
  const running = runBrowserLabProgram({
    role: 'bridge',
    program: `return await new Promise(() => {})`,
    isAborted: () => aborted,
  })
  setTimeout(() => { aborted = true }, 40)
  const result = await running
  assert.equal(result.error?.kind, 'abort')
})
