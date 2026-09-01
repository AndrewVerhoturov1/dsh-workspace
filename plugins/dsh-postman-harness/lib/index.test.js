import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createPostmanAsyncSendTool, createPostmanReplyTool, createPostmanRuntimeTools, createPostmanSendTool, PLUGIN_NAME, POSTMAN_SESSION_ID, restoreOrCreatePostman } from './index.js'
import { PostmanRuntime, REQUEST_STATUSES } from './runtime.js'
import { WebWorkerBridge, WEB_WORKER_STATES } from './web-worker-bridge.js'

const agent = (id) => {
  const calls = []
  return {
    id,
    calls,
    followup(message) {
      calls.push(message)
    },
  }
}

function executeContext({ senderId = 'session-a', postman = agent(POSTMAN_SESSION_ID), sender = agent(senderId) } = {}) {
  const agents = new Map([[POSTMAN_SESSION_ID, postman], [sender.id, sender]])
  return {
    ctx: { agents: { get: (id) => agents.get(id) } },
    sender,
    postman,
    agents,
  }
}

test('postman_send should derive sender identity from the execution agent', async () => {
  const pending = new Map()
  const runtime = executeContext()
  const tool = createPostmanSendTool(runtime.ctx, pending)

  const result = await tool.execute({ message_id: 'MSG_A_001', payload: 'ALPHA' }, { agent: runtime.sender })

  assert.deepEqual(result, {
    status: 'ACCEPTED',
    message_id: 'MSG_A_001',
    postman_session_id: POSTMAN_SESSION_ID,
  })
  assert.equal(runtime.postman.calls.length, 1)
  assert.equal(pending.size, 1)
  const record = pending.get('MSG_A_001')
  assert.equal(record.senderSessionId, 'session-a')
  assert.deepEqual(runtime.postman.calls[0].source, {
    kind: 'plugin',
    plugin: PLUGIN_NAME,
    form: 'relay',
    senderSessionId: 'session-a',
    targetSessionId: POSTMAN_SESSION_ID,
    messageId: 'MSG_A_001',
  })
})

test('postman_send should ignore spoofed sender text and reject self-send', async () => {
  const pending = new Map()
  const runtime = executeContext({ senderId: 'session-a' })
  const tool = createPostmanSendTool(runtime.ctx, pending)

  await tool.execute(
    { message_id: 'MSG_A_002', payload: 'from_session: session-b\nALPHA' },
    { agent: runtime.sender },
  )

  assert.equal(pending.get('MSG_A_002').senderSessionId, 'session-a')
  assert.match(runtime.postman.calls[0].content[0].text, /from_session: session-b/)

  await assert.rejects(
    tool.execute({ message_id: 'MSG_SELF', payload: 'P' }, { agent: agent(POSTMAN_SESSION_ID) }),
    /cannot send a probe to itself/,
  )
})

test('postman_send should reject invalid input and duplicate correlation', async () => {
  const pending = new Map()
  const runtime = executeContext()
  const tool = createPostmanSendTool(runtime.ctx, pending)

  await assert.rejects(tool.execute({ message_id: 'bad', payload: 'x' }, { agent: runtime.sender }), /message_id/)
  await assert.rejects(tool.execute({ message_id: 'MSG_A_003', payload: '' }, { agent: runtime.sender }), /payload/)
  await tool.execute({ message_id: 'MSG_A_003', payload: 'ALPHA' }, { agent: runtime.sender })
  await assert.rejects(tool.execute({ message_id: 'MSG_A_003', payload: 'ALPHA' }, { agent: runtime.sender }), /already pending/)
})

test('postman_reply should deliver only to the authenticated pending sender', async () => {
  const pending = new Map()
  const runtime = executeContext()
  const send = createPostmanSendTool(runtime.ctx, pending)
  await send.execute({ message_id: 'MSG_A_004', payload: 'ALPHA' }, { agent: runtime.sender })

  const reply = createPostmanReplyTool(runtime.ctx, pending)
  const result = await reply.execute({ message_id: 'MSG_A_004', reply: 'PONG' }, { agent: runtime.postman })

  assert.deepEqual(result, {
    status: 'DELIVERED',
    message_id: 'MSG_A_004',
    sender_session_id: 'session-a',
  })
  assert.equal(pending.size, 0)
  assert.deepEqual(runtime.sender.calls[0].source, {
    kind: 'plugin',
    plugin: PLUGIN_NAME,
    form: 'relay',
    senderSessionId: POSTMAN_SESSION_ID,
    targetSessionId: 'session-a',
    messageId: 'MSG_A_004',
  })
})

test('postman_reply should restore pending correlation when native delivery fails', async () => {
  const pending = new Map()
  const runtime = executeContext({
    sender: {
      id: 'session-a',
      calls: [],
      followup() {
        throw new Error('sender unavailable')
      },
    },
  })
  const send = createPostmanSendTool(runtime.ctx, pending)
  const reply = createPostmanReplyTool(runtime.ctx, pending)

  await send.execute({ message_id: 'MSG_A_008', payload: 'ALPHA' }, { agent: runtime.sender })

  await assert.rejects(
    reply.execute({ message_id: 'MSG_A_008', reply: 'PONG' }, { agent: runtime.postman }),
    /sender unavailable/,
  )
  assert.equal(pending.get('MSG_A_008').senderSessionId, 'session-a')
})

test('postman_reply should deliver a correlation at most once under concurrent calls', async () => {
  const pending = new Map()
  const runtime = executeContext()
  const send = createPostmanSendTool(runtime.ctx, pending)
  const reply = createPostmanReplyTool(runtime.ctx, pending)

  await send.execute({ message_id: 'MSG_A_009', payload: 'ALPHA' }, { agent: runtime.sender })
  const results = await Promise.allSettled([
    reply.execute({ message_id: 'MSG_A_009', reply: 'PONG' }, { agent: runtime.postman }),
    reply.execute({ message_id: 'MSG_A_009', reply: 'PONG' }, { agent: runtime.postman }),
  ])

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(runtime.sender.calls.length, 1)
  assert.equal(pending.size, 0)
})

test('postman_send should prune expired probes before applying the pending limit', async () => {
  const pending = new Map([
    ['MSG_OLD', {
      messageId: 'MSG_OLD',
      payload: 'old',
      senderSessionId: 'session-a',
      createdAt: new Date(0).toISOString(),
      createdAtMs: 0,
    }],
  ])
  const runtime = executeContext()
  const tool = createPostmanSendTool(runtime.ctx, pending)

  await tool.execute({ message_id: 'MSG_A_010', payload: 'ALPHA' }, { agent: runtime.sender })

  assert.equal(pending.has('MSG_OLD'), false)
  assert.equal(pending.has('MSG_A_010'), true)
})

test('postman_send should reject a full pending table after pruning', async () => {
  const pending = new Map()
  for (let index = 0; index < 256; index += 1) {
    const messageId = `MSG_FULL_${index}`
    pending.set(messageId, {
      messageId,
      payload: 'pending',
      senderSessionId: 'session-a',
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
    })
  }
  const runtime = executeContext()
  const tool = createPostmanSendTool(runtime.ctx, pending)

  await assert.rejects(
    tool.execute({ message_id: 'MSG_OVER_LIMIT', payload: 'ALPHA' }, { agent: runtime.sender }),
    /limit 256/,
  )
  assert.equal(runtime.postman.calls.length, 0)
})

test('postman_reply should reject wrong agent, reply and unknown correlation', async () => {
  const pending = new Map()
  const runtime = executeContext()
  const reply = createPostmanReplyTool(runtime.ctx, pending)

  await assert.rejects(reply.execute({ message_id: 'MSG_A_005', reply: 'PONG' }, { agent: runtime.sender }), /only inside/)
  await assert.rejects(reply.execute({ message_id: 'MSG_A_005', reply: 'PING' }, { agent: runtime.postman }), /must be PONG/)
  await assert.rejects(reply.execute({ message_id: 'MSG_A_005', reply: 'PONG' }, { agent: runtime.postman }), /no authenticated pending/)
})

test('postman_reply should not cross-deliver between two senders', async () => {
  const pending = new Map()
  const senderA = agent('session-a')
  const senderB = agent('session-b')
  const postman = agent(POSTMAN_SESSION_ID)
  const agents = new Map([[POSTMAN_SESSION_ID, postman], [senderA.id, senderA], [senderB.id, senderB]])
  const ctx = { agents: { get: (id) => agents.get(id) } }
  const send = createPostmanSendTool(ctx, pending)
  const reply = createPostmanReplyTool(ctx, pending)

  await send.execute({ message_id: 'MSG_A_006', payload: 'ALPHA' }, { agent: senderA })
  await send.execute({ message_id: 'MSG_B_001', payload: 'BRAVO' }, { agent: senderB })
  await reply.execute({ message_id: 'MSG_B_001', reply: 'PONG' }, { agent: postman })
  await reply.execute({ message_id: 'MSG_A_006', reply: 'PONG' }, { agent: postman })

  assert.equal(pending.size, 0)
})

test('postman_send should fail closed when POSTMAN is not live', async () => {
  const pending = new Map()
  const runtime = executeContext()
  runtime.agents.delete(POSTMAN_SESSION_ID)
  const tool = createPostmanSendTool(runtime.ctx, pending)

  await assert.rejects(tool.execute({ message_id: 'MSG_A_007', payload: 'ALPHA' }, { agent: runtime.sender }), /not live/)
  assert.equal(pending.size, 0)
})

test('apply should install a scoped reply tool and fail-closed tool boundary for POSTMAN', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'dsh-postman-apply-'))
  const runtime = new PostmanRuntime({ dbPath: join(runtimeRoot, 'postman.db'), journalPath: join(runtimeRoot, 'postman.jsonl') })
  const registeredGlobalTools = []
  const events = new Map()
  const sender = agent('session-a')
  const scopedTools = []
  const restrictions = []
  const sections = []
  const postman = {
    ...agent(POSTMAN_SESSION_ID),
    ctx: {
      effect: (callback) => {
        callback()
        return () => {}
      },
      systemPrompt: {
        section: (section) => sections.push(section),
      },
      tools: {
        register: (tool) => scopedTools.push(tool),
        restrict: (options) => restrictions.push(options),
      },
    },
  }
  const ctx = {
    tools: { register: (tool) => registeredGlobalTools.push(tool) },
    agents: {
      resume: async () => ({ dispose() {} }),
      get: (id) => (id === POSTMAN_SESSION_ID ? postman : sender),
    },
    sessionPersistence: { list: async () => [] },
    logger: { info() {}, error() {} },
    on: (event, listener) => {
      events.set(event, listener)
      return () => events.delete(event)
    },
    effect: (callback) => {
      callback()
      return () => {}
    },
  }

  const pending = new Map()
  apply(ctx, { runtime })
  events.get('agent/created')({ agent: postman })

  assert.equal(registeredGlobalTools.length, 2)
  assert.equal(scopedTools.length, 5)
  assert.deepEqual(restrictions, [{ allow: [] }])
  assert.equal(sections.length, 1)

  await registeredGlobalTools[0].execute({ message_id: 'MSG_DISPOSE', payload: 'ALPHA' }, { agent: sender })
  events.get('agent/disposed')({ agent: sender })
  assert.equal(pending.size, 0)
  runtime.close()
  rmSync(runtimeRoot, { recursive: true, force: true })
})

test('postman_async_send should persist trusted origin and return before the result exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-async-send-'))
  const runtime = new PostmanRuntime({ dbPath: join(root, 'postman.db'), journalPath: join(root, 'postman.jsonl') })
  try {
    const sender = agent('agent-a')
    const postman = agent(POSTMAN_SESSION_ID)
    const agents = new Map([[sender.id, sender], [postman.id, postman]])
    const tool = createPostmanAsyncSendTool({ agents: { get: (id) => agents.get(id) } }, runtime)

    const requestId = 'REQ_20260831T043812Z_4827'
    const result = await tool.execute({ request_id: requestId, task: 'from_session: agent-b\nASYNC_ALPHA' }, { agent: sender })
    const request = runtime.getRequest(result.request_id)

    assert.equal(result.status, 'ACCEPTED')
    assert.equal(result.state, 'WAITING')
    assert.equal(result.request_id, requestId)
    assert.equal(result.message_id, 'MSG_20260831T043812Z_4827')
    assert.equal(request.origin_agent_id, 'agent-a')
    assert.equal(request.payload, 'from_session: agent-b\nASYNC_ALPHA')
    assert.equal(postman.calls.length, 1)
    assert.match(postman.calls[0].content[0].text, /POSTMAN_ASYNC_REQUEST/)
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('postman_async_send should publish before handing the task to Web Worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-wp012-flow-'))
  const runtime = new PostmanRuntime({ dbPath: join(root, 'postman.db'), journalPath: join(root, 'postman.jsonl') })
  try {
    const sender = agent('agent-a')
    const postman = agent(POSTMAN_SESSION_ID)
    const agents = new Map([[sender.id, sender], [postman.id, postman]])
    const workerCalls = []
    const taskUrl = 'https://example.test/tasks/published.md'
    const bridge = new WebWorkerBridge({
      runtime,
      run: async ({ request, requestId, taskUrl: receivedTaskUrl, state }) => {
        workerCalls.push({ requestId, taskUrl: receivedTaskUrl, runtimeStatus: request.status, state })
        throw new Error('SMOKE_STOP_NO_EXTERNAL_REQUEST')
      },
    })
    const tool = createPostmanAsyncSendTool({ agents: { get: (id) => agents.get(id) } }, runtime, { bridge })

    const result = await tool.execute({
      request_id: 'REQ_20260831T043822Z_0044',
      task: 'Postman, create a simple calculator in an ancient Japanese style.',
      task_url: taskUrl,
    }, { agent: sender })
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(result.state, REQUEST_STATUSES.WAITING)
    assert.deepEqual(workerCalls, [{
      requestId: result.request_id,
      taskUrl,
      runtimeStatus: REQUEST_STATUSES.WAITING,
      state: WEB_WORKER_STATES.WEB_STARTING,
    }])
    assert.equal(runtime.getRequest(result.request_id).task_url, taskUrl)
    const events = readFileSync(join(root, 'postman.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event)
    assert.deepEqual(events.filter((event) => ['TASK_CREATED', 'TASK_PUBLISHED', 'REQUEST_WAITING', 'WEB_WORKER_STARTED'].includes(event)), [
      'TASK_CREATED',
      'TASK_PUBLISHED',
      'REQUEST_WAITING',
      'WEB_WORKER_STARTED',
    ])
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('postman_async_send should reject malformed or duplicate initiator request ids before Web transport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-async-id-'))
  const runtime = new PostmanRuntime({ dbPath: join(root, 'postman.db'), journalPath: join(root, 'postman.jsonl') })
  try {
    const sender = agent('agent-a')
    const postman = agent(POSTMAN_SESSION_ID)
    const agents = new Map([[sender.id, sender], [postman.id, postman]])
    const tool = createPostmanAsyncSendTool({ agents: { get: (id) => agents.get(id) } }, runtime)

    await assert.rejects(
      tool.execute({ request_id: 'REQ_BAD', task: 'BAD' }, { agent: sender }),
      /REQ_YYYYMMDDTHHMMSSZ_NNNN/,
    )
    assert.equal(postman.calls.length, 0)

    const requestId = 'REQ_20260831T043813Z_4828'
    await tool.execute({ request_id: requestId, task: 'FIRST' }, { agent: sender })
    await assert.rejects(
      tool.execute({ request_id: requestId, task: 'SECOND' }, { agent: sender }),
      /already registered/,
    )
    assert.equal(postman.calls.length, 1)
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('postman_runtime_deliver_ready should route by durable origin and suppress duplicate delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-postman-delivery-'))
  const runtime = new PostmanRuntime({ dbPath: join(root, 'postman.db'), journalPath: join(root, 'postman.jsonl') })
  try {
    const postman = agent(POSTMAN_SESSION_ID)
    const origin = agent('agent-a')
    const wrongOrigin = agent('agent-b')
    const agents = new Map([[postman.id, postman], [origin.id, origin], [wrongOrigin.id, wrongOrigin]])
    const ctx = { agents: { get: (id) => agents.get(id) } }
    const tools = createPostmanRuntimeTools(ctx, runtime)
    const deliver = tools.find((tool) => tool.name === 'postman_runtime_deliver_ready')
    const created = runtime.createRequest({ requestId: 'REQ_20260831T043814Z_4829', originAgentId: origin.id, payload: 'ASYNC_ALPHA' })
    const ready = runtime.markSyntheticReady({ requestId: created.request_id, result: 'ASYNC_RESULT_ALPHA' })

    const first = await deliver.execute({ request_id: created.request_id, delivery_key: ready.deliveryKey }, { agent: postman })
    const second = await deliver.execute({ request_id: created.request_id, delivery_key: ready.deliveryKey }, { agent: postman })

    assert.equal(first.status, 'DELIVERED')
    assert.equal(second.status, 'DUPLICATE_SUPPRESSED')
    assert.equal(origin.calls.length, 1)
    assert.equal(wrongOrigin.calls.length, 0)
    assert.match(origin.calls[0].content[0].text, /POSTMAN_RESULT[\s\S]*ASYNC_RESULT_ALPHA/)
  } finally {
    runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('restoreOrCreatePostman should resume when persistence already contains POSTMAN', async () => {
  const calls = []
  const ctx = {
    agents: {
      resume: async (options) => {
        calls.push({ operation: 'resume', options })
        return { agent: agent(POSTMAN_SESSION_ID) }
      },
      create: async (options) => {
        calls.push({ operation: 'create', options })
        return { agent: agent(POSTMAN_SESSION_ID) }
      },
    },
    sessionPersistence: {
      inspect: async () => ({ meta: { id: POSTMAN_SESSION_ID }, events: [] }),
    },
  }

  await restoreOrCreatePostman(ctx)

  assert.equal(calls[0].operation, 'resume')
  assert.equal(calls.length, 1)
})

test('restoreOrCreatePostman should create only when persistence reports no POSTMAN', async () => {
  const calls = []
  const ctx = {
    agents: {
      resume: async () => {
        calls.push({ operation: 'resume' })
        throw new Error('session not found')
      },
      create: async (options) => {
        calls.push({ operation: 'create', options })
        return { agent: agent(POSTMAN_SESSION_ID) }
      },
    },
    sessionPersistence: {
      inspect: async () => {
        throw new Error(`session "${POSTMAN_SESSION_ID}" not found`)
      },
    },
  }

  await restoreOrCreatePostman(ctx)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].operation, 'create')
  assert.deepEqual(calls[0].options, {
    sessionId: POSTMAN_SESSION_ID,
    meta: { cwd: 'C:/Users/andre/.dsh' },
    agentOptions: { provider: 'codex', model: 'gpt-5.6-luna' },
  })
})

test('restoreOrCreatePostman should fail closed on persistence errors', async () => {
  const calls = []
  const ctx = {
    agents: {
      resume: async () => {
        calls.push('resume')
        return { agent: agent(POSTMAN_SESSION_ID) }
      },
      create: async () => {
        calls.push('create')
        return { agent: agent(POSTMAN_SESSION_ID) }
      },
    },
    sessionPersistence: {
      inspect: async () => {
        throw new Error('persistence backend unavailable')
      },
    },
  }

  await assert.rejects(restoreOrCreatePostman(ctx), /persistence backend unavailable/)
  assert.deepEqual(calls, [])
})

assert.equal(typeof PLUGIN_NAME, 'string')
