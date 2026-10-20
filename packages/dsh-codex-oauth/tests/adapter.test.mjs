import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAdapter } from '../lib/adapter.js'
import { toCodexContext, mapUsage, toStreamChunks } from '../lib/convert.js'
import { foldAttempts, mergeUsage, summarize } from '../../../plugins/dsh-cost-panel/accounting.js'
import prices from '../../../plugins/dsh-cost-panel/model-prices.json' with { type: 'json' }

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm4kAAAAASUVORK5CYII=',
  'base64',
)

const catalog = [
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', input: ['text', 'image'], contextWindow: 128_000, reasoning: false },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', input: ['text'], contextWindow: 256_000, reasoning: false },
  { id: 'text-only-test', name: 'Text only', input: ['text'], contextWindow: 32_000, reasoning: false },
]

function fakeModels(onStream = () => {}) {
  return {
    getModels: () => catalog,
    getModel: (_provider, id) => catalog.find(model => model.id === id),
    streamSimple(model, context, options) {
      return onStream(model, context, options) ?? terminalStream(model)
    },
  }
}

function terminalStream(model) {
  return (async function* () {
    yield {
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        api: model.api ?? 'openai-responses',
        provider: model.provider ?? 'openai-codex',
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 0,
      },
    }
  })()
}

function makeAdapter(models = fakeModels(), resolveAttachments = () => undefined) {
  return new CodexAdapter(models, 'codex', {
    transport: 'sse',
    cacheRetention: 'none',
    streamIdleTimeoutMs: 10_000,
  }, resolveAttachments)
}

function imageRef() {
  return {
    attachmentId: 'codex-image-test',
    mediaType: 'image/png',
    bytes: png.byteLength,
    width: 1,
    height: 1,
    name: 'test.png',
  }
}

function fakeAttachments() {
  const reads = []
  return {
    reads,
    store: {
      async readImageRequest(ref, policy, signal) {
        reads.push({ ref, policy, signal })
        return {
          variantId: 'codex-image-variant',
          attachment: ref,
          data: png,
          mediaType: 'image/png',
          bytes: png.byteLength,
          width: 1,
          height: 1,
          depth: 'uchar',
          space: 'srgb',
          hasAlpha: true,
        }
      },
    },
  }
}

function imageOptions() {
  return {
    provider: 'codex',
    model: 'gpt-5.6-luna',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image', attachment: imageRef() },
      ],
      source: { kind: 'user' },
    }],
  }
}

test('Luna catalog and resolveModel preserve text plus image modalities', async () => {
  const adapter = makeAdapter()
  const listed = await adapter.listModels('codex')
  const luna = listed.find(model => model.id === 'gpt-5.6-luna')
  assert.deepEqual(luna.inputModalities, ['text', 'image'])

  const resolved = await adapter.resolveModel('codex', 'gpt-5.6-luna')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
})

test('text-only catalog models stay text-only', async () => {
  const resolved = await makeAdapter().resolveModel('codex', 'text-only-test')
  assert.deepEqual(resolved.inputModalities, ['text'])
})

test('Astra remains in the provider model list', async () => {
  const listed = await makeAdapter().listModels('codex')
  assert.ok(listed.some(model => model.id === 'gpt-6-astra'))
})

test('a user image reaches pi-ai without local UNSUPPORTED_CONTENT', async () => {
  const attachments = fakeAttachments()
  let sentContext
  const models = fakeModels((_model, context) => {
    sentContext = context
    return terminalStream(_model)
  })
  const adapter = makeAdapter(models, () => attachments.store)

  for await (const _chunk of adapter.stream(imageOptions())) {}

  const content = sentContext.messages[0].content
  assert.ok(Array.isArray(content))
  assert.equal(content.find(block => block.type === 'image').mimeType, 'image/png')
})

test('Harness image attachment becomes the pi-ai base64 image block', async () => {
  const attachments = fakeAttachments()
  const context = await toCodexContext(imageOptions(), attachments.store)
  const content = context.messages[0].content

  assert.ok(Array.isArray(content))
  assert.equal(content[0].text, 'Describe this image.')
  assert.equal(content[1].type, 'text')
  assert.deepEqual(content[2], {
    type: 'image',
    data: png.toString('base64'),
    mimeType: 'image/png',
  })
  assert.equal(attachments.reads.length, 1)
  assert.deepEqual(attachments.reads[0].policy, { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 })
})

test('ordinary text requests keep the existing pi-ai context shape', async () => {
  let sentContext
  const models = fakeModels((_model, context) => {
    sentContext = context
    return terminalStream(_model)
  })
  const adapter = makeAdapter(models, () => {
    throw new Error('attachment service should not be resolved for text')
  })
  const options = {
    provider: 'codex',
    model: 'gpt-5.6-luna',
    system: 'Answer briefly.',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }],
      source: { kind: 'user' },
    }],
  }

  for await (const _chunk of adapter.stream(options)) {}

  assert.deepEqual(sentContext, {
    systemPrompt: 'Answer briefly.',
    messages: [{ role: 'user', content: 'hello world', timestamp: 0 }],
  })
})

test('positive SDK buckets stay disjoint and reasoning remains an output subset', () => {
  assert.deepEqual(mapUsage({ input: 10, output: 7, reasoning: 3, cacheRead: 20, cacheWrite: 4 }), {
    inputTokens: 10, outputTokens: 7, reasoningTokens: 3, cacheReadTokens: 20, cacheWriteTokens: 4,
  })
})

test('raw Codex cache-write presence wins over SDK defaults; no raw bag retains positive-only fallback', () => {
  const usage = { input: 10, output: 7, reasoning: 0, cacheRead: 20, cacheWrite: 0 }
  const baseline = { inputTokens: 10, outputTokens: 7, cacheReadTokens: 20 }
  assert.deepEqual(mapUsage({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }), {
    inputTokens: 0, outputTokens: 0, inputTokensKnown: false, outputTokensKnown: false,
  })
  assert.deepEqual(mapUsage(usage), baseline)
  assert.deepEqual(mapUsage({ ...usage, cacheWrite: 4 }), { ...baseline, cacheWriteTokens: 4 })
  assert.deepEqual(mapUsage({ ...usage, openaiResponsesUsage: {} }), baseline)
  assert.deepEqual(mapUsage({ ...usage, cacheWrite: 4, openaiResponsesUsage: {} }), baseline)
  assert.deepEqual(mapUsage({ ...usage, openaiResponsesUsage: { cache_write_tokens: 0 } }), {
    ...baseline, cacheWriteTokens: 0, cacheWriteTokensKnown: true,
  })
  assert.deepEqual(mapUsage({ ...usage, openaiResponsesUsage: { cache_write_tokens: 4 } }), {
    ...baseline, cacheWriteTokens: 4, cacheWriteTokensKnown: true,
  })
  assert.deepEqual(mapUsage({ ...usage, openaiResponsesUsage: { cache_write_tokens: -1 } }), baseline)
  assert.deepEqual(mapUsage({ ...usage, openaiResponsesUsage: { cache_write_tokens: '0' } }), baseline)
})

test('raw Codex cache writes survive terminal stream and actual panel pricing', async () => {
  for (const [caseName, raw, sdkWrite, knownWrite] of [
    ['absent', {}, 0, undefined],
    ['explicit zero', { cache_write_tokens: 0 }, 0, 0],
    ['positive', { cache_write_tokens: 4 }, 4, 4],
  ]) {
    const message = {
      role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop',
      usage: { input: 10, output: 7, cacheRead: 20, cacheWrite: sdkWrite, openaiResponsesUsage: raw },
    }
    const chunks = []
    for await (const chunk of toStreamChunks((async function* () { yield { type: 'done', message } })())) {
      chunks.push(chunk)
    }
    assert.equal(chunks.at(-1).type, 'finish', caseName)
    const mapped = chunks.find(chunk => chunk.type === 'usage').usage
    assert.equal(mapped.cacheWriteTokens, knownWrite, caseName)
    assert.equal(mapped.cacheWriteTokensKnown, knownWrite === undefined ? undefined : true, caseName)
    const merged = mergeUsage(null, mapped)
    const record = { id: 1, provider: 'codex', model: 'gpt-6-luna', serviceTier: 'default',
      purpose: 'conversation', turn: 1, step: 0, usage: merged, status: 'finished' }
    const folded = foldAttempts({ seedLength: 0 }, [
      { type: 'cost-panel/attempt', seq: 0, data: record },
      { type: 'cost-panel/attempt', seq: 1, data: { id: 1, usage: { outputTokens: 7 }, status: 'finished' } },
    ])
    assert.equal(folded.attempts.length, 1, caseName)
    assert.equal(folded.attempts[0].usage.cacheWriteTokensKnown, mapped.cacheWriteTokensKnown, caseName)
    const summary = summarize(folded, prices)
    assert.equal(summary.writeScenario.tokens, knownWrite === undefined ? 10 : 0, caseName)
    assert.ok(Math.abs(summary.writeScenario.extra - (knownWrite === undefined ? 10 * (0.125 - 0.1) / prices.unitTokens : 0)) < 1e-15, caseName)
    const write = summary.metrics.write
    assert.equal(write.countKnown, knownWrite !== undefined, caseName)
    assert.equal(write.costKnown, knownWrite !== undefined, caseName)
    if (knownWrite !== undefined) {
      assert.equal(write.count, knownWrite, caseName)
      assert.ok(Math.abs(write.cost - knownWrite * 0.125 / prices.unitTokens) < 1e-15, caseName)
    } else {
      assert.equal(write.countUnknown, true, caseName)
      assert.equal(write.costUnknown, true, caseName)
    }
  }
})

test('terminal streams forward positive read/write/reasoning and omit SDK zero defaults on errors', async () => {
  for (const type of ['done', 'error']) {
    const message = { content: [{ type: 'text', text: 'ok' }], stopReason: type === 'done' ? 'stop' : 'error', errorMessage: 'network error', usage: { input: 10, output: 7, reasoning: 3, cacheRead: 20, cacheWrite: 4 } }
    const events = (async function* () { yield { type, [type === 'done' ? 'message' : 'error']: message } })()
    const chunks = []
    for await (const chunk of toStreamChunks(events)) chunks.push(chunk)
    assert.deepEqual(chunks[0], { type: 'usage', usage: { inputTokens: 10, outputTokens: 7, reasoningTokens: 3, cacheReadTokens: 20, cacheWriteTokens: 4 } })
    assert.equal(chunks[1].type, 'finish')
  }
  const zero = (async function* () { yield { type: 'error', error: { content: [], stopReason: 'error', errorMessage: 'network error', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } })()
  const chunks = []
  for await (const chunk of toStreamChunks(zero)) chunks.push(chunk)
  assert.deepEqual(chunks[0], { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, inputTokensKnown: false, outputTokensKnown: false } })
})

