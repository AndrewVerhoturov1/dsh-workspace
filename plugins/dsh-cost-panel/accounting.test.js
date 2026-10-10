import test from 'node:test';
import assert from 'node:assert/strict';
import { foldAttempts, summarize, taskTeam } from './accounting.js';
import catalog from './model-prices.json' with { type: 'json' };

const header = { id: 'root', seedLength: 0 };
const usage = (inputTokens = 0, reasoningTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0, extra = {}) => ({ inputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, outputTokens, ...extra });
const cost = (attempts, incompleteHistory = false, prices = catalog) => summarize({ attempts, incompleteHistory }, prices);
const attempt = (id, model = 'gpt-6-luna', data = {}) => ({ id, purpose: 'conversation', provider: 'openai', model, usage: usage(), status: 'finished', ...data });

function assistantMessage(turn, step, model, counts, extra = {}) {
  return { type: 'assistant/message', seq: turn * 10 + step, data: { turn, step, message: { source: { kind: 'model', provider: 'openai', model }, ...extra.message }, usage: counts, ...extra } };
}

test('real disjoint usage buckets and reasoning is not billed twice as output', () => {
  const result = cost([attempt('a', 'gpt-6-luna', { usage: usage(10, 3, 20, 4, 7) })]);
  assert.equal(result.metrics.input.count, 10);
  assert.equal(result.metrics.reasoning.count, 3);
  assert.equal(result.metrics.read.count, 20);
  assert.equal(result.metrics.write.count, 4);
  assert.equal(result.metrics.output.count, 7);
  assert.equal(result.metrics.reasoning.cost, 3 * 0.5 / 1e6);
  assert.equal(result.metrics.output.cost, 7 * 0.5 / 1e6);
  assert.ok(Math.abs(result.total - (10 * 0.1 + 20 * 0.01 + 4 * 0.125 + 7 * 0.5) / 1e6) < 1e-15);
});

test('sum distinct calls using each call model price rather than the current model', () => {
  const result = cost([
    attempt('a', 'gpt-6-astra', { usage: usage(100, 0, 0, 0, 20) }),
    attempt('b', 'gpt-6-luna', { usage: usage(50, 0, 0, 0, 10) }),
  ]);
  assert.equal(result.calls, 2);
  assert.equal(result.total, (100 * 10 + 20 * 50 + 50 * 0.1 + 10 * 0.5) / 1e6);
});

test('legacy same-turn-step retries remain explicitly incomplete despite final usage', () => {
  const events = [
    { type: 'request/header', seq: 0, data: { header: { config: { model: 'gpt-6-luna', provider: 'openai' } } } },
    { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 0, chunk: { type: 'usage', usage: usage(90, 0, 0, 0, 90) } } },
    { type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'error' } } } },
    { type: 'llm/retry', seq: 3, data: { retryId: 'retry-a', provider: 'openai', turn: 1, step: 0, retry: 1 } },
    { type: 'llm/retry-started', seq: 4, data: { retryId: 'retry-a', turn: 1, step: 0, retry: 1 } },
    { type: 'assistant/chunk', seq: 5, data: { turn: 1, step: 0, chunk: { type: 'usage', usage: usage(70, 0, 0, 0, 70) } } },
    { type: 'assistant/chunk', seq: 6, data: { turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'error' } } } },
    { type: 'llm/retry', seq: 7, data: { retryId: 'retry-b', provider: 'openai', turn: 1, step: 0, retry: 2 } },
    { type: 'llm/retry-started', seq: 8, data: { retryId: 'retry-b', turn: 1, step: 0, retry: 2 } },
    { type: 'assistant/chunk', seq: 9, data: { turn: 1, step: 0, chunk: { type: 'usage', usage: usage(11, 2, 0, 0, 4) } } },
    { type: 'assistant/chunk', seq: 10, data: { turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
    assistantMessage(1, 0, 'gpt-6-luna', usage(11, 2, 0, 0, 4)),
  ];
  const folded = foldAttempts(header, events);
  assert.equal(folded.attempts.length, 1);
  assert.equal(folded.attempts[0].status, 'finished');
  assert.deepEqual(folded.attempts[0].usage, usage(11, 2, 0, 0, 4));
  const result = cost(folded.attempts, folded.incompleteHistory);
  assert.equal(folded.incompleteHistory, true);
  assert.equal(result.callsUnknown, true);
  assert.equal(result.costUnknown, true);
});

test('observed same-turn-step retries remain exact and suppress native chunks', () => {
  const events = [
    { type: 'cost-panel/attempt', seq: 1, data: { ...attempt('call-a', 'gpt-6-luna', { turn: 2, step: 0, usage: usage(5, 0, 0, 0, 2) }) } },
    { type: 'assistant/chunk', seq: 2, data: { turn: 2, step: 0, chunk: { type: 'finish', reason: { kind: 'error' } } } },
    { type: 'llm/retry', seq: 3, data: { retryId: 'retry-a', provider: 'openai', turn: 2, step: 0, retry: 1 } },
    { type: 'llm/retry-started', seq: 4, data: { retryId: 'retry-a', turn: 2, step: 0, retry: 1 } },
    { type: 'cost-panel/attempt', seq: 5, data: { ...attempt('call-b', 'gpt-6-luna', { turn: 2, step: 0, usage: usage(4, 0, 0, 0, 1) }) } },
    { type: 'assistant/chunk', seq: 6, data: { turn: 2, step: 0, chunk: { type: 'usage', usage: usage(99, 0, 0, 0, 99) } } },
    assistantMessage(2, 0, 'gpt-6-luna', usage(99, 0, 0, 0, 99)),
  ];
  const folded = foldAttempts(header, events);
  assert.equal(folded.attempts.length, 2);
  assert.deepEqual(folded.attempts.map(a => a.id), ['call-a', 'call-b']);
  assert.deepEqual(folded.attempts.map(a => a.usage), [usage(5, 0, 0, 0, 2), usage(4, 0, 0, 0, 1)]);
  assert.equal(folded.incompleteHistory, false);
});

test('legacy retry gap stays incomplete even when a later observer snapshot covers the step', () => {
  const events = [
    { type: 'llm/retry', seq: 1, data: { retryId: 'old-retry', provider: 'openai', turn: 3, step: 0, retry: 1 } },
    { type: 'cost-panel/attempt', seq: 2, data: { ...attempt('observed-later', 'gpt-6-luna', { turn: 3, step: 0, usage: usage(8, 0, 0, 0, 3) }) } },
  ];
  const folded = foldAttempts(header, events);
  assert.equal(folded.attempts.length, 1);
  assert.equal(folded.incompleteHistory, true);
  const result = cost(folded.attempts, folded.incompleteHistory);
  assert.equal(result.callsUnknown, true);
  assert.equal(result.costUnknown, true);
});

test('compaction auxiliary attempts remain distinct and legacy compaction signals history gap', () => {
  const events = [
    { type: 'compaction/start', seq: 0, data: {} },
    { type: 'cost-panel/attempt', seq: 1, data: { ...attempt('turn', 'gpt-6-luna', { turn: 1, step: 0, usage: usage(5, 0, 0, 0, 2) }) } },
    { type: 'cost-panel/attempt', seq: 2, data: { ...attempt('compact', 'gpt-6-astra', { purpose: 'compaction', usage: usage(7, 0, 0, 0, 3) }) } },
    { type: 'compaction/start', seq: 3, data: {} },
  ];
  const folded = foldAttempts(header, events);
  assert.equal(folded.attempts.length, 2);
  assert.equal(folded.incompleteHistory, true);
  assert.equal(cost(folded.attempts, folded.incompleteHistory).callsUnknown, true);
});

test('reported zero differs from unknown reasoning or cache counts', () => {
  const zero = cost([attempt('zero', 'gpt-6-luna', { usage: usage(2, 0, 0, 0, 1) })]);
  assert.equal(zero.metrics.reasoning.countUnknown, false);
  assert.equal(zero.metrics.reasoning.costUnknown, false);
  const missing = cost([attempt('missing', 'gpt-6-luna', { usage: { inputTokens: 2, outputTokens: 1 } })]);
  assert.equal(missing.metrics.reasoning.countUnknown, true);
  assert.equal(missing.metrics.read.countUnknown, true);
  assert.equal(missing.metrics.reasoning.costUnknown, true);
});

test('missing price or model alias leaves cost explicitly unknown', () => {
  const noPrice = cost([attempt('a', 'not-in-catalog', { usage: usage(2, 0, 0, 0, 1) })]);
  assert.equal(noPrice.metrics.input.costUnknown, true);
  assert.equal(noPrice.costUnknown, true);
  const alias = cost([attempt('alias', 'gpt-6-luna-2026-10-10', { usage: usage(2, 0, 0, 0, 1) })]);
  assert.equal(alias.metrics.output.costUnknown, true);
});

test('Anthropic aggregate cache-write is unknown unless exact TTL split is present', () => {
  const aggregate = cost([attempt('a', 'claude-fable-5-1', { provider: 'anthropic', usage: usage(1, 0, 0, 10, 1) })]);
  assert.equal(aggregate.metrics.write.count, 10);
  assert.equal(aggregate.metrics.write.costUnknown, true);
  const split = cost([attempt('b', 'claude-fable-5-1', { provider: 'anthropic', usage: usage(1, 0, 0, 10, 1, { cacheWrite5mTokens: 4, cacheWrite1hTokens: 6 }) })]);
  assert.equal(split.metrics.write.costUnknown, false);
  assert.equal(split.metrics.write.cost, (4 * 12.5 + 6 * 20) / 1e6);
});

test('prompt tiers include cached tokens and switch only above the boundary', () => {
  const model = 'gpt-6-astra';
  const at = cost([attempt('at', model, { usage: usage(272000, 0, 0, 0, 1) })]);
  const above = cost([attempt('above', model, { usage: usage(272001, 0, 0, 0, 1) })]);
  assert.ok(Math.abs(at.total - (272000 * 10 + 50) / 1e6) < 1e-12);
  assert.ok(Math.abs(above.total - (272001 * 20 + 75) / 1e6) < 1e-12);
  const cached = cost([attempt('cached', model, { usage: usage(99999, 0, 172002, 0, 1) })]);
  assert.ok(Math.abs(cached.total - (99999 * 20 + 172002 * 2 + 75) / 1e6) < 1e-12);
  const haikuAt = cost([attempt('haiku-at', 'claude-haiku-5-5', { provider: 'anthropic', usage: usage(99999, 0, 1, 0, 1) })]);
  const haikuAbove = cost([attempt('haiku-above', 'claude-haiku-5-5', { provider: 'anthropic', usage: usage(100000, 0, 1, 0, 1) })]);
  assert.ok(Math.abs(haikuAt.total - (99999 * 0.1 + 1 * 0.01 + 0.5) / 1e6) < 1e-12);
  assert.ok(Math.abs(haikuAbove.total - (100000 * 0.5 + 1 * 0.05 + 2.5) / 1e6) < 1e-12);
});

test('team is root plus unique subagent descendants, excluding ordinary fork ancestry and seed copies', () => {
  const headers = [
    { id: 'fork', origin: 'ordinary', parentSession: 'old' },
    { id: 'root', origin: 'ordinary' },
    { id: 'child', origin: 'subagent', parentSession: 'root' },
    { id: 'grandchild', origin: 'subagent', parentSession: 'child' },
    { id: 'fork-child', origin: 'subagent', parentSession: 'fork' },
  ];
  assert.deepEqual(taskTeam(headers, 'child'), { rootId: 'root', ids: ['root', 'child', 'grandchild'], incomplete: false });
  assert.deepEqual(taskTeam(headers, 'grandchild'), { rootId: 'root', ids: ['root', 'child', 'grandchild'], incomplete: false });
  const seededHeader = { id: 'child', seedLength: 3 };
  const seededEvents = [
    { type: 'llm/retry', seq: 2, data: { retryId: 'seed-retry', turn: 0, step: 0, provider: 'openai', retry: 1 } },
    { type: 'llm/retry-started', seq: 3, data: { retryId: 'seed-retry', turn: 0, step: 0, retry: 1 } },
    { type: 'llm/retry', seq: 4, data: { retryId: 'current-retry', turn: 1, step: 0, provider: 'openai', retry: 1 } },
    assistantMessage(1, 0, 'gpt-6-luna', usage(100, 0, 0, 0, 100)),
  ];
  const seededFold = foldAttempts(seededHeader, seededEvents);
  assert.equal(seededFold.attempts.length, 1);
  assert.equal(seededFold.incompleteHistory, true);
});
