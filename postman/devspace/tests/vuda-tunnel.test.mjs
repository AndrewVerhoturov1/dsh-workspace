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
