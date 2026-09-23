import assert from 'node:assert/strict'
import test from 'node:test'

import { backfillGpt6CodexModels, withGpt6CodexModels } from '../src/catalog.ts'

const astra = {
  id: 'gpt-6-astra',
  name: 'GPT-6 Astra',
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  contextWindow: 272_000,
  maxTokens: 128_000,
}

function byId(models, id) {
  const model = models.find(entry => entry.id === id)
  assert.ok(model, `missing ${id}`)
  return model
}

test('backfills GPT-6 Sol and Luna with upstream Codex image metadata', () => {
  const models = backfillGpt6CodexModels([astra])
  assert.deepEqual(models.map(model => model.id), ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])

  const expected = {
    'gpt-6-sol': {
      name: 'GPT-6 Sol',
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      tier: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
    },
    'gpt-6-luna': {
      name: 'GPT-6 Luna',
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      tier: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
    },
  }

  for (const [id, metadata] of Object.entries(expected)) {
    const model = byId(models, id)
    assert.equal(model.name, metadata.name)
    assert.equal(model.api, 'openai-codex-responses')
    assert.equal(model.provider, 'openai-codex')
    assert.equal(model.baseUrl, 'https://chatgpt.com/backend-api')
    assert.equal(model.reasoning, true)
    assert.deepEqual(model.input, ['text', 'image'])
    assert.equal(model.contextWindow, 272_000)
    assert.equal(model.maxTokens, 128_000)
    assert.deepEqual(model.thinkingLevelMap, {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    })
    assert.deepEqual(
      { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
      metadata.cost,
    )
    assert.deepEqual(model.cost.tiers, [{ inputTokensAbove: 272_000, ...metadata.tier }])
    assert.deepEqual(model.compat, {
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
    })
  }
})

test('existing upstream catalog entries win and are not duplicated', () => {
  const upstreamLuna = { ...astra, id: 'gpt-6-luna', name: 'Upstream Luna', input: ['text'] }
  const models = backfillGpt6CodexModels([astra, upstreamLuna])
  assert.equal(models.filter(model => model.id === 'gpt-6-luna').length, 1)
  assert.equal(byId(models, 'gpt-6-luna'), upstreamLuna)
  assert.ok(byId(models, 'gpt-6-sol'))
})

test('provider wrapper changes only getModels behavior', () => {
  const stream = () => 'stream'
  const streamSimple = () => 'streamSimple'
  const provider = {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    auth: { oauth: {} },
    getModels: () => [astra],
    stream,
    streamSimple,
  }
  const wrapped = withGpt6CodexModels(provider)
  assert.equal(wrapped.id, provider.id)
  assert.equal(wrapped.auth, provider.auth)
  assert.equal(wrapped.stream, stream)
  assert.equal(wrapped.streamSimple, streamSimple)
  assert.deepEqual(wrapped.getModels().map(model => model.id), ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])
})
