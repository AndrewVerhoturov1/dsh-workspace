import { Context, type Events } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor, snapshotSubagentDescriptor, type ContinuableSetupContribution, type ContinuableStartSpec } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { AgentId, SquadId } from '../src/types.ts'
import { createService } from './helpers.ts'

// Real detached Session logs and the installed descriptor codec; no model or
// persistence backend is contacted. Only Agent driving/inbox acceptance is stubbed.
describe('persistent Implementer installed host API contract', () => {
  it('recomposes fresh and cold activations, keeps identity, and scopes Bridge/request policy', async () => {
    const live = new Map<string, Agent>()
    const stored = new Map<string, Session>()
    const starts: ContinuableStartSpec[] = []
    const configs: unknown[] = []
    const scopes: { agent: Agent; names: string[]; dispose(): void }[] = []
    let install!: ContinuableSetupContribution
    let turn = 0
    const state = createService({
      agentsGet: id => live.get(id),
      toolSchemas: () => ['read_file', 'dispatch_postman_bridge', 'dispatch_to_squad', 'subagent', 'workflow'].map(name => ({ name, description: name })),
      startContinuable: async spec => {
        starts.push(spec)
        if (spec.childId === undefined) throw new Error('missing reserved identity')
        const session = Session.create(spec.childId, [], {
          ...Session.create(spec.childId).header, origin: 'subagent', parentSession: spec.request.parent.id, delegationDepth: 1,
        })
        session.append('subagent/descriptor', snapshotSubagentDescriptor({
          mode: 'continuable', provider: spec.provider, label: spec.label,
          agentProvider: spec.request.agentOptions!.provider!, agentModel: spec.request.agentOptions!.model!,
          persona: spec.request.persona!, toolFilter: spec.request.toolFilter!,
        }))
        stored.set(spec.childId, session)
        const child = materialize(session)
        return { childId: child.id, messageId: await deliver(child, spec.request.prompt) }
      },
      followup: async (_parent, id, content) => {
        const session = stored.get(id)
        if (session === undefined) throw Object.assign(new Error('missing'), { code: 'NOT_RESUMABLE' })
        const child = live.get(id) ?? materialize(Session.fromRestore(id, structuredClone(session.events), structuredClone(session.header)))
        stored.set(id, child.session)
        return deliver(child, content)
      },
    })
    const register: typeof state.ctx.subagents.registerContinuableSetup = contribution => { install = contribution; return () => {} }
    Object.assign(state.ctx.subagents, { registerContinuableSetup: register })
    const service = state.service as unknown as {
      registerReasoningEffortRouting(): void
      dispatchPersistentImplementerConversation(id: SquadId, task: string, parent: Agent, signal: AbortSignal): Promise<{ childId: SessionId; output: string }>
    }
    service.registerReasoningEffortRouting()
    live.set(state.parent.id, state.parent)
    const leader = AgentId('implementer')
    const team = SquadId('persistent-api')
    await state.agents.put(leader, { name: 'Implementer', provider: 'dedicated-provider', model: 'dedicated-model', reasoningEffort: 'high', maxTokens: 4567, systemPrompt: 'Apply prepared artifacts', toolScope: { allow: ['read_file'] } })
    await state.squads.put(team, { name: 'Team', members: [leader], leaderAgentId: leader, conversationMode: 'persistent-lead' })

    function materialize(session: Session): Agent {
      const descriptor = foldSubagentDescriptor(session.events)
      if (descriptor === undefined || descriptor.mode !== 'continuable') throw new Error('invalid descriptor')
      expect(descriptor.persona).toContain('dedicated Implementer')
      expect(descriptor.toolFilter).toMatchObject({ allow: ['read_file', 'dispatch_postman_bridge'], deny: ['dispatch_to_squad', 'subagent', 'workflow'] })
      const ctx = new Context() // deliberately NOT descended from the plugin scope
      const on = vi.spyOn(ctx, 'on')
      const names: string[] = []
      ctx.provide('tools', { register: (tool: { name: string }) => { names.push(tool.name); return () => { names.splice(names.indexOf(tool.name), 1) } } })
      const child = { id: session.id, session, ctx, options: { provider: descriptor.agentProvider, model: descriptor.agentModel }, async whenIdle() {} } as unknown as Agent
      ctx.provide('agent', child)
      const dispose = install(ctx)
      scopes.push({ agent: child, names, dispose })
      const call = on.mock.calls.find(args => args[0] === 'agent/request')
      if (call === undefined) throw new Error('missing scoped request routing')
      const handler = call[1] as Events['agent/request']
      configs.push(handler.call(child, { agent: child, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ provider: 'wrong', model: 'wrong', maxTokens: 1 })))
      live.set(child.id, child)
      return child
    }
    async function deliver(child: Agent, content: readonly ContentBlock[]) {
      const id = MessageId('task-' + ++turn)
      child.session.append('user/message', { id, role: 'user', content: [...content], source: { kind: 'user' } }, { surfaceOp: 'append' })
      child.session.append('assistant/message', { turn, step: 1, message: { id: MessageId('answer-' + turn), role: 'assistant', content: [{ type: 'text', text: 'exact answer ' + turn }], source: { kind: 'model', provider: 'dedicated-provider', model: 'dedicated-model' } } }, { surfaceOp: 'append' })
      return id
    }
    const signal = new AbortController().signal
    const first = await service.dispatchPersistentImplementerConversation(team, 'first', state.parent, signal)
    const second = await service.dispatchPersistentImplementerConversation(team, 'second', state.parent, signal)
    live.delete(first.childId)
    scopes[0]!.dispose()
    const cold = await service.dispatchPersistentImplementerConversation(team, 'third', state.parent, signal)
    expect(starts).toHaveLength(1)
    expect(first.childId).not.toBe(state.parent.id)
    expect([second.childId, cold.childId]).toEqual([first.childId, first.childId])
    expect([first.output, second.output, cold.output]).toEqual(['exact answer 1', 'exact answer 2', 'exact answer 3'])
    expect(await Promise.all(configs)).toEqual(Array(2).fill({ provider: 'dedicated-provider', model: 'dedicated-model', reasoningEffort: 'high', maxTokens: 4567 }))
    expect(scopes[0]!.names).toEqual([])
    expect(scopes[1]!.names).toEqual(['dispatch_postman_bridge'])
    const arbitraryCtx = new Context()
    arbitraryCtx.provide('agent', { ...scopes[1]!.agent, id: SessionId('arbitrary-delegate') })
    const arbitraryOn = vi.spyOn(arbitraryCtx, 'on')
    install(arbitraryCtx)()
    expect(arbitraryOn).not.toHaveBeenCalled()
    scopes[1]!.dispose()
    expect(scopes[1]!.names).toEqual([])
    expect(state.starts).toEqual([]) // root never invokes a synthesis model
  })
})
