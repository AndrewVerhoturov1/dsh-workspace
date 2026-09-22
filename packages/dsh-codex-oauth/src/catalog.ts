/**
 * Compatibility backfill for Codex models released after the pinned pi-ai
 * catalog. The transport and OAuth implementation stay owned by pi-ai; this
 * module only supplies model metadata that pi-ai 0.87.1 added upstream.
 *
 * Existing catalog entries always win, so a future pi-ai upgrade can absorb
 * these models without duplicates or local metadata overriding upstream.
 *
 * @module dsh-codex-oauth/catalog
 */

import type { Model, Provider } from '@earendil-works/pi-ai'

type CodexModel = Model<'openai-codex-responses'>
type CodexProvider = Provider<'openai-codex-responses'>
type BaseCost = Pick<CodexModel['cost'], 'input' | 'output' | 'cacheRead' | 'cacheWrite'>

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const CODEX_CONTEXT_WINDOW = 272_000
const CODEX_MAX_TOKENS = 128_000

function withLongContextPricing(cost: BaseCost): CodexModel['cost'] {
  return {
    ...cost,
    tiers: [{
      inputTokensAbove: CODEX_CONTEXT_WINDOW,
      input: cost.input * 2,
      output: cost.output * 1.5,
      cacheRead: cost.cacheRead * 2,
      cacheWrite: cost.cacheWrite * 2,
    }],
  }
}

function gpt6CodexModel(id: 'gpt-6-sol' | 'gpt-6-luna', name: string, cost: BaseCost): CodexModel {
  return {
    id,
    name,
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: CODEX_BASE_URL,
    reasoning: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
    input: ['text', 'image'],
    cost: withLongContextPricing(cost),
    contextWindow: CODEX_CONTEXT_WINDOW,
    maxTokens: CODEX_MAX_TOKENS,
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
    },
  }
}

const BACKFILL_MODELS: readonly CodexModel[] = [
  gpt6CodexModel('gpt-6-sol', 'GPT-6 Sol', {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  }),
  gpt6CodexModel('gpt-6-luna', 'GPT-6 Luna', {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
  }),
]

/** Add only missing GPT-6 Codex models to a pi-ai catalog. */
export function backfillGpt6CodexModels(models: readonly CodexModel[]): readonly CodexModel[] {
  const known = new Set(models.map(model => model.id))
  const additions = BACKFILL_MODELS.filter(model => !known.has(model.id))
  return additions.length === 0 ? models : [...models, ...additions]
}

/** Wrap a pi-ai Codex provider without changing its OAuth or stream implementation. */
export function withGpt6CodexModels(provider: CodexProvider): CodexProvider {
  const getModels = provider.getModels.bind(provider)
  return {
    ...provider,
    getModels: () => backfillGpt6CodexModels(getModels()),
  }
}
