import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const root = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh')
const sdkRequire = createRequire(join(root, 'package.json'))
const pkg = async name => import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/' + name)).href)
const { Context } = await pkg('cordis')
const { AgentRegistry } = await pkg('dsh-agent')
const { SessionStore } = await pkg('dsh-session')
const { JsonlSessionPersistence } = await pkg('dsh-session-persistence-jsonl')
const { SessionProjectionRegistry } = await pkg('dsh-session-projection')
const { SystemPrompt } = await pkg('dsh-system-prompt')
const { ToolRuntime } = await pkg('dsh-tools')
const { LlmRuntime, LlmAdapter } = await pkg('dsh-llm')
const { AgentLoop } = await pkg('dsh-agent-loop')
const { SubagentRuntime } = await pkg('dsh-subagent')
const { BasicCompactionEngine } = await pkg('dsh-compaction-basic')
const { TokenMeter } = await pkg('dsh-token-meter')
const { apply: spawn } = await pkg('dsh-subagent-spawn-in-process')
const signal = () => new AbortController().signal
const content = text => [{ type: 'text', text }]

test('exact close durably discards parked inbox and rejects later followup',
  { timeout: 10000, skip: typeof SubagentRuntime.prototype.closeContinuableChild !== 'function' && 'installed DSH lacks native child cutoff patch' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'native-cutoff-'))
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new LlmRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(dir, 'sessions') })
  new SubagentRuntime(ctx); spawn(ctx, { providerName: 'spawn' })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  const started = Promise.withResolvers(), heldStarted = Promise.withResolvers()
  class FakeAdapter extends LlmAdapter {
    async *stream(request) {
      const agent = ctx.agents.currentInitiator()
      if (agent.session.events.find(event => event.type === 'subagent/descriptor')?.data?.label === 'C') {
        heldStarted.resolve()
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
        request.signal.throwIfAborted()
      }
      started.resolve()
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['codex'], new FakeAdapter())
  assert.ok(ctx.get('agents'), 'agents registered')
  await Promise.resolve()
  assert.ok(ctx.subagents.continuations, 'continuations injected')
  const leader = ctx.agentLoop.create('leader', { provider: 'codex', model: 'test' }, { cwd: dir })
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const accepted = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'A', signal: signal(),
    request: { parent: leader, prompt: content('initial'), agentOptions: { provider: 'codex', model: 'test' } } })
  await started.promise
  const child = ctx.agents.get(accepted.childId)
  await child.whenIdle()
  const queued = await ctx.subagents.followup(leader, accepted.childId, content('parked'),
    { source: { kind: 'user' }, signal: signal() })
  assert.ok(queued)
  const closed = await ctx.subagents.closeContinuableChild(leader, accepted.childId, async () => true)
  assert.equal(closed, true)
  const saved = await ctx.sessionPersistence.inspect(accepted.childId)
  assert.ok(saved.events.some(event => event.type === 'subagent/closed'))
  const { Inbox } = await pkg('dsh-agent')
  assert.equal(new Inbox({ header: saved.meta, events: saved.events }, { inserted() {}, discarded() {}, claimed() {} }).hasPending, false)
  assert.equal(ctx.subagents.continuations.closedChildren.has(accepted.childId), false)
  ctx.subagents.continuations.closedChildren.add(accepted.childId) // simulate uncertain cache after durable marker
  assert.equal(await ctx.subagents.inspectClosedContinuableChild(leader, accepted.childId), true)
  assert.equal(ctx.subagents.continuations.closedChildren.has(accepted.childId), false)
  await assert.rejects(ctx.subagents.followup(leader, accepted.childId, content('late'),
    { source: { kind: 'user' }, signal: signal() }), /closed/)
  const naturallyDisposed = Promise.withResolvers()
  ctx.on('agent/disposed', ({ agent }) => { if (agent.id !== 'leader') naturallyDisposed.resolve() })
  const cold = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'B', signal: signal(),
    request: { parent: leader, prompt: content('initial B'), agentOptions: { provider: 'codex', model: 'test' } } })
  await naturallyDisposed.promise
  assert.equal(ctx.agents.get(cold.childId), undefined)
  const before = await ctx.sessionPersistence.inspect(cold.childId)
  await ctx.sessionPersistence.append(cold.childId, [{ type: 'agent/inbox/spliced',
    seq: before.events.length, time: Date.now(), data: { target: 'next-turn', start: 0, inserted: [
      { id: 'parked-B', role: 'user', source: { kind: 'user' }, content: content('parked B') }] } }])
  assert.equal(await ctx.subagents.closeContinuableChild(leader, cold.childId, async () => true), true)
  const coldSaved = await ctx.sessionPersistence.inspect(cold.childId)
  assert.ok(coldSaved.events.some(event => event.type === 'subagent/closed'))
  assert.equal(new Inbox({ header: coldSaved.meta, events: coldSaved.events },
    { inserted() {}, discarded() {}, claimed() {} }).hasPending, false)
  assert.equal(ctx.subagents.continuations.closedChildren.has(cold.childId), false)
  await assert.rejects(ctx.subagents.followup(leader, cold.childId, content('late cold'),
    { source: { kind: 'user' }, signal: signal() }), /closed/)
  const active = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'C', signal: signal(),
    request: { parent: leader, prompt: content('hold'), agentOptions: { provider: 'codex', model: 'test' } } })
  await heldStarted.promise
  assert.equal(ctx.agents.get(active.childId)?.status, 'running')
  assert.equal(await ctx.subagents.closeContinuableChild(leader, active.childId, async () => true), true)
  assert.equal(ctx.agents.get(active.childId), undefined)
  assert.ok((await ctx.sessionPersistence.inspect(active.childId)).events.some(event => event.type === 'subagent/closed'))
  assert.equal(ctx.subagents.continuations.closedChildren.has(active.childId), false)
  assert.equal(await ctx.subagents.inspectClosedContinuableChild(leader, active.childId), true)
})

test('native exact-child compact serializes against followup and refuses running or queued child',
  { timeout: 10000, skip: typeof SubagentRuntime.prototype.compactContinuableChild !== 'function' && 'native compact overlay unavailable' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'native-compact-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const ctx = new Context()
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new LlmRuntime(ctx)
  new TokenMeter(ctx)
  new JsonlSessionPersistence(ctx, { root: join(dir, 'sessions') })
  new SubagentRuntime(ctx); spawn(ctx, { providerName: 'spawn' })
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
  await Promise.resolve()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  class FakeAdapter extends LlmAdapter {
    async *stream() {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['codex'], new FakeAdapter())
  const leader = ctx.agentLoop.create('leader', { provider: 'codex', model: 'test' }, { cwd: dir })
  t.after(() => ctx.fiber.dispose())
  const accepted = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'compact', signal: signal(),
    request: { parent: leader, prompt: content('first'), agentOptions: { provider: 'codex', model: 'test' } } })
  const child = ctx.agents.get(accepted.childId)
  await child.whenIdle()
  let calls = 0
  const engine = new BasicCompactionEngine(child.ctx, { auto: false })
  const nativeCompact = engine.compactNow.bind(engine)
  engine.compactNow = async (...args) => {
    calls++; entered.resolve(); await release.promise
    return nativeCompact(...args)
  }
  const compact = ctx.subagents.compactContinuableChild(leader, accepted.childId, agent => agent === child, signal())
  await entered.promise
  const later = ctx.subagents.followup(leader, accepted.childId, content('later'),
    { source: { kind: 'user' }, signal: signal() })
  assert.equal(calls, 1)
  release.resolve()
  const compacted = (await compact).result
  assert.ok(compacted?.shadowedSeqs?.length > 0, 'real engine shadowed prior model-visible history')
  assert.ok(child.session.events.some(event => event.type === 'compaction/end'))
  assert.ok((await ctx.sessionPersistence.inspect(accepted.childId)).events.some(event => event.type === 'compaction/end'))
  assert.ok(await later)
  assert.equal(ctx.agents.get(accepted.childId)?.id, accepted.childId)
  await ctx.agents.get(accepted.childId).whenIdle()
  assert.equal(await ctx.subagents.compactContinuableChild(leader, accepted.childId,
    () => false, signal()), false)
  assert.equal(calls, 1)
  const parked = await ctx.subagents.followup(leader, accepted.childId, content('parked'),
    { source: { kind: 'user' }, signal: signal() })
  assert.ok(parked)
  assert.equal(await ctx.subagents.compactContinuableChild(leader, accepted.childId,
    () => true, signal()), false)
  assert.equal(calls, 1)
})

test('closed marker rejects old child after actual runtime recreation',
  { timeout: 10000, skip: typeof SubagentRuntime.prototype.closeContinuableChild !== 'function' && 'native overlay unavailable' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'native-recreation-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  async function runtime() {
    const ctx = new Context()
    new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
    new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new LlmRuntime(ctx)
    new JsonlSessionPersistence(ctx, { root: join(dir, 'sessions') })
    new SubagentRuntime(ctx); spawn(ctx, { providerName: 'spawn' })
    new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
    class FakeAdapter extends LlmAdapter {
      async *stream() {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['codex'], new FakeAdapter())
    const leader = ctx.agentLoop.create('leader', { provider: 'codex', model: 'test' }, { cwd: dir })
    return { ctx, leader }
  }
  const a = await runtime()
  const accepted = await a.ctx.subagents.startContinuable({ provider: 'spawn', label: 'A', signal: signal(),
    request: { parent: a.leader, prompt: content('initial'), agentOptions: { provider: 'codex', model: 'test' } } })
  await a.ctx.agents.get(accepted.childId).whenIdle()
  assert.equal(await a.ctx.subagents.closeContinuableChild(a.leader, accepted.childId, async () => true), true)
  await a.ctx.fiber.dispose()
  const b = await runtime()
  t.after(() => b.ctx.fiber.dispose())
  assert.equal(await b.ctx.subagents.inspectClosedContinuableChild(b.leader, accepted.childId), true)
  await assert.rejects(b.ctx.subagents.followup(b.leader, accepted.childId, content('after restart'),
    { source: { kind: 'user' }, signal: signal() }), /closed/)
})
