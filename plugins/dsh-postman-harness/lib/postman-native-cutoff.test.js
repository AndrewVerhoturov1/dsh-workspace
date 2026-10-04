import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm/node_modules/@deepseek-ai/dsh')
const pkg = async name => import(pathToFileURL(join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
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
  ctx.subagents.continuations.closedChildren.delete(accepted.childId) // model a new manager loading the durable marker
  await assert.rejects(ctx.subagents.followup(leader, accepted.childId, content('late'),
    { source: { kind: 'user' }, signal: signal() }), /closed/)
  const naturallyDisposed = Promise.withResolvers()
  ctx.on('agent/disposed', ({ agent }) => { if (agent.id !== 'leader') naturallyDisposed.resolve() })
  const cold = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'B', signal: signal(),
    request: { parent: leader, prompt: content('initial B'), agentOptions: { provider: 'codex', model: 'test' } } })
  await naturallyDisposed.promise
  assert.equal(ctx.agents.get(cold.childId), undefined)
  assert.equal(await ctx.subagents.closeContinuableChild(leader, cold.childId, async () => true), true)
  assert.ok((await ctx.sessionPersistence.inspect(cold.childId)).events.some(event => event.type === 'subagent/closed'))
  ctx.subagents.continuations.closedChildren.delete(cold.childId)
  await assert.rejects(ctx.subagents.followup(leader, cold.childId, content('late cold'),
    { source: { kind: 'user' }, signal: signal() }), /closed/)
  const active = await ctx.subagents.startContinuable({ provider: 'spawn', label: 'C', signal: signal(),
    request: { parent: leader, prompt: content('hold'), agentOptions: { provider: 'codex', model: 'test' } } })
  await heldStarted.promise
  assert.equal(ctx.agents.get(active.childId)?.status, 'running')
  assert.equal(await ctx.subagents.closeContinuableChild(leader, active.childId, async () => true), true)
  assert.equal(ctx.agents.get(active.childId), undefined)
  assert.ok((await ctx.sessionPersistence.inspect(active.childId)).events.some(event => event.type === 'subagent/closed'))
})
