import test from 'node:test'
import assert from 'node:assert/strict'
import { PtcLabRoles } from './ptc-lab-roles.js'

test('roles expose their separate JSON bindings and reject cross-role control', async () => {
  const lab = new PtcLabRoles()
  try {
    assert.deepEqual((await lab.run('leader', { program: `return await tools.plan({intent:'ship'})` })).value, { role: 'leader', accepted: true })
    assert.deepEqual((await lab.run('worker', { program: `return await tools.executeLocal({item:7})` })).value, { role: 'worker', value: { item: 7 } })
    assert.deepEqual((await lab.run('bridge', { program: `return await tools.inspectReceipt({requestId:'REQ-1'})` })).value, { requestId: 'REQ-1', state: 'diagnostic-only' })

    for (const [role, name] of [['worker', 'delegateBridge'], ['worker', 'plan'], ['bridge', 'executeLocal'], ['bridge', 'delegateWorker'], ['leader', 'executeLocal']]) {
      const denied = await lab.run(role, { program: `return await tools.${name}({})` })
      assert.match(denied.error?.message ?? '', /not a function/, `${role}.${name}`)
    }
  } finally { await lab.dispose() }
})

test('aborted role run settles; runtimes dispose independently', async () => {
  const lab = new PtcLabRoles({ timeoutMs: 2_000, maxWallMs: 3_000 })
  const controller = new AbortController()
  try {
    const running = lab.run('worker', { program: `while (true) {}`, signal: controller.signal })
    setTimeout(() => controller.abort(), 25)
    assert.equal((await running).error?.kind, 'abort')
  } finally { await lab.dispose() }
})
