import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAdapter } from '../lib/adapter.js'
import { toCodexContext } from '../lib/convert.js'

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
