import { defineTool } from '@deepseek-ai/dsh-tools'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { applyChildComposition, foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_SOL_WORKER_TOOL_NAME,
  POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  POSTMAN_WORKER_LIST_TOOL_NAME,
  POSTMAN_WORKER_COMPACT_TOOL_NAME,
  isTopLevelPostmanSupervisor,
  isTopLevelPostmanPtcLeader,
  isTopLevelPostmanNodesLeader,
  WORKER_CONTROL_TOOLS, DELEGATION_TOOLS, SECRETARY_TOOLS, POSTMAN_NODES_TOOL_NAMES,
} from './postman-bridge-core.js'

export const POSTMAN_WORKER_PROVIDER = 'spawn'
// Codex metadata: minimal=null (unsupported); off omits reasoning on the wire.
// low is the lowest explicit supported reasoning effort, not the provider default.
export const FAST_WORKER_MODEL = 'gpt-6-luna'
export const FAST_WORKER_REASONING = 'low'
export const POSTMAN_WORKER_AGENT_OPTIONS = Object.freeze({ provider: 'codex', model: FAST_WORKER_MODEL, reasoningEffort: FAST_WORKER_REASONING })
const hardValid = hard => Number.isSafeInteger(hard) && hard >= 8 && hard <= 100
const limitsFor = hardLimit => ({ hardLimit, softLimit: Math.floor(hardLimit * 0.8) })
export const FAST_WORKER_BUDGET = Object.freeze(limitsFor(60))
const ROLE_SKILLS = Object.freeze(Object.fromEntries(['luna', 'secretary', 'sol'].map(type => [type,
  readFileSync(new URL('../../../.agents/skills/' + (type === 'luna' ? 'postman-worker' : type === 'sol' ? 'postman-sol-worker' : 'postman-secretary') + '/SKILL.md', import.meta.url), 'utf8') ])))
export const postmanRoleInstruction = type => ROLE_SKILLS[type]
export const POSTMAN_SOL_WORKER_AGENT_OPTIONS = Object.freeze({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' })
const workerTypeOf = binding => binding.workerType ?? 'luna'
const workerOptions = type => type === 'sol' ? POSTMAN_SOL_WORKER_AGENT_OPTIONS : POSTMAN_WORKER_AGENT_OPTIONS
// Compatibility export, sourced from the canonical skill rather than a second persona.
export const POSTMAN_WORKER_PERSONA = ROLE_SKILLS.luna

function diagnostic(error) {
  const text = String(error?.message ?? error ?? 'unknown error')
  return text.length <= 512 ? text : `${text.slice(0, 509)}...`
}

function output() {
  return {
    schema: {
      type: 'object', additionalProperties: true,
      properties: { status: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

// Discover the transport/control surface from the host registry at admission.
// This is a deny-only child filter, not a Worker coding-tool allowlist.
export { WORKER_CONTROL_TOOLS, DELEGATION_TOOLS, SECRETARY_TOOLS } from './postman-bridge-core.js'
export function postmanWorkerDeniedTools(tools, type = 'luna', scope) {
  return [...new Set([...tools.schemas(scope).map(tool => tool.name).filter(name => name.startsWith('postman_') &&
    !(type === 'sol' && WORKER_CONTROL_TOOLS.includes(name)) && !(type === 'luna' && name === 'postman_app') && !(type === 'secretary' && name === 'postman_secretary_ledger')),
    ...tools.schemas(scope).map(tool => tool.name).filter(name => DELEGATION_TOOLS.includes(name) || (type === 'luna' && ['ask_user_question', 'list_agents', 'exit_plan_mode'].includes(name)) || (type !== 'sol' && name === 'ptc_execute') || (type === 'secretary' && name === 'implementation_artifact_apply'))])]
}

function nodeToolFilter(node, type, intrinsicDenied) {
  const grants = node.capabilities?.grants || []
  const denied = new Set([...intrinsicDenied, ...grants.filter(g => g.kind === 'tool' && g.mode === 'deny').map(g => g.id)])
  const allowed = grants.filter(g => g.kind === 'tool' && g.mode === 'allow').map(g => g.id)
  const nativeRequired = ['report', 'notify_parent', ...POSTMAN_NODES_TOOL_NAMES,
    ...(type === 'sol' ? ['ptc_execute', ...WORKER_CONTROL_TOOLS] : []),
    ...(type === 'secretary' ? ['postman_secretary_ledger'] : []),
    ...(type === 'luna' ? ['postman_app'] : [])]
  return { deny: [...denied], ...(allowed.length ? { allow: [...new Set([...allowed, ...nativeRequired])].filter(name => !denied.has(name)) } : {}) }
}

export function buildPostmanWorkerStartRequest(parent, task, signal, deniedTools, label = 'Postman Worker', workerType = 'luna', nodeConfig = null) {
  if (!Array.isArray(deniedTools) || deniedTools.length === 0 ||
      deniedTools.some(name => typeof name !== 'string')) {
    throw new Error('POSTMAN_WORKER_TRANSPORT_BOUNDARY_REQUIRED')
  }
  return {
    provider: POSTMAN_WORKER_PROVIDER,
    label,
    signal,
    request: {
      parent,
      prompt: [{ type: 'text', text: task }],
      agentOptions: nodeConfig ? { provider: nodeConfig.model.provider, model: nodeConfig.model.model,
        ...(nodeConfig.model.reasoningEffort ? { reasoningEffort: nodeConfig.model.reasoningEffort } : {}) } : { ...workerOptions(workerType) },
      persona: 'You are ' + (workerType === 'sol' ? 'Postman Sol Worker' : workerType === 'secretary' ? 'Secretary' : 'Postman Worker') + '. Follow the Host-injected canonical role skill.' + (nodeConfig ? '\nNode configuration (subordinate to immutable Postman role restrictions):\n' + nodeConfig.systemPrompt : ''),
      maxDepth: workerType === 'sol' ? 2 : (parent.session?.header?.delegationDepth ?? 0) + 1,
      // Only deny host Postman transport/control tools. The shared preset's
      // coding tools and child-scoped report remain available.
      toolFilter: nodeConfig ? nodeToolFilter(nodeConfig, workerType, deniedTools) : { deny: [...deniedTools] },
    },
  }
}


// One short Leader admission queue reserves membership; every child has its own
// delivery queue. Neither queue is held until a model turn finishes.
export function createPostmanWorkerTools(ctx, grants, contexts, { onBindingChange = () => {}, localDevelopment = false, fastBudget = FAST_WORKER_BUDGET, nodesService = () => null } = {}) {
  if (!hardValid(fastBudget.hardLimit))
    throw new Error('POSTMAN_WORKER_BUDGET_INVALID')
  const taskContexts = contexts
  // One durable task row; exact parent-scoped projections reuse the same manager.
  const rootId = id => ctx.agents.get(id)?.session?.header?.origin === 'subagent'
    ? ctx.agents.get(id).session.header.parentSession
    : [...leaders.keys()].find(leaderId => taskContexts?.record?.(leaderId)?.workers?.[id]?.workerType === 'sol') ?? id
  const owned = (row, id) => Object.fromEntries(Object.entries(row?.workers ?? {}).filter(([, b]) =>
    (b.ownerSessionId ?? row.leaderSessionId ?? rootId(id)) === id))
  const rawRow = id => taskContexts?.record?.(rootId(id))
  const contextAt = id => taskContexts?.get(rootId(id))
  const changeScoped = (id, fn) => taskContexts.changeRecord(rootId(id), row => {
    const peers = Object.fromEntries(Object.entries(row.workers ?? {}).filter(([key]) => !Object.hasOwn(owned(row, id), key)))
    const next = fn({ ...row, workers: owned(row, id) })
    return { ...next, workers: { ...peers, ...next.workers } }
  })
  if (taskContexts) contexts = { ...taskContexts,
    // Production taskContexts is an accessor-only Proxy, so object spread
    // copies no methods. Keep the auto branchless Secretary prerequisite.
    ensure: parent => taskContexts.ensure?.(ctx.agents.get(rootId(parent.id)) ?? parent),
    get: contextAt,
    record: taskContexts.record ? id => { const row = rawRow(id); return row ? { ...row, workers: owned(row, id) } : null } : undefined,
    changeRecord: taskContexts.changeRecord ? changeScoped : undefined,
  }
  const depthOf = id => (ctx.agents.get(id)?.session?.header?.delegationDepth ?? (rootId(id) !== id ? 1 : 0)) + 1
  const leaders = new Map()
  const disposedParents = new WeakSet()
  const bindingChanged = id => onBindingChange(id)
  let disposed = false
  const durable = typeof contexts?.record === 'function' && typeof contexts?.changeRecord === 'function'
  const rowOf = id => durable ? contexts.record(id) : null
  const liveWorker = id => ctx.agents.get(id)
  const nativeNodesService = () => nodesService()
  const nodesOwner = parent => isTopLevelPostmanNodesLeader(parent) ||
    (roleOf(parent) === 'sol' && isTopLevelPostmanNodesLeader(ctx.agents.get(parent?.session?.header?.parentSession)))
  const emptyLifecycle = () => ({ version: 1, admissions: [], reports: [] })
  const newBudget = (assignmentId, task, hard = fastBudget.hardLimit) => ({
    assignmentId, task, used: 0, ...limitsFor(hard), exhausted: false, notified: false, reported: false })
  const budgetArgsInvalid = args => (args.hardBudget !== undefined && !hardValid(args.hardBudget)) ||
    (args.softLimit !== undefined || args.softBudget !== undefined)
  const activeSlot = agent => provisionalSlot(agent, false) || liveSlot(agent, agent?.session?.header?.parentSession, true)
  async function saveBudget(agent, slot, budget) {
    if (durable) await changeBinding({ id: agent.session.header.parentSession }, agent.id, current => {
      if (current.budget && current.budget.assignmentId !== budget.assignmentId) throw new Error('POSTMAN_WORKER_ASSIGNMENT_CHANGED')
      return { ...current, budget }
    })
    slot.budget = budget
  }
  function budgetOf(agent) {
    const slot = activeSlot(agent)
    if (!slot || slot.workerType === 'sol') return null
    const binding = rowOf(agent.session.header.parentSession)?.workers?.[agent.id]
    const budget = binding?.budget ?? slot.budget ?? { ...newBudget(binding?.lifecycle?.admissions?.at(-1)?.id ?? 'legacy:' + agent.id,
      'Legacy assignment: return bounded facts or parent guidance', fastBudget.hardLimit), used: agent.session.events.filter(e => e.type === 'step/start').length }
    return budget
  }
  function blockerText(agent, budget) {
    const calls = agent.session.events.filter(e => e.type === 'tool/call').slice(-8).map(e => e.data.name)
    return ['NEEDS_PARENT_GUIDANCE:', 'Задача: ' + budget.task,
      'Уже сделано/проверено: только подтверждённые результаты в child history; Host не подтверждает PASS.',
      'Что мешает закончить: FAST assignment budget exhausted (' + budget.used + '/' + budget.hardLimit + ').',
      'Что уже пробовал: ' + calls.join(', '),
      'Какое решение нужно от parent: проверить evidence и дать конкретное ограниченное назначение либо изменить routing.',
      'Безопасные варианты: закончить по достаточным evidence или вернуть blocker; task success не установлен.'].join(String.fromCharCode(10))
  }
  // AgentOptions carries the start intent; this existing request waterfall also
  // covers first-request assembly and cold resumes that retain only provider/model.
  const stopRequestOptions = ctx.on?.('agent/request', async ({ agent }, next) => {
    const config = await next()
    const slot = provisionalSlot(agent, false) || liveSlot(agent, agent?.session?.header?.parentSession, true)
    if (slot && slot.workerType !== 'sol') {
      const budget = budgetOf(agent)
      if (budget && !budget.reported) {
        if (durable) {
          await contexts.changeRecord(agent.session.header.parentSession, row => {
            const current = row.workers[agent.id]?.budget
            if (!current || current.assignmentId !== budget.assignmentId) throw new Error('POSTMAN_WORKER_ASSIGNMENT_CHANGED')
            if (current.used >= current.hardLimit) throw new Error('POSTMAN_WORKER_BUDGET_EXHAUSTED')
            const updated = { ...current, used: current.used + 1, exhausted: current.used + 1 >= current.hardLimit }
            return { ...row, workers: { ...row.workers, [agent.id]: { ...row.workers[agent.id], budget: updated } } }
          })
          slot.budget = rowOf(agent.session.header.parentSession).workers[agent.id].budget
        }
        else await saveBudget(agent, slot, { ...budget, used: budget.used + 1, exhausted: budget.used + 1 >= budget.hardLimit })
      }
    }
    const options = slot && workerOptions(slot.workerType)
    const binding = slot && rowOf(agent?.session?.header?.parentSession)?.workers?.[agent.id]
    const node = binding?.nodesRunId && nativeNodesService()?.workerNodeFromBinding(binding)
    if (binding?.nodesRunId && !node) throw new Error('NODES_WORKER_CONFIG_UNAVAILABLE')
    if (node) {
      const { reasoningEffort, ...rest } = config
      return { ...rest, provider: node.model.provider, model: node.model.model,
        ...(node.model.reasoningEffort ? { reasoningEffort: node.model.reasoningEffort } : {}) }
    }
    return options && config.provider === options.provider && config.model === options.model
      ? { ...config, reasoningEffort: options.reasoningEffort } : config
  })
  // A released Activation is not a deleted durable Session. inspect never resumes a model.
  async function history(id, leaderId, signal) {
    const resident = liveWorker(id)
    let saved
    try { saved = resident?.session ?? ctx.get?.('sessions')?.get?.(id) ??
      (await ctx.get?.('sessionPersistence')?.inspect?.(id, signal)) } catch { return null }
    const header = saved?.header ?? saved?.meta
    if ((header?.id !== undefined && header.id !== id) || header?.origin !== 'subagent' ||
        header.parentSession !== leaderId || header.delegationDepth !== depthOf(leaderId) ||
        !Array.isArray(saved.events)) return null
    const seed = header.seedLength ?? 0
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > saved.events.length) return null
    let inbox = resident?.inbox
    if (!inbox) try { inbox = new Inbox({ header, events: saved.events }, {
      inserted() {}, discarded() {}, claimed() {},
    }) } catch { return null }
    return { session: { events: saved.events.slice(seed) }, status: resident?.status ?? 'idle', inbox }
  }
  async function observeReport(exec, result) {
    if (exec?.name !== 'report' || result?.isError ||
        typeof result?.value?.messageId !== 'string' ||
        typeof exec.arguments?.output !== 'string' || !exec.arguments.output.trim()) return
    const child = exec.agent, leaderId = child?.session?.header?.parentSession
    if (!durable || child?.session?.header?.origin !== 'subagent' ||
        child.session.header.delegationDepth !== depthOf(leaderId) || liveWorker(child.id) !== child) return
    const call = child.session.events.findLast(event => event.type === 'tool/call' &&
      event.data.callId === exec.callId && event.data.name === 'report')
    const budget = budgetOf(child)
    const forced = !call && budget?.exhausted && exec.callId === budget.assignmentId + ':budget-report'
    if (!call && !forced) return
    const turn = call?.data.turn ?? child.session.events.findLast(e => e.type === 'turn/start')?.data.turn
    if (!Number.isInteger(turn)) return
    try { await changeBinding({ id: leaderId }, child.id, current => {
      if (!['intent', 'ready'].includes(current.state)) return current
      return { ...current, lifecycle: { ...(current.lifecycle ?? emptyLifecycle()),
        reports: [...(current.lifecycle?.reports ?? []).filter(item => item.callId !== exec.callId),
          { childId: child.id, turn, callId: exec.callId, messageId: result.value.messageId,
            ...(forced ? {hostBudgetAfterSeq:child.session.events.at(-1).seq} : {}) }] } }
    }) } catch { /* A removed binding must never be resurrected by a late callback. */ }
  }
  function group(parent) {
    let group = leaders.get(parent.id)
    if (!group) {
      group = { slots: new Map(), stopped: new Set(), fresh: new Map(), tail: Promise.resolve() }
      leaders.set(parent.id, group)
    }
    return group
  }
  function enqueue(holder, action) {
    const result = holder.tail.then(action)
    holder.tail = result.then(() => undefined, () => undefined)
    return result
  }
  function authorized(parent) {
    return Boolean(parent) && !disposed && !disposedParents.has(parent) && ctx.agents.get(parent.id) === parent &&
      (isTopLevelPostmanSupervisor(parent) || roleOf(parent) === 'sol')
  }
  function bindings(parent, group) {
    return durable ? rowOf(parent.id)?.workers ?? {} : Object.fromEntries(
      [...group.slots].filter(([, slot]) => !slot.closed).map(([id, slot]) =>
        [id, { id, label: slot.label, workerType: slot.workerType, state: slot.state, delivery: slot.delivery, artifactRequests: [], lifecycle: slot.lifecycle }]))
  }
  function slotFor(group, binding) {
    let slot = group.slots.get(binding.id)
    if (!slot) {
      slot = { id: binding.id, label: binding.label, workerType: workerTypeOf(binding), state: binding.state, delivery: binding.delivery,
        artifactRequests: new Set(), lifecycle: binding.lifecycle, budget: binding.budget, context: binding.cwd ? {worktree:binding.cwd,cwd:binding.cwd} : null, parent: null, workerAgent: null, closed: false, tail: Promise.resolve() }
      group.slots.set(binding.id, slot)
    }
    return slot
  }
  async function changeBinding(parent, id, fn) {
    if (!durable) return
    await contexts.changeRecord(parent.id, row => {
      const current = Object.hasOwn(row.workers ?? {}, id) ? row.workers[id] : null
      if (!current || current.id !== id) throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
      const changed = fn(current)
      return { ...row, workers: { ...row.workers, [id]: changed } }
    })
  }
  function matchesContext(parent, slot) {
    const binding = rowOf(parent.id)?.workers?.[slot.id]
    return !contexts || binding?.id === slot.id && (binding.ownerSessionId ?? parent.id) === parent.id
  }
  const stopIntent = (entry, mode, childIds = []) => ({
    ...(entry.lifecycle ?? emptyLifecycle()), stop: { id: randomUUID(), mode,
      cascade: childIds.length > 0, childIds, requestedAt: new Date().toISOString() },
  })
  async function provenClosed(parent, id) {
    if (typeof ctx.subagents.inspectClosedContinuableChild !== 'function') return false
    try { return await ctx.subagents.inspectClosedContinuableChild(parent, id) === true } catch { return false }
  }
  async function childExists(parent, id, signal) {
    const entries = await ctx.subagents.listChildren(parent.id, signal)
    const matches = entries.filter(entry => entry.id === id)
    return matches.length === 1 && matches[0].kind === 'child' && matches[0].mode === 'continuable'
  }
  async function reconcile(parent, slot, signal) {
    const saved = durable ? rowOf(parent.id)?.workers?.[slot.id] : slot
    if (!saved || slot.closed) return 'POSTMAN_WORKER_TARGET_UNKNOWN'
    if (saved.lifecycle?.stop) return 'POSTMAN_WORKER_EXECUTION_REVOKED'
    slot.state = 'ready'
    slot.parent = parent
    slot.workerAgent = liveWorker(slot.id) ?? null
    slot.verified = true
    slot.label = saved.label
    slot.delivery = saved.delivery
    if (durable && saved.state !== 'ready') await changeBinding(parent, slot.id, current => ({ ...current, state: 'ready' }))
    return null
  }
  async function admitted(parent, action) {
    await contexts?.ensure?.(parent)
    return action()
  }
  function select(parent, id, group, workerType) {
    const workers = bindings(parent, group)
    if (id !== undefined) return Object.hasOwn(workers, id) && workers[id]?.id === id
      ? { binding: workers[id] } : { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
    const entries = Object.entries(workers)
    if (entries.some(([key, value]) => value?.id !== key)) return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN' }
    const values = entries.map(([, value]) => value).filter(value => workerType === undefined || workerTypeOf(value) === workerType)
    if (values.length > 1) return { status: 'POSTMAN_WORKER_TARGET_REQUIRED' }
    return values.length === 1 ? { binding: values[0] } : { status: 'POSTMAN_WORKER_INTERRUPT_NO_ACTIVE_WORKER' }
  }
  function workContext(parent, args, slot) {
    const owner = contexts?.get(parent.id)
    const cwd = resolve(args.cwd ?? slot?.context?.worktree ?? rowOf(parent.id)?.workers?.[slot?.id]?.cwd ?? owner?.worktree ?? parent.session?.header?.cwd ?? process.cwd())
    return Object.freeze({ leaderSessionId: owner?.leaderSessionId ?? parent.id, cwd, worktree: cwd })
  }
  function taskText(context, text, workerType) {
    return 'Working directory: ' + context.worktree.replaceAll(String.fromCharCode(92), '/') + '. Use it as the base for relative paths and shell workdir. ' +
      'Follow applicable AGENTS.md and repository policy. Coordinate shared files with your parent. ' +
      (workerType === 'secretary' ? 'Collect facts and maintain the private ledger. ' : '') + text
  }
  async function taskWithGrant(parent, context, args, workerType = 'luna') {
    const text = taskText(context, args.task, workerType)
    if (args.artifactRequestId === undefined) return { text }
    if (!isTopLevelPostmanSupervisor(parent)) return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED' }
    const grant = await grants?.resolve(parent.id, args.artifactRequestId)
    if (!grant) return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED' }
    return { grant, text: text + '\nTrusted Host artifact REQ: ' + grant.requestId +
      '. Host supplies the verified ZIP. Choose the target temporary worktree under repository policy and call ' +
      'implementation_artifact_apply({requestId, worktree}). The existing runner owns package checks and declared tests. ' +
      'Do not repeat unchanged successful tests. Report the actual outcome.' }
  }
  async function deliver(parent, slot, args, exec, interrupt, workerType = 'luna') {
    if (slot.workerType !== workerType) return { status: slot.workerType === 'sol' ?
      'POSTMAN_SOL_WORKER_TOOL_REQUIRED' : 'POSTMAN_WORKER_TYPE_MISMATCH', workerSessionId: slot.id }
    if (slot.closed || !authorized(parent)) return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
    if (nodesOwner(parent) && !nativeNodesService()?.nativeDeliveryAllowed(parent, slot.id, rowOf(parent.id)?.workers?.[slot.id]))
      return { status: 'NODES_ASSIGNMENT_DENIED' }
    const context = workContext(parent, args, slot)
    slot.context = context
    const recovered = await reconcile(parent, slot, exec.signal)
    if (recovered) return { status: recovered, workerSessionId: slot.id }
    let task
    try { task = await taskWithGrant(parent, context, args, workerType) }
    catch (error) { return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED', diagnostic: diagnostic(error) } }
    if (task.status) return task
    const id = slot.id
    const onAbort = () => bindingChanged(id)
    exec.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const assignment = { id: randomUUID(), state: 'pending', messageId: null, ...(context ? {worktree:context.worktree} : {}) }
      let nextBudget = slot.workerType !== 'sol' ? newBudget(assignment.id, args.task, args.hardBudget ?? fastBudget.hardLimit) : null
      if (durable) await contexts.changeRecord(parent.id, row => {
        const current = row.workers[id]
        if (current.lifecycle?.stop) throw new Error('POSTMAN_WORKER_EXECUTION_REVOKED')
        return { ...row, workers: { ...row.workers, [id]: { ...current, ...(nextBudget ? {pendingBudgets: {...(current.pendingBudgets ?? {}), [assignment.id]: nextBudget}} : {}), delivery: 'pending', lifecycle: { ...(current.lifecycle ?? emptyLifecycle()),
          admissions: [...(current.lifecycle?.admissions ?? []), assignment] }, artifactRequests: task.grant ?
          [...new Set([...current.artifactRequests, args.artifactRequestId])] : current.artifactRequests } } }
      })
      slot.delivery = 'pending'
      if (nextBudget) slot.pendingBudgets = {...(slot.pendingBudgets ?? {}), [assignment.id]: nextBudget}
      slot.ptcAdmission = { id: assignment.id, parent, signal: exec.signal }
      bindingChanged(id)
      if (task.grant) slot.artifactRequests.add(args.artifactRequestId)
      const messageId = await ctx.subagents.followup(parent, id, [{ type: 'text', text: task.text }, ...(nextBudget ? [{type:'text',text:'Host assignment: '+assignment.id}] : [])], {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }, signal: exec.signal,
      })
      exec.signal.throwIfAborted()
      if (durable) await changeBinding(parent, id, current => {
        if (current.state !== 'ready' || current.delivery !== 'pending' ||
            current.lifecycle?.admissions?.at(-1)?.id !== assignment.id ||
            current.lifecycle.admissions.at(-1).state !== 'pending')
          throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
        return { ...current, delivery: 'none', lifecycle: { ...current.lifecycle,
          admissions: current.lifecycle.admissions.map(item => item.id === assignment.id ?
            { ...item, state: 'accepted', messageId: String(messageId) } : item) } }
      })
      slot.delivery = 'none'
      slot.ptcAdmission = null
      bindingChanged(id)
      return { status: interrupt ? 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED' : 'POSTMAN_WORKER_TASK_ACCEPTED',
        workerSessionId: id, label: slot.label, created: false, messageId: String(messageId),
        ...(interrupt ? { interruptRequested: false, mappingPreserved: true } : {}),
        workerType: slot.workerType, model: workerOptions(slot.workerType).model, provider: POSTMAN_WORKER_PROVIDER }
    } catch (error) {
      slot.ptcAdmission = null
      slot.delivery = 'unknown'
      bindingChanged(id)
      if (durable && Object.hasOwn(rowOf(parent.id)?.workers ?? {}, id) &&
          rowOf(parent.id).workers[id].delivery === 'pending') {
        try { await changeBinding(parent, id, current => ({ ...current, delivery: 'unknown' })) } catch {}
      }
      slot.delivery = 'unknown'
      return { status: interrupt ? 'POSTMAN_WORKER_INTERRUPT_DELIVERY_FAILED' : 'POSTMAN_WORKER_FOLLOWUP_FAILED',
        workerSessionId: id, diagnostic: diagnostic(error) }
    } finally { exec.signal.removeEventListener('abort', onAbort) }
  }
  async function create(parent, group, args, exec, workerType = 'luna', freshId = null) {
    const limit = workerType === 'luna' ? 2 : 1
    const limitStatus = workerType === 'sol' ? 'POSTMAN_SOL_WORKER_LIMIT_REACHED' : workerType === 'secretary' ? 'POSTMAN_SECRETARY_LIMIT_REACHED' : 'POSTMAN_WORKER_LIMIT_REACHED'
    const count = workers => Object.values(workers).filter(value => workerTypeOf(value) === workerType &&
      (liveWorker(value.id) || group.slots.get(value.id)?.ptcAdmission || group.slots.get(value.id)?.state === 'intent')).length +
      [...group.fresh].filter(([id,type]) => id !== freshId && type === workerType && !Object.hasOwn(workers,id)).length
    const context = workContext(parent, args)
    let task
    try { task = await taskWithGrant(parent, context, args, workerType) }
    catch (error) { return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED', diagnostic: diagnostic(error) } }
    if (task.status) return task
    if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
    const reservedId = randomUUID()
    const assignment = { id: randomUUID(), state: 'pending', messageId: null, ...(context ? {worktree:context.worktree} : {}) }
    let initialBudget = workerType !== 'sol' ? newBudget(assignment.id, args.task, args.hardBudget ?? fastBudget.hardLimit) : null
    let selectedNode = null
    const label = args.label ?? (workerType === 'sol' ? 'Postman Sol Worker' : workerType === 'secretary' ? 'Secretary' : 'Postman Worker')
    // Reserve an exact child identity durably before the first DSH side effect.
    const admission = await enqueue(group, async () => {
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      if (args.createNew !== true && count(bindings(parent, group))) {
        if (!nodesOwner(parent)) return { selected: select(parent, undefined, group, workerType) }
        const exact = Object.values(bindings(parent, group)).find(b => b.nodesNodeId === args.nodeId && workerTypeOf(b) === workerType)
        if (exact) return { selected: select(parent, exact.id, group, workerType) }
      }
      if (count(bindings(parent, group)) >= limit) return { status: limitStatus }
      try {
        if (nodesOwner(parent)) {
          const service = nativeNodesService()
          if (!service) return { status: 'NODES_SERVICE_UNAVAILABLE' }
          if (typeof args.nodeId !== 'string' || !args.nodeId) return { status: 'NODES_NODE_ID_REQUIRED' }
          selectedNode = service.nodeForNativeWorker(parent, workerType, bindings(parent, group), args.nodesIdle === true, args.nodeId)
          if (selectedNode.status) return { status: selectedNode.status }
        }
        if (durable) await contexts.changeRecord(parent.id, row => {
          if (count(row.workers ?? {}) >= limit) throw new Error(limitStatus)
          if (Object.hasOwn(row.workers ?? {}, reservedId)) throw new Error('POSTMAN_WORKER_BINDING_EXISTS')
          return { ...row, workers: { ...row.workers,
            [reservedId]: { id: reservedId, label, workerType, cwd: context.worktree, ownerSessionId: parent.id, state: 'intent', delivery: 'pending',
              ...(selectedNode ? { nodesRunId: selectedNode.runId, nodesNodeId: selectedNode.nodeId } : {}),
              artifactRequests: task.grant ? [args.artifactRequestId] : [],
              ...(initialBudget ? { budget: initialBudget } : {}),
              lifecycle: { version: 1, admissions: [assignment], reports: [] } } } }
        })
        const slot = slotFor(group, { id: reservedId, label, workerType, state: 'intent', delivery: 'pending' })
        slot.context = context
        if (initialBudget) slot.budget = initialBudget
        if (task.grant) slot.artifactRequests.add(args.artifactRequestId)
        return { slot }
      } catch (error) {
        return { status: String(error).includes(limitStatus) ?
          limitStatus : 'POSTMAN_WORKER_START_FAILED', diagnostic: diagnostic(error) }
      }
    })
    if (admission.selected) {
      if (!admission.selected.binding) return admission.selected
      const selected = slotFor(group, admission.selected.binding)
      return enqueue(selected, () => deliver(parent, selected, args, exec, false, workerType))
    }
    if (!admission.slot) return admission
    const slot = admission.slot
    const exactIntent = () => !durable ||
      (Object.hasOwn(rowOf(parent.id)?.workers ?? {}, reservedId) &&
       rowOf(parent.id).workers[reservedId]?.state === 'intent' &&
       rowOf(parent.id).workers[reservedId]?.label === label &&
       rowOf(parent.id).workers[reservedId]?.lifecycle?.admissions?.[0]?.id === assignment.id)
    return enqueue(slot, async () => {
    let readyBinding
    const onAbort = () => bindingChanged(reservedId)
    if (slot.closed || !authorized(parent) || !exactIntent())
      return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: reservedId,
        diagnostic: slot.closed ? 'NATIVE_SLOT_CLOSED' : !authorized(parent) ?
          ctx.agents.get(parent.id) !== parent ? 'NATIVE_PARENT_NOT_RESIDENT' :
          disposedParents.has(parent) ? 'NATIVE_PARENT_REVOKED' :
          roleOf(parent) !== 'sol' && !isTopLevelPostmanSupervisor(parent) ? 'NATIVE_PARENT_ROLE_LOST' : 'NATIVE_PARENT_SETTLED'
          : 'NATIVE_INTENT_CHANGED' }
    try {
      exec.signal.addEventListener('abort', onAbort, { once: true })
      slot.parent = parent
      slot.ptcAdmission = { id: assignment.id, parent, signal: exec.signal }
      if (selectedNode) await nativeNodesService().nativeChildAccepted(parent, reservedId, selectedNode.nodeId, selectedNode.runId, args.nodesIdle === true)
      const accepted = await ctx.subagents.startContinuable({
        ...buildPostmanWorkerStartRequest(parent, task.text, exec.signal, postmanWorkerDeniedTools(ctx.tools, workerType, scopeParentOf(parent)), label, workerType, selectedNode?.node),
        childId: reservedId,
      })
      exec.signal.throwIfAborted()
      if (String(accepted.childId) !== reservedId) throw new Error('POSTMAN_WORKER_CHILD_ID_MISMATCH')
      if (slot.closed || !authorized(parent) || !exactIntent()) throw new Error('POSTMAN_WORKER_START_STALE')
      if (durable && !await childExists(parent, reservedId, exec.signal))
        throw new Error('POSTMAN_WORKER_CHILD_NOT_VERIFIED')
      if (slot.closed || !authorized(parent) || !exactIntent()) throw new Error('POSTMAN_WORKER_START_STALE')
      if (durable) await changeBinding(parent, reservedId, current => {
        if (current.state !== 'intent' || current.label !== label ||
            current.lifecycle?.admissions?.[0]?.id !== assignment.id)
          throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
        readyBinding = { ...current, state: 'ready', delivery: 'none', lifecycle: { ...current.lifecycle,
          admissions: current.lifecycle.admissions.map(item => item.id === assignment.id ?
            { ...item, state: 'accepted', messageId: String(accepted.messageId) } : item) } }
        return readyBinding
      })
      if (slot.closed || !authorized(parent) ||
          (durable && rowOf(parent.id)?.workers?.[reservedId]?.lifecycle?.admissions?.[0]?.id !== assignment.id))
        throw new Error('POSTMAN_WORKER_START_STALE')
      if (selectedNode) await nativeNodesService().nativeChildAccepted(parent, reservedId, selectedNode.nodeId, selectedNode.runId, args.nodesIdle === true)
      slot.verified = true
      slot.parent = parent
      slot.workerAgent = liveWorker(reservedId) ?? null
      slot.state = 'ready'
      slot.delivery = 'none'
      slot.ptcAdmission = null
      bindingChanged(reservedId)
      return { status: 'POSTMAN_WORKER_TASK_ACCEPTED', workerSessionId: reservedId, label,
        created: true, messageId: String(accepted.messageId), workerType, model: workerOptions(workerType).model,
        provider: POSTMAN_WORKER_PROVIDER }
    } catch (error) {
      slot.ptcAdmission = null
      slot.state = 'uncertain'
      slot.delivery = 'unknown'
      bindingChanged(reservedId)
      // Even if DSH rolled back, do not release a persisted intent without proof.
      // A late completion must never replace a removed or different binding.
      // The selected drain releases only this child's Activation, preserving
      // the Session; failure leaves the original slot uncertain.
      try { await ctx.subagents.drainContinuableChildren(parent, [reservedId]) } catch {}
      if (durable && Object.hasOwn(rowOf(parent.id)?.workers ?? {}, reservedId)) {
        try { await changeBinding(parent, reservedId, current => {
          if (current.label !== label || current.lifecycle?.admissions?.[0]?.id !== assignment.id ||
              !['intent', 'ready'].includes(current.state))
            throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
          return { ...current, state: 'uncertain', delivery: 'unknown' }
        }) } catch {}
      } else if (!durable) { slot.state = 'uncertain'; slot.delivery = 'unknown' }
      bindingChanged(reservedId)
      return { status: durable ? 'POSTMAN_WORKER_BINDING_UNCERTAIN' : 'POSTMAN_WORKER_START_FAILED',
        workerSessionId: reservedId, diagnostic: diagnostic(error) }
    } finally { exec.signal.removeEventListener('abort', onAbort) }
    })
  }
  const parameters = {
    task: { type: 'string', required: true, description: 'Complete autonomous local task.' },
    createNew: { type: 'boolean', description: 'Create a distinct Worker; never follow up an existing one.' },
    workerSessionId: { type: 'string', description: 'Exact existing Worker session for an addressed task or artifact grant.' },
    label: { type: 'string', description: 'Display name, not an authority or lookup key.' },
    nodeId: { type: 'string', description: 'Exact NodesAgent child nodeId (required for a new native child).' },
    artifactRequestId: { type: 'string', description: 'Separately trusted artifact REQ.' },
    cwd: { type: 'string', description: 'Optional absolute working directory; defaults to the current assignment or parent directory. This is a path base, not an access fence.' },
    hardBudget: { type: 'number', description: 'FAST assignment hard model-request budget: integer 8..100, default 60 for substantial work; smaller values for obviously short bounded assignments. Host computes softLimit=floor(0.8*hardBudget); each assignment is independent.' },
  }
  function makeTaskTool(workerType) {
    const sol = workerType === 'sol', secretary = workerType === 'secretary'
    return defineTool({
      name: sol ? POSTMAN_SOL_WORKER_TOOL_NAME : secretary ? 'postman_secretary' : POSTMAN_WORKER_TOOL_NAME,
      description: sol ? 'Create or continue the Sol Worker (GPT-6.1 Sol, xhigh) selected by Leader. Leader decides routing and acceptance under the user task and repository policy. Use workerSessionId for follow-up; technical limits and role tools remain unchanged. Acceptance is not completion.' :
        secretary ? 'Create or continue the exact singleton Secretary for this Leader task. FAST facts and private operational ledger, no PTC/delegation. Acceptance is not completion.' :
        'Create or continue a Postman Worker, up to two per exact parent (Leader or Sol Worker). FAST local execution without PTC/delegation. Acceptance is not completion.',
      parameters: Object.fromEntries(Object.entries(parameters).filter(([name]) =>
        !(secretary && name === 'artifactRequestId') && !(sol && name === 'hardBudget'))), output: output(),
      async execute(args, exec) {
        const parent = exec?.agent
        if (!authorized(parent) || (workerType !== 'luna' && !isTopLevelPostmanSupervisor(parent))) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
        if (secretary && Object.hasOwn(args ?? {}, 'artifactRequestId') || Object.hasOwn(args ?? {}, 'nodesBootstrap')) return { status: 'POSTMAN_WORKER_ARGUMENTS_INVALID' }
        if (budgetArgsInvalid(args) || (sol && args.hardBudget !== undefined)) return { status: 'POSTMAN_WORKER_BUDGET_INVALID' }
        if (typeof args?.task !== 'string' || !args.task.trim()) return { status: 'POSTMAN_WORKER_TASK_INVALID' }
        if ((args.createNew !== undefined && typeof args.createNew !== 'boolean') ||
            (args.workerSessionId !== undefined && (typeof args.workerSessionId !== 'string' || !args.workerSessionId)) ||
            (args.label !== undefined && (typeof args.label !== 'string' || !args.label.trim() || args.label.length > 120)) ||
            (args.nodeId !== undefined && (typeof args.nodeId !== 'string' || !args.nodeId)) ||
            (args.artifactRequestId !== undefined && typeof args.artifactRequestId !== 'string') ||
            (args.createNew === true && args.workerSessionId !== undefined))
          return { status: 'POSTMAN_WORKER_ARGUMENTS_INVALID' }
        return admitted(parent, async () => {
          const group = groupFor(parent)
          if (args.createNew === true) return create(parent, group, args, exec, workerType)
          if (nodesOwner(parent) && !args.nodeId && !args.workerSessionId)
            return { status: 'NODES_NODE_ID_REQUIRED' }
          const chosen = await enqueue(group, () => {
            if (nodesOwner(parent) && args.nodeId && !args.workerSessionId) {
              const exact = Object.values(bindings(parent, group)).find(b =>
                b.nodesNodeId === args.nodeId && workerTypeOf(b) === workerType)
              return exact ? select(parent, exact.id, group, workerType) : { status: 'NODES_NODE_ABSENT' }
            }
            return select(parent, args.workerSessionId, group, workerType)
          })
          if (!chosen.binding) {
            if (args.workerSessionId !== undefined || chosen.status === 'POSTMAN_WORKER_TARGET_REQUIRED') return chosen
            return create(parent, group, args, exec, workerType)
          }
          if (nodesOwner(parent) && args.nodeId && chosen.binding.nodesNodeId !== args.nodeId)
            return { status: 'NODES_NODE_ID_MISMATCH' }
          const slot = slotFor(group, chosen.binding)
          return enqueue(slot, () => deliver(parent, slot, args, exec, false, workerType))
        })
      },
    })
  }
  const taskTool = makeTaskTool('luna')
  const solTaskTool = makeTaskTool('sol')
  const secretaryTool = makeTaskTool('secretary')
  function groupFor(parent) { return group(parent) }
  const interruptTool = defineTool({
    name: POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
    description: 'Queue a follow-up for the selected continuable Worker without interrupting its current model/tool step.',
    parameters: { workerSessionId: { type: 'string' }, task: parameters.task, hardBudget: parameters.hardBudget }, output: output(),
    async execute(args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      if (budgetArgsInvalid(args)) return { status: 'POSTMAN_WORKER_BUDGET_INVALID' }
      if (typeof args?.task !== 'string' || !args.task.trim()) return { status: 'POSTMAN_WORKER_TASK_INVALID' }
      if (args.workerSessionId !== undefined && (typeof args.workerSessionId !== 'string' || !args.workerSessionId))
        return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
      return admitted(parent, async () => {
        const group = groupFor(parent)
        const chosen = await enqueue(group, () => select(parent, args.workerSessionId, group))
        if (!chosen.binding) return chosen
        const slot = slotFor(group, chosen.binding)
        return enqueue(slot, () => deliver(parent, slot, args, exec, true))
      })
    },
  })
  // Compare only this Worker: unrelated peer activity must not invalidate approval.
  function cancelWitness(binding) {
    return JSON.stringify({ id: binding.id, state: binding.state,
      admissions: binding.lifecycle?.admissions ?? null, delivery: binding.delivery,
      artifactRequests: binding.artifactRequests, stop: binding.lifecycle?.stop ?? null })
  }
  async function verifyIdentity(parent, id, signal) {
    const entries = await ctx.subagents.listChildren(parent.id, signal)
    const matches = entries.filter(entry => entry.id === id)
    return matches.length === 1 && matches[0].kind === 'child' && matches[0].mode === 'continuable'
  }
  async function closeEvidence(parent, binding, signal) {
    const child = await history(binding.id, parent.id, signal)
    return { ready: child?.status === 'idle' && child.inbox?.hasPending === false,
      reason: 'Worker has active or queued work; use addressed cancel',
      resultReported: (binding.lifecycle?.reports?.length ?? 0) > 0,
      eventCount: child?.session.events.length }
  }
  const stopTool = defineTool({
    name: POSTMAN_WORKER_STOP_TOOL_NAME,
    description: 'Stop only the selected owned Worker. No rollback, Git cleanup, or task-success claim; peers are unaffected.',
    parameters: {
      mode: { type: 'string', enum: ['close', 'cancel'] },
      workerSessionId: { type: 'string', description: 'Exact Worker ID; mandatory for cancel.' },
      reason: { type: 'string', description: 'Explanation, never authorization.' },
      cascade: { type: 'boolean', description: 'Exact Leader-owned Sol only; retire its exact direct ordinary Workers before Sol.' },
    }, output: output(),
    execute: (args, exec) => stopWorker(args, exec),
  })
  async function stopWorker(args, exec, hostOwned = false, slotLocked = false) {
      const parent = exec?.agent
      if (!hostOwned && !authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      const id = args?.workerSessionId, mode = args?.mode ?? (id ? 'cancel' : 'close')
      if (mode !== 'close' && mode !== 'cancel') return { status: 'POSTMAN_WORKER_STOP_MODE_INVALID' }
      if (id !== undefined && (typeof id !== 'string' || !id)) return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
      if (mode === 'cancel' && !id) return { status:'POSTMAN_WORKER_TARGET_REQUIRED' }
      const g = groupFor(parent)
      const chosen = await enqueue(g, () => select(parent, id, g))
      if (!chosen.binding) {
        if (id && g.stopped.has(id)) return { status: 'POSTMAN_WORKER_ALREADY_STOPPED', workerSessionId: id }
        return chosen
      }
      const selected = chosen.binding, slot = slotFor(g, selected)
      if (args.cascade === true) {
        if (!isTopLevelPostmanSupervisor(parent) || workerTypeOf(selected) !== 'sol')
          return { status: 'POSTMAN_WORKER_CASCADE_TARGET_REJECTED', workerSessionId: selected.id }
        return cascadeStop(parent, selected, slot, mode, exec)
      }
      if (workerTypeOf(selected) === 'sol' && Object.values(rawRow(parent.id)?.workers ?? {}).some(value => value.ownerSessionId === selected.id))
        return {status: 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT', workerSessionId: selected.id, reason: 'Sol must retire its own Worker bindings first'}
      let witness
      if (mode === 'cancel') {
        if (!durable) return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: id }
        try {
          if (!await verifyIdentity(parent, id, exec.signal))
            return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: id }
        } catch { return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: id } }
        witness = cancelWitness(selected)
      }

      // Per-Worker queue prevents a selected admission between validation and drain.
      // No Leader-wide queue is held while a human or model runs.
      const stop = async () => {
        if (slot.closed || (!hostOwned && !authorized(parent))) return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
        const current = bindings(parent, g)[selected.id]
        if (!current || current.id !== selected.id || !matchesContext(parent, slot, true))
          return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: selected.id }
        if (mode === 'cancel' && cancelWitness(current) !== witness)
          return { status:'POSTMAN_WORKER_BINDING_CHANGED', workerSessionId:selected.id }
        try {
          const evidence = mode === 'close' ? await closeEvidence(parent, current, exec.signal) : null
          if (mode === 'close') {
            if (!evidence.ready) return { status: 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT',
              workerSessionId: selected.id, reason: evidence.reason + '; request addressed cancel for active or uncertain work' }
          }
          if (!await verifyIdentity(parent, selected.id, exec.signal))
            return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: selected.id }
          if (typeof ctx.subagents.closeContinuableChild !== 'function')
            return { status: 'POSTMAN_WORKER_LIFECYCLE_UNSUPPORTED', workerSessionId: selected.id,
              diagnostic: { code: 'EXACT_CHILD_ADMISSION_CUTOFF_UNAVAILABLE' } }
          const latest = bindings(parent, g)[selected.id]
          if (!latest || latest.id !== selected.id ||
              (mode === 'cancel' && cancelWitness(latest) !== witness))
            return { status: mode === 'cancel' ? 'POSTMAN_WORKER_BINDING_CHANGED' :
              'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT', workerSessionId: selected.id }
          if (mode === 'close') {
            // Verification and admission cutoff share the native exact-child lock.
            // An ordinary native followup is not serialized by the Postman slot queue.
            const closed = await ctx.subagents.closeContinuableChild(parent, selected.id, async () => {
              const snapshot = bindings(parent, g)[selected.id]
              if (!snapshot || snapshot.id !== selected.id || !matchesContext(parent, slot, true)) return false
              const fresh = await closeEvidence(parent, snapshot, exec.signal)
              if (!fresh.ready) return false
              if (durable) await changeBinding(parent, selected.id, entry => {
                if (entry.id !== selected.id)
                  throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
                return { ...entry, state: 'stopping', lifecycle: stopIntent(entry, mode) }
              })
              slot.state = 'stopping'
              bindingChanged(selected.id)
              return true
            })
            if (!closed) return { status: 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT',
              workerSessionId: selected.id }
          } else {
            // Cancellation must close native admission too; drain alone allows a
            // later cold followup to resurrect the released child.
            const closed = await ctx.subagents.closeContinuableChild(parent, selected.id, async () => {
              if (durable) await changeBinding(parent, selected.id, entry => {
                if (cancelWitness(entry) !== witness) throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
                return { ...entry, state: 'stopping', lifecycle: stopIntent(entry, mode) }
              })
              slot.state = 'stopping'
              bindingChanged(selected.id)
              return true
            })
            if (!closed) throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
          }
          if (ctx.agents.get(selected.id)) throw new Error('POSTMAN_WORKER_RESIDENT_NOT_SETTLED')
          await removeBinding(parent, g, slot, selected.id)
          return { status: mode === 'cancel' ? 'POSTMAN_WORKER_CANCELLED' : 'POSTMAN_WORKER_STOPPED',
            workerSessionId: selected.id, residentReleased: true, mappingRemoved: true,
            durableSessionDeleted: false, taskCompleted: false, resultReported: mode === 'close' && evidence.resultReported === true }
        } catch (error) {
          if (durable && rowOf(parent.id)?.workers?.[selected.id]?.state === 'stopping')
            try { await changeBinding(parent, selected.id, entry => ({ ...entry, state: 'uncertain' })) } catch {}
          slot.state = 'uncertain'
          bindingChanged(selected.id)
          return { status: 'POSTMAN_WORKER_STOP_FAILED', workerSessionId: selected.id,
            outcome: 'unknown', diagnostic: diagnostic(error) }
        }
      }
      return admitted(parent, () => slotLocked ? stop() : enqueue(slot, stop), true)
  }
  async function cascadeStop(parent, selected, slot, mode, exec) {
    return admitted(parent, () => enqueue(slot, async () => {
      const current = rowOf(parent.id)?.workers?.[selected.id]
      if (!current || cancelWitness(current) !== cancelWitness(selected))
        return { status: 'POSTMAN_WORKER_BINDING_CHANGED', workerSessionId: selected.id }
      let sol = ctx.agents.get(selected.id), hostHandle
      if (!sol) {
        const saved = await history(selected.id, parent.id, exec.signal)
        const descriptor = saved && foldSubagentDescriptor(saved.session.events)
        if (!saved || descriptor?.mode !== 'continuable' || typeof ctx.agents.resume !== 'function' ||
            saved.session.events.some(event => event.type === 'subagent/closed'))
          return { status: 'POSTMAN_WORKER_CASCADE_BLOCKED', workerSessionId: selected.id,
            blockers: [{ workerSessionId: selected.id, reason: 'exact cold Sol activation unavailable' }] }
        try {
          hostHandle = await ctx.agents.resume({ resumeSessionId: selected.id, agentOptions: { ...POSTMAN_SOL_WORKER_AGENT_OPTIONS },
            signal: exec.signal, setup: childCtx => applyChildComposition(childCtx, parent, { persona: descriptor.persona, toolFilter: descriptor.toolFilter }) })
          sol = hostHandle.agent
          if (ctx.agents.get(sol.id) !== sol || sol.id !== selected.id || sol.session.header.origin !== 'subagent' ||
              sol.session.header.parentSession !== parent.id || sol.session.header.delegationDepth !== depthOf(parent.id))
            throw new Error('exact resumed Sol identity/setup unavailable')
        } catch (error) {
          await hostHandle?.dispose()
          return { status: 'POSTMAN_WORKER_CASCADE_BLOCKED', workerSessionId: selected.id,
            blockers: [{ workerSessionId: selected.id, reason: diagnostic(error) }] }
        }
      }
      try {
      const children = Object.entries(rawRow(parent.id)?.workers ?? {}).filter(([, b]) => b.ownerSessionId === selected.id)
      const blockers = []
      for (const [id, binding] of children) {
        try {
          if (binding.id !== id || workerTypeOf(binding) !== 'luna' || !await verifyIdentity(sol, id, exec.signal))
            blockers.push({ workerSessionId: id, reason: 'exact ordinary child identity unavailable' })
          else if (mode === 'close') {
            const evidence = await closeEvidence(sol, binding, exec.signal)
            if (!evidence.ready) blockers.push({ workerSessionId: id, reason: evidence.reason })
          }
        } catch (error) { blockers.push({ workerSessionId: id, reason: diagnostic(error) }) }
      }
      try {
        if (!await verifyIdentity(parent, selected.id, exec.signal))
          blockers.push({ workerSessionId: selected.id, reason: 'Sol identity unavailable' })
        else if (mode === 'close') {
          const evidence = await closeEvidence(parent, current, exec.signal, true)
          if (!evidence.ready) blockers.push({ workerSessionId: selected.id, reason: evidence.reason })
        }
      } catch (error) { blockers.push({ workerSessionId: selected.id, reason: diagnostic(error) }) }
      if (blockers.length) return { status: 'POSTMAN_WORKER_CASCADE_BLOCKED', workerSessionId: selected.id, blockers }
      if (typeof ctx.subagents.closeContinuableChild !== 'function')
        return { status: 'POSTMAN_WORKER_LIFECYCLE_UNSUPPORTED', workerSessionId: selected.id, diagnostic: { code: 'EXACT_CHILD_ADMISSION_CUTOFF_UNAVAILABLE' } }
      const results = []
      try {
      // Revoke Sol admissions while the Host retires children. Ownership is never reassigned.
      await changeBinding(parent, selected.id, entry => {
        if (entry !== current) throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
        return { ...entry, state: 'stopping', lifecycle: stopIntent(entry, mode, children.map(([id]) => id)) }
      })
      slot.state = 'stopping'
      bindingChanged(selected.id)
      for (const [id] of children) {
        const result = await stopWorker({ workerSessionId: id, mode }, { ...exec, agent: sol }, true)
        results.push(result)
        if (!['POSTMAN_WORKER_STOPPED', 'POSTMAN_WORKER_CANCELLED'].includes(result.status)) break
      }
      const remaining = Object.values(rawRow(parent.id)?.workers ?? {}).filter(b => b.ownerSessionId === selected.id)
      if (remaining.length || results.some(r => !['POSTMAN_WORKER_STOPPED', 'POSTMAN_WORKER_CANCELLED'].includes(r.status))) {
        await changeBinding(parent, selected.id, entry => ({ ...entry, state: 'uncertain' }))
        bindingChanged(selected.id)
        return { status: 'POSTMAN_WORKER_CASCADE_PARTIAL', workerSessionId: selected.id, results,
          blockers: remaining.map(b => ({ workerSessionId: b.id, reason: 'not retired' })), taskCompleted: false }
      }
      await changeBinding(parent, selected.id, entry => ({ ...entry, state: 'ready' }))
      slot.state = 'ready'
      // Direct Host resume is not manager-owned: release its idle handle before durable Sol closure.
      if (hostHandle) { await hostHandle.dispose(); hostHandle = null }
      const result = await stopWorker({ workerSessionId: selected.id, mode }, exec, false, true)
      return { ...result, cascade: true, results, ...(results.length && !['POSTMAN_WORKER_STOPPED', 'POSTMAN_WORKER_CANCELLED'].includes(result.status)
        ? { status: 'POSTMAN_WORKER_CASCADE_PARTIAL' } : {}) }
      } catch (error) {
        try { await changeBinding(parent, selected.id, entry => ({ ...entry, state: 'uncertain' })) } catch {}
        bindingChanged(selected.id)
        return { status: 'POSTMAN_WORKER_CASCADE_PARTIAL', workerSessionId: selected.id, results,
          outcome: 'unknown', taskCompleted: false, diagnostic: diagnostic(error) }
      }
      } finally { await hostHandle?.dispose() }
    }), true)
  }
  const listTool = defineTool({
    name: POSTMAN_WORKER_LIST_TOOL_NAME,
    description: 'Read exact Leader Worker bindings, residency, durable closure and quota without resuming children.',
    parameters: {}, output: output(),
    async execute(_args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      // Only exceptional uncertain/stopping bindings need exact reconciliation.
      // Ordinary snapshot performs no recovery loop or model activation.
      const values = Object.values(bindings(parent, groupFor(parent)))
      let children
      try { children = await ctx.subagents.listChildren(parent.id, exec.signal) } catch { children = null }
      const workers = await Promise.all(values.map(async value => {
        const entries = children?.filter(entry => entry.id === value.id)
        const child = entries?.length === 1 ? entries[0] : null
        const live = liveWorker(value.id)
        let runtime = 'unknown'
        if (live?.session?.header?.parentSession === parent.id && live.session.header.origin === 'subagent')
          runtime = live.status === 'running' ? 'resident-running' : live.status === 'idle' ? 'resident-idle' : 'unknown'
        else if (entries?.length > 1 || child?.kind === 'diagnostic') runtime = 'corrupt/diagnostic'
        else if (child?.kind === 'child' && child.mode === 'continuable')
          runtime = child.activity === 'inactive' ? 'cold-continuable' : 'unknown'
        else if (children && !child) runtime = 'unavailable'
        let saved
        try { saved = await ctx.get?.('sessionPersistence')?.inspect?.(value.id, exec.signal) } catch {}
        const exactSaved = saved?.meta?.id === value.id && saved.meta.origin === 'subagent' &&
          saved.meta.parentSession === parent.id && saved.meta.delegationDepth === depthOf(parent.id) &&
          Array.isArray(saved.events) && child?.kind === 'child' && child.mode === 'continuable'
        if (exactSaved && saved.events.some(event => event.type === 'subagent/closed'))
          runtime = live ? 'corrupt/diagnostic' : 'durable-closed'
        const exactLive = live?.session?.header?.id === value.id && live.session.header.origin === 'subagent' &&
          live.session.header.parentSession === parent.id && live.session.header.delegationDepth === depthOf(parent.id)
        const events = exactLive ? live.session.events : exactSaved ? saved.events : null
        const latestStart = events?.findLast(event => event.type === 'turn/start')
        const latestEnd = events?.findLast(event => event.type === 'turn/end')
        const turn = !latestStart ? 'unknown' : latestEnd?.data?.turn === latestStart.data?.turn
          ? 'settled' : !latestEnd || events.indexOf(latestEnd) < events.indexOf(latestStart) ? 'open' : 'unknown'
        const reports = value.lifecycle?.reports
        const report = !Array.isArray(reports) || !parent.session?.events ? 'unknown'
          : reports.some(item => parent.session.events.some(event => event.type === 'user/message' &&
            event.data?.id === item.messageId && event.data?.source?.kind === 'subagent-report' &&
            event.data.source.senderSessionId === value.id)) ? 'delivered' : 'absent'
        return { workerSessionId: value.id, label: value.label, workerType: workerTypeOf(value),
          model: workerOptions(workerTypeOf(value)).model, binding: value.state,
          delivery: value.delivery, runtime, execution: runtime, turn, report,
          countsAgainstLimit: Boolean(live || groupFor(parent).slots.get(value.id)?.ptcAdmission || groupFor(parent).slots.get(value.id)?.state === 'intent'),
          ...(workerTypeOf(value) !== 'sol' ? { budget: value.budget ?? null, pendingBudgets: Object.values(value.pendingBudgets ?? {}) } : {}) }
      }))
      return { status: 'POSTMAN_WORKER_LIST', quota: {
        secretary: { used: workers.filter(value => value.countsAgainstLimit && value.workerType === 'secretary').length, limit: isTopLevelPostmanSupervisor(parent) ? 1 : 0 },
        luna: { used: workers.filter(value => value.countsAgainstLimit && value.workerType === 'luna').length, limit: 2 },
        sol: { used: workers.filter(value => value.countsAgainstLimit && value.workerType === 'sol').length, limit: isTopLevelPostmanSupervisor(parent) ? 1 : 0 },
      }, workers }
    },
  })
  const ledgerTool = defineTool({
    name: 'postman_secretary_ledger',
    description: 'Read the exact Leader/task private durable operational ledger; only its Secretary may replace it. Never writes repository files.',
    parameters: { content: { type: 'string', description: 'Compact whole ledger; omit to read. Facts, decisions, assignments, verification with inputs, blockers, questions, next step.' },
      revision: { type: 'number', description: 'Exact read revision for replacement.' } }, output: output(),
    async execute(args, exec) {
      const agent = exec.agent, secretary = roleOf(agent) === 'secretary'
      if (!isTopLevelPostmanSupervisor(agent) && !secretary) return { status: 'POSTMAN_SECRETARY_LEDGER_CALLER_REJECTED' }
      const id = secretary ? agent.session.header.parentSession : agent.id
      if (!durable || typeof taskContexts?.readLedger !== 'function' ||
          typeof taskContexts?.changeLedger !== 'function')
        return { status: 'POSTMAN_SECRETARY_LEDGER_UNAVAILABLE' }
      if (args.content !== undefined) {
        if (!secretary) return { status: 'POSTMAN_SECRETARY_LEDGER_CALLER_REJECTED' }
        if (typeof args.content !== 'string' || args.content.length > 16000) return { status: 'POSTMAN_SECRETARY_LEDGER_INVALID' }
        try { await taskContexts.changeLedger(id, old => {
          if (old.revision !== args.revision) throw Error('POSTMAN_SECRETARY_LEDGER_STALE')
          return { revision: old.revision + 1, content: args.content, updatedBy: agent.id }
        }) } catch (error) { return { status: 'POSTMAN_SECRETARY_LEDGER_UPDATE_FAILED', diagnostic: diagnostic(error) } }
      }
      return { status: 'POSTMAN_SECRETARY_LEDGER', ledger: taskContexts.readLedger(id) }
    },
  })
  const freshTool = defineTool({
    name: 'postman_worker_fresh',
    description: 'Cancel and retire an exact owned child, then spawn a fresh role-preserving Session for an explicit new assignment after native closure. No history inheritance or Git reset; Secretary ledger survives. Approved-plan routing is preserved; fresh is not approval for a new independent outcome or material change.',
    parameters: { workerSessionId: { type: 'string', required: true }, task: { type: 'string', required: true }, hardBudget: parameters.hardBudget, label: { type: 'string' }, retireOwnedWorkers: { type: 'boolean' } }, output: output(),
    async execute(args, exec) {
      const parent = exec.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      if (budgetArgsInvalid(args)) return { status: 'POSTMAN_WORKER_BUDGET_INVALID' }
      if (typeof args.task !== 'string' || !args.task.trim()) return { status: 'POSTMAN_WORKER_TASK_INVALID' }
      const g = groupFor(parent), id = args.workerSessionId
      const chosen = await enqueue(g, () => {
        let selected = select(parent, id, g)
        if (!selected.binding && typeof id === 'string') {
          const retired = rawRow(parent.id)?.retiredWorkers?.findLast(b => b.id === id && (b.ownerSessionId ?? parent.id) === parent.id)
          if (retired) selected = { binding: retired }
        }
        if (!selected.binding) return selected
        if (g.fresh.has(id)) return {status: 'POSTMAN_WORKER_FRESH_BUSY'}
        g.fresh.set(id, workerTypeOf(selected.binding)); return selected
      })
      if (!chosen.binding) return chosen
      try { return await admitted(parent, async () => {
          if (chosen.binding.retired) {
            if (!await provenClosed(parent, id) || ctx.agents.get(id) || Object.values(rawRow(parent.id)?.workers ?? {}).some(b => b.ownerSessionId === id))
              return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: id }
          } else {
            const closed = await stopTool.execute({workerSessionId: id, mode: 'cancel', cascade: args.retireOwnedWorkers === true}, exec)
            if (!['POSTMAN_WORKER_STOPPED', 'POSTMAN_WORKER_CANCELLED'].includes(closed.status)) return closed
          }
          const accepted = await create(parent, g, {...args, workerSessionId: undefined, label: args.label ?? chosen.binding.label, createNew: true}, exec, workerTypeOf(chosen.binding), id)
          return {...accepted, retiredWorkerSessionId: id, fresh: accepted.status === 'POSTMAN_WORKER_TASK_ACCEPTED'}
      }) } finally {g.fresh.delete(id)}
    },
  })
  const compactTool = defineTool({
    name: POSTMAN_WORKER_COMPACT_TOOL_NAME,
    description: 'Compact the exact idle Worker using native compaction, including non-resident sessions without a historical report; keep its Session, binding and budget without a Worker turn.',
    parameters: { workerSessionId: { type: 'string', required: true } }, output: output(),
    async execute(args, exec) {
      const parent = exec?.agent, id = args?.workerSessionId
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      if (typeof id !== 'string' || !id) return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
      const g = groupFor(parent), selected = select(parent, id, g)
      if (!selected.binding) return selected
      const slot = slotFor(g, selected.binding)
      return admitted(parent, () => enqueue(slot, async () => {
        const binding = bindings(parent, g)[id]
        if (binding.id !== selected.binding.id || binding.lifecycle?.stop ||
            !matchesContext(parent, slot)) return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
        const child = liveWorker(id), saved = await history(id, parent.id, exec.signal)
        if (!saved || saved.status !== 'idle' || saved.inbox?.hasPending !== false)
          return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
        if (!child) {
          try {
            if (!durable || !await verifyIdentity(parent, id, exec.signal))
              return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
            if (typeof ctx.subagents.compactContinuableChild !== 'function')
              return { status: 'POSTMAN_WORKER_LIFECYCLE_UNSUPPORTED', workerSessionId: id }
            const compacted = await ctx.subagents.compactContinuableChild(parent, id, async agent => {
              const current = bindings(parent, g)[id]
              return authorized(parent) && current === binding && matchesContext(parent, slot) &&
                agent.id === id && agent.status === 'idle' && agent.inbox?.hasPending === false &&
                agent.session?.header?.origin === 'subagent' && agent.session.header.parentSession === parent.id &&
                agent.session.header.delegationDepth === depthOf(parent.id)
            }, exec.signal)
            if (!compacted) return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
            return { status: 'POSTMAN_WORKER_COMPACTED', workerSessionId: id,
              compacted: compacted.result !== null, sameSession: true }
          } catch (error) { return { status: 'POSTMAN_WORKER_COMPACT_FAILED', workerSessionId: id, diagnostic: diagnostic(error) } }
        }
        if (child.session?.header?.parentSession !== parent.id ||
            child.session.header.origin !== 'subagent' || child.session.header.delegationDepth !== depthOf(parent.id))
          return { status: 'POSTMAN_WORKER_COMPACT_NOT_RESIDENT', workerSessionId: id }
        const compaction = child.ctx?.get?.('compaction') ?? ctx.agentPresets?.serviceFor(child, 'compaction')
        if (child.status !== 'idle' || child.inbox?.hasPending !== false ||
            typeof compaction?.compactNow !== 'function')
          return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
        try {
          // Native compactNow reserves Agent.runMaintenance synchronously before
          // any await, so accepted followups cannot run inside the compacted span.
          const compacted = await compaction.compactNow(child, exec.signal)
          return { status: 'POSTMAN_WORKER_COMPACTED', workerSessionId: id,
            compacted: compacted !== null, sameSession: true }
        } catch (error) { return { status: 'POSTMAN_WORKER_COMPACT_FAILED', workerSessionId: id, diagnostic: diagnostic(error) } }
      }))
    },
  })
  function liveSlot(caller, leaderId, requireActivation = false) {
    if (disposed || typeof caller?.id !== 'string' || ctx.agents.get(caller.id) !== caller ||
        caller.session?.header?.origin !== 'subagent' || caller.session.header.delegationDepth !== depthOf(leaderId) ||
        caller.session.header.parentSession !== leaderId || !authorized(ctx.agents.get(leaderId))) return null
    const slot = leaders.get(leaderId)?.slots.get(caller.id)
    if (!slot || slot.closed || !slot.verified || slot.parent !== ctx.agents.get(leaderId) ||
        slot.state !== 'ready' ||
        (durable && (!Object.hasOwn(rowOf(leaderId)?.workers ?? {}, caller.id) ||
          rowOf(leaderId).workers[caller.id]?.id !== caller.id ||
          rowOf(leaderId).workers[caller.id].state !== 'ready'))) return null
    return !requireActivation || slot.workerAgent === caller ? slot : null
  }
  function appOwnerOf(caller) {
    const parent = ctx.agents.get(caller?.session?.header?.parentSession)
    const slot = liveSlot(caller, parent?.id, true)
    const assignment = budgetOf(caller)
    return slot && workerTypeOf(slot) === 'luna' && isTopLevelPostmanSupervisor(parent) &&
      typeof assignment?.assignmentId === 'string'
      ? { owner: parent, context: slot.context, assignmentId: assignment.assignmentId } : null
  }
  function ownerOf(caller, requestId) {
    const leaderId = caller?.session?.header?.parentSession
    const slot = liveSlot(caller, leaderId)
    return slot?.artifactRequests.has(requestId) ? leaderId : null
  }
  function releaseActivation(caller) {
    const slot = leaders.get(caller?.session?.header?.parentSession)?.slots.get(caller?.id)
    if (!slot || slot.workerAgent !== caller) return false
    slot.workerAgent = null
    slot.ptcAdmission = null
    bindingChanged(caller.id)
    return true
  }
  // Only the Host's current durable pending admission can authorize the creation window.
  // The slot is the existing lifecycle record, not a second child registry.
  function provisionalSlot(caller, requirePtcLeader = false) {
    const header = caller?.session?.header, leaderId = header?.parentSession
    const parent = ctx.agents.get(leaderId), slot = leaders.get(leaderId)?.slots.get(caller?.id)
    const admission = slot?.ptcAdmission, binding = rowOf(leaderId)?.workers?.[caller?.id]
    const latest = binding?.lifecycle?.admissions?.at(-1)
    if (!authorized(parent) || (requirePtcLeader && !isTopLevelPostmanPtcLeader(parent)) ||
        ctx.agents.get(caller?.id) !== caller || (header?.id !== undefined && header.id !== caller.id) || header?.origin !== 'subagent' || header.delegationDepth !== depthOf(leaderId) ||
        !slot || slot.closed || slot.parent !== parent || admission?.parent !== parent || admission.signal?.aborted ||
        (slot.workerAgent !== null && slot.workerAgent !== caller) ||
        !['intent', 'ready'].includes(slot.state) || slot.delivery !== 'pending' ||
        (durable && (binding?.id !== caller.id || binding.state !== slot.state || binding.delivery !== 'pending' ||
        latest?.id !== admission.id || latest.state !== 'pending'))) return null
    return slot
  }
  function roleOf(caller) {
    const slot = provisionalSlot(caller, false) || liveSlot(caller, caller?.session?.header?.parentSession)
    return slot?.workerType ?? null
  }
  const stopBudgetGuard = ctx.tools.guard?.(exec => {
    const type = roleOf(exec.agent)
    if (type === 'secretary' && !SECRETARY_TOOLS.includes(exec.name) &&
        !(nodesOwner(exec.agent) && POSTMAN_NODES_TOOL_NAMES.includes(exec.name))) return 'POSTMAN_SECRETARY_TOOL_REJECTED'
    if (type && (DELEGATION_TOOLS.includes(exec.name) || (type !== 'sol' && exec.name === 'ptc_execute') ||
      (exec.name.startsWith('postman_') && !(type === 'sol' && WORKER_CONTROL_TOOLS.includes(exec.name)) &&
      !(type === 'luna' && exec.name === 'postman_app') &&
      !(type === 'secretary' && exec.name === 'postman_secretary_ledger')))) return 'POSTMAN_WORKER_TOOL_REJECTED'
    const budget = budgetOf(exec.agent)
    if (!budget) return
    if (budget.reported) return 'POSTMAN_WORKER_ASSIGNMENT_REPORTED: wait for a new parent assignment'
    if (!budget.exhausted) return
    if (!['notify_parent', 'report'].includes(exec.name)) return 'POSTMAN_WORKER_BUDGET_EXHAUSTED: escalation/report only'

  })
  const stopReportConclusion = ctx.on?.('tools/execute', async (exec, next) => {
    // Sol may report PARTIAL/BLOCKED while owned work is unresolved. Delivery
    // does not settle children, remove their bindings or certify a PASS.
    const result = await next()
    if (exec.name === 'report' && roleOf(exec.agent) && !result.isError && typeof result.value?.messageId === 'string') {
      exec.concludeTurn?.()
      return { ...result, concludesTurn: true }
    }
    return result
  })
  const stopBudgetResult = ctx.on?.('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const slot = activeSlot(exec.agent), budget = budgetOf(exec.agent)
    if (decision.kind === 'accept' && !result.isError && slot && budget &&
        ((exec.name === 'notify_parent' && result.value?.status === 'PARENT_NOTIFICATION_ACCEPTED') ||
         (exec.name === 'report' && typeof result.value?.messageId === 'string')))
      { await saveBudget(exec.agent, slot, { ...budget, ...(exec.name === 'report' ? { reported: true } : { notified: true }) })
        if (exec.name === 'report') exec.concludeTurn?.()
      }
    return decision
  })
  // Request #hardLimit is escalation-only. If the model ignores it, no ordinary
  // model cycle is granted: finish through the same native notify/report paths.
  const reportBudgetBlocker = async (agent, budget, turn, step, signal) => {
    const text = blockerText(agent, budget)
    if (!budget.notified) await ctx.tools.execute({agent,name:'notify_parent',arguments:{message:text},callId:budget.assignmentId+':budget-notify',signal})
    const callId = budget.assignmentId + ':budget-report'
    // The real native report and durable exhausted/reported budget are Host
    // evidence, never a synthetic model tool pair or a manufactured turn/end.
    await ctx.tools.execute({agent,name:'report',arguments:{output:text},callId,signal})
  }
  const stopBudgetTerminal = ctx.on?.('agent/turn-stopping', async ({agent,turn,signal}) => {
    const budget = budgetOf(agent)
    if (budget?.exhausted && !budget.reported) await reportBudgetBlocker(agent,budget,turn,
      agent.session.events.findLast(e=>e.type==='step/start')?.data.step ?? 1,signal)
  })
  const stopBudgetStep = ctx.on?.('agent/pre-step', async (payload, next) => {
    const agent = payload.agent
    // agent/created listeners are non-blocking. An exact Nodes cold Session must
    // finish the existing durable activation check before its first model step.
    if (nativeNodesService()?.configForSession(agent.id) && !ownsLiveWorker(agent)) await confirmActivation(agent)
    const slot = activeSlot(agent)
    const binding = rowOf(agent?.session?.header?.parentSession)?.workers?.[agent?.id]
    const pending = binding?.pendingBudgets ?? slot?.pendingBudgets ?? {}
    const claimed = Object.keys(pending).findLast(id => payload.messages.some(message =>
      message.content?.some(block => block.type === 'text' && block.text === 'Host assignment: ' + id)))
    if (claimed && slot && slot.workerType !== 'sol') {
      slot.budget = pending[claimed];const remaining = {...pending};delete remaining[claimed];slot.pendingBudgets = remaining
      if (durable) await changeBinding({id: agent.session.header.parentSession},agent.id,current => ({...current,budget:slot.budget,pendingBudgets:remaining}))
    }
    const decision = await next(), budget = budgetOf(agent)
    if (decision.kind === 'reject' || !slot || !budget) return decision
    if (budget.reported) {
      const reportTurn = agent.session.events.findLast(e => e.type === 'tool/call' && e.data.name === 'report')?.data.turn
      if (reportTurn !== payload.turn) return {kind: 'reject', messages: []}
      if (agent.inbox.nextTurn.length === 0 && decision.messages.length) agent.inbox.splice('next-step', 0, 0, decision.messages)
      return {kind: 'enter', messages: []}
    }
    if (!budget.exhausted && budget.used < budget.hardLimit) return decision
    await reportBudgetBlocker(agent, budget, payload.turn, payload.step - 1, payload.signal)
    return { kind: 'reject', reason: 'POSTMAN_WORKER_BUDGET_EXHAUSTED' }
  })
  const stopRoleInstruction = ctx.get?.('systemPrompt')?.section({
    name: 'postman-role', order: 120,
    text: ({ scope } = {}) => {
      const type = roleOf(scope)
      if (!type) return ''
      const budget = budgetOf(scope)
      const warning = budget && budget.used >= budget.hardLimit - 1
        ? 'HARD CEILING: this assignment is escalation-only. No ordinary searches/tests/edits/retries. ONE NEEDS_PARENT_GUIDANCE: notify_parent and meaningful blocker report, then stop. Exhaustion is not success.'
        : budget && budget.used >= budget.softLimit - 1 ? 'SOFT WARNING: budget nearly exhausted. Do not start a new research branch. Finish immediately with sufficient evidence or prepare escalation.' : ''
      const ledger = type === 'secretary' ? taskContexts?.readLedger?.(scope.session.header.parentSession) ?? rawRow(scope.session.header.parentSession)?.secretaryLedger : null
      return ROLE_SKILLS[type] + (warning ? String.fromCharCode(10) + warning : '') +
        (ledger ? String.fromCharCode(10) + 'Current Host-private operational ledger: ' + JSON.stringify(ledger) : '')
    },
  })
  const directRoleTools = caller => {
    const tools = caller.ctx?.tools
    if (tools?.modeFor && tools.modeFor(caller) !== 'native') tools.presentAs('native')
  }
  async function confirmActivation(caller) {
    const provisional = provisionalSlot(caller, false)
    if (provisional) {
      provisional.workerAgent = caller
      directRoleTools(caller)
      bindingChanged(caller.id) // Synchronous: before the first model request is assembled.
      return true
    }
    const leaderId = caller?.session?.header?.parentSession
    let slot = leaders.get(leaderId)?.slots.get(caller?.id)
    if (!slot && authorized(ctx.agents.get(leaderId))) {
      const binding = rowOf(leaderId)?.workers?.[caller?.id]
      if (!binding || binding.lifecycle?.stop) return false
      slot = slotFor(groupFor(ctx.agents.get(leaderId)), binding)
      slot.context ??= workContext(ctx.agents.get(leaderId), {}, slot)
      if (await reconcile(ctx.agents.get(leaderId), slot)) return false
    }
    if (!slot || slot.workerAgent !== null || !liveSlot(caller, leaderId)) return false
    // A saved session ID alone is insufficient: reconcile the actual durable child.
    try { if (!await childExists(ctx.agents.get(leaderId), caller.id)) return false } catch { return false }
    if (slot.workerAgent !== null || !liveSlot(caller, leaderId)) return false
    slot.workerAgent = caller
    directRoleTools(caller)
    bindingChanged(caller.id)
    return true
  }
  function ownsNotification(caller, leaderId) {
    if (caller?.session?.header?.parentSession !== leaderId) return false
    return Boolean(provisionalSlot(caller, false) || liveSlot(caller, leaderId))
  }
  // The same exact live-slot predicate serves PTC; a saved child ID is never authority.
  function ownsLiveWorker(caller) {
    return Boolean(provisionalSlot(caller, false) || liveSlot(caller, caller?.session?.header?.parentSession, true))
  }
  function ptcContextOf(caller) {
    const slot = provisionalSlot(caller, false) || liveSlot(caller, caller?.session?.header?.parentSession, true)
    const binding = durable ? rowOf(caller?.session?.header?.parentSession)?.workers?.[caller?.id] : slot
    return slot?.workerType === 'sol' && binding && workerTypeOf(binding) === 'sol' ? slot.context : null
  }
  function suspendLeader(parent) {
    if (parent) disposedParents.add(parent)
    for (const slot of leaders.get(parent?.id)?.slots.values() ?? []) { slot.verified = false; slot.workerAgent = null; slot.ptcAdmission = null }
    refreshLeader(parent?.id)
  }
  function refreshLeader(leaderId) {
    for (const id of leaders.get(leaderId)?.slots.keys() ?? []) bindingChanged(id)
  }
  function contextOf(leaderId, childId) {
    const slot = leaders.get(leaderId)?.slots.get(childId)
    return slot && !slot.closed && slot.state === 'ready' &&
      (!durable || (Object.hasOwn(rowOf(leaderId)?.workers ?? {}, childId) &&
        rowOf(leaderId).workers[childId]?.id === childId &&
        rowOf(leaderId).workers[childId].state === 'ready')) ? slot.context : null
  }
  async function removeBinding(parent, g, slot, id, expected = null, expectedContext = null) {
    if (durable) await contexts.changeRecord(parent.id, row => {
      if (expected ? cancelWitness(row.workers?.[id] ?? {}) !== expected : row.workers?.[id]?.state !== 'stopping')
        throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
      const workers = { ...row.workers }; delete workers[id]
      return { ...row, workers, retiredWorkers: [...(row.retiredWorkers ?? []), { ...row.workers[id], retired: true }] }
    })
    slot.closed = true; g.slots.delete(id); g.stopped.add(id)
  }
  // Called only by native settlement after disposal. Reports remain semantic
  // evidence; the native terminal is separate lifecycle authority. Be conservative:
  // new output, failure, input/work, missing identity or unseen report always wakes.
  function canDeferSettlement(parent, child, terminal) {
    if (!authorized(parent) || terminal?.stopReason !== 'completed' || child?.session?.header?.parentSession !== parent.id) return false
    if (nodesOwner(parent) && nativeNodesService()?.configForSession(child.id) &&
        !child.session.events.some(e => e.type === 'llm/request')) return true
    const output = terminal.output
    if (!Array.isArray(output) || output.length !== 1 || output[0].type !== 'tool-call' || output[0].name !== 'report') return false
    return (rowOf(parent.id)?.workers?.[child.id]?.lifecycle?.reports ?? []).some(report => report.callId === output[0].id)
  }
  function teamSnapshot(leader) {
    if (!isTopLevelPostmanSupervisor(leader) || !authorized(leader)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
    const row = taskContexts?.record?.(leader.id) ?? {}
    const budget = b => b?.budget ? { used: b.budget.used, soft: b.budget.softLimit,
      hard: b.budget.hardLimit, exhausted: b.budget.exhausted === true } : null
    const summary = ([id, b]) => {
      const live = ctx.agents.get(id), owner = b.ownerSessionId ?? row.leaderSessionId ?? leader.id
      const exact = b.id === id && (!live || (live.session?.header?.origin === 'subagent' && live.session.header.parentSession === owner))
      const state = !exact ? 'unknown' : b.state !== 'ready' || b.delivery !== 'none' ? b.state === 'ready' ? 'uncertain' : b.state
        : live ? live.inbox?.hasPending ? 'pending' : live.status ?? 'unknown' : 'not-resident'
      return { sessionId: id, label: String(b.label ?? '').slice(0, 160), state, budget: budget(b) }
    }
    const direct = Object.entries(row.workers ?? {}).filter(([, b]) => (b.ownerSessionId ?? row.leaderSessionId ?? leader.id) === leader.id)
    const ordinary = direct.filter(([, b]) => workerTypeOf(b) === 'luna')
    const secretary = direct.find(([, b]) => workerTypeOf(b) === 'secretary')
    const sol = direct.find(([, b]) => workerTypeOf(b) === 'sol')
    const children = sol ? Object.entries(row.workers ?? {}).filter(([, b]) => b.ownerSessionId === sol[0]) : []
    const states = {}, totals = { used: 0, soft: 0, hard: 0, exhausted: 0, unknown: 0 }
    for (const entry of children) {
      const child = summary(entry); states[child.state] = (states[child.state] ?? 0) + 1
      if (!child.budget) totals.unknown++
      else { totals.used += child.budget.used; totals.soft += child.budget.soft; totals.hard += child.budget.hard; totals.exhausted += Number(child.budget.exhausted) }
    }
    return { status: 'POSTMAN_TEAM_STATUS',
      secretary: { present: Boolean(secretary), ...(secretary ? summary(secretary) : { sessionId: null, state: 'absent', budget: null }), ledgerRevision: taskContexts?.readLedger?.(leader.id)?.revision ?? row.secretaryLedger?.revision ?? 0 },
      workers: { used: ordinary.length, limit: 2, rows: ordinary.slice(0, 2).map(summary) },
      sol: { present: Boolean(sol), ...(sol ? summary(sol) : { sessionId: null, state: 'absent' }),
        ownedWorkers: { used: children.length, limit: 2, states, budget: totals } } }
  }
  async function deliverNodesMessage(sender, targetSessionId, parentSessionId, runId, text, signal) {
    let parent = ctx.agents.get(parentSessionId), hostHandle
    if (!parent) {
      const service = nativeNodesService(), run = service?.getRun(runId)
      const root = run && ctx.agents.get(run.rootSessionId)
      const saved = root && await history(parentSessionId, root.id, signal)
      const descriptor = saved && foldSubagentDescriptor(saved.session.events)
      if (!root || !descriptor || descriptor.mode !== 'continuable' ||
          saved.session.events.some(e => e.type === 'subagent/closed')) throw Error('NODES_NATIVE_PARENT_UNAVAILABLE')
      hostHandle = await ctx.agents.resume({ resumeSessionId: parentSessionId, signal,
        agentOptions: { provider: descriptor.agentProvider, model: descriptor.agentModel },
        setup: childCtx => { applyChildComposition(childCtx, root, descriptor) } })
      parent = hostHandle.agent
    }
    try {
    if (!authorized(parent)) throw Error('NODES_NATIVE_PARENT_UNAVAILABLE')
    const binding = rowOf(parent.id)?.workers?.[targetSessionId]
    if (!binding || binding.id !== targetSessionId || binding.nodesRunId !== runId ||
        binding.state !== 'ready' || binding.lifecycle?.stop)
      throw Error('NODES_NATIVE_BINDING_REJECTED')
    const slot = slotFor(groupFor(parent), binding)
    return await enqueue(slot, async () => {
      const current = rowOf(parent.id)?.workers?.[targetSessionId]
      if (slot.closed || !current || current.nodesRunId !== runId || current.state !== 'ready' ||
          current.lifecycle?.stop || !nativeNodesService()?.runForAgent(sender) ||
          nativeNodesService().getRun(runId)?.status !== 'RUNNING')
        throw Error('NODES_NATIVE_DELIVERY_REVOKED')
      const source = { kind: 'coordinator', form: 'relay', senderSessionId: sender.id }
      const resumed = resumedNodes.get(targetSessionId)
      if (resumed) {
        // An explicitly resumed, idle node is owned by this Host handle,
        // not by the subagent manager's Activation table. Native followup
        // would try to cold-resume that already-live exact Session again.
        const recipient = ctx.agents.get(targetSessionId)
        if (resumed.agent !== recipient || recipient?.session?.header?.parentSession !== parent.id)
          throw Error('NODES_NATIVE_RECOVERY_UNPROVEN')
        signal?.throwIfAborted()
        const message = createUserMessage({ content: [{ type: 'text', text }], source })
        recipient.followup(message)
        return message.id
      }
      return ctx.subagents.followup(parent, targetSessionId,
        [{ type: 'text', text }], { signal, source })
    })
    } finally { await hostHandle?.dispose() }
  }
  // Node actions reuse the durable native child and its original parent. No
  // closeContinuableChild is used here: suspension must preserve history.
  const resumedNodes = new Map()
  async function nativeNodeAction(requester, runId, nodeId, action, signal = new AbortController().signal, user = false) {
    const service = nativeNodesService(), run = service?.getRun(runId)
    const leader = run && ctx.agents.get(run.rootSessionId)
    const node = run?.definition.agents.find(a => a.id === nodeId)
    if (!service || !run || run.status !== 'RUNNING' || !leader ||
        !isTopLevelPostmanNodesLeader(leader) || !node || node.slot === 'entry' ||
        !['activate', 'finish', 'interrupt'].includes(action))
      return { status: 'NODES_NATIVE_ACTION_REJECTED' }
    if (user ? requester !== leader : !authorized(requester))
      return { status: 'NODES_NATIVE_OWNER_REJECTED' }
    const owner = run.definition.agents.find(a => a.slot === (node.slot.startsWith('sol-worker') ? 'sol' : 'entry'))
    if (!owner) return { status: 'NODES_NATIVE_PARENT_UNAVAILABLE' }
    if (!user && run.bindings[owner.id]?.sessionId !== requester.id)
      return { status: 'NODES_NATIVE_OWNER_REJECTED' }
    return service.locked('node-action:' + runId + ':' + nodeId, async () => {
      let fresh = service.getRun(runId)
      const bound = fresh?.bindings[nodeId]
      if (fresh?.status !== 'RUNNING') return { status: 'NODES_RUN_NOT_RUNNING' }
      let parent = ctx.agents.get(fresh.bindings[owner.id]?.sessionId), borrowed = null
      // A Sol spawned by the native continuable owner can settle between two
      // asynchronous child-admission stages. Release its idle Activation, then
      // hold an explicit Host-owned resume handle through the exact operation.
      if (parent && owner.slot === 'sol' && user) {
        const descendants = fresh.definition.agents.filter(a => a.slot.startsWith('sol-worker') &&
          fresh.bindings[a.id] && ctx.agents.get(fresh.bindings[a.id].sessionId))
        if (parent.status !== 'idle' || parent.inbox?.hasPending)
          return { status: 'NODES_NATIVE_PARENT_BUSY', nodeId }
        if (!descendants.length) {
          await ctx.subagents.drainContinuableChildren(leader, [parent.id])
          if (ctx.agents.get(parent.id)) return { status: 'NODES_NATIVE_PARENT_RELEASE_UNPROVEN', nodeId }
          parent = null
        }
      }
      // A selected Sol-owned child must not silently activate its potential
      // parent. Activating Sol is a separate explicit owner/user action.
      if (!parent && owner.slot === 'sol' && !fresh.bindings[owner.id])
        return { status: 'NODES_NATIVE_PARENT_UNAVAILABLE', nodeId }
      if (!parent && owner.slot === 'sol' && fresh.bindings[owner.id]) {
        // Resume the exact cold parent only to perform this addressed child operation.
        const rootBinding = fresh.bindings[owner.id]
        const saved = await history(rootBinding.sessionId, leader.id, signal)
        const descriptor = saved && foldSubagentDescriptor(saved.session.events)
        if (!saved || descriptor?.mode !== 'continuable' ||
            saved.session.events.some(event => event.type === 'subagent/closed'))
          return { status: 'NODES_NATIVE_PARENT_UNAVAILABLE' }
        try {
          borrowed = await ctx.agents.resume({ resumeSessionId: rootBinding.sessionId,
            agentOptions: { ...POSTMAN_SOL_WORKER_AGENT_OPTIONS }, signal,
            setup: childCtx => applyChildComposition(childCtx, leader, descriptor) })
          parent = borrowed.agent
        } catch (error) {
          await borrowed?.dispose()
          return { status: 'NODES_NATIVE_PARENT_UNAVAILABLE', diagnostic: diagnostic(error) }
        }
      }
      try {
        if (!parent || !authorized(parent) ||
            fresh.bindings[owner.id]?.sessionId !== parent.id ||
            (owner.slot === 'sol' && parent.session.header.parentSession !== leader.id))
          return { status: 'NODES_NATIVE_PARENT_UNAVAILABLE' }
        const ownerBindings = bindings(parent, groupFor(parent))
        const workerType = node.slot === 'secretary' ? 'secretary' : node.slot === 'sol' ? 'sol' : 'luna'
        if (action === 'activate') {
          if (bound) {
            if (bound.parentSessionId !== parent.id) return { status: 'NODES_BINDING_UNCERTAIN' }
            const binding = ownerBindings[bound.sessionId]
            if (!binding || binding.nodesRunId !== runId || binding.nodesNodeId !== nodeId ||
                binding.lifecycle?.stop || !await childExists(parent, bound.sessionId, signal))
              return { status: 'NODES_BINDING_UNCERTAIN' }
            const live = liveWorker(bound.sessionId)
            if (live) {
              if (live.session.header.parentSession !== parent.id) return { status: 'NODES_BINDING_UNCERTAIN' }
              await service.nativeChildState(runId, nodeId, bound.sessionId, 'READY')
              return { status: 'NODES_NODE_ACTIVE', nodeId, workerSessionId: bound.sessionId, reused: true }
            }
            const saved = await history(bound.sessionId, parent.id, signal)
            const descriptor = saved && foldSubagentDescriptor(saved.session.events)
            if (!saved || descriptor?.mode !== 'continuable' ||
                saved.session.events.some(event => event.type === 'subagent/closed'))
              return { status: 'NODES_SESSION_RECOVERY_UNPROVEN' }
            try {
              const handle = await ctx.agents.resume({ resumeSessionId: bound.sessionId,
                agentOptions: { provider: descriptor.agentProvider, model: descriptor.agentModel },
                signal, setup: childCtx => applyChildComposition(childCtx, parent, descriptor) })
              if (handle.agent.id !== bound.sessionId || ctx.agents.get(bound.sessionId) !== handle.agent ||
                  handle.agent.session.header.parentSession !== parent.id)
                throw Error('NODES_SESSION_IDENTITY_CHANGED')
              resumedNodes.set(bound.sessionId, handle)
              await service.nativeChildState(runId, nodeId, bound.sessionId,
                ctx.agents.get(bound.sessionId) ? 'READY' : 'SUSPENDED')
              return { status: 'NODES_NODE_ACTIVE', nodeId, workerSessionId: bound.sessionId, reused: true }
            } catch (error) {
              return { status: 'NODES_SESSION_RECOVERY_FAILED', diagnostic: diagnostic(error) }
            }
          }
          const next = service.nodeForNativeWorker(parent, workerType, ownerBindings, true, nodeId)
          if (next.status) return { status: next.status }
          const accepted = await admitted(parent, () => create(parent, groupFor(parent), {
            task: 'Initialize your native Postman role. Await a direct assignment; do not invoke the model.',
            label: node.displayName, createNew: true, nodesIdle: true, nodeId,
          }, { agent: parent, signal }, workerType))
          if (accepted.status !== 'POSTMAN_WORKER_TASK_ACCEPTED' || !accepted.workerSessionId)
            return { status: accepted.status || 'NODES_NATIVE_ACTIVATION_FAILED', diagnostic: accepted.diagnostic }
          await ctx.agents.get(accepted.workerSessionId)?.whenIdle()
          await service.nativeChildState(runId, nodeId, accepted.workerSessionId,
            ctx.agents.get(accepted.workerSessionId) ? 'READY' : 'SUSPENDED')
          return { status: 'NODES_NODE_ACTIVE', nodeId, workerSessionId: accepted.workerSessionId, reused: false }
        }
        if (!bound) return { status: 'NODES_NODE_POTENTIAL', nodeId }
        if (bound.parentSessionId !== parent.id) return { status: 'NODES_BINDING_UNCERTAIN' }
        const binding = ownerBindings[bound.sessionId]
        if (!binding || binding.nodesRunId !== runId || binding.nodesNodeId !== nodeId ||
            binding.lifecycle?.stop || !await childExists(parent, bound.sessionId, signal))
          return { status: 'NODES_BINDING_UNCERTAIN' }
        let cascadeHandle = null
        try {
          if (node.slot === 'sol') {
            const children = fresh.definition.agents.filter(a => a.slot.startsWith('sol-worker') && fresh.bindings[a.id])
            for (const descendant of children) {
              // After one descendant settles the SDK may naturally release
              // its idle Sol parent. Acquire the same persisted Sol again for
              // the next child, never a new Session or a new model assignment.
              let solOwner = ctx.agents.get(bound.sessionId)
              if (!solOwner && !cascadeHandle) {
                const saved = await history(bound.sessionId, parent.id, signal)
                const descriptor = saved && foldSubagentDescriptor(saved.session.events)
                if (!saved || descriptor?.mode !== 'continuable' ||
                    saved.session.events.some(event => event.type === 'subagent/closed'))
                  return { status: 'NODES_SOL_CASCADE_UNPROVEN', nodeId }
                cascadeHandle = await ctx.agents.resume({ resumeSessionId: bound.sessionId,
                  agentOptions: { provider: descriptor.agentProvider, model: descriptor.agentModel }, signal,
                  setup: childCtx => applyChildComposition(childCtx, parent, descriptor) })
                solOwner = cascadeHandle.agent
              }
              if (!solOwner || solOwner.id !== bound.sessionId ||
                  solOwner.session?.header?.parentSession !== parent.id)
                return { status: 'NODES_SOL_CASCADE_UNPROVEN', nodeId }
              // Cold resumes publish before the asynchronous role callback.
              if (!authorized(solOwner)) await confirmActivation(solOwner)
              if (!authorized(solOwner)) return { status: 'NODES_SOL_CASCADE_UNPROVEN', nodeId }
              const result = await nativeNodeAction(solOwner, runId, descendant.id, action, signal, false)
              if (!['NODES_NODE_SUSPENDED', 'NODES_NODE_ALREADY_COLD'].includes(result.status))
                return { status: 'NODES_SOL_CASCADE_BLOCKED', childNodeId: descendant.id, result }
            }
          }
        } finally { await cascadeHandle?.dispose() }
        const child = liveWorker(bound.sessionId)
        if (!child) {
          if (bound.state === 'SUSPENDED') return { status: 'NODES_NODE_ALREADY_COLD', nodeId, workerSessionId: bound.sessionId }
          return { status: 'NODES_NODE_COLD_UNKNOWN', nodeId }
        }
        const slot = slotFor(groupFor(parent), binding)
        return enqueue(slot, async () => {
          if (action === 'finish' && child.status !== 'idle') await child.whenIdle()
          const proof = await closeEvidence(parent, binding, signal)
          if (action === 'finish' && !proof.ready)
            return { status: 'NODES_NODE_BUSY', nodeId, reason: proof.reason }
          if (typeof ctx.subagents.drainContinuableChildren !== 'function')
            return { status: 'NODES_RELEASE_UNSUPPORTED', nodeId }
          // Native SDK owns a freshly spawned child's Activation; the Host
          // owns the explicit resume handle of a previously cold Session.
          // Release the actual owner, without closing durable admission.
          const resumed = resumedNodes.get(bound.sessionId)
          if (resumed) {
            if (resumed.agent !== child) return { status: 'NODES_RELEASE_UNPROVEN', nodeId }
            await resumed.dispose()
          } else {
            await ctx.subagents.drainContinuableChildren(parent, [bound.sessionId])
          }
          if (ctx.agents.get(bound.sessionId))
            return { status: 'NODES_RELEASE_UNPROVEN', nodeId }
          resumedNodes.delete(bound.sessionId)
          await service.nativeChildState(runId, nodeId, bound.sessionId, 'SUSPENDED')
          return { status: 'NODES_NODE_SUSPENDED', nodeId, workerSessionId: bound.sessionId,
            durableSessionDeleted: false }
        })
      } catch (error) {
        return { status: 'NODES_NATIVE_ACTION_UNKNOWN', nodeId, diagnostic: diagnostic(error) }
      } finally { await borrowed?.dispose() }
    })
  }
  async function startNodesTeam(leader, runId) {
    if (!isTopLevelPostmanNodesLeader(leader) || !authorized(leader))
      return { status: 'NODES_NATIVE_CALLER_REJECTED' }
    const run = nativeNodesService()?.getRun(runId)
    if (!run || run.rootSessionId !== leader.id || run.status !== 'RUNNING' ||
        Object.keys(run.bindings).length !== 1)
      return { status: 'NODES_NATIVE_RUN_REJECTED' }
    // The Entry Session already exists; all native children remain potential.
    return { status: 'NODES_NATIVE_READY' }
  }
  function dispose() {
    disposed = true
    stopRequestOptions?.()
    stopRoleInstruction?.()
    stopBudgetGuard?.(); stopBudgetResult?.(); stopBudgetStep?.(); stopReportConclusion?.(); stopBudgetTerminal?.()
    for (const group of leaders.values()) for (const slot of group.slots.values()) {
      slot.closed = true
      bindingChanged(slot.id)
    }
    leaders.clear()
  }
  return { taskTool, solTaskTool, secretaryTool, ledgerTool, freshTool, interruptTool, stopTool, listTool, compactTool, roleOf, ownerOf, appOwnerOf, ownsNotification, ownsLiveWorker, ptcContextOf, confirmActivation, releaseActivation, refreshLeader, suspendLeader,
    contextOf, observeReport, teamSnapshot, canDeferSettlement, startNodesTeam, nativeNodeAction, deliverNodesMessage, dispose }
}
