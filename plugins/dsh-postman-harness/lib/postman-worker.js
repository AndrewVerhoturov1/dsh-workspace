import { defineTool } from '@deepseek-ai/dsh-tools'
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

export function buildPostmanWorkerStartRequest(parent, task, signal) {
  return {
    provider: POSTMAN_WORKER_PROVIDER,
    label: 'Postman Worker',
    signal,
    request: {
      parent,
      prompt: [{ type: 'text', text: task }],
      agentOptions: { ...POSTMAN_WORKER_AGENT_OPTIONS },
      persona: POSTMAN_WORKER_PERSONA,
      // No Worker-specific toolFilter: the child receives the shared preset,
      // except for existing host-enforced role boundaries.
    },
  }
}

/** One process-local active Worker per exact Leader Agent/Session. No restart registry. */
export function createPostmanWorkerTools(ctx) {
  const slots = new Map()

  function slotFor(parent) {
    let slot = slots.get(parent.id)
    if (slot === undefined) {
      slot = { childId: undefined, closed: false, tail: Promise.resolve() }
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
    },
    output: output(),
    async execute(args, exec) {
      const parent = exec?.agent
      if (!authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
      if (typeof args?.task !== 'string' || args.task.trim() === '') {
        return { status: 'POSTMAN_WORKER_TASK_INVALID' }
      }
      const slot = slotFor(parent)
      return enqueue(slot, async () => {
        if (slot.closed || !authorized(parent)) return { status: 'POSTMAN_WORKER_CALLER_REJECTED' }
        if (slot.childId !== undefined) {
          try {
            const messageId = await ctx.subagents.followup(parent, slot.childId,
              [{ type: 'text', text: args.task }], {
                source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
                signal: exec.signal,
              })
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
            buildPostmanWorkerStartRequest(parent, args.task, exec.signal))
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

  function dispose() {
    for (const slot of slots.values()) slot.closed = true
    slots.clear()
  }

  return { taskTool, stopTool, dispose }
}
