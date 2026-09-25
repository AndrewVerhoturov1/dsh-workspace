import { defineTool } from '@deepseek-ai/dsh-tools'
import { IMPLEMENTATION_REPOSITORY } from './implementation-artifact.js'
import {
  POSTMAN_WORKER_TOOL_NAME,
  POSTMAN_WORKER_STOP_TOOL_NAME,
  isTopLevelPostmanLeader,
} from './postman-bridge-core.js'

export const POSTMAN_WORKER_PROVIDER = 'spawn'
export const POSTMAN_WORKER_AGENT_OPTIONS = Object.freeze({ provider: 'codex', model: 'gpt-6-luna' })
export const POSTMAN_WORKER_PERSONA = `You are Postman Worker, a local continuable Luna subagent working under your direct parent, Postman Leader (Sol).
Complete each assigned local task using the tools available to you. Follow the repository's instructions and the parent's task boundaries. You are not Postman Bridge: never use Direct Postman or imitate its transport. Do not use @Postman or @PostmanAsk as a way around your parent's boundaries.
When you have a substantive result, use your child-scoped report tool to tell your Leader what you did, what you checked, and any errors. Send a concise, factual, self-contained final report for each task before finishing the turn. A report is not the end of your Worker session: remain available for later tasks in this same durable child session.`

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

/** One process-local active Worker per exact Leader Agent/Session. No restart registry. */
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
            const messageId = await ctx.subagents.followup(parent, slot.childId,
              [{ type: 'text', text: task }], {
                source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
                signal: exec.signal,
              })
            if (args.artifactRequestId !== undefined) slot.artifactRequests.add(args.artifactRequestId)
            return {
              status: 'POSTMAN_WORKER_TASK_ACCEPTED', workerSessionId: slot.childId,
              created: false, messageId: String(messageId),
              model: POSTMAN_WORKER_AGENT_OPTIONS.model, provider: POSTMAN_WORKER_PROVIDER,
            }
          } catch (error) {
            // Preserve the mapping: admission failure does not prove that the
            // durable child is gone, and a retry must not silently create another.
            return { status: 'POSTMAN_WORKER_FOLLOWUP_FAILED', workerSessionId: slot.childId,
              diagnostic: diagnostic(error) }
          }
        }
        let accepted
        try {
          accepted = await ctx.subagents.startContinuable(
            buildPostmanWorkerStartRequest(parent, task, exec.signal,
              postmanWorkerDeniedTools(ctx.tools)))
        } catch (error) {
          // Before inbox admission Harness rolls back the child. Keep this
          // empty slot so already queued calls can retry without losing mapping.
          return { status: 'POSTMAN_WORKER_START_FAILED', diagnostic: diagnostic(error) }
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

  const stopTool = defineTool({
    name: POSTMAN_WORKER_STOP_TOOL_NAME,
    description: 'Stop the active local Worker for this exact Postman Leader. Drain its resident Activation and forget the active mapping; keep the durable child Session. Safe to call again.',
    parameters: {},
    output: output(),
    async execute(_args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      const slot = slots.get(parent.id)
      if (slot === undefined) return { status: 'POSTMAN_WORKER_ALREADY_STOPPED' }
      return enqueue(slot, async () => {
        if (slot.closed) return { status: 'POSTMAN_WORKER_ALREADY_STOPPED' }
        if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
        const childId = slot.childId
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
        !slot.artifactRequests.has(requestId) || !authorized(ctx.agents.get(leaderId))) return null
    if (contexts && slots.get(leaderId)?.context !== contexts.get(leaderId)) return null
    return leaderId
  }

  function contextOf(leaderId) { return slots.get(leaderId)?.context ?? null }

  async function prepareRestore(leaderId) {
    const slot = slots.get(leaderId)
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

  return { taskTool, stopTool, ownerOf, contextOf, prepareRestore, dispose }
}
