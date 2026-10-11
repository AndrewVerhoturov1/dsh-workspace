import assert from 'node:assert/strict'
import test from 'node:test'
import { processResponsesStream } from '@earendil-works/pi-ai/api/openai-responses-shared'
import { mapUsage, toStreamChunks } from '../lib/convert.js'

const model = {
  id: 'usage-fixture', api: 'openai-responses', provider: 'openai-codex',
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

async function nativeMessage(reasoning, status = 'completed') {
  const message = {
    role: 'assistant', content: [{ type: 'text', text: 'ok' }], ...model, model: model.id, timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
  }
  const events = (async function* () {
    yield { type: status === 'completed' ? 'response.completed' : 'response.incomplete', response: {
      status, output: [], incomplete_details: status === 'completed' ? undefined : { reason: 'content_filter' },
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
        ...(reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoning } }),
      },
    } }
  })()
  await processResponsesStream(events, message, { push() {} }, model)
  return message
}

for (const [label, reasoning] of [['positive', 17], ['explicit zero', 0], ['omitted', undefined]]) {
  test(`native SDK ${label} reasoning keeps output unchanged and zero-or-missing unknown`, async () => {
    const message = await nativeMessage(reasoning)
    assert.equal(message.usage.reasoning, reasoning ?? 0)
    const actual = mapUsage(message.usage)
    const expected = { inputTokens: 75, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5,
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}) }
    assert.deepEqual(actual, expected)
    assert.equal(Object.hasOwn(actual, 'reasoningTokens'), reasoning > 0)
  })
}

test('missing SDK reasoning never becomes a confirmed zero', () => {
  assert.deepEqual(mapUsage({ input: 3, output: 4, cacheRead: 0, cacheWrite: 0 }),
    { inputTokens: 3, outputTokens: 4 })
})

for (const [terminal, status, kind] of [['done', 'completed', 'stop'], ['error', 'incomplete', 'error']]) {
  test(`native SDK numeric reasoning reaches the ${terminal} usage chunk`, async () => {
    const message = await nativeMessage(17, status)
    const events = (async function* () {
      yield terminal === 'done'
        ? { type: 'done', reason: 'stop', message }
        : { type: 'error', reason: 'error', error: message }
    })()
    const chunks = []
    for await (const chunk of toStreamChunks(events)) chunks.push(chunk)
    assert.deepEqual(chunks[0], { type: 'usage', usage: {
      inputTokens: 75, outputTokens: 50, reasoningTokens: 17, cacheReadTokens: 20, cacheWriteTokens: 5,
    } })
    assert.equal(chunks[1].type, 'finish')
    assert.equal(chunks[1].reason.kind, kind)
    assert.equal(chunks.length, 2)
  })
}
