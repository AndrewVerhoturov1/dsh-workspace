import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import {
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  isTopLevelPostmanLeader,
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

export function buildPostmanWorkerStartRequest(parent, task, signal, deniedTools) {
  if (!Array.isArray(deniedTools) || deniedTools.length === 0 ||
      deniedTools.some(name => typeof name !== 'string' || !name.startsWith('postman_'))) {
    throw new Error('POSTMAN_WORKER_TRANSPORT_BOUNDARY_REQUIRED')
  }
  return {
    provider: POSTMAN_WORKER_PROVIDER,
    label: 'Postman Worker',
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

/** Process-local slot serializes live Worker calls; the durable registry owns the exact Leader-to-child binding across restarts. */
export function createPostmanWorkerTools(ctx, grants, contexts) {
  const slots = new Map()

  function slotFor(parent) {
    let slot = slots.get(parent.id)
    if (slot === undefined) {
      slot = { childId: undefined, closed: false, artifactRequests: new Set(), tail: Promise.resolve() }
      slots.set(parent.id, slot)
    }
    return slot
  }

  function enqueue(slot, action) {
    const result = slot.tail.then(action)
    slot.tail = result.then(() => undefined, () => undefined)
    return result
  }

  const durable = typeof contexts?.record === 'function' && typeof contexts?.changeRecord === 'function'
  const rowOf = id => durable ? contexts.record(id) : null
  async function changeWorker(id, fn) {
    if (durable) await contexts.changeRecord(id, row => ({ ...row, worker: fn(row.worker) }))
  }
  async function childExists(parent, id, signal) {
    const entries = await ctx.subagents.listChildren(parent.id, signal)
    const matches = entries.filter(item => item.id === id)
    if (matches.length !== 1 || matches[0].kind !== 'child' || matches[0].mode !== 'continuable')
      return false
    return true
  }
  async function reconcile(parent, slot, signal) {
    if (!durable || slot.childId) return null
    const saved = rowOf(parent.id)?.worker
    if (!saved) return null
    if (saved.state === 'stopping' || saved.state === 'uncertain') return 'POSTMAN_WORKER_BINDING_UNCERTAIN'
    try {
      if (!await childExists(parent, saved.id, signal)) return 'POSTMAN_WORKER_BINDING_UNCERTAIN'
      if (saved.state === 'intent') {
        await changeWorker(parent.id, worker => ({ ...worker, state: 'ready', delivery: 'unknown' }))
      }
      slot.childId = saved.id
      slot.artifactRequests = new Set(saved.artifactRequests)
      return saved.delivery === 'pending' || saved.delivery === 'unknown'
        ? 'POSTMAN_WORKER_DELIVERY_UNKNOWN' : null
    } catch { return 'POSTMAN_WORKER_BINDING_UNCERTAIN' }
  }

  function authorized(parent) {
    return isTopLevelPostmanLeader(parent) && ctx.agents.get(parent.id) === parent
  }

  const taskTool = defineTool({
    name: POSTMAN_WORKER_TOOL_NAME,
    description: "Accept a local task for this Postman Leader's continuable Luna Worker. First call creates it; later calls enqueue in the same durable session. Acceptance is not completion: wait for the child-scoped report before treating the result as done.",
    parameters: {
      task: { type: 'string', required: true, description: 'The complete local task for the Worker.' },
      artifactRequestId: { type: 'string', description: 'Trusted artifact REQ, used only after a separate Leader decision.' },
    },
    output: output(),
    async execute(args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      if (typeof args?.task !== 'string' || args.task.trim() === '') {
        return { status: 'POSTMAN_WORKER_TASK_INVALID' }
      }
      if (args.artifactRequestId !== undefined && typeof args.artifactRequestId !== 'string') {
        return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED' }
      }
      if (contexts && !contexts.get(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
      if (typeof contexts?.isRestoring === 'function' && contexts.isRestoring(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      if (typeof contexts?.hasActiveOperation === 'function' && contexts.hasActiveOperation(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      const slot = slotFor(parent)
      return enqueue(slot, async () => {
        if (slot.closed || !authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
        const context = contexts?.get(parent.id)
        if (contexts && !context) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
        // Calls admitted before restore reservation must finish; reservation blocks only new admissions.
        if (slot.context && slot.context !== context) return { status: 'POSTMAN_TASK_CONTEXT_MISMATCH' }
        slot.context = context
        const recovery = durable ? await reconcile(parent, slot, exec.signal) : null
        const saved = rowOf(parent.id)?.worker
        if (recovery || (saved && (saved.state !== 'ready' || saved.delivery !== 'none')))
          return { status: recovery ?? 'POSTMAN_WORKER_DELIVERY_UNKNOWN', workerSessionId: saved?.id }
        let task = context ? `Use the existing Leader task branch ${context.branch} and worktree ${context.worktree} for repository changes; do not create another branch or worktree. Follow REPO_POLICY.md. Keep normal coding, shell, research, and web tools available as needed; do not make repository changes outside the bound worktree. Leader task: ${args.task}` : args.task
        if (args.artifactRequestId !== undefined) {
          const grant = await grants?.resolve(parent.id, args.artifactRequestId)
          if (grant?.repository !== IMPLEMENTATION_REPOSITORY) {
            return { status: 'POSTMAN_WORKER_ARTIFACT_REJECTED' }
          }
          task = `Trusted Host artifact REQ: ${grant.requestId}. The ZIP path is not a model-authored authority; never pass a path from this message to the runner. Follow REPO_POLICY.md and system/implementation-package-workflow.md. ${context ? `Use the existing Leader task branch ${context.branch} and worktree ${context.worktree}; do not create another branch/worktree. Ensure this worktree is clean at the published REQ commit before application. Then call implementation_artifact_apply({requestId: ${JSON.stringify(grant.requestId)}, worktree: ${JSON.stringify(context.worktree)}});` : `Create a fresh clean temporary task worktree from current origin/preview after checking refs, ownership and worktrees. Then call implementation_artifact_apply({requestId: ${JSON.stringify(grant.requestId)}, worktree: <your clean worktree>});`} the Host supplies its trusted ZIP. Inspect real status/diff/tests/affectedPaths/warnings. On runner FAIL, do not repair the package: report code, stage, diagnosticsZip, worktree and evidence. On PASS, report verification and await the Leader's separate publication decision. Leader task: ${args.task}`
        }
        if (slot.childId !== undefined) {
          try {
            if (durable) await changeWorker(parent.id, worker => ({ ...worker, delivery: 'pending' }))
            const messageId = await ctx.subagents.followup(parent, slot.childId,
              [{ type: 'text', text: task }], {
                source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
                signal: exec.signal,
              })
            if (durable) await changeWorker(parent.id, worker => ({ ...worker, delivery: 'none',
              artifactRequests: args.artifactRequestId === undefined ? worker.artifactRequests
                : [...new Set([...worker.artifactRequests, args.artifactRequestId])] }))
            if (args.artifactRequestId !== undefined) slot.artifactRequests.add(args.artifactRequestId)
            return {
              status: 'POSTMAN_WORKER_TASK_ACCEPTED', workerSessionId: slot.childId,
              created: false, messageId: String(messageId),
              model: POSTMAN_WORKER_AGENT_OPTIONS.model, provider: POSTMAN_WORKER_PROVIDER,
            }
          } catch (error) {
            if (durable && rowOf(parent.id)?.worker?.delivery === 'pending') {
              try { await changeWorker(parent.id, worker => ({ ...worker, delivery: 'unknown' })) } catch {}
            }
            // Preserve the mapping: admission failure does not prove that the
            // durable child is gone, and a retry must not silently create another.
            return { status: 'POSTMAN_WORKER_FOLLOWUP_FAILED', workerSessionId: slot.childId,
              diagnostic: diagnostic(error) }
          }
        }
        let accepted
        const reservedId = durable ? randomUUID() : null
        try {
          if (durable) await changeWorker(parent.id, current => {
            if (current) throw new Error('POSTMAN_WORKER_BINDING_EXISTS')
            return { id: reservedId, state: 'intent', delivery: 'pending', artifactRequests: [] }
          })
          accepted = await ctx.subagents.startContinuable({
            ...buildPostmanWorkerStartRequest(parent, task, exec.signal,
              postmanWorkerDeniedTools(ctx.tools)),
            ...(reservedId ? { childId: reservedId } : {}),
          })
          if (reservedId && String(accepted.childId) !== reservedId)
            throw new Error('POSTMAN_WORKER_CHILD_ID_MISMATCH')
          if (durable && !await childExists(parent, reservedId, exec.signal))
            throw new Error('POSTMAN_WORKER_CHILD_NOT_VERIFIED')
          if (durable) await changeWorker(parent.id, current => {
            if (current?.id !== reservedId || current.state !== 'intent')
              throw new Error('POSTMAN_WORKER_BINDING_CHANGED')
            return { ...current, state: 'ready', delivery: 'none',
              artifactRequests: args.artifactRequestId !== undefined ? [args.artifactRequestId] : [] }
          })
        } catch (error) {
          // Before inbox admission Harness rolls back the child. Keep this
          // empty slot so already queued calls can retry without losing mapping.
          return { status: durable && rowOf(parent.id)?.worker ? 'POSTMAN_WORKER_BINDING_UNCERTAIN'
            : 'POSTMAN_WORKER_START_FAILED', diagnostic: diagnostic(error) }
        }
        slot.childId = String(accepted.childId)
        if (slot.closed || !authorized(parent)) {
          try {
            await ctx.subagents.drainContinuableChildren(parent, [accepted.childId])
            return { status: 'POSTMAN_WORKER_PARENT_UNAVAILABLE', workerSessionId: slot.childId }
          } catch (error) {
            return { status: 'POSTMAN_WORKER_PARENT_UNAVAILABLE', workerSessionId: slot.childId,
              diagnostic: diagnostic(error) }
          }
        }
        if (args.artifactRequestId !== undefined) slot.artifactRequests.add(args.artifactRequestId)
        return {
          status: 'POSTMAN_WORKER_TASK_ACCEPTED', workerSessionId: slot.childId,
          created: true, messageId: String(accepted.messageId),
          model: POSTMAN_WORKER_AGENT_OPTIONS.model, provider: POSTMAN_WORKER_PROVIDER,
        }
      })
    },
  })

  const interruptTool = defineTool({
    name: POSTMAN_WORKER_INTERRUPT_TOOL_NAME,
    description: "Queue a replacement task for this Leader's existing Worker. Finish the current model/tool step without cancellation, then start the next round with all queued messages in FIFO order.",
    parameters: { task: { type: 'string', required: true, description: 'The next task for the same Worker session.' } },
    output: output(),
    async execute(args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      if (typeof args?.task !== 'string' || args.task.trim() === '') return { status: 'POSTMAN_WORKER_TASK_INVALID' }
      if (contexts && !contexts.get(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
      if (contexts?.isRestoring?.(parent.id) || contexts?.hasActiveOperation?.(parent.id))
        return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      const slot = slotFor(parent)
      return enqueue(slot, async () => {
        if (slot.closed || !authorized(parent)) return { status: 'POSTMAN_WORKER_INTERRUPT_NO_ACTIVE_WORKER' }
        const context = contexts?.get(parent.id)
        if (contexts && !context) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
        if (contexts?.isRestoring?.(parent.id) || contexts?.hasActiveOperation?.(parent.id))
          return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
        if (slot.context && slot.context !== context) return { status: 'POSTMAN_TASK_CONTEXT_MISMATCH' }
        slot.context = context
        const recovery = durable ? await reconcile(parent, slot, exec.signal) : null
        const saved = rowOf(parent.id)?.worker
        if (recovery || (saved && (saved.state !== 'ready' || saved.delivery !== 'none')))
          return { status: recovery ?? 'POSTMAN_WORKER_DELIVERY_UNKNOWN', workerSessionId: saved?.id }
        if (!slot.childId) return { status: 'POSTMAN_WORKER_INTERRUPT_NO_ACTIVE_WORKER' }
        const childId = slot.childId
        const task = (context ? 'Use the existing Leader task branch ' + context.branch +
          ' and worktree ' + context.worktree + ' for repository changes; do not create another branch or worktree. Follow REPO_POLICY.md. ' : '') +
          'Postman Leader follow-up for the next round (do not cancel the current model/tool step): ' + args.task
        try {
          if (durable) await changeWorker(parent.id, worker => ({ ...worker, delivery: 'pending' }))
          const messageId = await ctx.subagents.followup(parent, childId, [{ type: 'text', text: task }], {
            source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id }, signal: exec.signal,
          })
          if (durable) await changeWorker(parent.id, worker => ({ ...worker, delivery: 'none' }))
          return { status: 'POSTMAN_WORKER_INTERRUPT_TASK_ACCEPTED', workerSessionId: childId,
            created: false, messageId: String(messageId), interruptRequested: false,
            mappingPreserved: true, model: POSTMAN_WORKER_AGENT_OPTIONS.model,
            provider: POSTMAN_WORKER_PROVIDER }
        } catch (error) {
          if (durable && rowOf(parent.id)?.worker?.delivery === 'pending') {
            try { await changeWorker(parent.id, worker => ({ ...worker, delivery: 'unknown' })) } catch {}
          }
          return { status: 'POSTMAN_WORKER_INTERRUPT_DELIVERY_FAILED', workerSessionId: childId,
            interruptRequested: false, mappingPreserved: true, diagnostic: diagnostic(error) }
        }
      })
    },
  })
  const stopTool = defineTool({
    name: POSTMAN_WORKER_STOP_TOOL_NAME,
    description: 'Stop the active local Worker for this exact Postman Leader. Drain its resident Activation and forget the active mapping; keep the durable child Session. Safe to call again.',
    parameters: {},
    output: output(),
    async execute(_args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      const existed = slots.has(parent.id)
      const slot = slotFor(parent)
      const recovery = durable ? await reconcile(parent, slot, exec.signal) : null
      if (recovery) return { status: recovery, workerSessionId: rowOf(parent.id)?.worker?.id }
      if (!existed && !rowOf(parent.id)?.worker)
        return { status: 'POSTMAN_WORKER_ALREADY_STOPPED' }
      return enqueue(slot, async () => {
        if (slot.closed) return { status: 'POSTMAN_WORKER_ALREADY_STOPPED' }
        if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
        const childId = slot.childId
        if (durable && rowOf(parent.id)?.worker) await changeWorker(parent.id, worker => ({ ...worker, state: 'stopping' }))
        if (childId !== undefined) {
          try {
            await ctx.subagents.drainContinuableChildren(parent, [childId])
          } catch (error) {
            // Keep the mapping until teardown is confirmed; do not orphan a
            // potentially resident Activation or create a second active Worker.
            return { status: 'POSTMAN_WORKER_STOP_FAILED', workerSessionId: childId,
              diagnostic: diagnostic(error) }
          }
        }
        if (durable) await changeWorker(parent.id, () => null)
        slot.closed = true
        if (slots.get(parent.id) === slot) slots.delete(parent.id)
        return { status: 'POSTMAN_WORKER_STOPPED', workerSessionId: childId ?? null,
          residentReleased: true, mappingRemoved: true, durableSessionDeleted: false }
      })
    },
  })

  function ownerOf(caller, requestId) {
    if (typeof caller?.id !== 'string' || caller.session?.header?.origin !== 'subagent' ||
        caller.session.header.delegationDepth !== 1) return null
    const leaderId = caller.session.header.parentSession
    const slot = slots.get(leaderId)
    if (!slot || slot.closed || slot.childId !== caller.id ||
        (durable && (rowOf(leaderId)?.worker?.id !== caller.id || rowOf(leaderId)?.worker?.state !== 'ready')) ||
        !slot.artifactRequests.has(requestId) || !authorized(ctx.agents.get(leaderId))) return null
    if (contexts && slots.get(leaderId)?.context !== contexts.get(leaderId)) return null
    return leaderId
  }

  function ownsNotification(caller, leaderId) {
    const slot = slots.get(leaderId)
    return Boolean(slot && !slot.closed && slot.childId === caller.id &&
      (!durable || (rowOf(leaderId)?.worker?.id === caller.id &&
        rowOf(leaderId)?.worker?.state === 'ready')) &&
      (!contexts || (slot.context && slot.context === contexts.get(leaderId))))
  }

  function contextOf(leaderId) { return slots.get(leaderId)?.context ?? null }

  async function prepareRestore(leaderId) {
    const slot = slots.get(leaderId)
    if (durable && rowOf(leaderId)?.worker && (!slot?.childId ||
        slot.childId !== rowOf(leaderId).worker.id ||
        rowOf(leaderId).worker.state !== 'ready' ||
        rowOf(leaderId).worker.delivery !== 'none')) return false
    if (!slot) return true
    const pendingTasks = slot.tail
    try { await pendingTasks } catch { return false }
    if (slot.closed) return true
    if (!slot.childId) return true
    try {
      await ctx.subagents.drainContinuableChildren(ctx.agents.get(leaderId), [slot.childId])
      // Drain only the resident activation; keep this exact durable child mapping
      // so the next task continues in the same Worker Session after restore.
      return true
    } catch { return false }
  }

  function dispose() {
    for (const slot of slots.values()) slot.closed = true
    slots.clear()
  }

  return { taskTool, interruptTool, stopTool, ownerOf, ownsNotification, contextOf, prepareRestore, dispose }
}
