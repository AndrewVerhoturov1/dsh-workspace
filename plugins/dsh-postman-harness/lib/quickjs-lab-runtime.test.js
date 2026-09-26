import test from 'node:test'
import assert from 'node:assert/strict'
import { QuickJSLabRuntime } from './quickjs-lab-runtime.js'

const make = options => new QuickJSLabRuntime({ timeoutMs: 1_000, maxWallMs: 3_000, ...options })

test('QuickJS evaluates async JSON binding calls in order and roundtrips values', async () => {
  const runtime = make()
  const order = []
  const result = await runtime.run({
    program: `const a = await tools.first({n: 1}); const b = await tools.second(a); return b`,
    bindings: [{ global: 'tools', functions: {
      first: async args => { order.push('first'); return { n: args.n + 1, list: [true, null, 'é'] } },
      second: async args => { order.push('second'); return { ...args, ok: true } },
    } }],
  })
  assert.deepEqual(order, ['first', 'second'])
  assert.deepEqual(result.value, { n: 2, list: [true, null, 'é'], ok: true })
  await runtime.dispose()
})

test('QuickJS awaits Promise.all, accepts host rejection, and reports missing method TypeError', async () => {
  const runtime = make()
  const result = await runtime.run({
    program: `const values = await Promise.all([tools.ok({x: 1}), tools.ok({x: 2})]); try { await tools.nope({}) } catch (e) { return [values, e.message] }`,
    bindings: [{ global: 'tools', functions: { ok: async x => x } }],
  })
  assert.deepEqual(result.value, [[{ x: 1 }, { x: 2 }], 'not a function'])
  const rejected = await runtime.run({
    program: `try { await tools.fail({}) } catch (error) { return error.message }`,
    bindings: [{ global: 'tools', functions: { fail: async () => { throw new Error('host failure') } } }],
  })
  assert.equal(rejected.value, 'host failure')
  await runtime.dispose()
})

test('rejects non-JSON values and strips type-only TypeScript on trusted host', async () => {
  const runtime = make()
  const result = await runtime.run({ program: `const n: number = 4; return n`, bindings: [] })
  assert.equal(result.value, 4)
  const invalid = await runtime.run({ program: `return undefined`, bindings: [] })
  assert.equal(invalid.error?.kind, 'invalid-output')
  await runtime.dispose()
})

test('does not expose Node globals and rejects dynamic import', async () => {
  const runtime = make()
  for (const name of ['process', 'require', 'global', 'Deno']) {
    const result = await runtime.run({ program: `return typeof ${name}`, bindings: [] })
    assert.equal(result.value, 'undefined', name)
  }
  const dynamicImport = await runtime.run({ program: `return await import('node:fs')`, bindings: [] })
  assert.ok(dynamicImport.error, 'Node module import must not be available')
  await runtime.dispose()
})

test('interrupts infinite loops and wall timer bounds pending Promise', async () => {
  const runtime = make({ timeoutMs: 150, maxWallMs: 1_000 })
  const loop = await runtime.run({ program: `while (true) {}`, bindings: [] })
  assert.equal(loop.error?.kind, 'timeout')
  const pending = await runtime.run({ program: `return await new Promise(() => {})`, bindings: [] })
  assert.equal(pending.error?.kind, 'timeout')
  await runtime.dispose()
})

test('abort terminates worker and memory exhaustion does not hang parent', async () => {
  const runtime = make({ timeoutMs: 2_000, maxWallMs: 3_000, memoryLimitBytes: 16 * 1024 * 1024 })
  const controller = new AbortController()
  const running = runtime.run({ program: `while (true) {}`, bindings: [], signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  const aborted = await running
  assert.equal(aborted.error?.kind, 'abort')
  const memory = await runtime.run({ program: `const a = []; while (true) a.push(new Array(10000).fill('x'));`, bindings: [] })
  assert.ok(memory.error)
  await runtime.dispose()
})

test('enforces program/output/argument and binding result limits', async () => {
  const runtime = make()
  const tooLarge = await runtime.run({ program: `return 1;` + ' '.repeat(300_000), bindings: [] })
  assert.equal(tooLarge.error?.kind, 'exception')
  const out = await runtime.run({ program: `console.log('x'.repeat(70000)); return 1`, bindings: [] })
  assert.ok(out.error)
  const args = await runtime.run({ program: `await tools.echo('x'.repeat(1100000));`, bindings: [{ global: 'tools', functions: { echo: async x => x } }] })
  assert.ok(args.error)
  const value = await runtime.run({ program: `return await tools.large(null)`, bindings: [{ global: 'tools', functions: { large: async () => 'x'.repeat(1100000) } }] })
  assert.ok(value.error)
  await runtime.dispose()
})
