import test from 'node:test'
import assert from 'node:assert/strict'
import { newQuickJSWASMModule, newQuickJSAsyncWASMModule } from 'quickjs-emscripten'

async function makeRuntime() {
  const module = await newQuickJSWASMModule()
  return module.newRuntime()
}

async function run(code, configure, timeoutMs = 250) {
  const runtime = await makeRuntime()
  const context = runtime.newContext()
  configure?.(context, runtime)
  const result = context.evalCode(code)
  if (result.error) throw context.dump(result.error)
  const promise = result.value
  const deadline = Date.now() + timeoutMs
  let state = context.getPromiseState(promise)
  while (state.type === 'pending' && Date.now() < deadline) {
    runtime.executePendingJobs()
    await new Promise(resolve => setTimeout(resolve, 1))
    state = context.getPromiseState(promise)
  }
  return { context, runtime, promise, state }
}

function installDeferredBinding(context, name = 'hostFn', reject = false) {
  const fn = context.newFunction(name, argsHandle => {
    const argument = argsHandle ? context.dump(argsHandle) : undefined
    const deferred = context.newPromise()
    const returned = deferred.handle.dup()
    setTimeout(() => {
      if (reject) {
        const error = context.newError({ name: 'Error', message: 'host failure' })
        try { deferred.reject(error) } finally { error.dispose() }
      } else {
        const value = context.newNumber(argument?.x ?? 7)
        try { deferred.resolve(value) } finally { value.dispose() }
      }
      deferred.dispose()
    }, 5)
    return returned
  })
  fn.consume(handle => context.setProp(context.global, name, handle))
}

test('official asyncified host callback cleanup currently reproduces cleanup failure', async () => {
  const quickjs = await newQuickJSAsyncWASMModule()
  const runtime = quickjs.newRuntime()
  const context = runtime.newContext()
  const fn = context.newAsyncifiedFunction('hostFn', async value => context.newNumber(context.getNumber(value) + 1))
  fn.consume(handle => context.setProp(context.global, 'hostFn', handle))
  const result = await context.evalCodeAsync('hostFn(41)')
  const value = context.unwrapResult(result)
  assert.equal(context.getNumber(value), 42)
  value.dispose()
  context.dispose()
  assert.throws(() => runtime.dispose(), /not found when trying to free HostRef/)
})

test('sync host function eval and teardown', async () => {
  const { context, runtime, state } = await run('hostFn(41)', context => {
    const fn = context.newFunction('hostFn', value => context.newNumber(context.getNumber(value) + 1))
    fn.consume(handle => context.setProp(context.global, 'hostFn', handle))
  })
  assert.equal(state.type, 'fulfilled')
  assert.equal(context.getNumber(state.value), 42)
  state.value.dispose(); context.dispose(); runtime.dispose()
})

test('sync host function returns deferred result and tears down', async () => {
  const { context, runtime, promise, state } = await run('hostFn()', context => installDeferredBinding(context))
  assert.equal(state.type, 'fulfilled')
  assert.equal(context.getNumber(state.value), 7)
  state.value.dispose(); promise.dispose(); context.dispose(); runtime.dispose()
})

test('sync runtime handles parallel deferred calls and host rejection', async () => {
  const { context, runtime, promise, state } = await run('Promise.all([hostFn({x:1}), hostFn({x:2}), badFn().catch(e => e.message)])', context => {
    installDeferredBinding(context, 'hostFn')
    installDeferredBinding(context, 'badFn', true)
  })
  assert.equal(state.type, 'fulfilled')
  assert.deepEqual(context.dump(state.value), [1, 2, 'host failure'])
  state.value.dispose(); promise.dispose(); context.dispose(); runtime.dispose()
})

test('sync runtime pending promise times out and cleans up', async () => {
  const { context, runtime, promise, state } = await run('new Promise(() => {})', undefined, 20)
  assert.equal(state.type, 'pending')
  promise.dispose(); context.dispose(); runtime.dispose()
})
