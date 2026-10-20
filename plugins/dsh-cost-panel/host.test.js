import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmRuntime, markAgentLoopRequest, isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { rpcResultSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema';
import { z } from 'zod';
import { foldAttempts, taskTeam } from './accounting.js';
import { apply } from './index.js';
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const usage = (inputTokens, outputTokens) => ({ inputTokens, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens });
const chunk = (type, extra = {}) => ({ type, ...extra });

async function harness(t) {
  const root = new Context();
  let rpcRegistration;
  let store;
  let llm;
  let projections;
  const infrastructure = root.plugin({ name: 'test-infrastructure', apply(ctx) {
    llm = new LlmRuntime(ctx);
    store = new SessionStore(ctx);
    projections = new SessionProjectionRegistry(ctx);
    ctx.provide('connection', { rpc: { handle: (...args) => { rpcRegistration = args; return async () => {}; } } });
  } });
  await infrastructure;
  const adapterPlugin = root.plugin({ name: 'test-adapter', inject: ['llm'], apply(ctx) {
    class FakeAdapter extends LlmAdapter {
      providerInfo(provider) { return { id: provider, name: provider }; }
      async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
      async *stream(options) { yield* options.testChunks ?? [chunk('finish', { reason: { kind: 'stop' } })]; }
    }
    ctx.llm.registerAdapter(['p', 'test-provider', 'openai'], new FakeAdapter());
  } });
  await adapterPlugin;
  const fiber = root.plugin({ name: 'cost-panel-test', inject: ['sessions', 'llm', 'connection', 'sessionProjections'], apply });
  await fiber;
  t.after(async () => { await fiber.dispose(); await adapterPlugin.dispose(); await infrastructure.dispose(); });
  return { ctx: root, store, llm, projections, rpcRegistration, fiber };
}

function sessionWithStep(store, id = 'root', extra = {}) {
  const session = store.create(id, { meta: extra });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 0 });
  return session;
}

async function runStream(ctx, options, chunks) {
  const output = await ctx.emit('llm/stream', options, async function* () { yield* chunks; });
  return output;
}

test('native SessionStore + marked Agent Loop request records exact session step, usage/final chunks and forwards chunks', async t => {
  const h = await harness(t);
  const session = sessionWithStep(h.store, 'root');
  const original = [chunk('text-delta', { index: 0, text: 'a' }), chunk('usage', { usage: usage(10, 4) }), chunk('finish', { reason: { kind: 'stop' } })];
  const request = markAgentLoopRequest({ sessionId: session.id, provider: 'p', model: 'm', messages: [], testChunks: original });
  const yielded = [];
  const iter = h.llm.stream(request);
  for await (const item of iter) {
    yielded.push(item);
    session.append('assistant/chunk', { turn: 1, step: 0, chunk: item });
  }
  session.append('assistant/message', { turn: 1, step: 0, message: { source: { kind: 'model', provider: 'p', model: 'm' } }, usage: usage(10, 4) });
  assert.deepEqual(yielded, original);
  const records = session.events.filter(e => e.type === 'cost-panel/attempt').map(e => e.data);
  assert.ok(session.events.filter(e => e.type === 'cost-panel/attempt').every(e => e.ignorable === true));
  assert.equal(records.length, 3);
  assert.equal(records[0].purpose, 'conversation'); // same-module marked calls still work without native echoes
  assert.deepEqual([records[0].turn, records[0].step], [1, 0]);
  assert.deepEqual(records[1].usage, usage(10, 4));
  assert.equal(records[2].status, 'stop');
  const folded = foldAttempts(session.header, session.events);
  assert.equal(folded.attempts.length, 1);
  assert.equal(folded.attempts[0].purpose, 'conversation');
  assert.deepEqual([folded.attempts[0].turn, folded.attempts[0].step], [1, 0]);
  assert.equal(folded.incompleteHistory, false);
  assert.equal(h.projections.snapshot(session).values.costPanelRevision, 6);
  const beforeUnknown = h.projections.snapshot(session).values.costPanelRevision;
  session.append('extension/future-event', { payload: 1 });
  assert.equal(h.projections.snapshot(session).values.costPanelRevision, beforeUnknown);
});

test('separate Agent Loop module WeakSet: native stream evidence prevents double calls and costs', async t => {
  const h = await harness(t);
  const session = sessionWithStep(h.store, 'foreign-module');
  const request = { sessionId: session.id, provider: 'openai', serviceTier: 'default', model: 'gpt-6.1-sol', messages: [],
    testChunks: [chunk('usage', { usage: usage(1000, 100) }), chunk('finish', { reason: { kind: 'stop' } })] };
  const hostModuleMarks = new WeakSet([request]);
  assert.equal(hostModuleMarks.has(request), true);
  assert.equal(isAgentLoopRequest(request), false); // the panel's peer module cannot see Host marks
  for await (const item of h.llm.stream(request)) session.append('assistant/chunk', { turn: 1, step: 0, chunk: item });
  session.append('assistant/message', { turn: 1, step: 0, message: { source: { kind: 'model', provider: 'openai', model: 'gpt-6.1-sol' } }, usage: usage(1000, 100) });
  const folded = foldAttempts(session.header, session.events);
  assert.equal(folded.attempts.length, 1);
  assert.equal(folded.attempts[0].purpose, 'conversation');
  assert.equal(folded.incompleteHistory, false);
  const result = await h.rpcRegistration[1]('get', { sessionId: session.id }, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.value.own.calls, 1);
  assert.equal(result.value.own.metrics.input.count, 1000);
  assert.equal(result.value.own.metrics.output.count, 100);
  assert.ok(Math.abs(result.value.own.total - 0.003) < 1e-12);
  assert.ok(Math.abs(result.value.team.total - 0.003) < 1e-12);

  // An actual title call with the SAME usage is still a separate request.
  const title = { ...request, purpose: 'title' };
  for await (const _ of h.llm.stream(title)) { /* not a native assistant step */ }
  const distinct = foldAttempts(session.header, session.events);
  assert.deepEqual(distinct.attempts.map(a => a.purpose), ['conversation', 'title']);
  assert.equal(distinct.attempts.length, 2);
});

test('cost attempts reopen with the native persistence reader after the plugin is disabled; unknown required events remain rejected', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cost-compat-'));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = await harness(t);
  const writerContext = new Context();
  new SessionStore(writerContext);
  const persistence = new JsonlSessionPersistence(writerContext, { root: directory });
  const session = sessionWithStep(h.store, 'cost-reopen', { cwd: directory });
  const request = markAgentLoopRequest({ sessionId: session.id, provider: 'p', model: 'm', messages: [],
    testChunks: [chunk('usage', { usage: usage(7, 3) }), chunk('finish', { reason: { kind: 'stop' } })] });
  for await (const _ of h.llm.stream(request)) { /* exercise the actual writer */ }
  session.append('step/end', { turn: 1, step: 0 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await persistence.create(session.header);
  await persistence.append(session.id, session.events);
  const readerContext = new Context();
  new SessionStore(readerContext);
  const reader = new JsonlSessionPersistence(readerContext, { root: directory });
  try {
    const stored = await reader.inspect(session.id);
    const attempts = stored.events.filter(e => e.type === 'cost-panel/attempt');
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every(e => e.ignorable === true));
    assert.deepEqual(foldAttempts(stored.meta, stored.events).attempts[0].usage, usage(7, 3));
    session.append('extension/required-test', { necessary: true });
    await persistence.append(session.id, [session.events.at(-1)]);
    await assert.rejects(reader.inspect(session.id), /unknown to this harness and not marked ignorable/);
  } finally { await readerContext.fiber.dispose(); await writerContext.fiber.dispose(); }
});

test('separate retry requests on same turn-step survive fold and auxiliary compaction has its own purpose', async t => {
  const h = await harness(t);
  const session = sessionWithStep(h.store, 'retry');
  const first = markAgentLoopRequest({ sessionId: session.id, provider: 'p', model: 'm', messages: [] });
  const second = markAgentLoopRequest({ sessionId: session.id, provider: 'p', model: 'm', messages: [] });
  for (const request of [first, second]) {
    request.testChunks = [chunk('usage', { usage: usage(1, 1) }), chunk('finish', { reason: { kind: 'error', failure: { code: 'TEST', message: 'Test request failure' } } })];
    const iter = h.llm.stream(request);
    for await (const item of iter) session.append('assistant/chunk', { turn: 1, step: 0, chunk: item });
  }
  session.append('assistant/message', { turn: 1, step: 0, message: { source: { kind: 'model', provider: 'p', model: 'm' } }, usage: usage(1, 1) });
  const compact = { sessionId: session.id, provider: 'p', model: 'm', purpose: 'compaction', messages: [] };
  const compIter = h.llm.stream({ ...compact, messages: [], testChunks: [chunk('usage', { usage: usage(3, 2) }), chunk('finish', { reason: { kind: 'stop' } })] });
  for await (const _ of compIter) { /* consume */ }
  const attempts = foldAttempts(session.header, session.events).attempts;
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(a => a.purpose), ['conversation', 'conversation', 'compaction']);
  assert.equal(attempts[0].status, 'error');
  assert.deepEqual(attempts[0].usage, usage(1, 1));
  assert.equal(new Set(attempts.map(a => a.id)).size, 3);
});

test('native observer persists usage and interrupted status when stream aborts early', async t => {
  const h = await harness(t);
  const session = sessionWithStep(h.store, 'abort');
  const request = markAgentLoopRequest({ sessionId: session.id, provider: 'p', model: 'm', messages: [], testChunks: [chunk('usage', { usage: usage(7, 3) })] });
  const iter = h.llm.stream(request)[Symbol.asyncIterator]();
  await iter.next();
  await iter.return();
  const records = session.events.filter(e => e.type === 'cost-panel/attempt').map(e => e.data);
  assert.ok(session.events.filter(e => e.type === 'cost-panel/attempt').every(e => e.ignorable === true));
  assert.equal(records.at(-1).status, 'interrupted');
  assert.deepEqual(records.at(-1).usage, usage(7, 3));
});

test('seeded own history is excluded from fold and descendant team IDs remain unique', async t => {
  const h = await harness(t);
  const seeded = [
    { type: 'cost-panel/attempt', seq: 0, time: 1, data: { id: 0, purpose: 'conversation', turn: 1, step: 0, usage: usage(99, 99), status: 'stop' } },
  ];
  const session = h.store.create('seeded', { seed: seeded, meta: { cwd: tmpdir(), seedLength: 1 } });
  assert.equal(foldAttempts(session.header, session.events).attempts.length, 0);
  assert.deepEqual(taskTeam([
    { id: 'root', origin: 'ordinary' }, { id: 'child', origin: 'subagent', parentSession: 'root' },
    { id: 'cold', origin: 'subagent', parentSession: 'child' }, { id: 'ordinary-fork', origin: 'ordinary', parentSession: 'root' },
  ], 'child'), { rootId: 'root', ids: ['root', 'child', 'cold'], incomplete: false });
});

test('registered loopback RPC returns own/live-root/live-child/cold-descendant costs from native Host sessions and persisted event shape', async t => {
  const h = await harness(t);
  const root = sessionWithStep(h.store, 'root');
  const child = h.store.create('child', { meta: { cwd: tmpdir(), parentSession: root.id, origin: 'subagent' } });
  const coldHeader = { id: 'cold', version: 0, createdAt: 1, cwd: tmpdir(), parentSession: child.id, origin: 'subagent', seedLength: 0 };
  const usageEvent = (session, input) => {
    const request = markAgentLoopRequest({ sessionId: session.id, provider: 'openai', serviceTier: 'default', model: 'gpt-6-astra', messages: [], testChunks: [chunk('usage', { usage: usage(input, 2) }), chunk('finish', { reason: { kind: 'stop' } })] });
    return h.llm.stream(request);
  };
  for (const [session, amount] of [[root, 10], [child, 20]]) {
    for await (const _ of await usageEvent(session, amount)) { /* preserve the actual Host observer log */ }
  }
  const coldEvents = [{ type: 'cost-panel/attempt', seq: 0, time: 1, data: { id: 0, provider: 'openai', serviceTier: 'default', model: 'gpt-6-astra', purpose: 'conversation', turn: 1, step: 0, usage: usage(30, 2), status: 'stop' } }];
  const persistence = {
    async list() { return [root.header, child.header, coldHeader]; },
    async inspect(id) { assert.equal(id, 'cold'); return { meta: coldHeader, events: coldEvents }; },
  };
  h.ctx.provide('sessionPersistence', persistence);
  const [channel, handler, options] = h.rpcRegistration;
  assert.equal(channel, '/cost-panel');
  assert.deepEqual(options, { authority: 'loopback' });
  const controller = new AbortController();
  const own = await handler('get', { sessionId: root.id }, controller.signal);
  assert.equal(own.ok, true);
  assert.equal(own.value.sessionId, root.id);
  assert.equal(own.value.own.calls, 1);
  const childResult = await handler('get', { sessionId: child.id }, controller.signal);
  assert.equal(childResult.ok, true);
  assert.equal(childResult.value.team.rootId, root.id);
  assert.equal(childResult.value.team.sessions, 3);
  assert.ok(Math.abs(childResult.value.team.total - (60 * 10 + 6 * 50) / 1e6) < 1e-15);
  assert.ok(childResult.value.team.total > childResult.value.own.total);
  assert.equal(childResult.value.team.costUnknown, false);
  persistence.inspect = async () => { throw new Error('Unsupported required event in a cold child'); };
  const incompleteTeam = await handler('get', { sessionId: root.id }, controller.signal);
  assert.equal(incompleteTeam.ok, true);
  assert.deepEqual(incompleteTeam.value.own, own.value.own);
  assert.equal(incompleteTeam.value.team.costUnknown, true);
  const unavailableSelected = await handler('get', { sessionId: 'cold' }, controller.signal);
  assert.equal(unavailableSelected.ok, false);
  const invalid = await handler('other', { sessionId: root.id }, controller.signal);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'bad-request');
  assert.doesNotThrow(() => rpcResultSchema(z.unknown()).parse(invalid));
});

test('observer persists merged partial usage, with one attempt and no repeated output billing', async t => {
  const h = await harness(t);
  const session = sessionWithStep(h.store, 'partial');
  const chunks = [chunk('usage', { usage: usage(10, 4) }), chunk('usage', { usage: { outputTokens: 6 } }), chunk('usage', { usage: { inputTokens: 0, outputTokens: 0 } }), chunk('finish', { reason: { kind: 'stop' } })];
  for await (const item of h.llm.stream(markAgentLoopRequest({ sessionId: session.id, provider: 'openai', serviceTier: 'default', model: 'gpt-6-luna', messages: [], testChunks: chunks })))
    session.append('assistant/chunk', { turn: 1, step: 0, chunk: item });
  session.append('assistant/message', { turn: 1, step: 0, message: { source: { kind: 'model', provider: 'openai', model: 'gpt-6-luna' } }, usage: usage(10, 6) });
  const records = session.events.filter(e => e.type === 'cost-panel/attempt');
  assert.deepEqual(records.at(-1).data.usage, usage(10, 6));
  assert.equal(foldAttempts(session.header, session.events).attempts.length, 1);
  const result = await h.rpcRegistration[1]('get', { sessionId: session.id }, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.value.own.calls, 1);
  assert.equal(result.value.own.metrics.input.count, 10);
  assert.equal(result.value.own.metrics.output.count, 6);
  assert.ok(Math.abs(result.value.own.total - (10 * 0.1 + 6 * 0.5) / 1e6) < 1e-15);
});

test('unreadable descendant or persistence list preserves available own/team costs and flags incomplete', async t => {
  const h = await harness(t);
  const root = sessionWithStep(h.store, 'available');
  root.append('cost-panel/attempt', { id: 0, provider: 'openai', serviceTier: 'default', model: 'gpt-6-luna', purpose: 'conversation', usage: usage(10, 4), status: 'stop' });
  const cold = { id: 'unavailable', origin: 'subagent', parentSession: root.id };
  let failList = false;
  h.ctx.provide('sessionPersistence', {
    async list() { if (failList) throw new Error('list offline'); return [root.header, cold]; },
    async inspect() { throw new Error('cold unavailable'); },
  });
  for (const fail of [false, true]) {
    failList = fail;
    const result = await h.rpcRegistration[1]('get', { sessionId: root.id }, new AbortController().signal);
    assert.equal(result.ok, true);
    assert.ok(result.value.own.total > 0);
    assert.equal(result.value.team.total, result.value.own.total);
    assert.equal(result.value.team.costKnown, true);
    assert.equal(result.value.team.costUnknown, true);
  }
});

test('unknown required SDK placeholders survive observer/RPC without fabricated confirmed zeros', async t => {
  const h = await harness(t);
  const session = sessionWithStep(h.store, 'sdk-unknown');
  const counts = { inputTokens: 0, outputTokens: 7, inputTokensKnown: false, cacheReadTokens: 20, reasoningTokens: 3 };
  for await (const _ of h.llm.stream(markAgentLoopRequest({ sessionId: session.id, provider: 'openai', serviceTier: 'default', model: 'gpt-6-luna', messages: [], testChunks: [chunk('usage', { usage: counts }), chunk('finish', { reason: { kind: 'stop' } })] }))) {}
  const recorded = session.events.filter(e => e.type === 'cost-panel/attempt').at(-1).data.usage;
  assert.equal(recorded.inputTokens, undefined);
  assert.equal(recorded.inputTokensKnown, false);
  const result = await h.rpcRegistration[1]('get', { sessionId: session.id }, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(result.value.own.metrics.input.countKnown, false);
  assert.equal(result.value.own.metrics.output.count, 7);
  assert.equal(result.value.own.metrics.read.count, 20);
  assert.equal(result.value.own.metrics.write.countKnown, false);
  assert.equal(result.value.own.costUnknown, true);
  assert.ok(result.value.own.total > 0);
});

