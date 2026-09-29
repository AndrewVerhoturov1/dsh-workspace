import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import {
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  POSTMAN_WORKER_LIST_TOOL_NAME,
  isTopLevelPostmanSupervisor,
} from './postman-bridge-core.js'

export const POSTMAN_WORKER_PROVIDER = 'spawn'
export const POSTMAN_WORKER_AGENT_OPTIONS = Object.freeze({ provider: 'codex', model: 'gpt-6-luna' })
export const POSTMAN_WORKER_PERSONA = `You are Postman Worker, a local continuable Luna subagent working under your direct parent, Postman Leader (Sol).
Complete each assigned local task using the tools available to you. Follow the repository's instructions and the parent's task boundaries. You are not Postman Bridge: never use Direct Postman or imitate its transport. Do not use @Postman or @PostmanAsk as a way around your parent's boundaries.
Work independently while the safe next step is clear. Resolve routine local friction yourself: a typo, an obviously wrong path, one related file to read, a first test failure with a clear cause, a simple targeted diagnosis, or a deterministic fix within the approved approach. Do not escalate every error. Never repeat a failed or equivalent approach without new evidence. Do not rerun a passing check with unchanged inputs.
Stop autonomous work when the next step needs Leader judgement: competing substantial designs, unclear user intent or scope, an unrelated bug, a weakened safety/trust boundary, conflicting evidence, baseline versus regression uncertainty, runtime behavior contradicting its contract, a more invasive fix, or a variation of an approach that already failed without new evidence. If one narrow diagnostic can distinguish specific hypotheses, do at most that one step; continue only if it makes the safe next step clear. Do not search through variants or workarounds hoping for a different result.
For a timely factual intermediate update that does not require a decision, call notify_parent({message: ...}); it steers an untrusted message to your direct Leader at the next safe Leader step, without canceling a running tool. You may continue after such an update. This is not a trusted Bridge result or a replacement for your substantive report.
For a decision-relevant blocker, send ONE actionable notify_parent message for immediate steering. Include the blocker, concrete evidence, only meaningfully distinct attempts, the exact decision needed, and safe options if known; NEEDS_LEADER_GUIDANCE is a helpful label, not a machine token. Then call your child-scoped report tool once with a concise self-contained blocker report required by the Worker turn contract. The installed report path may wait for the Leader's next turn; do not rely on it for timely escalation. After this escalation report, use NO more tools: no tests, searches, edits, retries or work while waiting. Finish the current turn and remain available in this same durable child session for a concrete Leader decision. If notification or report delivery fails ambiguously, do not blindly send duplicates or resume autonomous work.
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
export function createPostmanWorkerTools(ctx, grants, contexts) {
  const leaders = new Map()
  let disposed = false
  const durable = typeof contexts?.record === 'function' && typeof contexts?.changeRecord === 'function'
  const rowOf = id => durable ? contexts.record(id) : null
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
    return !disposed && isTopLevelPostmanSupervisor(parent) && ctx.agents.get(parent.id) === parent
  }
  function bindings(parent, group) {
    return durable ? rowOf(parent.id)?.workers ?? {} : Object.fromEntries(
      [...group.slots].filter(([, slot]) => !slot.closed).map(([id, slot]) =>
        [id, { id, label: slot.label, state: slot.state, delivery: slot.delivery, artifactRequests: [] }]))
  }
  function slotFor(group, binding) {
    let slot = group.slots.get(binding.id)
    if (!slot) {
      slot = { id: binding.id, label: binding.label, state: binding.state, delivery: binding.delivery,
        artifactRequests: new Set(), context: null, closed: false, tail: Promise.resolve() }
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
    if (saved.state === 'stopping' || saved.state === 'uncertain') return 'POSTMAN_WORKER_BINDING_UNCERTAIN'
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
    try {
      if (durable) await changeBinding(parent, id, current => {
        if (current.state !== 'ready' || current.delivery !== 'none')
          throw new Error('POSTMAN_WORKER_DELIVERY_UNKNOWN')
        return { ...current, delivery: 'pending', artifactRequests: task.grant ?
          [...new Set([...current.artifactRequests, args.artifactRequestId])] : current.artifactRequests }
      })
      slot.delivery = 'pending'
      if (task.grant) slot.artifactRequests.add(args.artifactRequestId)
      const messageId = await ctx.subagents.followup(parent, id, [{ type: 'text', text: task.text }], {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }, signal: exec.signal,
      })
      if (durable) await changeBinding(parent, id, current => {
        if (current.state !== 'ready' || current.delivery !== 'pending')
          throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
        return { ...current, delivery: 'none' }
      })
      slot.delivery = 'none'
      return { status: interrupt ? 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED' : 'POSTMAN_WORKER_TASK_ACCEPTED',
        workerSessionId: id, label: slot.label, created: false, messageId: String(messageId),
        ...(interrupt ? { interruptRequested: false, mappingPreserved: true } : {}),
        model: POSTMAN_WORKER_AGENT_OPTIONS.model, provider: POSTMAN_WORKER_PROVIDER }
    } catch (error) {
      if (durable && Object.hasOwn(rowOf(parent.id)?.workers ?? {}, id) &&
          rowOf(parent.id).workers[id].delivery === 'pending') {
        try { await changeBinding(parent, id, current => ({ ...current, delivery: 'unknown' })) } catch {}
      }
      slot.delivery = 'unknown'
      return { status: interrupt ? 'POSTMAN_WORKER_INTERRUPT_DELIVERY_FAILED' : 'POSTMAN_WORKER_FOLLOWUP_FAILED',
        workerSessionId: id, diagnostic: diagnostic(error) }
    }
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
              artifactRequests: task.grant ? [args.artifactRequestId] : [] } } }
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
    const reservedBinding = durable ? rowOf(parent.id)?.workers?.[reservedId] : null
    const exactIntent = () => !durable ||
      (Object.hasOwn(rowOf(parent.id)?.workers ?? {}, reservedId) &&
       rowOf(parent.id).workers[reservedId] === reservedBinding && reservedBinding?.state === 'intent')
    return enqueue(slot, async () => {
    let readyBinding
    if (slot.closed || !authorized(parent) || !exactIntent())
      return { status: 'POSTMAN_WORKER_BINDING_UNCERTAIN', workerSessionId: reservedId }
    try {
      const accepted = await ctx.subagents.startContinuable({
        ...buildPostmanWorkerStartRequest(parent, task.text, exec.signal, postmanWorkerDeniedTools(ctx.tools), label),
        childId: reservedId,
      })
      if (String(accepted.childId) !== reservedId) throw new Error('POSTMAN_WORKER_CHILD_ID_MISMATCH')
      if (slot.closed || !authorized(parent) || !exactIntent()) throw new Error('POSTMAN_WORKER_START_STALE')
      if (durable && !await childExists(parent, reservedId, exec.signal))
        throw new Error('POSTMAN_WORKER_CHILD_NOT_VERIFIED')
      if (slot.closed || !authorized(parent) || !exactIntent()) throw new Error('POSTMAN_WORKER_START_STALE')
      if (durable) await changeBinding(parent, reservedId, current => {
        if (current !== reservedBinding) throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
        readyBinding = { ...current, state: 'ready', delivery: 'none' }
        return readyBinding
      })
      if (slot.closed || !authorized(parent) ||
          (durable && rowOf(parent.id)?.workers?.[reservedId] !== readyBinding))
        throw new Error('POSTMAN_WORKER_START_STALE')
      slot.verified = true
      slot.state = 'ready'
      slot.delivery = 'none'
      return { status: 'POSTMAN_WORKER_TASK_ACCEPTED', workerSessionId: reservedId, label,
        created: true, messageId: String(accepted.messageId), model: POSTMAN_WORKER_AGENT_OPTIONS.model,
        provider: POSTMAN_WORKER_PROVIDER }
    } catch (error) {
      // Even if DSH rolled back, do not release a persisted intent without proof.
      // A late completion must never replace a removed or different binding.
      // The selected drain releases only this child's Activation, preserving
      // the Session; failure leaves the original slot uncertain.
      try { await ctx.subagents.drainContinuableChildren(parent, [reservedId]) } catch {}
      if (durable && Object.hasOwn(rowOf(parent.id)?.workers ?? {}, reservedId)) {
        try { await changeBinding(parent, reservedId, current => {
          if ((current !== reservedBinding && current !== readyBinding) ||
              !['intent', 'ready'].includes(current.state))
            throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
          return { ...current, state: 'uncertain', delivery: 'unknown' }
        }) } catch {}
      } else if (!durable) { slot.state = 'uncertain'; slot.delivery = 'unknown' }
      return { status: durable ? 'POSTMAN_WORKER_BINDING_UNCERTAIN' : 'POSTMAN_WORKER_START_FAILED',
        workerSessionId: reservedId, diagnostic: diagnostic(error) }
    }
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
  const stopTool = defineTool({
    name: POSTMAN_WORKER_STOP_TOOL_NAME,
    description: 'Release only the selected Worker Activation and close its binding, retaining its Session.',
    parameters: { workerSessionId: { type: 'string' } }, output: output(),
    async execute(args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      const id = args?.workerSessionId
      if (id !== undefined && (typeof id !== 'string' || !id)) return { status: 'POSTMAN_WORKER_TARGET_UNKNOWN' }
      return admitted(parent, async () => {
      const group = groupFor(parent)
      const chosen = await enqueue(group, () => select(parent, id, group))
      if (!chosen.binding) {
        if (id && group.stopped.has(id)) return { status: 'POSTMAN_WORKER_ALREADY_STOPPED', workerSessionId: id }
        return id ? chosen : chosen.status === 'POSTMAN_WORKER_INTERRUPT_NO_ACTIVE_WORKER'
          ? { status: 'POSTMAN_WORKER_ALREADY_STOPPED' } : chosen
      }
      const slot = slotFor(group, chosen.binding)
      return enqueue(slot, async () => {
        if (slot.closed) return { status: 'POSTMAN_WORKER_ALREADY_STOPPED', workerSessionId: slot.id }
        if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
        const recovered = await reconcile(parent, slot, exec.signal)
        if (recovered && recovered !== 'POSTMAN_WORKER_DELIVERY_UNKNOWN' &&
            !(recovered === 'POSTMAN_WORKER_BINDING_UNCERTAIN' && slot.state === 'stopping'))
          return { status: recovered, workerSessionId: slot.id }
        try {
          if (durable) await changeBinding(parent, slot.id, current => ({ ...current, state: 'stopping' }))
          slot.state = 'stopping'
          await ctx.subagents.drainContinuableChildren(parent, [slot.id])
          // Remove exactly the same binding, never another Worker admitted later.
          if (durable) await contexts.changeRecord(parent.id, row => {
            if (!Object.hasOwn(row.workers ?? {}, slot.id) ||
                row.workers[slot.id]?.id !== slot.id || row.workers[slot.id].state !== 'stopping')
              throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
            const workers = { ...row.workers }
            delete workers[slot.id]
            return { ...row, workers }
          })
          slot.closed = true
          group.slots.delete(slot.id)
          group.stopped.add(slot.id)
          return { status: 'POSTMAN_WORKER_STOPPED', workerSessionId: slot.id,
            residentReleased: true, mappingRemoved: true, durableSessionDeleted: false }
        } catch (error) {
          return { status: 'POSTMAN_WORKER_STOP_FAILED', workerSessionId: slot.id, diagnostic: diagnostic(error) }
        }
      })
      })
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
  function liveSlot(caller, leaderId) {
    if (disposed || typeof caller?.id !== 'string' || ctx.agents.get(caller.id) !== caller ||
        caller.session?.header?.origin !== 'subagent' || caller.session.header.delegationDepth !== 1 ||
        caller.session.header.parentSession !== leaderId || !authorized(ctx.agents.get(leaderId))) return null
    const slot = leaders.get(leaderId)?.slots.get(caller.id)
    if (!slot || slot.closed || slot.state !== 'ready' ||
        (durable && (!Object.hasOwn(rowOf(leaderId)?.workers ?? {}, caller.id) ||
          rowOf(leaderId).workers[caller.id]?.id !== caller.id ||
          rowOf(leaderId).workers[caller.id].state !== 'ready')) ||
        (contexts && slot.context !== contexts.get(leaderId))) return null
    return slot
  }
  function ownerOf(caller, requestId) {
    const leaderId = caller?.session?.header?.parentSession
    const slot = liveSlot(caller, leaderId)
    return slot?.artifactRequests.has(requestId) ? leaderId : null
  }
  function ownsNotification(caller, leaderId) { return Boolean(liveSlot(caller, leaderId)) }
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
  async function prepareRestore(leaderId) {
    return pauseForOperation(leaderId)
  }
  function dispose() {
    disposed = true
    for (const group of leaders.values()) for (const slot of group.slots.values()) slot.closed = true
    leaders.clear()
  }
  return { taskTool, interruptTool, stopTool, listTool, ownerOf, ownsNotification,
    contextOf, pauseForOperation, prepareRestore, dispose }
}
