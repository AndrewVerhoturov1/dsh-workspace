import assert from 'node:assert/strict'
import test from 'node:test'
import { createVudaSessionRouter } from '../vuda-tunnel.mjs'

const params = (scope, name, args = {}) => ({ name, arguments: args, _meta: { 'openai/session': scope } })

test('two chats keep different pages, cookies, screenshots and browser instances', async () => {
  const clients = []
  const router = createVudaSessionRouter(async () => {
    const state = { browser: clients.length, page: null, cookie: null, screenshot: null }
    const client = {
      async callTool({ name, arguments: args }) {
        if (name === 'navigate') Object.assign(state, args)
        return { content: [{ type: 'text', text: JSON.stringify(state) }] }
      },
      async listResources() { return { resources: [{ uri: state.screenshot }] } },
      async readResource() { return { contents: [{ uri: state.screenshot, text: state.page }] } },
      async close() { state.closed = true }
    }
    clients.push(state)
    return client
  })
  try {
    await Promise.all([
      router.run('tools/call', params('chat A', 'navigate', { page: 'A', cookie: 'cookie A', screenshot: 'screenshot://A' })),
      router.run('tools/call', params('chat B', 'navigate', { page: 'B', cookie: 'cookie B', screenshot: 'screenshot://B' }))
    ])
    const a = JSON.parse((await router.run('tools/call', params('chat A', 'inspect'))).content[0].text)
    const b = JSON.parse((await router.run('tools/call', params('chat B', 'inspect'))).content[0].text)
    assert.notEqual(a.browser, b.browser)
    assert.deepEqual([a.page, a.cookie, b.page, b.cookie], ['A', 'cookie A', 'B', 'cookie B'])
    assert.equal((await router.run('resources/list', { _meta: params('chat A')._meta })).resources[0].uri, 'screenshot://A')
    assert.equal((await router.run('resources/read', { uri: 'screenshot://B', _meta: params('chat B')._meta })).contents[0].text, 'B')
    assert.equal(clients.length, 2)
  } finally { await router.close() }
  assert.ok(clients.every(client => client.closed))
})

test('a chat waits for its navigation while another chat can proceed independently', async () => {
  let release, started
  const active = new Promise(resolve => { started = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const calls = []
  const router = createVudaSessionRouter(async () => ({
    async callTool({ name }) {
      calls.push(name)
      if (name === 'navigation A') { started(); await waiting }
      return {}
    }, async close() {}
  }))
  try {
    const first = router.run('tools/call', params('A', 'navigation A'))
    await active
    const next = router.run('tools/call', params('A', 'inspect A'))
    await router.run('tools/call', params('B', 'navigation B'))
    assert.deepEqual(calls, ['navigation A', 'navigation B'])
    release()
    await Promise.all([first, next])
    assert.deepEqual(calls, ['navigation A', 'navigation B', 'inspect A'])
  } finally { release(); await router.close() }
})

test('missing chat metadata never opens a shared browser', async () => {
  let connected = 0
  const router = createVudaSessionRouter(async () => { connected++ })
  for (const scope of [undefined, '', ' ', 123, {}]) {
    await assert.rejects(router.run('tools/call', params(scope, 'navigate')), /VUDA_CHAT_SESSION_REQUIRED/)
  }
  assert.equal(connected, 0)
  await router.close()
  await assert.rejects(router.run('tools/call', params('A', 'navigate')), /VUDA_TUNNEL_CLOSED/)
})

test('audit contains correlation metadata but neither arguments, results nor error text', async () => {
  const events = []
  const router = createVudaSessionRouter(async () => ({
    async callTool({ name }) {
      if (name === 'failed') throw new Error('secret error')
      return { content: [{ type: 'text', text: 'secret result' }] }
    }, async close() {}
  }), event => events.push(event))
  try {
    await router.run('tools/call', params('secret session', 'inspect', { script: 'secret argument' }), 1)
    await assert.rejects(router.run('tools/call', params('secret session', 'failed'), 2), /secret error/)
    assert.equal(events.length, 4)
    assert.doesNotMatch(JSON.stringify(events), /secret/)
    assert.match(events[0].scope, /^[a-f0-9]{64}$/)
    assert.equal(events[0].requestId, events[1].requestId)
    assert.deepEqual(events.map(event => event.event), ['received', 'completed', 'received', 'failed'])
  } finally { await router.close() }
})

test('shutdown also closes a child whose connection is still opening', async () => {
  let opened, started
  const connecting = new Promise(resolve => { started = resolve })
  let closed = 0
  const router = createVudaSessionRouter(() => {
    started()
    return new Promise(resolve => { opened = resolve })
  })
  const call = router.run('tools/call', params('A', 'inspect'))
  await connecting
  const closing = router.close()
  opened({ async callTool() { return {} }, async close() { closed++ } })
  await Promise.all([call, closing])
  assert.equal(closed, 1)
})

const settle = () => new Promise(resolve => setImmediate(resolve))

test('30 idle minutes close only the expired child; returning chats get fresh private state', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clients = [], events = []
  const router = createVudaSessionRouter(async () => {
    const state = { id: clients.length, page: null, closed: false }
    clients.push(state)
    return {
      async callTool({ arguments: args }) {
        if (args.page) state.page = args.page
        return { content: [{ type: 'text', text: JSON.stringify(state) }] }
      },
      async listResources() { return {} },
      async close() { state.closed = true }
    }
  }, event => events.push(event))
  try {
    await router.run('tools/call', params('A', 'navigate', { page: 'A' }))
    t.mock.timers.tick(20 * 60 * 1000)
    await router.run('tools/call', params('B', 'navigate', { page: 'B' }))
    t.mock.timers.tick(10 * 60 * 1000 - 1)
    assert.ok(clients.every(client => !client.closed))
    t.mock.timers.tick(1)
    await settle()
    assert.deepEqual(clients.map(client => client.closed), [true, false])
    const fresh = JSON.parse((await router.run('tools/call', params('A', 'inspect'))).content[0].text)
    assert.equal(fresh.page, null)
    assert.equal(fresh.id, 2)
    assert.equal(clients[1].page, 'B')
    assert.ok(events.some(event => event.event === 'session_closed' && event.reason === 'idle'))
    // Resource calls reset the same idle clock, without touching other chats.
    await router.run('resources/list', { _meta: params('B')._meta })
    t.mock.timers.tick(20 * 60 * 1000)
    await settle()
    assert.equal(clients[1].closed, false)
  } finally { await router.close() }
})

test('connection, active calls and queued actions cannot expire even after 30 minutes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let connect, releaseFirst, releaseSecond, firstStarted, secondStarted
  const firstReady = new Promise(resolve => { firstStarted = resolve })
  const secondReady = new Promise(resolve => { secondStarted = resolve })
  const firstWait = new Promise(resolve => { releaseFirst = resolve })
  const secondWait = new Promise(resolve => { releaseSecond = resolve })
  let closed = 0
  const router = createVudaSessionRouter(() => new Promise(resolve => { connect = resolve }))
  try {
    const first = router.run('tools/call', params('A', 'first'))
    const second = router.run('tools/call', params('A', 'second'))
    await settle()
    t.mock.timers.tick(60 * 60 * 1000)
    connect({
      async callTool({ name }) {
        if (name === 'first') { firstStarted(); await firstWait }
        else { secondStarted(); await secondWait }
        return {}
      }, async close() { closed++ }
    })
    await firstReady
    t.mock.timers.tick(60 * 60 * 1000)
    assert.equal(closed, 0)
    releaseFirst()
    await secondReady
    t.mock.timers.tick(60 * 60 * 1000)
    assert.equal(closed, 0)
    releaseSecond()
    await Promise.all([first, second])
    t.mock.timers.tick(30 * 60 * 1000)
    await settle()
    assert.equal(closed, 1)
  } finally { releaseFirst(); releaseSecond(); await router.close() }
})

test('a failed call still expires and shutdown waits for an idle child already closing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let finishClose, didClose = false
  const closeWait = new Promise(resolve => { finishClose = resolve })
  const router = createVudaSessionRouter(async () => ({
    async callTool() { throw new Error('action failed') },
    async close() { await closeWait; didClose = true }
  }))
  await assert.rejects(router.run('tools/call', params('A', 'inspect')), /action failed/)
  t.mock.timers.tick(30 * 60 * 1000)
  await settle()
  let stopped = false
  const closing = router.close().then(() => { stopped = true })
  await settle()
  assert.equal(stopped, false)
  finishClose()
  await closing
  assert.equal(didClose, true)
})

test('a disconnected child is discarded without reusing another chat or replaying actions', async () => {
  const clients = []
  const router = createVudaSessionRouter(async () => {
    const client = { async callTool() { return {} }, async close() {} }
    clients.push(client)
    return client
  })
  try {
    await router.run('tools/call', params('A', 'inspect'))
    await router.run('tools/call', params('B', 'inspect'))
    clients[0].onclose()
    await router.run('tools/call', params('A', 'inspect'))
    assert.equal(clients.length, 3)
    await router.run('tools/call', params('B', 'inspect'))
    assert.equal(clients.length, 3)
  } finally { await router.close() }
})
