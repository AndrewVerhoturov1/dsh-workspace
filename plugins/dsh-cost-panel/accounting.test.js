import test from 'node:test';
import assert from 'node:assert/strict';
import { foldAttempts, summarize, taskTeam } from './accounting.js';
import catalog from './model-prices.json' with { type: 'json' };

const header = { id: 'root', seedLength: 0 };
const usage = (inputTokens = 0, reasoningTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0, extra = {}) => ({ inputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, outputTokens, ...extra });
const cost = (attempts, incompleteHistory = false, prices = catalog) => summarize({ attempts, incompleteHistory }, prices);
const attempt = (id, model = 'gpt-6-luna', data = {}) => ({ id, purpose: 'conversation', provider: 'openai', model, serviceTier: 'default', usage: usage(), status: 'finished', ...data });

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

test('legacy auxiliary observer is linked to its native step by usage AND finish echoes', () => {
  const counts = usage(1000, 0, 0, 0, 100);
  const old = attempt('legacy', 'gpt-6.1-sol', { purpose: 'auxiliary', usage: null, status: 'started' });
  const events = [
    { type: 'step/start', seq: 0, data: { turn: 1, step: 0 } },
    { type: 'cost-panel/attempt', seq: 1, data: old },
    { type: 'cost-panel/attempt', seq: 2, data: { ...old, usage: counts } },
    { type: 'assistant/chunk', seq: 3, data: { turn: 1, step: 0, chunk: { type: 'usage', usage: counts } } },
    { type: 'cost-panel/attempt', seq: 4, data: { ...old, usage: counts, status: 'stop' } },
    { type: 'assistant/chunk', seq: 5, data: { turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
    { ...assistantMessage(1, 0, 'gpt-6.1-sol', counts), seq: 6 },
    { type: 'step/end', seq: 7, data: { turn: 1, step: 0 } },
  ];
  const original = structuredClone(events);
  const folded = foldAttempts(header, events);
  assert.deepEqual(events, original); // no historical journal migration
  assert.equal(folded.attempts.length, 1);
  assert.equal(folded.incompleteHistory, false);
  assert.deepEqual([folded.attempts[0].purpose, folded.attempts[0].turn, folded.attempts[0].step], ['conversation', 1, 0]);
  assert.deepEqual(folded.attempts[0].usage, counts);
  assert.ok(Math.abs(summarize(folded, catalog).total - 0.003) < 1e-12);
});

test('live unmarked stream links on first text or usage chunk, before finish', () => {
  const counts = usage(1000, 0, 0, 0, 100);
  const old = attempt('live', 'gpt-6.1-sol', { purpose: 'auxiliary', usage: null, status: 'started' });
  const events = [
    { type: 'step/start', seq: 0, data: { turn: 1, step: 0 } },
    { type: 'cost-panel/attempt', seq: 1, data: old },
    { type: 'assistant/chunk', seq: 2, data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'hello' } } },
    { type: 'cost-panel/attempt', seq: 3, data: { ...old, usage: counts } },
    { type: 'assistant/chunk', seq: 4, data: { turn: 1, step: 0, chunk: { type: 'usage', usage: counts } } },
    { type: 'cost-panel/attempt', seq: 5, data: { ...old, usage: counts, status: 'stop' } },
    { type: 'assistant/chunk', seq: 6, data: { turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
    { ...assistantMessage(1, 0, 'gpt-6.1-sol', counts), seq: 7 },
  ];
  for (const length of [2, 3, 4, 5, 6, 7, 8]) {
    const folded = foldAttempts(header, events.slice(0, length));
    const result = summarize(folded, catalog);
    assert.equal(result.calls, 1, 'events prefix ' + length);
    assert.equal(result.duplicateUncertain, false);
    assert.equal(result.callsUnknown, false);
    assert.equal(result.metrics.input.count, length >= 4 ? 1000 : 0);
    assert.equal(result.metrics.output.count, length >= 4 ? 100 : 0);
    assert.ok(Math.abs(result.total - (length >= 4 ? 0.003 : 0)) < 1e-12);
  }
  const noText = [events[0], events[1], { ...events[3], seq: 2 }, { ...events[4], seq: 3 }];
  assert.equal(foldAttempts(header, noText).attempts.length, 1);
  const title = attempt('title', 'gpt-6.1-sol', { purpose: 'title', usage: counts });
  const compaction = attempt('compact', 'gpt-6.1-sol', { purpose: 'compaction', usage: counts });
  const extra = [...events, { type: 'cost-panel/attempt', seq: 8, data: title }, { type: 'cost-panel/attempt', seq: 9, data: compaction }];
  assert.deepEqual(foldAttempts(header, extra).attempts.map(a => a.purpose), ['conversation', 'title', 'compaction']);
});

test('legacy same-usage coincidence without adjacent stream echoes stays unknown, not merged', () => {
  const counts = usage(1000, 0, 0, 0, 100);
  const old = attempt('uncertain', 'gpt-6.1-sol', { purpose: 'auxiliary', usage: null, status: 'started' });
  const events = [
    { type: 'step/start', seq: 0, data: { turn: 1, step: 0 } },
    { type: 'cost-panel/attempt', seq: 1, data: old },
    { type: 'cost-panel/attempt', seq: 2, data: { ...old, usage: counts } },
    { type: 'tool/result', seq: 3, data: {} }, // even equal usage is insufficient without causal adjacency
    { type: 'assistant/chunk', seq: 4, data: { turn: 1, step: 0, chunk: { type: 'usage', usage: counts } } },
    { type: 'cost-panel/attempt', seq: 5, data: { ...old, usage: counts, status: 'stop' } },
    { type: 'tool/result', seq: 6, data: {} },
    { type: 'assistant/chunk', seq: 7, data: { turn: 1, step: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } } },
    { ...assistantMessage(1, 0, 'gpt-6.1-sol', counts), seq: 8 },
    { type: 'step/end', seq: 9, data: { turn: 1, step: 0 } },
  ];
  const folded = foldAttempts(header, events);
  assert.equal(folded.attempts.length, 2);
  assert.equal(folded.incompleteHistory, true);
  const result = summarize(folded, catalog);
  assert.equal(result.callsUnknown, true);
  assert.equal(result.costUnknown, true);
});

test('unmarked same-step retries each count once; multiple usage snapshots never add twice', () => {
  const first = attempt('first', 'gpt-6.1-sol', { purpose: 'auxiliary', usage: null, status: 'started' });
  const second = attempt('second', 'gpt-6.1-sol', { purpose: 'auxiliary', usage: null, status: 'started' });
  const counts1 = usage(100, 0, 0, 0, 10);
  const counts2 = usage(200, 0, 0, 0, 20);
  const observed = (seq, data) => ({ type: 'cost-panel/attempt', seq, data });
  const native = (seq, type, data) => ({ type: 'assistant/chunk', seq, data: { turn: 1, step: 0, chunk: { type, ...data } } });
  const events = [
    { type: 'step/start', seq: 0, data: { turn: 1, step: 0 } },
    observed(1, first),
    observed(2, { ...first, usage: counts1 }),
    native(3, 'usage', { usage: counts1 }),
    observed(4, { ...first, usage: { ...counts1, outputTokens: 12 } }),
    native(5, 'usage', { usage: { outputTokens: 12 } }),
    observed(6, { ...first, usage: { ...counts1, outputTokens: 12 }, status: 'error' }),
    native(7, 'finish', { reason: { kind: 'error' } }),
    { type: 'llm/retry', seq: 8, data: { provider: 'openai', turn: 1, step: 0, retry: 1 } },
    observed(9, second),
    observed(10, { ...second, usage: counts2 }),
    native(11, 'usage', { usage: counts2 }),
    observed(12, { ...second, usage: counts2, status: 'stop' }),
    native(13, 'finish', { reason: { kind: 'stop' } }),
    { ...assistantMessage(1, 0, 'gpt-6.1-sol', counts2), seq: 14 },
  ];
  const folded = foldAttempts(header, events);
  assert.equal(folded.attempts.length, 2);
  assert.equal(folded.incompleteHistory, false);
  assert.deepEqual(folded.attempts.map(a => a.id), ['first', 'second']);
  assert.deepEqual(folded.attempts.map(a => a.usage.outputTokens), [12, 20]);
  assert.ok(Math.abs(summarize(folded, catalog).total - 0.00092) < 1e-12);
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

test('durable snapshots preserve earlier usage fields without adding repeated snapshots', () => {
  const events = [
    { type: 'cost-panel/attempt', seq: 0, data: attempt('one', 'gpt-6-luna', { turn: 1, step: 0, usage: usage(10, 3, 20, 4, 7) }) },
    { type: 'cost-panel/attempt', seq: 1, data: { id: 'one', purpose: 'conversation', turn: 1, step: 0, usage: { outputTokens: 9 }, status: 'stop' } },
    { type: 'cost-panel/attempt', seq: 2, data: { id: 'one', purpose: 'conversation', turn: 1, step: 0, usage: { inputTokens: 0, outputTokens: 0 }, status: 'stop' } },
    { type: 'cost-panel/attempt', seq: 3, data: { id: 'one', purpose: 'conversation', turn: 1, step: 0, usage: null, status: 'stop' } },
    assistantMessage(1, 0, 'gpt-6-luna', usage(999, 999, 999, 999, 999)),
  ];
  const folded = foldAttempts(header, events);
  assert.equal(folded.attempts.length, 1);
  assert.deepEqual(folded.attempts[0].usage, usage(10, 3, 20, 4, 9));
  const result = summarize(folded, catalog);
  assert.equal(result.calls, 1);
  assert.equal(result.metrics.reasoning.count, 3);
  assert.ok(Math.abs(result.total - (10 * 0.1 + 20 * 0.01 + 4 * 0.125 + 9 * 0.5) / 1e6) < 1e-15);
});

test('old session uses latest saved fields from chunks and partial final message, including gaps', () => {
  const events = [
    { type: 'request/header', seq: 0, data: { header: { config: { model: 'gpt-6-luna', provider: 'openai' } } } },
    { type: 'assistant/chunk', seq: 1, data: { turn: 1, step: 0, chunk: { type: 'usage', usage: usage(10, 3, 20, 4, 7) } } },
    assistantMessage(1, 0, 'gpt-6-luna', { outputTokens: 9 }),
    { type: 'compaction/start', seq: 20, data: {} },
  ];
  const result = summarize(foldAttempts(header, events), catalog);
  assert.equal(result.calls, 1);
  assert.equal(result.callsUnknown, true);
  assert.equal(result.metrics.input.count, 10);
  assert.equal(result.metrics.input.countKnown, true);
  assert.equal(result.metrics.reasoning.count, 3);
  assert.equal(result.metrics.read.count, 20);
  assert.equal(result.metrics.write.count, 4);
  assert.equal(result.metrics.output.count, 9);
  assert.equal(result.costKnown, true);
  assert.equal(result.costUnknown, true);
  assert.ok(result.total > 0);
});

test('empty history and absent usage have no received token data, unlike explicit zero', () => {
  for (const result of [cost([]), cost([attempt('no-usage', 'gpt-6-luna', { usage: null })])]) {
    assert.equal(result.total, 0);
    assert.equal(result.costKnown, false);
    for (const metric of Object.values(result.metrics)) {
      assert.equal(metric.count, 0);
      assert.equal(metric.countKnown, false);
      assert.equal(metric.costKnown, false);
    }
  }
  const zero = cost([attempt('zero')]);
  assert.equal(zero.costKnown, true);
  assert.equal(zero.metrics.input.countKnown, true);
  assert.equal(zero.total, 0);
});

test('known part of a bill survives missing model, usage, cache TTL and historical completeness', () => {
  const result = cost([
    attempt('priced', 'gpt-6-luna', { usage: usage(10, 3, 20, 4, 7) }),
    attempt('missing', 'unknown-model', { usage: { inputTokens: 100, outputTokens: 50 } }),
    attempt('no-usage', 'gpt-6-luna', { usage: null }),
  ], true);
  assert.equal(result.calls, 3);
  assert.equal(result.callsUnknown, true);
  assert.equal(result.metrics.input.count, 110);
  assert.equal(result.metrics.output.count, 57);
  assert.equal(result.metrics.reasoning.count, 3);
  assert.equal(result.metrics.input.countUnknown, true);
  assert.equal(result.costKnown, true);
  assert.equal(result.costUnknown, true);
  assert.ok(Math.abs(result.total - (10 * 0.1 + 20 * 0.01 + 4 * 0.125 + 7 * 0.5) / 1e6) < 1e-15);
  const ttl = cost([attempt('ttl', 'claude-fable-5-1', { provider: 'anthropic', usage: usage(10, 3, 20, 4, 7) })]);
  assert.equal(ttl.metrics.write.count, 4);
  assert.equal(ttl.metrics.write.costKnown, false);
  assert.equal(ttl.costUnknown, true);
  assert.ok(ttl.total > 0);
});

test('read-only, write-only, both and repeated reads are disjoint per call', () => {
  for (const [read, write] of [[20, 0], [0, 20], [20, 30]]) {
    const result = cost([attempt('a', 'gpt-6-luna', { usage: usage(10, 2, read, write, 5) })]);
    assert.equal(result.metrics.read.count, read);
    assert.equal(result.metrics.write.count, write);
    assert.equal(result.metrics.input.count, 10);
    assert.equal(result.costUnknown, false);
  }
  const result = cost([attempt('a', 'gpt-6-luna', { usage: usage(10, 0, 20, 0, 5) }), attempt('b', 'gpt-6-luna', { usage: usage(10, 0, 20, 0, 5) })]);
  assert.equal(result.calls, 2);
  assert.equal(result.metrics.read.count, 40);
  assert.equal(result.metrics.read.cost, 40 * 0.01 / 1e6);
});

test('missing prompt components retain lower-bound subtotal, not exact shares', () => {
  for (const counts of [{ inputTokens: 10, outputTokens: 5 }, { inputTokens: 10, cacheReadTokens: 20, outputTokens: 5 }, { inputTokens: 10, cacheWriteTokens: 30, outputTokens: 5 }]) {
    const result = cost([attempt('partial', 'gpt-6-luna', { usage: counts })]);
    assert.equal(result.costKnown, true);
    assert.equal(result.costUnknown, true);
    assert.ok(result.total > 0);
    assert.equal(result.metrics.input.cost, 10 * 0.1 / 1e6);
    assert.equal(result.metrics.output.cost, 5 * 0.5 / 1e6);
    assert.equal(result.metrics.input.costUnknown, true);
    assert.ok(Object.values(result.metrics).every(m => m.share === null));
  }
});

test('prompt threshold is per request, not summed session input', () => {
  const result = cost([attempt('a', 'gpt-6-luna', { usage: usage(200000, 0, 0, 0, 1) }), attempt('b', 'gpt-6-luna', { usage: usage(200000, 0, 0, 0, 1) })]);
  assert.equal(result.total, (400000 * 0.1 + 2 * 0.5) / 1e6);
  assert.equal(result.costUnknown, false);
});


test('price identity matches provider plus model; Codex is an API-equivalent estimate', () => {
  const counts = usage(10, 0, 0, 0, 5);
  const wrong = cost([attempt('wrong', 'gpt-6-luna', { provider: 'anthropic', usage: counts })]);
  assert.equal(wrong.metrics.input.costKnown, false);
  assert.equal(wrong.costUnknown, true);
  const codex = cost([attempt('codex', 'gpt-6-luna', { provider: 'codex', usage: counts })]);
  assert.equal(codex.total, cost([attempt('api', 'gpt-6-luna', { usage: counts })]).total);
  assert.equal(codex.costUnknown, false);
});


test('absent processing tier retains marked Standard estimate; other tiers are not substituted', () => {
  const absent = cost([attempt('unknown-tier', 'gpt-6-luna', { serviceTier: undefined, usage: usage(10, 0, 0, 0, 5) })]);
  assert.ok(absent.total > 0);
  assert.equal(absent.costKnown, true);
  assert.equal(absent.costUnknown, true);
  assert.equal(absent.metrics.input.share, null);
  const other = cost([attempt('priority', 'gpt-6-luna', { serviceTier: 'priority', usage: usage(10, 0, 0, 0, 5) })]);
  assert.equal(other.metrics.input.costKnown, false);
  assert.equal(other.costUnknown, true);
});


test('required SDK zero placeholders remain unknown through saved attempts; trusted zeros stay known', () => {
  const events = [{ type: 'cost-panel/attempt', seq: 0, data: attempt('unknown', 'gpt-6-luna', { usage: { inputTokens: 0, outputTokens: 0, inputTokensKnown: false, outputTokensKnown: false } }) }];
  const folded = foldAttempts(header, events);
  assert.equal(folded.attempts[0].usage.inputTokens, undefined);
  assert.equal(folded.attempts[0].usage.inputTokensKnown, false);
  const result = summarize(folded, catalog);
  assert.equal(result.metrics.input.countKnown, false);
  assert.equal(result.metrics.output.countKnown, false);
  assert.equal(result.costKnown, false);
  const positive = foldAttempts(header, [...events, { type: 'cost-panel/attempt', seq: 1, data: { id: 'unknown', usage: { inputTokens: 10, outputTokens: 4 } } }, { type: 'cost-panel/attempt', seq: 2, data: { id: 'unknown', usage: { inputTokens: 0, outputTokens: 0, inputTokensKnown: false, outputTokensKnown: false } } }]);
  assert.equal(positive.attempts[0].usage.inputTokens, 10);
  assert.equal(positive.attempts[0].usage.outputTokens, 4);
  assert.equal(positive.attempts[0].usage.inputTokensKnown, undefined);
  const trusted = cost([attempt('zero', 'gpt-6-luna', { usage: usage() })]);
  assert.equal(trusted.metrics.input.countKnown, true);
  assert.equal(trusted.metrics.input.count, 0);
});


test('partial prompt subtotal proves the higher tier only above the threshold', () => {
  const above = cost([attempt('above-partial', 'gpt-6-luna', { usage: { inputTokens: 270000, cacheReadTokens: 3000, outputTokens: 5 } })]);
  assert.equal(above.metrics.input.cost, 270000 * 0.2 / 1e6);
  assert.equal(above.metrics.read.cost, 3000 * 0.02 / 1e6);
  assert.equal(above.metrics.output.cost, 5 * 0.75 / 1e6);
  assert.equal(above.metrics.input.costUnknown, false);
  assert.equal(above.metrics.output.costUnknown, false);
  assert.equal(above.metrics.write.countKnown, false);
  assert.equal(above.costUnknown, true);
  assert.equal(above.metrics.input.share, null);
  const at = cost([attempt('at-partial', 'gpt-6-luna', { usage: { inputTokens: 270000, cacheReadTokens: 2000, outputTokens: 5 } })]);
  assert.equal(at.metrics.input.cost, 270000 * 0.1 / 1e6);
  assert.equal(at.metrics.output.cost, 5 * 0.5 / 1e6);
  assert.equal(at.metrics.input.costUnknown, true);
  assert.equal(at.metrics.output.costUnknown, true);
  const unknownInput = cost([attempt('unknown-input', 'gpt-6-luna', { usage: { inputTokens: 300000, inputTokensKnown: false, cacheReadTokens: 20, outputTokens: 5 } })]);
  assert.equal(unknownInput.metrics.input.countKnown, false);
  assert.equal(unknownInput.metrics.read.cost, 20 * 0.01 / 1e6);
  assert.equal(unknownInput.metrics.output.cost, 5 * 0.5 / 1e6);
  assert.equal(unknownInput.metrics.output.costUnknown, true);
});

