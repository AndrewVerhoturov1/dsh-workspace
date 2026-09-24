import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeTool } from './postman-bridge.js'

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
  const tool = createPostmanBridgeTool({})
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
  const tool = createPostmanBridgeTool(ctx)
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
