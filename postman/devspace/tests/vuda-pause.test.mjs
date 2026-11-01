import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { configureVudaPause, installVudaPauseHandlers } from '../vuda-pause.mjs'

function fixture({ failFreeze = false, confirmPause = true } = {}) {
  const states = []
  const page = { closed: false, isClosed() { return this.closed } }
  const context = { pages: () => [page], async newCDPSession() {
    const session = new EventEmitter()
    session.send = async method => {
      states.push(method)
      if (method === 'Runtime.evaluate') {
        if (failFreeze) throw new Error('freeze failed')
        if (confirmPause) session.emit('Debugger.paused')
      }
    }
    session.detach = async () => { states.push('detached') }
    return session
  } }
  const chromium = { async launch() { return { contexts: () => [context] } } }
  return { chromium, states, page, lifecycle: configureVudaPause(chromium) }
}

test('pause is explicit, idempotent, keeps the page and affects only owned browsers', async () => {
  const a = fixture(), b = fixture()
  await a.chromium.launch({})
  await b.chromium.launch({})
  assert.deepEqual(a.states, [])
  assert.equal(await a.lifecycle.pause(), 1)
  assert.equal(await a.lifecycle.pause(), 1)
  assert.deepEqual(a.states, ['Debugger.enable', 'Runtime.evaluate'])
  assert.deepEqual(b.states, [])
  assert.equal(a.page.closed, false)
  await a.lifecycle.resume()
  assert.deepEqual(a.states, ['Debugger.enable', 'Runtime.evaluate', 'Debugger.disable', 'detached'])
})

test('partial freeze failure resumes and releases the CDP connection', async () => {
  const f = fixture({ failFreeze: true })
  await f.chromium.launch({})
  await assert.rejects(f.lifecycle.pause(), /freeze failed/)
  assert.deepEqual(f.states, ['Debugger.enable', 'Runtime.evaluate', 'Debugger.disable', 'detached'])
})

test('a page closed while paused is not resumed or recreated', async () => {
  const f = fixture()
  await f.chromium.launch({})
  await f.lifecycle.pause()
  f.page.closed = true
  await f.lifecycle.resume()
  assert.deepEqual(f.states, ['Debugger.enable', 'Runtime.evaluate', 'detached'])
})

test('a successful CDP response without a paused event is not reported as a pause', async () => {
  const f = fixture({ confirmPause: false })
  await f.chromium.launch({})
  await assert.rejects(f.lifecycle.pause(), /VUDA_PAUSE_NOT_CONFIRMED/)
  assert.deepEqual(f.states, ['Debugger.enable', 'Runtime.evaluate', 'Debugger.disable', 'detached'])
})

test('MCP pauses after active tools, resumes before the next tool and never replays failures', async () => {
  class Server { setRequestHandler(schema, handler) { this[schema.shape.method.value] = handler } }
  const calls = []
  let release, started
  const ready = new Promise(resolve => { started = resolve })
  const active = new Promise(resolve => { release = resolve })
  const restore = installVudaPauseHandlers(Server, {
    async pause() { calls.push('pause'); return 1 }, async resume() { calls.push('resume') }
  })
  const server = new Server()
  server.setRequestHandler({ shape: { method: { value: 'tools/list' } } }, async () => ({ tools: [{ name: 'inspect' }] }))
  server.setRequestHandler({ shape: { method: { value: 'tools/call' } } }, async request => {
    calls.push(request.params.name)
    if (request.params.name === 'test') { started(); await active }
    if (request.params.name === 'failed') throw new Error('action failed')
    return {}
  })
  restore()
  const run = name => server['tools/call']({ params: { name } })
  assert.deepEqual((await server['tools/list']()).tools.map(t => t.name), ['inspect', 'vuda_pause'])
  const first = run('test')
  await ready
  const pause = run('vuda_pause')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['resume', 'test'])
  release()
  await Promise.all([first, pause])
  await assert.rejects(run('failed'), /action failed/)
  await run('inspect')
  assert.deepEqual(calls, ['resume', 'test', 'pause', 'resume', 'failed', 'resume', 'inspect'])
})
