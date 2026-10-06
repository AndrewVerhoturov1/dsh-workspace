import { defineTool } from '@deepseek-ai/dsh-tools'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { applyChildComposition, foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import { workerEvidence } from './postman-worker-evidence.js'
import {
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_SOL_WORKER_TOOL_NAME,
  POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  POSTMAN_WORKER_LIST_TOOL_NAME,
  POSTMAN_WORKER_COMPACT_TOOL_NAME,
  isTopLevelPostmanSupervisor,
  isTopLevelPostmanPtcLeader,
  WORKER_CONTROL_TOOLS, DELEGATION_TOOLS, SECRETARY_TOOLS,
} from './postman-bridge-core.js'

export const POSTMAN_WORKER_PROVIDER = 'spawn'
// Codex metadata: minimal=null (unsupported); off omits reasoning on the wire.
// low is the lowest explicit supported reasoning effort, not the provider default.
export const FAST_WORKER_MODEL = 'gpt-6-luna'
export const FAST_WORKER_REASONING = 'low'
export const POSTMAN_WORKER_AGENT_OPTIONS = Object.freeze({ provider: 'codex', model: FAST_WORKER_MODEL, reasoningEffort: FAST_WORKER_REASONING })
export const FAST_WORKER_BUDGET = Object.freeze({ softLimit: 12, hardLimit: 15 })
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
    !(type === 'sol' && WORKER_CONTROL_TOOLS.includes(name)) && !(type === 'secretary' && name === 'postman_secretary_ledger')),
    ...tools.schemas(scope).map(tool => tool.name).filter(name => DELEGATION_TOOLS.includes(name) || (type === 'luna' && ['ask_user_question', 'list_agents', 'exit_plan_mode'].includes(name)) || (type !== 'sol' && name === 'ptc_execute') || (type === 'secretary' && name === 'implementation_artifact_apply'))])]
}

export function buildPostmanWorkerStartRequest(parent, task, signal, deniedTools, label = 'Postman Worker', workerType = 'luna') {
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
      agentOptions: { ...workerOptions(workerType) },
      persona: 'You are ' + (workerType === 'sol' ? 'Postman Sol Worker' : workerType === 'secretary' ? 'Secretary' : 'Postman Worker') + '. Follow the Host-injected canonical role skill.',
      maxDepth: workerType === 'sol' ? 2 : (parent.session?.header?.delegationDepth ?? 0) + 1,
      // Only deny host Postman transport/control tools. The shared preset's
      // coding tools and child-scoped report remain available.
      toolFilter: { deny: [...deniedTools] },
    },
  }
}


// One short Leader admission queue reserves membership; every child has its own
// delivery queue. Neither queue is held until a model turn finishes.
export function createPostmanWorkerTools(ctx, grants, contexts, { onBindingChange = () => {}, localDevelopment = false, fastBudget = FAST_WORKER_BUDGET } = {}) {
  if (!Number.isSafeInteger(fastBudget.softLimit) || fastBudget.softLimit < 1 ||
      !Number.isSafeInteger(fastBudget.hardLimit) || fastBudget.hardLimit <= fastBudget.softLimit)
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
  if (taskContexts) contexts = { ...taskContexts, get: contextAt,
    record: taskContexts.record ? id => { const row = rawRow(id); return row ? { ...row, workers: owned(row, id) } : null } : undefined,
    changeRecord: taskContexts.changeRecord ? changeScoped : undefined,
    ...Object.fromEntries(['isRestoring', 'hasActiveOperation', 'hasSyncOperation', 'beginWorkerAdmission', 'endWorkerAdmission'].filter(name => typeof taskContexts[name] === 'function').map(name =>
      [name, (id, ...args) => taskContexts[name](rootId(id), ...args)])) }
  const depthOf = id => (ctx.agents.get(id)?.session?.header?.delegationDepth ?? (rootId(id) !== id ? 1 : 0)) + 1
  const leaders = new Map()
  const disposedParents = new WeakSet()
  const bindingChanged = id => onBindingChange(id)
  let disposed = false
  const durable = typeof contexts?.record === 'function' && typeof contexts?.changeRecord === 'function'
  const rowOf = id => durable ? contexts.record(id) : null
  const liveWorker = id => ctx.agents.get(id)
  const emptyLifecycle = () => ({ version: 1, admissions: [], reports: [] })
  const newBudget = (assignmentId, task) => ({ assignmentId, task, used: 0, ...fastBudget, exhausted: false, notified: false, reported: false })
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
    return binding?.budget ?? slot.budget ?? { ...newBudget(binding?.lifecycle?.admissions?.at(-1)?.id ?? 'legacy:' + agent.id,
      'Legacy assignment: return bounded facts or parent guidance'), used: agent.session.events.filter(e => e.type === 'step/start').length }
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
      if (budget && !budget.reported) await saveBudget(agent, slot, { ...budget, used: budget.used + 1,
        exhausted: budget.used + 1 >= budget.hardLimit })
    }
    const options = slot && workerOptions(slot.workerType)
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
        artifactRequests: new Set(), lifecycle: binding.lifecycle, budget: binding.budget, context: null, parent: null, workerAgent: null, closed: false, tail: Promise.resolve() }
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
    const context = contexts?.get(parent.id)
    return !contexts || Boolean(context && (!slot.context || slot.context === context))
  }
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
    if (!durable) return slot.state === 'uncertain' ? 'POSTMAN_WORKER_BINDING_UNCERTAIN' :
      slot.delivery === 'unknown' ? 'POSTMAN_WORKER_DELIVERY_UNKNOWN' : null
    const workers = rowOf(parent.id)?.workers ?? {}
    const saved = Object.hasOwn(workers, slot.id) ? workers[slot.id] : null
    if (!saved || saved.id !== slot.id || slot.closed) return 'POSTMAN_WORKER_TARGET_UNKNOWN'
    if (saved.state === 'stopping' || saved.state === 'uncertain') {
      if (slot.parent !== parent) slot.verified = false
      if (!authorized(parent) || !matchesContext(parent, slot)) return 'POSTMAN_WORKER_BINDING_UNCERTAIN'
      const expectedContext = contexts.get(parent.id)
      if (await provenClosed(parent, slot.id)) {
        const current = rowOf(parent.id)?.workers?.[slot.id]
        if (authorized(parent) && contexts.get(parent.id) === expectedContext &&
            current?.id === slot.id && cancelWitness(current) === cancelWitness(saved) &&
            (current.state === 'stopping' || current.state === 'uncertain')) {
          await removeBinding(parent, groupFor(parent), slot, slot.id, cancelWitness(current), expectedContext)
          bindingChanged(slot.id)
          return 'POSTMAN_WORKER_CLOSED_RECONCILED'
        }
      }
      bindingChanged(slot.id)
      return 'POSTMAN_WORKER_BINDING_UNCERTAIN'
    }
    if (slot.parent !== parent) slot.verified = false
    if (!slot.verified) {
      try {
        if (!await childExists(parent, slot.id, signal)) return 'POSTMAN_WORKER_BINDING_UNCERTAIN'
        if (saved.state === 'intent') {
          await changeBinding(parent, slot.id, current => {
            if (current.state !== 'intent') throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
            return { ...current, state: 'ready', delivery: 'unknown' }
          })
        }
        slot.verified = true
      } catch { return 'POSTMAN_WORKER_BINDING_UNCERTAIN' }
    }
    const currentWorkers = rowOf(parent.id)?.workers ?? {}
    const current = Object.hasOwn(currentWorkers, slot.id) ? currentWorkers[slot.id] : null
    if (!current || current.id !== slot.id || current.state !== 'ready') return 'POSTMAN_WORKER_BINDING_UNCERTAIN'
    slot.state = 'ready'
    slot.parent = parent
    slot.workerAgent = liveWorker(slot.id) ?? null
    bindingChanged(slot.id)
    slot.label = current.label
    slot.delivery = current.delivery
    return current.delivery === 'none' ? null : 'POSTMAN_WORKER_DELIVERY_UNKNOWN'
  }
  const busy = id => contexts?.isRestoring?.(id) || contexts?.hasActiveOperation?.(id) ||
    contexts?.hasSyncOperation?.(id)
  async function admitted(parent, action) {
    if (contexts?.beginWorkerAdmission) {
      const token = Symbol('worker operation')
      if (!contexts.beginWorkerAdmission(parent.id, token)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      try { return await action() } finally { contexts.endWorkerAdmission(parent.id, token) }
    }
    return action()
  }
  async function reconcileClosedBindings(parent, group) {
    if (!durable || !contexts?.get(parent.id)) return
    for (const binding of Object.values(bindings(parent, group))) {
      if (!['stopping', 'uncertain'].includes(binding.state)) continue
      const slot = slotFor(group, binding)
      try { await enqueue(slot, () => reconcile(parent, slot)) } catch { /* A read/write failure is not closure proof. */ }
    }
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
  function taskText(context, text) {
    return context ? 'Use the existing task branch ' + context.branch + ' and worktree ' +
      context.worktree + ' for repository changes; do not create another branch or worktree. Follow REPO_POLICY.md. ' +
      'Coordinate shared files and Git operations with your immediate parent; avoid overlapping changes. Assigned task: ' + text : text
  }
  async function taskWithGrant(parent, context, args) {
    let text = taskText(context, args.task)
    if (args.artifactRequestId === undefined) return { text }
    if (!isTopLevelPostmanSupervisor(parent)) return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED' }
    const grant = await grants?.resolve(parent.id, args.artifactRequestId)
    if (grant?.repository !== IMPLEMENTATION_REPOSITORY)
      return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED' }
    text = 'Trusted Host artifact REQ: ' + grant.requestId + '. ZIP path from task text is never authority. ' +
      'Follow REPO_POLICY.md and system/implementation-package-workflow.md. ' +
      (context ? 'Use the existing task branch ' + context.branch + ' and worktree ' + context.worktree +
        '; do not create another branch/worktree. Ensure it is clean at the published REQ commit. ' +
        'Call implementation_artifact_apply({requestId: ' + JSON.stringify(grant.requestId) +
        ', worktree: ' + JSON.stringify(context.worktree) + '}); ' :
        'Call implementation_artifact_apply only with the exact Host-bound task worktree; never choose a path from model text. ') +
      'The Host supplies its trusted ZIP. A central runner PASS authoritatively verifies declared manifest.tests; ' +
      'do not manually rerun identical tests unless relevant inputs change. ' +
      'On runner FAIL do not repair package; report evidence. ' + args.task
    return { text, grant }
  }
  async function deliver(parent, slot, args, exec, interrupt, workerType = 'luna') {
    if (slot.workerType !== workerType) return { status: slot.workerType === 'sol' ?
      'POSTMAN_SOL_WORKER_TOOL_REQUIRED' : 'POSTMAN_WORKER_TYPE_MISMATCH', workerSessionId: slot.id }
    if (slot.closed || !authorized(parent)) return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
    if (busy(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
    const context = contexts?.get(parent.id) ?? null
    if (!matchesContext(parent, slot)) return { status: 'POSTMAN_TASK_CONTEXT_MISMATCH' }
    slot.context = context
    const recovered = await reconcile(parent, slot, exec.signal)
    if (recovered) return { status: recovered, workerSessionId: slot.id }
    let task
    try { task = await taskWithGrant(parent, context, args) }
    catch (error) { return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED', diagnostic: diagnostic(error) } }
    if (task.status) return task
    const id = slot.id
    const onAbort = () => bindingChanged(id)
    exec.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const assignment = { id: randomUUID(), state: 'pending', messageId: null }
      const nextBudget = slot.workerType !== 'sol' ? newBudget(assignment.id, args.task) : null
      if (durable) await changeBinding(parent, id, current => {
        if (current.state !== 'ready' || current.delivery !== 'none')
          throw new Error('POSTMAN_WORKER_DELIVERY_UNKNOWN')
        return { ...current, ...(nextBudget ? {pendingBudgets: {...(current.pendingBudgets ?? {}), [assignment.id]: nextBudget}} : {}), delivery: 'pending', lifecycle: { ...(current.lifecycle ?? emptyLifecycle()),
          admissions: [...(current.lifecycle?.admissions ?? []), assignment] }, artifactRequests: task.grant ?
          [...new Set([...current.artifactRequests, args.artifactRequestId])] : current.artifactRequests }
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
    const count = workers => Object.values(workers).filter(value => workerTypeOf(value) === workerType).length +
      [...group.fresh].filter(([id,type]) => id !== freshId && type === workerType && !Object.hasOwn(workers,id)).length
    const context = contexts?.get(parent.id) ?? null
    if (contexts && !context) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    let task
    try { task = await taskWithGrant(parent, context, args) }
    catch (error) { return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED', diagnostic: diagnostic(error) } }
    if (task.status) return task
    if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
    const reservedId = randomUUID()
    const assignment = { id: randomUUID(), state: 'pending', messageId: null }
    const label = args.label ?? (workerType === 'sol' ? 'Postman Sol Worker' : workerType === 'secretary' ? 'Secretary' : 'Postman Worker')
    // Reserve an exact child identity durably before the first DSH side effect.
    const admission = await enqueue(group, async () => {
      if (busy(parent.id) || !authorized(parent)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      if (args.createNew !== true && count(bindings(parent, group)))
        return { selected: select(parent, undefined, group, workerType) }
      if (count(bindings(parent, group)) >= limit) return { status: limitStatus }
      try {
        if (durable) await contexts.changeRecord(parent.id, row => {
          if (count(row.workers ?? {}) >= limit) throw new Error(limitStatus)
          if (Object.hasOwn(row.workers ?? {}, reservedId)) throw new Error('POSTMAN_WORKER_BINDING_EXISTS')
          return { ...row, workers: { ...row.workers,
            [reservedId]: { id: reservedId, label, workerType, ownerSessionId: parent.id, state: 'intent', delivery: 'pending',
              artifactRequests: task.grant ? [args.artifactRequestId] : [],
              ...(workerType !== 'sol' ? { budget: newBudget(assignment.id, args.task) } : {}),
              lifecycle: { version: 1, admissions: [assignment], reports: [] } } } }
        })
        const slot = slotFor(group, { id: reservedId, label, workerType, state: 'intent', delivery: 'pending' })
        slot.context = context
        if (workerType !== 'sol') slot.budget = newBudget(assignment.id, args.task)
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
      return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: reservedId }
    try {
      exec.signal.addEventListener('abort', onAbort, { once: true })
      slot.parent = parent
      slot.ptcAdmission = { id: assignment.id, parent, signal: exec.signal }
      const accepted = await ctx.subagents.startContinuable({
        ...buildPostmanWorkerStartRequest(parent, task.text, exec.signal, postmanWorkerDeniedTools(ctx.tools, workerType, scopeParentOf(parent)), label, workerType),
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
    artifactRequestId: { type: 'string', description: 'Separately trusted artifact REQ.' },
  }
  function makeTaskTool(workerType) {
    const sol = workerType === 'sol', secretary = workerType === 'secretary'
    return defineTool({
      name: sol ? POSTMAN_SOL_WORKER_TOOL_NAME : secretary ? 'postman_secretary' : POSTMAN_WORKER_TOOL_NAME,
      description: sol ? 'Only on an explicit user request: create or continue the one Sol Worker (GPT-6.1 Sol, xhigh). An explicit user request to use Sol Worker is sufficient authorization; do not ask a separate ask_user_question before creation or continuation. Follow-up and new tasks by workerSessionId require no additional user confirmation within the user-selected Sol route. Never automatically escalate Luna to Sol. Use workerSessionId for follow-up; createNew rejects a second Sol Worker. Acceptance is not completion.' :
        secretary ? 'Create or continue the exact singleton Secretary for this Leader task. FAST facts and private operational ledger, no PTC/delegation. Acceptance is not completion.' :
        'Create or continue a Postman Worker, up to two per exact parent (Leader or Sol Worker). FAST local execution without PTC/delegation. Acceptance is not completion.',
      parameters: secretary ? Object.fromEntries(Object.entries(parameters).filter(([name]) => name !== 'artifactRequestId')) : parameters, output: output(),
      async execute(args, exec) {
        const parent = exec?.agent
        if (!authorized(parent) || (workerType !== 'luna' && !isTopLevelPostmanSupervisor(parent))) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
        if (secretary && Object.hasOwn(args ?? {}, 'artifactRequestId')) return { status: 'POSTMAN_WORKER_ARGUMENTS_INVALID' }
        if (typeof args?.task !== 'string' || !args.task.trim()) return { status: 'POSTMAN_WORKER_TASK_INVALID' }
        if ((args.createNew !== undefined && typeof args.createNew !== 'boolean') ||
            (args.workerSessionId !== undefined && (typeof args.workerSessionId !== 'string' || !args.workerSessionId)) ||
            (args.label !== undefined && (typeof args.label !== 'string' || !args.label.trim() || args.label.length > 120)) ||
            (args.artifactRequestId !== undefined && typeof args.artifactRequestId !== 'string') ||
            (args.createNew === true && args.workerSessionId !== undefined))
          return { status: 'POSTMAN_WORKER_ARGUMENTS_INVALID' }
        if (contexts && !contexts.get(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
        return admitted(parent, async () => {
          const group = groupFor(parent)
          await reconcileClosedBindings(parent, group)
          if (args.createNew === true) return create(parent, group, args, exec, workerType)
          const chosen = await enqueue(group, () => select(parent, args.workerSessionId, group, workerType))
          if (!chosen.binding) {
            if (args.workerSessionId !== undefined || chosen.status === 'POSTMAN_WORKER_TARGET_REQUIRED') return chosen
            return create(parent, group, args, exec, workerType)
          }
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
    parameters: { workerSessionId: { type: 'string' }, task: { type: 'string', required: true } }, output: output(),
    async execute(args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      if (typeof args?.task !== 'string' || !args.task.trim()) return { status: 'POSTMAN_WORKER_TASK_INVALID' }
      if (args.workerSessionId !== undefined && (typeof args.workerSessionId !== 'string' || !args.workerSessionId))
        return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
      if (contexts && !contexts.get(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
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
      artifactRequests: binding.artifactRequests })
  }
  async function verifyIdentity(parent, id, signal) {
    const entries = await ctx.subagents.listChildren(parent.id, signal)
    const matches = entries.filter(entry => entry.id === id)
    return matches.length === 1 && matches[0].kind === 'child' && matches[0].mode === 'continuable'
  }
  async function closeEvidence(parent, binding, signal, preflightOwned = false) {
    if (!preflightOwned && workerTypeOf(binding) === 'sol' && Object.values(rawRow(parent.id)?.workers ?? {}).some(value => value.ownerSessionId === binding.id))
      return { ready: false, reason: 'Sol must retire its own Worker bindings before closing/fresh' }
    if (binding.state !== 'ready' || binding.delivery !== 'none')
      return { ready: false, reason: 'binding or admission uncertain; request approved addressed cancel' }
    const child = await history(binding.id, parent.id, signal)
    const reported = workerEvidence(binding, child, parent)
    // Releasing a session is not certifying its task. Local mode needs runtime
    // quiescence, not a perfect historical chain of reports.
    const evidence = localDevelopment
      ? { ready: child?.status === 'idle' && child.inbox?.hasPending === false,
          reason: 'Worker active, pending, or history unavailable', resultReported: reported.ready }
      : { ...reported, resultReported: reported.ready }
    if (!evidence.ready) return evidence
    // Capture before the asynchronous descendant read, not after it.
    const eventCount = child.session.events.length
    const descendants = await ctx.subagents.listDescendants(binding.id, signal)
    const ownedIds = preflightOwned ? new Set(Object.values(rawRow(parent.id)?.workers ?? {}).filter(b => b.ownerSessionId === binding.id).map(b => b.id)) : new Set()
    if (descendants.some(entry => !ownedIds.has(entry.id) && (entry.kind === 'diagnostic' ||
        (entry.kind === 'child' && entry.mode === 'continuable' &&
          (entry.activity !== 'inactive' || ctx.agents.get(entry.id))))))
      return { ready: false, reason: 'managed descendants running or uncertain' }
    return { ...evidence, eventCount }
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
      if (args.cascade !== true && !slotLocked) await reconcileClosedBindings(parent, g)
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
        if (!current || current.id !== selected.id || !matchesContext(parent, slot))
          return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: selected.id }
        if (mode === 'cancel' && cancelWitness(current) !== witness)
          return { status:'POSTMAN_WORKER_BINDING_CHANGED', workerSessionId:selected.id }
        try {
          const evidence = mode === 'close' ? (localDevelopment || current.lifecycle ?
            await closeEvidence(parent, current, exec.signal) :
            { ready: false, reason: 'no durable lifecycle witness' }) : null
          if (mode === 'close') {
            if (!evidence.ready) return { status: 'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT',
              workerSessionId: selected.id, reason: evidence.reason + '; request approved addressed cancel if no report can arrive' }
          }
          if (!await verifyIdentity(parent, selected.id, exec.signal))
            return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: selected.id }
          if (typeof ctx.subagents.closeContinuableChild !== 'function')
            return { status: 'POSTMAN_WORKER_LIFECYCLE_UNSUPPORTED', workerSessionId: selected.id,
              diagnostic: { code: 'EXACT_CHILD_ADMISSION_CUTOFF_UNAVAILABLE' } }
          const latest = bindings(parent, g)[selected.id]
          if (!latest || latest.id !== selected.id ||
              (mode === 'cancel' && cancelWitness(latest) !== witness))
            return { status: mode === 'cancel' ? (localDevelopment ? 'POSTMAN_WORKER_BINDING_CHANGED' : 'POSTMAN_WORKER_CANCEL_APPROVAL_REQUIRED') :
              'POSTMAN_WORKER_STOP_REJECTED_PENDING_RESULT', workerSessionId: selected.id }
          if (mode === 'close') {
            // Verification and admission cutoff share the native exact-child lock.
            // An ordinary native followup is not serialized by the Postman slot queue.
            const closed = await ctx.subagents.closeContinuableChild(parent, selected.id, async () => {
              const snapshot = bindings(parent, g)[selected.id]
              if (!snapshot || snapshot.id !== selected.id || !matchesContext(parent, slot)) return false
              const fresh = await closeEvidence(parent, snapshot, exec.signal)
              if (!fresh.ready || fresh.eventCount !== evidence.eventCount) return false
              if (durable) await changeBinding(parent, selected.id, entry => {
                if (entry !== snapshot || entry.state !== 'ready' || entry.delivery !== 'none')
                  throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
                return { ...entry, state: 'stopping' }
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
                return { ...entry, state: 'stopping' }
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
      return admitted(parent, () => slotLocked ? stop() : enqueue(slot, stop))
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
        return { ...entry, state: 'stopping' }
      })
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
      await changeBinding(parent, selected.id, entry => ({ ...entry, state: current.state }))
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
    }))
  }
  const listTool = defineTool({
    name: POSTMAN_WORKER_LIST_TOOL_NAME,
    description: 'Read exact Leader Worker bindings, residency, durable closure and quota without resuming children.',
    parameters: {}, output: output(),
    async execute(_args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
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
          ...(workerTypeOf(value) !== 'sol' ? { budget: value.budget ?? { used: 0, ...fastBudget, exhausted: false } } : {}) }
      }))
      return { status: 'POSTMAN_WORKER_LIST', quota: {
        secretary: { used: workers.filter(value => value.workerType === 'secretary').length, limit: isTopLevelPostmanSupervisor(parent) ? 1 : 0 },
        luna: { used: workers.filter(value => value.workerType === 'luna').length, limit: 2 },
        sol: { used: workers.filter(value => value.workerType === 'sol').length, limit: isTopLevelPostmanSupervisor(parent) ? 1 : 0 },
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
      if (!durable || !contextAt(id)) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
      if (args.content !== undefined) {
        if (!secretary) return { status: 'POSTMAN_SECRETARY_LEDGER_CALLER_REJECTED' }
        if (typeof args.content !== 'string' || args.content.length > 16000) return { status: 'POSTMAN_SECRETARY_LEDGER_INVALID' }
        try { await taskContexts.changeRecord(id, row => {
          if ((row.secretaryLedger?.revision ?? 0) !== args.revision) throw new Error('POSTMAN_SECRETARY_LEDGER_STALE')
          return { ...row, secretaryLedger: { revision: args.revision + 1, content: args.content, updatedBy: agent.id } }
        }) } catch (error) { return { status: 'POSTMAN_SECRETARY_LEDGER_UPDATE_FAILED', diagnostic: diagnostic(error) } }
      }
      return { status: 'POSTMAN_SECRETARY_LEDGER', ledger: taskContexts.record(id).secretaryLedger ?? { revision: 0, content: '', updatedBy: '' } }
    },
  })
  const freshTool = defineTool({
    name: 'postman_worker_fresh',
    description: 'Retire an exact owned settled child and spawn a fresh role-preserving Session for an explicit new assignment. No history inheritance or Git reset; Secretary ledger survives. Sol user-selected route is preserved.',
    parameters: { workerSessionId: { type: 'string', required: true }, task: { type: 'string', required: true }, label: { type: 'string' }, retireOwnedWorkers: { type: 'boolean' } }, output: output(),
    async execute(args, exec) {
      const parent = exec.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
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
            const closed = await stopTool.execute({workerSessionId: id, mode: 'close', cascade: args.retireOwnedWorkers === true}, exec)
            if (closed.status !== 'POSTMAN_WORKER_STOPPED') return closed
          }
          const accepted = await create(parent, g, {task: args.task, label: args.label ?? chosen.binding.label, createNew: true}, exec, workerTypeOf(chosen.binding), id)
          return {...accepted, retiredWorkerSessionId: id, fresh: accepted.status === 'POSTMAN_WORKER_TASK_ACCEPTED'}
      }) } finally {g.fresh.delete(id)}
    },
  })
  const compactTool = defineTool({
    name: POSTMAN_WORKER_COMPACT_TOOL_NAME,
    description: 'Compact the exact idle or settled non-resident Worker using native compaction; keep its Session, binding and budget without a Worker turn.',
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
        if (binding !== selected.binding || binding.state !== 'ready' || binding.delivery !== 'none' ||
            !matchesContext(parent, slot)) return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
        const child = liveWorker(id)
        if (!child) {
          try {
            if (!durable || !await verifyIdentity(parent, id, exec.signal) ||
                !workerEvidence(binding, await history(id, parent.id, exec.signal), parent).ready)
              return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
            if (typeof ctx.subagents.compactContinuableChild !== 'function')
              return { status: 'POSTMAN_WORKER_LIFECYCLE_UNSUPPORTED', workerSessionId: id }
            const compacted = await ctx.subagents.compactContinuableChild(parent, id, async agent => {
              const current = bindings(parent, g)[id]
              return authorized(parent) && current === binding && matchesContext(parent, slot) &&
                workerEvidence(current, await history(agent.id, parent.id, exec.signal), parent).ready
            }, exec.signal)
            if (!compacted) return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
            return { status: 'POSTMAN_WORKER_COMPACTED', workerSessionId: id,
              compacted: compacted.result !== null, sameSession: true }
          } catch (error) { return { status: 'POSTMAN_WORKER_COMPACT_FAILED', workerSessionId: id, diagnostic: diagnostic(error) } }
        }
        if (child.session?.header?.parentSession !== parent.id ||
            child.session.header.origin !== 'subagent' || child.session.header.delegationDepth !== depthOf(parent.id))
          return { status: 'POSTMAN_WORKER_COMPACT_NOT_RESIDENT', workerSessionId: id }
        if (child.status !== 'idle' || child.inbox?.hasPending !== false ||
            typeof child.ctx?.get?.('compaction')?.compactNow !== 'function')
          return { status: 'POSTMAN_WORKER_COMPACT_BUSY', workerSessionId: id }
        try {
          // Native compactNow reserves Agent.runMaintenance synchronously before
          // any await, so accepted followups cannot run inside the compacted span.
          const compacted = await child.ctx.get('compaction').compactNow(child, exec.signal)
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
          rowOf(leaderId).workers[caller.id].state !== 'ready')) ||
        (contexts && slot.context !== contexts.get(leaderId))) return null
    return !requireActivation || slot.workerAgent === caller ? slot : null
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
        (contexts && (!slot.context || slot.context !== contexts.get(leaderId))) ||
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
    if (type === 'secretary' && !SECRETARY_TOOLS.includes(exec.name)) return 'POSTMAN_SECRETARY_TOOL_REJECTED'
    if (type && (DELEGATION_TOOLS.includes(exec.name) || (type !== 'sol' && exec.name === 'ptc_execute') ||
      (exec.name.startsWith('postman_') && !(type === 'sol' && WORKER_CONTROL_TOOLS.includes(exec.name)) &&
      !(type === 'secretary' && exec.name === 'postman_secretary_ledger')))) return 'POSTMAN_WORKER_TOOL_REJECTED'
    const budget = budgetOf(exec.agent)
    if (!budget) return
    if (budget.reported) return 'POSTMAN_WORKER_ASSIGNMENT_REPORTED: wait for a new parent assignment'
    if (exec.name === 'notify_parent' && budget.notified) return 'POSTMAN_WORKER_ESCALATION_ALREADY_SENT'
    if (!budget.exhausted) return
    if (!['notify_parent', 'report'].includes(exec.name)) return 'POSTMAN_WORKER_BUDGET_EXHAUSTED: escalation/report only'
    const text = exec.name === 'report' ? exec.arguments?.output : exec.arguments?.message
    if (typeof text !== 'string' || !/^(NEEDS_PARENT_GUIDANCE:|NEEDS_LEADER_GUIDANCE:)/.test(text))
      return 'POSTMAN_WORKER_BUDGET_EXHAUSTED: meaningful blocker required, not success'
  })
  const stopReportConclusion = ctx.on?.('tools/execute', async (exec, next) => {
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
    const agent = payload.agent, slot = activeSlot(agent)
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
    if (budget.used < budget.hardLimit) return decision
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
      const ledger = type === 'secretary' ? rawRow(scope.session.header.parentSession)?.secretaryLedger : null
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
      if (!binding || binding.state !== 'ready' || binding.delivery !== 'none') return false
      slot = slotFor(groupFor(ctx.agents.get(leaderId)), binding)
      slot.context = contexts?.get(leaderId) ?? null
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
  // The Host has already reserved the shared worktree before calling this.
  // DSH's selected drain cancels a live turn; never use it as a pause.
  // Inactive durable peers already have no resident Activation to release.
  // The runner's caller is inside this tool and must never await itself.
  async function pauseForOperation(leaderId, callerId = null) {
    const parent = ctx.agents.get(leaderId)
    if (!authorized(parent)) return false
    const group = groupFor(parent)
    const values = Object.values(bindings(parent, group))
    // Caller may be Sol inside the artifact runner. Its children share this task
    // worktree but are not the Leader slots: never ignore their mutation activity.
    if (durable) for (const binding of Object.values(rawRow(leaderId)?.workers ?? {})) {
      if ((binding.ownerSessionId ?? leaderId) === leaderId) continue
      if (binding.state !== 'ready' || binding.delivery !== 'none') return false
      const child = await history(binding.id, binding.ownerSessionId)
      if (!child || child.status !== 'idle' || child.inbox?.hasPending) return false
    }
    if (values.some(value => value.state !== 'ready' || value.delivery !== 'none' ||
        (callerId && value.id === callerId && !group.slots.has(callerId)))) return false
    if (callerId && !values.some(value => value.id === callerId)) return false
    try {
      // DSH activity is session residency, not proof of model completion.
      // Only inactive durable children have no resident accepted turns.
      const entries = await ctx.subagents.listChildren(leaderId)
      const mapped = new Set(values.map(value => value.id))
      // A removed mapping alone cannot prove its former child is not running.
      if (entries.some(entry => entry.activity === 'running' &&
          entry.id !== callerId && (mapped.has(entry.id) ||
            (entry.kind === 'child' && entry.mode === 'continuable')))) return false
      for (const value of values) {
        if (value.id === callerId) continue
        const match = entries.filter(entry => entry.id === value.id)
        if (match.length !== 1 || match[0].kind !== 'child' ||
            match[0].mode !== 'continuable' || match[0].activity !== 'inactive' ||
            ctx.agents.get(value.id)) return false
      }
      return authorized(parent) && values.every(value => {
        const current = bindings(parent, group)[value.id]
        return current?.id === value.id && current.state === 'ready' && current.delivery === 'none'
      })
    } catch { return false }
  }
  async function removeBinding(parent, g, slot, id, expected = null, expectedContext = null) {
    if (durable) await contexts.changeRecord(parent.id, row => {
      if (expectedContext && (!authorized(parent) || contexts.get(parent.id) !== expectedContext))
        throw new Error('POSTMAN_WORKER_CONTEXT_CHANGED')
      if (expected ? cancelWitness(row.workers?.[id] ?? {}) !== expected : row.workers?.[id]?.state !== 'stopping')
        throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
      const workers = { ...row.workers }; delete workers[id]
      return { ...row, workers, retiredWorkers: [...(row.retiredWorkers ?? []), { ...row.workers[id], retired: true }] }
    })
    slot.closed = true; g.slots.delete(id); g.stopped.add(id)
  }
  async function prepareRestore(leaderId) {
    if (!localDevelopment) return pauseForOperation(leaderId)
    // Called only after Host reserved restore: no new Postman admissions.
    const parent = ctx.agents.get(leaderId)
    if (!authorized(parent) || !durable || !contexts.isRestoring?.(leaderId)) return false
    const g = groupFor(parent)
    if (Object.keys(bindings(parent, g)).length && typeof ctx.subagents.closeContinuableChild !== 'function') return false
    for (const binding of Object.values(bindings(parent, g))) {
      const slot = slotFor(g, binding)
      try {
        const closed = await enqueue(slot, () => ctx.subagents.closeContinuableChild(parent, binding.id, async () => {
          const current = bindings(parent, g)[binding.id]
          if (!current || !matchesContext(parent, slot) ||
              !(await closeEvidence(parent, current)).ready) return false
          await changeBinding(parent, binding.id, entry => ({ ...entry, state: 'stopping' }))
          slot.state = 'stopping'; bindingChanged(binding.id)
          return true
        }))
        if (!closed) return false
        await removeBinding(parent, g, slot, binding.id)
      } catch {
        if (rowOf(leaderId)?.workers?.[binding.id]?.state === 'stopping')
          await changeBinding(parent, binding.id, entry => ({ ...entry, state: 'uncertain' }))
        slot.state = 'uncertain'; bindingChanged(binding.id)
        return false
      }
    }
    return pauseForOperation(leaderId)
  }
  // Raw durable membership + exact current live state only. No recovery, journal reads or writes.
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
      secretary: { present: Boolean(secretary), ...(secretary ? summary(secretary) : { sessionId: null, state: 'absent', budget: null }), ledgerRevision: row.secretaryLedger?.revision ?? 0 },
      workers: { used: ordinary.length, limit: 2, rows: ordinary.slice(0, 2).map(summary) },
      sol: { present: Boolean(sol), ...(sol ? summary(sol) : { sessionId: null, state: 'absent' }),
        ownedWorkers: { used: children.length, limit: 2, states, budget: totals } } }
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
  return { taskTool, solTaskTool, secretaryTool, ledgerTool, freshTool, interruptTool, stopTool, listTool, compactTool, roleOf, ownerOf, ownsNotification, ownsLiveWorker, ptcContextOf, confirmActivation, releaseActivation, refreshLeader, suspendLeader,
    contextOf, observeReport, pauseForOperation, prepareRestore, teamSnapshot, dispose }
}
