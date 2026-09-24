import { defineTool } from '@deepseek-ai/dsh-tools'
import { parsePostmanUserTurn } from './direct-current-turn.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createImplementationArtifactGrants, createImplementationArtifactApplyTool } from './implementation-artifact.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import {
  POSTMAN_BRIDGE_TOOL_ALLOWLIST, POSTMAN_BRIDGE_TOOL_NAME, POSTMAN_BRIDGE_STATUS_TOOL_NAME,
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

export function createPostmanBridgeTool(ctx, jobs) {
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
      let parsed
      try { parsed = parsePostmanUserTurn(args?.message) }
      catch (error) { return { status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED', diagnostic: String(error?.message ?? error) } }
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
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants)
  ctx.tools.register(createPostmanBridgeTool(ctx, jobs))
  ctx.tools.register(createPostmanBridgeStatusTool(ctx, jobs))
  ctx.effect(() => () => jobs.dispose(), 'dsh-postman-harness-bridge.background-jobs()')
  const worker = createPostmanWorkerTools(ctx, grants)
  ctx.tools.register(worker.taskTool)
  ctx.tools.register(worker.stopTool)
  ctx.tools.register(createImplementationArtifactApplyTool(ctx, grants, worker))
  ctx.effect(() => () => worker.dispose(), 'dsh-postman-harness-bridge.worker-mapping()')

  const boundaries = createPostmanBridgeBoundaryManager(sessionId => ctx.agents.get(sessionId))
  ctx.effect(() => () => boundaries.disposeAll(), 'dsh-postman-harness-bridge.boundary-manager()')
  ctx.on('agent/created', ({ agent }) => boundaries.install(agent))
  ctx.on('agent-preset/selected', sessionId => boundaries.refreshSession(sessionId))
  ctx.on('agent/disposed', ({ agent }) => boundaries.disposeAgent(agent))
  for (const agent of ctx.agents.list()) boundaries.install(agent)
}

export const POSTMAN_BRIDGE_VISIBLE_TOOLS = POSTMAN_BRIDGE_TOOL_ALLOWLIST
