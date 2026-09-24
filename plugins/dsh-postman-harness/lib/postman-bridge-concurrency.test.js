import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeTool } from './postman-bridge.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'

const parent = {
  id: 'leader',
  session: { header: { id: 'leader', agentPreset: 'postman-leader', delegationDepth: 0 } },
}
const signal = new AbortController().signal
const messages = [
  '@PostmanAsk first independent text',
  '@PostmanAsk second independent text',
  '@Postman third independent artifact',
]

test('Bridge opts into Harness parallel mode', () => {
  const tool = createPostmanBridgeTool({}, { run: () => {} })
  assert.equal(tool.isConcurrencySafe({ message: messages[0] }), true)
  assert.equal(tool.name, 'postman_bridge')
})

test('three calls overlap, retain exact child scope, terminal and individual cleanup', async () => {
  const pending = new Map()
  const disposed = []
  let next = 0
  const ctx = {
    subagents: {
      async start(_provider, request) {
        const id = 'child-' + ++next
        const child = { id }
        const result = new Promise(resolve => pending.set(id, resolve))
        return {
          id, localAgent: child, result,
          async dispose() { disposed.push(id) },
        }
      },
    },
    tools: {
      get(_name, child) {
        return { async execute() {
          return { status: 'COMPLETED', requestId: 'REQ_' + child.id,
            result: { ok: true, requestId: 'REQ_' + child.id, assistantText: 'text-' + child.id } }
        } }
      },
    },
  }
  // Parallel child isolation is independent of the launch-rate policy.
  const coordinator = { run: (_signal, launch) => launch() }
  const tool = createPostmanBridgeTool(ctx, coordinator)
  const promises = messages.map(message => tool.execute({ message }, { agent: parent, signal }))
  // All starts must reach their independent pending child before any settles.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.size, 3)
  pending.get('child-2')({ stopReason: 'end_turn' })
  pending.get('child-3')({ stopReason: 'end_turn' })
  pending.get('child-1')({ stopReason: 'end_turn' })
  const values = await Promise.all(promises)
  assert.deepEqual(values.map(v => v.childSessionId), ['child-1', 'child-2', 'child-3'])
  assert.deepEqual(values.map(v => v.requestId), ['REQ_child-1', 'REQ_child-2', 'REQ_child-3'])
  assert.deepEqual(values.map(v => v.result.assistantText), ['text-child-1', 'text-child-2', 'text-child-3'])
  assert.deepEqual(disposed.sort(), ['child-1', 'child-2', 'child-3'])
})

test('invalid delegation and rejected caller never enter launch coordinator', async () => {
  let launches = 0
  const coordinator = { run: (_signal, launch) => { launches++; return launch() } }
  const tool = createPostmanBridgeTool({}, coordinator)
  const invalid = await tool.execute({ message: 'not a Postman delegation' }, { agent: parent, signal })
  assert.equal(invalid.status, 'POSTMAN_BRIDGE_MESSAGE_REJECTED')
  const wrongCaller = await tool.execute({ message: messages[0] }, {
    agent: { id: 'other', session: { header: { id: 'other', agentPreset: 'default', delegationDepth: 0 } } },
    signal,
  })
  assert.equal(wrongCaller.status, 'POSTMAN_BRIDGE_CALLER_REJECTED')
  assert.equal(launches, 0)
})

test('start failure settles full coordinated lifecycle without masking diagnostic', async () => {
  let starts = 0
  let settlements = 0
  const coordinator = { run: async (_signal, launch) => {
    starts++
    try { return await launch() } finally { settlements++ }
  } }
  const tool = createPostmanBridgeTool({ subagents: { async start() { throw new Error('startup failed') } } }, coordinator)
  const value = await tool.execute({ message: messages[0] }, { agent: parent, signal })
  assert.equal(value.status, 'POSTMAN_BRIDGE_START_FAILED')
  assert.match(value.diagnostic, /startup failed/)
  assert.equal(starts, 1)
  assert.equal(settlements, 1)
})

test('real staggered coordinator overlaps independent children and releases after disposal', async () => {
  let time = 0
  let timer
  const coordinator = createPostmanBridgeLaunchCoordinator({
    now: () => time, random: () => 0,
    setTimer(callback, delay) { timer = { callback, at: time + delay }; return timer },
    clearTimer() { timer = undefined },
  })
  const pending = new Map()
  const disposed = []
  const starts = []
  const ctx = {
    subagents: { async start(_provider, request) {
      const id = String(starts.length + 1)
      starts.push({ id, at: time, prompt: request.prompt[0].text })
      let finish
      const result = new Promise(resolve => { finish = resolve })
      pending.set(id, finish)
      return { id, localAgent: { id }, result, async dispose() { disposed.push(id) } }
    } },
    tools: { get(_name, child) { return { async execute() {
      return { status: 'COMPLETED', requestId: child.id, result: { requestId: child.id } }
    } } } },
  }
  const tool = createPostmanBridgeTool(ctx, coordinator)
  const runs = messages.map(message => tool.execute({ message }, { agent: parent, signal }))
  assert.equal(starts.length, 1)
  time = 5000; timer.callback()
  assert.equal(starts.length, 2)
  time = 10000; timer.callback()
  assert.equal(starts.length, 3)
  assert.equal(coordinator.activeCount, 3)
  await new Promise(resolve => setImmediate(resolve))
  pending.get('2')({ stopReason: 'end_turn' })
  assert.equal((await runs[1]).childSessionId, '2')
  assert.equal(coordinator.activeCount, 2)
  pending.get('1')({ stopReason: 'end_turn' })
  pending.get('3')({ stopReason: 'end_turn' })
  const values = await Promise.all(runs)
  assert.deepEqual(values.map(x => x.childSessionId), ['1', '2', '3'])
  assert.deepEqual(disposed.sort(), ['1', '2', '3'])
  assert.equal(coordinator.activeCount, 0)
  coordinator.dispose()
})

test('unavailable child and terminal error free real coordinator slots after cleanup', async () => {
  const coordinator = createPostmanBridgeLaunchCoordinator()
  let disposed = 0
  const ctx = { subagents: { async start() {
    return { id: 'missing', localAgent: undefined, async dispose() { disposed++ } }
  } } }
  const tool = createPostmanBridgeTool(ctx, coordinator)
  ctx.subagents.start = async () => { throw new Error('cannot start child') }
  const failed = await tool.execute({ message: messages[0] }, { agent: parent, signal })
  assert.equal(failed.status, 'POSTMAN_BRIDGE_START_FAILED')
  assert.equal(coordinator.activeCount, 0)
  ctx.subagents.start = async () => ({
    id: 'missing', localAgent: undefined, async dispose() { disposed++ },
  })
  const missing = await tool.execute({ message: messages[0] }, { agent: parent, signal })
  assert.equal(missing.status, 'POSTMAN_BRIDGE_CHILD_UNAVAILABLE')
  assert.equal(coordinator.activeCount, 0)
  assert.equal(disposed, 1)
  ctx.subagents.start = async () => ({
    id: 'terminal-error', localAgent: { id: 'child' },
    result: Promise.reject(new Error('child failed')),
    async dispose() { disposed++ },
  })
  ctx.tools = { get() { return { async execute() { throw new Error('terminal read failed') } } } }
  await assert.rejects(tool.execute({ message: messages[0] }, { agent: parent, signal }), /terminal read failed/)
  assert.equal(coordinator.activeCount, 0)
  assert.equal(disposed, 2)
  let completeDisposal
  ctx.subagents.start = async () => ({
    id: 'cleanup-pending', localAgent: { id: 'child' },
    result: Promise.resolve({ stopReason: 'end_turn' }),
    dispose() { disposed++; return new Promise(resolve => { completeDisposal = resolve }) },
  })
  ctx.tools = { get() { return { async execute() {
    return { status: 'COMPLETED', result: { ok: true } }
  } } } }
  const pendingCleanup = tool.execute({ message: messages[0] }, { agent: parent, signal })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(coordinator.activeCount, 1)
  assert.equal(disposed, 3)
  completeDisposal()
  await pendingCleanup
  assert.equal(coordinator.activeCount, 0)
  coordinator.dispose()
})
