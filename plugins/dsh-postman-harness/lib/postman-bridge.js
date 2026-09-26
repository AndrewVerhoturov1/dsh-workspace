import { defineTool } from '@deepseek-ai/dsh-tools'
import { parsePostmanUserTurn } from './direct-current-turn.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createImplementationArtifactGrants, createImplementationArtifactApplyTool } from './implementation-artifact.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { postmanTaskContexts } from './postman-task-context.js'
import {
  POSTMAN_BRIDGE_TOOL_ALLOWLIST, POSTMAN_BRIDGE_TOOL_NAME, POSTMAN_BRIDGE_STATUS_TOOL_NAME, POSTMAN_TASK_PREPARE_TOOL_NAME, POSTMAN_TASK_RESTORE_TOOL_NAME,
  createPostmanBridgeBoundaryManager, isTopLevelPostmanLeader,
  postmanBridgeCallerAllowed, postmanBridgeRestrictionForAgent,
} from './postman-bridge-core.js'

export const name = 'dsh-postman-harness-bridge'
export const inject = ['agents', 'subagents', 'tools']

function output() {
  return {
    schema: { type: 'object', additionalProperties: true,
      properties: { status: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

function authorized(exec, ctx) {
  const agent = exec?.agent
  return postmanBridgeCallerAllowed(agent) && ctx.agents.get(agent.id) === agent
}

export function createPostmanTaskPrepareTool(ctx, contexts = postmanTaskContexts) {
  return defineTool({
    name: POSTMAN_TASK_PREPARE_TOOL_NAME,
    description: 'Prepare one isolated task branch and clean worktree from current origin/preview for this Leader session.',
    parameters: {}, output: output(),
    async execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TASK_CALLER_REJECTED' }
      return contexts.prepare(exec.agent)
    },
  })
}

export function createPostmanTaskRestoreTool(ctx, contexts = postmanTaskContexts, { jobs, worker } = {}) {
  return defineTool({
    name: POSTMAN_TASK_RESTORE_TOOL_NAME,
    description: 'After a runner FAIL, explicitly discard only uncommitted changes in this Leader’s existing bound temporary task worktree and restore its exact remote branch HEAD; never recreate bindings, grants, or Workers.',
    parameters: {}, output: output(),
    async execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TASK_CALLER_REJECTED' }
      if (!contexts.reserveRestore(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      try {
        return await contexts.restore(exec.agent, {
          isBusy: id => Boolean(jobs?.hasActive(id)),
          beforeRestore: async id => worker ? await worker.prepareRestore(id) : true,
        })
      } finally { contexts.releaseRestore(exec.agent.id) }
    },
  })
}

export function createPostmanBridgeTool(ctx, jobs, contexts) {
  return defineTool({
    name: POSTMAN_BRIDGE_TOOL_NAME,
    description: 'Accept a fresh exact @Postman or @PostmanAsk delegation in a background Bridge job. Acceptance is not a Web result; read the trusted terminal via postman_bridge_status after POSTMAN_BRIDGE_READY.',
    parameters: { message: { type: 'string', required: true,
      description: 'Complete model-authored delegation beginning with exact @Postman or @PostmanAsk.' } },
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      if (exec.signal?.aborted) return { status: 'POSTMAN_BRIDGE_ADMISSION_ABORTED' }
      if (typeof contexts?.isRestoring === 'function' && contexts.isRestoring(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      if (typeof contexts?.hasActiveOperation === 'function' && contexts.hasActiveOperation(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      let parsed
      try { parsed = parsePostmanUserTurn(args?.message) }
      catch (error) { return { status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED', diagnostic: String(error?.message ?? error) } }
      if (contexts && !contexts.get(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
      if (typeof contexts?.isRestoring === 'function' && contexts.isRestoring(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      if (typeof contexts?.hasActiveOperation === 'function' && contexts.hasActiveOperation(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      return jobs.accept(exec.agent, args.message, parsed.transportKind)
    },
  })
}

export function createPostmanBridgeStatusTool(ctx, jobs) {
  return defineTool({
    name: POSTMAN_BRIDGE_STATUS_TOOL_NAME,
    description: 'Read the authoritative trusted Direct Postman terminal of this Leader session background Bridge job.',
    parameters: { bridge_job_id: { type: 'string', required: true,
      description: 'Exact bridgeJobId from POSTMAN_BRIDGE_ACCEPTED or POSTMAN_BRIDGE_READY.' } },
    output: output(),
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      return jobs.status(exec.agent, args?.bridge_job_id)
    },
  })
}

export function installPostmanLeaderBoundary(agent) {
  const leader = isTopLevelPostmanLeader(agent)
  const restriction = postmanBridgeRestrictionForAgent(agent)
  agent.ctx.effect(() => agent.ctx.tools.restrict(restriction),
    leader ? 'dsh-postman-harness-bridge.leader-tool-boundary()'
      : 'dsh-postman-harness-bridge.non-leader-tool-boundary()')
  return leader
}

export function apply(ctx) {
  const coordinator = createPostmanBridgeLaunchCoordinator()
  const grants = createImplementationArtifactGrants()
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants, postmanTaskContexts)
  ctx.tools.register(createPostmanTaskPrepareTool(ctx))
  ctx.tools.register(createPostmanBridgeTool(ctx, jobs, postmanTaskContexts))
  ctx.tools.register(createPostmanBridgeStatusTool(ctx, jobs))
  ctx.effect(() => () => jobs.dispose(), 'dsh-postman-harness-bridge.background-jobs()')
  const worker = createPostmanWorkerTools(ctx, grants, postmanTaskContexts)
  ctx.tools.register(createPostmanTaskRestoreTool(ctx, postmanTaskContexts, { jobs, worker }))
  ctx.tools.register(worker.taskTool)
  ctx.tools.register(worker.interruptTool)
  ctx.tools.register(worker.stopTool)
  ctx.tools.register(createImplementationArtifactApplyTool(ctx, grants, worker, { taskContexts: postmanTaskContexts, jobs }))
  ctx.effect(() => () => worker.dispose(), 'dsh-postman-harness-bridge.worker-mapping()')
  ctx.effect(() => () => postmanTaskContexts.dispose(), 'dsh-postman-harness-bridge.task-contexts()')

  const boundaries = createPostmanBridgeBoundaryManager(sessionId => ctx.agents.get(sessionId))
  ctx.effect(() => () => boundaries.disposeAll(), 'dsh-postman-harness-bridge.boundary-manager()')
  ctx.on('agent/created', ({ agent }) => boundaries.install(agent))
  ctx.on('agent-preset/selected', sessionId => boundaries.refreshSession(sessionId))
  ctx.on('agent/disposed', ({ agent }) => boundaries.disposeAgent(agent))
  for (const agent of ctx.agents.list()) boundaries.install(agent)
}

export const POSTMAN_BRIDGE_VISIBLE_TOOLS = POSTMAN_BRIDGE_TOOL_ALLOWLIST
