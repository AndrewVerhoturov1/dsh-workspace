import { defineTool } from '@deepseek-ai/dsh-tools'
import { parsePostmanUserTurn } from './direct-current-turn.js'
import {
  POSTMAN_BRIDGE_PROVIDER,
  POSTMAN_BRIDGE_AGENT_OPTIONS,
  POSTMAN_BRIDGE_TOOL_ALLOWLIST,
  POSTMAN_BRIDGE_TOOL_NAME,
  buildPostmanBridgeStartRequest,
  isTopLevelPostmanLeader,
  postmanBridgeCallerAllowed,
  postmanBridgeRestrictionForAgent,
  settleTrustedPostmanStatus,
} from './postman-bridge-core.js'

export const name = 'dsh-postman-harness-bridge'
export const inject = ['subagents', 'tools']

function requiredAgent(exec) {
  const agent = exec?.agent
  if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
    throw new Error('postman_bridge requires a calling Harness agent')
  }
  return agent
}

function textBlock(text) {
  return { type: 'text', text }
}

function output() {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        status: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [textBlock(JSON.stringify(value))],
  }
}

function diagnostic(error) {
  const text = String(error?.message ?? error ?? 'unknown error')
  return text.length <= 512 ? text : `${text.slice(0, 509)}...`
}

async function trustedStatusReader(ctx, child, signal) {
  const statusTool = ctx.tools.get('postman_current_turn_status', child)
  if (statusTool === undefined || typeof statusTool.execute !== 'function') {
    return { status: 'NO_JOB' }
  }
  return statusTool.execute({}, { agent: child, signal })
}

export function createPostmanBridgeTool(ctx) {
  return defineTool({
    name: POSTMAN_BRIDGE_TOOL_NAME,
    description: 'Delegate one model-authored exact @Postman or @PostmanAsk message through a fresh fixed Luna bridge subagent. Use @PostmanAsk for text research/review and @Postman for a durable ZIP/artifact. Use --chat <REQ> in message when continuing an already proven ChatGPT conversation. The bridge returns the trusted Direct Postman terminal receipt, not the child model prose.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'A complete new delegation message beginning with exact @Postman or @PostmanAsk. This is a model-authored delegation, not a copy of the human current user message.',
      },
    },
    output: output(),
    async execute(args, exec) {
      const parent = requiredAgent(exec)
      if (!postmanBridgeCallerAllowed(parent)) {
        return {
          status: 'POSTMAN_BRIDGE_CALLER_REJECTED',
          diagnostic: 'postman_bridge is available only to a top-level postman-leader agent',
        }
      }

      let parsed
      try {
        parsed = parsePostmanUserTurn(args.message)
      } catch (error) {
        return {
          status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED',
          diagnostic: diagnostic(error),
        }
      }

      let run
      try {
        run = await ctx.subagents.start(POSTMAN_BRIDGE_PROVIDER, buildPostmanBridgeStartRequest({
          parent,
          message: args.message,
          signal: exec.signal,
          transportKind: parsed.transportKind,
        }))
      } catch (error) {
        return {
          status: 'POSTMAN_BRIDGE_START_FAILED',
          transportKind: parsed.transportKind,
          bridgeProvider: POSTMAN_BRIDGE_PROVIDER,
          bridgeModel: POSTMAN_BRIDGE_AGENT_OPTIONS.model,
          diagnostic: diagnostic(error),
        }
      }

      const child = run.localAgent
      if (child === undefined) {
        await run.dispose().catch(() => undefined)
        return {
          status: 'POSTMAN_BRIDGE_CHILD_UNAVAILABLE',
          transportKind: parsed.transportKind,
          childSessionId: String(run.id),
        }
      }

      let childStopReason = 'error'
      let childDiagnostic
      try {
        try {
          const childResult = await run.result
          childStopReason = childResult.stopReason
          childDiagnostic = childResult.diagnostic
        } catch (error) {
          childDiagnostic = diagnostic(error)
        }

        const trusted = await settleTrustedPostmanStatus(
          () => trustedStatusReader(ctx, child, exec.signal),
          exec.signal,
        )
        return {
          ...trusted,
          transportKind: parsed.transportKind,
          childSessionId: String(run.id),
          bridgeProvider: POSTMAN_BRIDGE_AGENT_OPTIONS.provider,
          bridgeModel: POSTMAN_BRIDGE_AGENT_OPTIONS.model,
          childStopReason,
          ...(childDiagnostic === undefined ? {} : { childDiagnostic }),
        }
      } finally {
        await run.dispose().catch(() => undefined)
      }
    },
  })
}

export function installPostmanLeaderBoundary(agent) {
  const leader = isTopLevelPostmanLeader(agent)
  const restriction = postmanBridgeRestrictionForAgent(agent)
  agent.ctx.effect(
    () => agent.ctx.tools.restrict(restriction),
    leader
      ? 'dsh-postman-harness-bridge.leader-tool-boundary()'
      : 'dsh-postman-harness-bridge.non-leader-tool-boundary()',
  )
  return leader
}

export function apply(ctx) {
  ctx.tools.register(createPostmanBridgeTool(ctx))
  ctx.on('agent/created', ({ agent }) => installPostmanLeaderBoundary(agent))
}

export const POSTMAN_BRIDGE_VISIBLE_TOOLS = POSTMAN_BRIDGE_TOOL_ALLOWLIST
