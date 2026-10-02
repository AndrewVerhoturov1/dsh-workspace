import { defineTool } from '@deepseek-ai/dsh-tools'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import { workerEvidence } from './postman-worker-evidence.js'
import {
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  POSTMAN_WORKER_LIST_TOOL_NAME,
  isTopLevelPostmanSupervisor,
  isTopLevelPostmanPtcLeader,
} from './postman-bridge-core.js'

export const POSTMAN_WORKER_PROVIDER = 'spawn'
export const POSTMAN_WORKER_AGENT_OPTIONS = Object.freeze({ provider: 'codex', model: 'gpt-6-luna', reasoningEffort: 'max' })
export const POSTMAN_WORKER_PERSONA = `You are Postman Worker, a local continuable Luna subagent working under your direct parent, Postman Leader (Sol).
Only if you are granted Postman's own ptc_execute, its automatically runtime-injected Postman PTC discipline is mandatory and governs batching/programming of that capability; it is not a separate mode for Workers without that assignment.
Complete each assigned local task using the tools available to you. Follow the repository's instructions and the parent's task boundaries. You are not Postman Bridge: never use Direct Postman or imitate its transport. Do not use @Postman or @PostmanAsk as a way around your parent's boundaries.
Work independently while the safe next step is clear. Resolve routine local friction yourself: a typo, an obviously wrong path, one related file to read, a first test failure with a clear cause, a simple targeted diagnosis, or a deterministic fix within the approved approach. Do not escalate every error. Never repeat a failed or equivalent approach without new evidence. Do not rerun a passing check with unchanged inputs.
Stop autonomous work when the next step needs Leader judgement: competing substantial designs, unclear user intent or scope, an unrelated bug, a weakened safety/trust boundary, conflicting evidence, baseline versus regression uncertainty, runtime behavior contradicting its contract, a more invasive fix, or a variation of an approach that already failed without new evidence. If one narrow diagnostic can distinguish specific hypotheses, do at most that one step; continue only if it makes the safe next step clear. Do not search through variants or workarounds hoping for a different result.
Keep progress, factual FYI and intermediate diagnostics that need no Leader decision for your substantive report; do not wake the Leader with notify_parent for these updates. If ptc_execute is available, use it for read/glob/grep/web_fetch/web_search/write/edit. Do not use shell to bypass PTC-first for filesystem/search operations available in that profile; shell is for commands, tests, processes and operations absent from the profile.
For a decision-relevant blocker, send ONE actionable notify_parent message beginning with the exact prefix NEEDS_LEADER_GUIDANCE: for immediate steering. Include the blocker, concrete evidence, only meaningfully distinct attempts, the exact decision needed, and safe options if known. Then call your child-scoped report tool once with a concise self-contained blocker report required by the Worker turn contract. The installed report path may wait for the Leader's next turn; do not rely on it for timely escalation. After this escalation report, use NO more tools: no tests, searches, edits, retries or work while waiting. Finish the current turn and remain available in this same durable child session for a concrete Leader decision. If notification or report delivery fails ambiguously, do not blindly send duplicates or resume autonomous work.
When you have a normal substantive result, use your child-scoped report tool to tell your Leader what you did, what you checked, and any errors. Send a concise, factual, self-contained final report for each task before finishing the turn. A report is not the end of your Worker session: remain available for later tasks in this same durable child session.`

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
export function postmanWorkerDeniedTools(tools) {
  return tools.schemas().map(tool => tool.name).filter(name => name.startsWith('postman_'))
}

export function buildPostmanWorkerStartRequest(parent, task, signal, deniedTools, label = 'Postman Worker') {
  if (!Array.isArray(deniedTools) || deniedTools.length === 0 ||
      deniedTools.some(name => typeof name !== 'string' || !name.startsWith('postman_'))) {
    throw new Error('POSTMAN_WORKER_TRANSPORT_BOUNDARY_REQUIRED')
  }
  return {
    provider: POSTMAN_WORKER_PROVIDER,
    label,
    signal,
    request: {
      parent,
      prompt: [{ type: 'text', text: task }],
      agentOptions: { ...POSTMAN_WORKER_AGENT_OPTIONS },
      persona: POSTMAN_WORKER_PERSONA,
      // Only deny host Postman transport/control tools. The shared preset's
      // coding tools and child-scoped report remain available.
      toolFilter: { deny: [...deniedTools] },
    },
  }
}


// One short Leader admission queue reserves membership; every child has its own
// delivery queue. Neither queue is held until a model turn finishes.
export function createPostmanWorkerTools(ctx, grants, contexts, { onBindingChange = () => {}, localDevelopment = false } = {}) {
  const leaders = new Map()
  const disposedParents = new WeakSet()
  const bindingChanged = id => onBindingChange(id)
  let disposed = false
  const durable = typeof contexts?.record === 'function' && typeof contexts?.changeRecord === 'function'
  const rowOf = id => durable ? contexts.record(id) : null
  const liveWorker = id => ctx.agents.get(id)
  const emptyLifecycle = () => ({ version: 1, admissions: [], reports: [] })
  // AgentOptions carries the start intent; this existing request waterfall also
  // covers first-request assembly and cold resumes that retain only provider/model.
  const stopRequestOptions = ctx.on?.('agent/request', async ({ agent }, next) => {
    const config = await next()
    return (provisionalSlot(agent, false) || liveSlot(agent, agent?.session?.header?.parentSession, true)) && config.provider === POSTMAN_WORKER_AGENT_OPTIONS.provider &&
      config.model === POSTMAN_WORKER_AGENT_OPTIONS.model
      ? { ...config, reasoningEffort: POSTMAN_WORKER_AGENT_OPTIONS.reasoningEffort } : config
  })
  // A released Activation is not a deleted durable Session. inspect never resumes a model.
  async function history(id, leaderId, signal) {
    const resident = liveWorker(id)
    let saved
    try { saved = resident?.session ?? ctx.get?.('sessions')?.get?.(id) ??
      (await ctx.get?.('sessionPersistence')?.inspect?.(id, signal)) } catch { return null }
    const header = saved?.header ?? saved?.meta
    if ((header?.id !== undefined && header.id !== id) || header?.origin !== 'subagent' ||
        header.parentSession !== leaderId || header.delegationDepth !== 1 ||
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
        child.session.header.delegationDepth !== 1 || liveWorker(child.id) !== child) return
    const call = child.session.events.findLast(event => event.type === 'tool/call' &&
      event.data.callId === exec.callId && event.data.name === 'report')
    if (!call) return
    try { await changeBinding({ id: leaderId }, child.id, current => {
      if (!['intent', 'ready'].includes(current.state)) return current
      return { ...current, lifecycle: { ...(current.lifecycle ?? emptyLifecycle()),
        reports: [...(current.lifecycle?.reports ?? []).filter(item => item.callId !== exec.callId),
          { childId: child.id, turn: call.data.turn, callId: exec.callId, messageId: result.value.messageId }] } }
    }) } catch { /* A removed binding must never be resurrected by a late callback. */ }
  }
  function group(parent) {
    let group = leaders.get(parent.id)
    if (!group) {
      group = { slots: new Map(), stopped: new Set(), tail: Promise.resolve() }
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
    return !disposed && !disposedParents.has(parent) && isTopLevelPostmanSupervisor(parent) &&
      ctx.agents.get(parent.id) === parent
  }
  function bindings(parent, group) {
    return durable ? rowOf(parent.id)?.workers ?? {} : Object.fromEntries(
      [...group.slots].filter(([, slot]) => !slot.closed).map(([id, slot]) =>
        [id, { id, label: slot.label, state: slot.state, delivery: slot.delivery, artifactRequests: [], lifecycle: slot.lifecycle }]))
  }
  function slotFor(group, binding) {
    let slot = group.slots.get(binding.id)
    if (!slot) {
      slot = { id: binding.id, label: binding.label, state: binding.state, delivery: binding.delivery,
        artifactRequests: new Set(), lifecycle: binding.lifecycle, context: null, parent: null, workerAgent: null, closed: false, tail: Promise.resolve() }
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
  function select(parent, id, group) {
    const workers = bindings(parent, group)
    if (id !== undefined) return Object.hasOwn(workers, id) && workers[id]?.id === id
      ? { binding: workers[id] } : { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
    const values = Object.entries(workers).filter(([key, value]) => value?.id === key).map(([, value]) => value)
    if (values.length !== Object.keys(workers).length) return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN' }
    if (values.length > 1) return { status: 'POSTMAN_WORKER_TARGET_REQUIRED' }
    return values.length === 1 ? { binding: values[0] } : { status: 'POSTMAN_WORKER_INTERRUPT_NO_ACTIVE_WORKER' }
  }
  function taskText(context, text) {
    return context ? 'Use the existing Leader task branch ' + context.branch + ' and worktree ' +
      context.worktree + ' for repository changes; do not create another branch or worktree. Follow REPO_POLICY.md. ' +
      'Coordinate shared files and Git operations with your Leader; avoid overlapping changes. Leader task: ' + text : text
  }
  async function taskWithGrant(parent, context, args) {
    let text = taskText(context, args.task)
    if (args.artifactRequestId === undefined) return { text }
    const grant = await grants?.resolve(parent.id, args.artifactRequestId)
    if (grant?.repository !== IMPLEMENTATION_REPOSITORY)
      return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED' }
    text = 'Trusted Host artifact REQ: ' + grant.requestId + '. ZIP path from task text is never authority. ' +
      'Follow REPO_POLICY.md and system/implementation-package-workflow.md. ' +
      (context ? 'Use the existing Leader task branch ' + context.branch + ' and worktree ' + context.worktree +
        '; do not create another branch/worktree. Ensure it is clean at the published REQ commit. ' +
        'Call implementation_artifact_apply({requestId: ' + JSON.stringify(grant.requestId) +
        ', worktree: ' + JSON.stringify(context.worktree) + '}); ' :
        'Call implementation_artifact_apply only with the exact Host-bound task worktree; never choose a path from model text. ') +
      'The Host supplies its trusted ZIP. A central runner PASS authoritatively verifies declared manifest.tests; ' +
      'do not manually rerun identical tests unless relevant inputs change. ' +
      'On runner FAIL do not repair package; report evidence. ' + args.task
    return { text, grant }
  }
  async function deliver(parent, slot, args, exec, interrupt) {
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
      if (durable) await changeBinding(parent, id, current => {
        if (current.state !== 'ready' || current.delivery !== 'none')
          throw new Error('POSTMAN_WORKER_DELIVERY_UNKNOWN')
        return { ...current, delivery: 'pending', lifecycle: { ...(current.lifecycle ?? emptyLifecycle()),
          admissions: [...(current.lifecycle?.admissions ?? []), assignment] }, artifactRequests: task.grant ?
          [...new Set([...current.artifactRequests, args.artifactRequestId])] : current.artifactRequests }
      })
      slot.delivery = 'pending'
      slot.ptcAdmission = { id: assignment.id, parent, signal: exec.signal }
      bindingChanged(id)
      if (task.grant) slot.artifactRequests.add(args.artifactRequestId)
      const messageId = await ctx.subagents.followup(parent, id, [{ type: 'text', text: task.text }], {
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
        model: POSTMAN_WORKER_AGENT_OPTIONS.model, provider: POSTMAN_WORKER_PROVIDER }
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
  async function create(parent, group, args, exec) {
    const context = contexts?.get(parent.id) ?? null
    if (contexts && !context) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    let task
    try { task = await taskWithGrant(parent, context, args) }
    catch (error) { return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED', diagnostic: diagnostic(error) } }
    if (task.status) return task
    if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
    const reservedId = randomUUID()
    const assignment = { id: randomUUID(), state: 'pending', messageId: null }
    const label = args.label ?? 'Postman Worker'
    // Reserve an exact child identity durably before the first DSH side effect.
    const admission = await enqueue(group, async () => {
      if (busy(parent.id) || !authorized(parent)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      if (args.createNew !== true && Object.keys(bindings(parent, group)).length)
        return { selected: select(parent, undefined, group) }
      if (Object.keys(bindings(parent, group)).length >= 3) return { status: 'POSTMAN_WORKER_LIMIT_REACHED' }
      try {
        if (durable) await contexts.changeRecord(parent.id, row => {
          if (Object.keys(row.workers ?? {}).length >= 3) throw new Error('POSTMAN_WORKER_LIMIT_REACHED')
          if (Object.hasOwn(row.workers ?? {}, reservedId)) throw new Error('POSTMAN_WORKER_BINDING_EXISTS')
          return { ...row, workers: { ...row.workers,
            [reservedId]: { id: reservedId, label, state: 'intent', delivery: 'pending',
              artifactRequests: task.grant ? [args.artifactRequestId] : [],
              lifecycle: { version: 1, admissions: [assignment], reports: [] } } } }
        })
        const slot = slotFor(group, { id: reservedId, label, state: 'intent', delivery: 'pending' })
        slot.context = context
        if (task.grant) slot.artifactRequests.add(args.artifactRequestId)
        return { slot }
      } catch (error) {
        return { status: /POSTMAN_WORKER_LIMIT_REACHED/.test(String(error)) ?
          'POSTMAN_WORKER_LIMIT_REACHED' : 'POSTMAN_WORKER_START_FAILED', diagnostic: diagnostic(error) }
      }
    })
    if (admission.selected) {
      if (!admission.selected.binding) return admission.selected
      const selected = slotFor(group, admission.selected.binding)
      return enqueue(selected, () => deliver(parent, selected, args, exec, false))
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
        ...buildPostmanWorkerStartRequest(parent, task.text, exec.signal, postmanWorkerDeniedTools(ctx.tools), label),
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
        created: true, messageId: String(accepted.messageId), model: POSTMAN_WORKER_AGENT_OPTIONS.model,
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
  const taskTool = defineTool({
    name: POSTMAN_WORKER_TOOL_NAME,
    description: 'Create an additional continuable Worker (up to three), or deliver a trusted artifact grant to an exact existing Worker. Acceptance is not completion.',
    parameters, output: output(),
    async execute(args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
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
        if (args.createNew === true) return create(parent, group, args, exec)
        const chosen = await enqueue(group, () => select(parent, args.workerSessionId, group))
        if (!chosen.binding) {
          if (args.workerSessionId !== undefined || chosen.status === 'POSTMAN_WORKER_TARGET_REQUIRED') return chosen
          return create(parent, group, args, exec)
        }
        const slot = slotFor(group, chosen.binding)
        return enqueue(slot, () => deliver(parent, slot, args, exec, false))
      })
    },
  })
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
  async function closeEvidence(parent, binding, signal) {
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
    if (descendants.some(entry => entry.kind === 'diagnostic' ||
        (entry.kind === 'child' && entry.mode === 'continuable' &&
          (entry.activity !== 'inactive' || ctx.agents.get(entry.id)))))
      return { ready: false, reason: 'managed descendants running or uncertain' }
    return { ...evidence, eventCount }
  }
  const stopTool = defineTool({
    name: POSTMAN_WORKER_STOP_TOOL_NAME,
    description: 'Release an idle Worker without claiming task success; cancel an exact Worker with Host approval unless localDevelopment is enabled.',
    parameters: {
      mode: { type: 'string', enum: ['close', 'cancel'] },
      workerSessionId: { type: 'string', description: 'Exact Worker ID; mandatory for cancel.' },
      reason: { type: 'string', description: 'Explanation, never authorization.' },
    }, output: output(),
    async execute(args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      const mode = args?.mode ?? 'close', id = args?.workerSessionId
      if (mode !== 'close' && mode !== 'cancel') return { status: 'POSTMAN_WORKER_STOP_MODE_INVALID' }
      if (id !== undefined && (typeof id !== 'string' || !id)) return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
      if (mode === 'cancel' && !id) return { status: localDevelopment ? 'POSTMAN_WORKER_TARGET_REQUIRED' : 'POSTMAN_WORKER_CANCEL_APPROVAL_REQUIRED' }
      const g = groupFor(parent)
      const chosen = await enqueue(g, () => select(parent, id, g))
      if (!chosen.binding) {
        if (id && g.stopped.has(id)) return { status: 'POSTMAN_WORKER_ALREADY_STOPPED', workerSessionId: id }
        return !localDevelopment && mode === 'cancel' && chosen.status === 'POSTMAN_WORKER_TARGET_UNKNOWN' ?
          { status: 'POSTMAN_WORKER_CANCEL_APPROVAL_REQUIRED' } : chosen
      }
      const selected = chosen.binding, slot = slotFor(g, selected)
      let witness
      if (mode === 'cancel') {
        if (!durable || (!localDevelopment && !ctx.get?.('approval')))
          return { status: 'POSTMAN_WORKER_CANCEL_APPROVAL_REQUIRED', workerSessionId: id }
        try {
          if (!await verifyIdentity(parent, id, exec.signal))
            return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: id }
        } catch { return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: id } }
        witness = cancelWitness(selected)
        if (!localDevelopment) {
          const approval = await ctx.get('approval').request({ agent: parent,
            toolName: POSTMAN_WORKER_STOP_TOOL_NAME, callId: exec.callId,
            reason: 'Cancel exact Leader ' + parent.id + ' Worker ' + id +
              ' assignments ' + witness + ': ' + (args.reason ?? 'no explanation'), signal: exec.signal })
          if (approval !== 'allowed-once')
            return { status: 'POSTMAN_WORKER_CANCEL_APPROVAL_REQUIRED', workerSessionId: id }
        }
      }
      // Per-Worker queue prevents a selected admission between validation and drain.
      // No Leader-wide queue is held while a human or model runs.
      return admitted(parent, () => enqueue(slot, async () => {
        if (slot.closed || !authorized(parent)) return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
        const current = bindings(parent, g)[selected.id]
        if (!current || current.id !== selected.id || !matchesContext(parent, slot))
          return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: selected.id }
        if (mode === 'cancel' && cancelWitness(current) !== witness)
          return { status: localDevelopment ? 'POSTMAN_WORKER_BINDING_CHANGED' : 'POSTMAN_WORKER_CANCEL_APPROVAL_REQUIRED', workerSessionId: selected.id }
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
      }))
    },
  })
  const listTool = defineTool({
    name: POSTMAN_WORKER_LIST_TOOL_NAME,
    description: 'List this Leader’s exact Worker bindings and delivery states without mutating or probing the children.',
    parameters: {}, output: output(),
    execute(_args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      const values = Object.values(bindings(parent, groupFor(parent)))
      return { status: 'POSTMAN_WORKER_LIST', workers: values.map(value => ({
        workerSessionId: value.id, label: value.label, binding: value.state,
        delivery: value.delivery, execution: 'unknown',
      })) }
    },
  })
  function liveSlot(caller, leaderId, requireActivation = false) {
    if (disposed || typeof caller?.id !== 'string' || ctx.agents.get(caller.id) !== caller ||
        caller.session?.header?.origin !== 'subagent' || caller.session.header.delegationDepth !== 1 ||
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
  function provisionalSlot(caller, requirePtcLeader = true) {
    const header = caller?.session?.header, leaderId = header?.parentSession
    const parent = ctx.agents.get(leaderId), slot = leaders.get(leaderId)?.slots.get(caller?.id)
    const admission = slot?.ptcAdmission, binding = rowOf(leaderId)?.workers?.[caller?.id]
    const latest = binding?.lifecycle?.admissions?.at(-1)
    if (!durable || !authorized(parent) || (requirePtcLeader && !isTopLevelPostmanPtcLeader(parent)) ||
        ctx.agents.get(caller?.id) !== caller || (header?.id !== undefined && header.id !== caller.id) || header?.origin !== 'subagent' || header.delegationDepth !== 1 ||
        !slot || slot.closed || slot.parent !== parent || admission?.parent !== parent || admission.signal?.aborted ||
        !slot.context || slot.context !== contexts.get(leaderId) ||
        (slot.workerAgent !== null && slot.workerAgent !== caller) ||
        !['intent', 'ready'].includes(slot.state) || slot.delivery !== 'pending' ||
        binding?.id !== caller.id || binding.state !== slot.state || binding.delivery !== 'pending' ||
        latest?.id !== admission.id || latest.state !== 'pending') return null
    return slot
  }
  function ptcSlot(caller, requireActivation = true) {
    const provisional = provisionalSlot(caller)
    if (provisional) return provisional.workerAgent === caller ? provisional : null
    const slot = liveSlot(caller, caller?.session?.header?.parentSession, requireActivation)
    const binding = rowOf(caller?.session?.header?.parentSession)?.workers?.[caller?.id]
    return slot?.delivery === 'none' && (!durable || binding?.delivery === 'none') ? slot : null
  }
  async function confirmActivation(caller) {
    const provisional = provisionalSlot(caller)
    if (provisional) {
      provisional.workerAgent = caller
      bindingChanged(caller.id) // Synchronous: before the first model request is assembled.
      return true
    }
    const leaderId = caller?.session?.header?.parentSession
    const slot = leaders.get(leaderId)?.slots.get(caller?.id)
    if (!slot || slot.workerAgent !== null || !liveSlot(caller, leaderId)) return false
    // A saved session ID alone is insufficient: reconcile the actual durable child.
    try { if (!await childExists(ctx.agents.get(leaderId), caller.id)) return false } catch { return false }
    if (slot.workerAgent !== null || !liveSlot(caller, leaderId)) return false
    slot.workerAgent = caller
    bindingChanged(caller.id)
    return true
  }
  function ownsNotification(caller, leaderId) {
    if (caller?.session?.header?.parentSession !== leaderId) return false
    return Boolean(isTopLevelPostmanPtcLeader(ctx.agents.get(leaderId))
      ? ptcSlot(caller, false) : liveSlot(caller, leaderId))
  }
  // The same exact live-slot predicate serves PTC; a saved child ID is never authority.
  function ownsLiveWorker(caller) {
    return Boolean(ptcSlot(caller))
  }
  function ptcContextOf(caller) {
    return ptcSlot(caller)?.context ?? null
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
  async function removeBinding(parent, g, slot, id) {
    if (durable) await contexts.changeRecord(parent.id, row => {
      if (row.workers?.[id]?.state !== 'stopping') throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
      const workers = { ...row.workers }; delete workers[id]
      return { ...row, workers }
    })
    slot.closed = true; g.slots.delete(id); g.stopped.add(id)
  }
  async function prepareRestore(leaderId) {
    if (!localDevelopment) return pauseForOperation(leaderId)
    // Called only after Host reserved restore: no new Postman admissions.
    const parent = ctx.agents.get(leaderId)
    if (!authorized(parent) || !durable || !contexts.isRestoring?.(leaderId)) return false
    const g = groupFor(parent)
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
  function dispose() {
    disposed = true
    stopRequestOptions?.()
    for (const group of leaders.values()) for (const slot of group.slots.values()) {
      slot.closed = true
      bindingChanged(slot.id)
    }
    leaders.clear()
  }
  return { taskTool, interruptTool, stopTool, listTool, ownerOf, ownsNotification, ownsLiveWorker, ptcContextOf, confirmActivation, releaseActivation, refreshLeader, suspendLeader,
    contextOf, observeReport, pauseForOperation, prepareRestore, dispose }
}
