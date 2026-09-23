import { randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parsePostmanUserTurn } from './direct-current-turn.js'
import {
  POSTMAN_BRIDGE_PROVIDER,
  POSTMAN_BRIDGE_AGENT_OPTIONS,
  POSTMAN_BRIDGE_TOOL_ALLOWLIST,
  POSTMAN_BRIDGE_TOOL_NAME,
  POSTMAN_WORKER_SCOPE_PROBE_TOOL_NAME,
  buildPostmanBridgeStartRequest,
  createPostmanBridgeBoundaryManager,
  isTopLevelPostmanLeader,
  postmanBridgeCallerAllowed,
  postmanWorkerScopeProbeCallerAllowed,
  postmanBridgeRestrictionForAgent,
  settleTrustedPostmanStatus,
} from './postman-bridge-core.js'

export const name = 'dsh-postman-harness-bridge'
export const inject = ['agents', 'subagents', 'tools']

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

function visibleToolNames(ctx, agent) {
  if (typeof ctx.tools?.schemas !== 'function') return []
  return ctx.tools.schemas(agent).map(tool => tool.name).sort()
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

export function createPostmanWorkerScopeProbeTool(ctx) {
  return defineTool({
    name: POSTMAN_WORKER_SCOPE_PROBE_TOOL_NAME,
    description: 'EXPERIMENT ONLY. Prove whether an ordinary spawn Luna child can use the shared preset write tool while write remains hidden from the exact Postman Leader runtime catalog. The host creates a unique marker name, verifies exact marker bytes, checks child lineage/tool visibility, removes the marker, and returns evidence.',
    parameters: {},
    output: output(),
    async execute(_args, exec) {
      const parent = requiredAgent(exec)
      if (!postmanWorkerScopeProbeCallerAllowed(parent)) {
        return {
          status: 'POSTMAN_WORKER_SCOPE_PROBE_CALLER_REJECTED',
          diagnostic: 'scope probe is available only to a top-level postman-leader agent',
        }
      }

      const cwd = parent.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        return {
          status: 'POSTMAN_WORKER_SCOPE_PROBE_CWD_REQUIRED',
          diagnostic: 'top-level Postman Leader has no usable cwd',
        }
      }

      const parentTools = visibleToolNames(ctx, parent)
      const parentWrite = ctx.tools.get('write', parent)
      const parentProbe = ctx.tools.get(POSTMAN_WORKER_SCOPE_PROBE_TOOL_NAME, parent)
      const forbiddenParentTools = ['write', 'edit', 'pwsh', 'bash', 'subagent', 'subagent_fork', 'workflow', 'todo_write']
        .filter(name => ctx.tools.get(name, parent) !== undefined)
      const parentBoundaryOk = forbiddenParentTools.length === 0 && parentProbe !== undefined
      if (!parentBoundaryOk) {
        return {
          status: 'POSTMAN_WORKER_SCOPE_PROBE_PARENT_BOUNDARY_FAILED',
          verdict: 'SPAWN_SCOPE_HYPOTHESIS_NOT_PROVEN',
          parentTools,
          parentWriteVisible: parentWrite !== undefined,
          forbiddenParentTools,
          probeVisible: parentProbe !== undefined,
        }
      }

      const nonce = randomUUID()
      const markerName = `.postman-worker-scope-probe-${nonce}.txt`
      const markerAbsolute = resolve(cwd, markerName)
      const markerText = `POSTMAN_WORKER_SCOPE_PROBE:${nonce}`
      let run
      let child
      let childTools = []
      let childPreset = null
      let childWriteVisible = false
      let childBridgeVisible = false
      let childProbeVisible = false
      let childStopReason = 'not-started'
      let childDiagnostic
      let markerObserved = null
      let result

      try {
        run = await ctx.subagents.start('spawn', {
          label: 'Postman Worker Scope Probe',
          parent,
          signal: exec.signal,
          agentOptions: { ...POSTMAN_BRIDGE_AGENT_OPTIONS },
          maxDepth: 1,
          toolFilter: { allow: ['write'] },
          persona: `You are a deterministic one-shot tool-scope probe.
You have exactly one intended capability: the write tool.
Call write exactly once with file_path=${JSON.stringify(markerName)} and content=${JSON.stringify(markerText)}.
Do not use any other path or content. After write succeeds, answer exactly PROBE_WRITE_DONE.`,
          prompt: [{
            type: 'text',
            text: 'Execute the fixed scope probe from your persona now. Do not explain or modify the task.',
          }],
        })
        child = run.localAgent
        if (child === undefined) {
          result = {
            status: 'POSTMAN_WORKER_SCOPE_PROBE_CHILD_UNAVAILABLE',
            verdict: 'SPAWN_SCOPE_HYPOTHESIS_NOT_PROVEN',
            childSessionId: String(run.id),
            parentTools,
          }
        } else {
          childTools = visibleToolNames(ctx, child)
          childWriteVisible = ctx.tools.get('write', child) !== undefined
          childBridgeVisible = ctx.tools.get(POSTMAN_BRIDGE_TOOL_NAME, child) !== undefined
          childProbeVisible = ctx.tools.get(POSTMAN_WORKER_SCOPE_PROBE_TOOL_NAME, child) !== undefined
          const presets = child.ctx?.get?.('agentPresets')
          childPreset = typeof presets?.composedPreset === 'function'
            ? presets.composedPreset(child.ctx) ?? null
            : child.session?.header?.agentPreset ?? null

          const childResult = await run.result
          childStopReason = childResult.stopReason
          childDiagnostic = childResult.diagnostic

          try {
            markerObserved = await readFile(markerAbsolute, 'utf8')
          } catch (error) {
            childDiagnostic = [
              childDiagnostic,
              `marker read failed: ${diagnostic(error)}`,
            ].filter(Boolean).join('; ')
          }

          const header = child.session?.header ?? {}
          const lineageOk = header.parentSession === parent.id
            && header.origin === 'subagent'
            && (header.delegationDepth ?? 0) === 1
          const childBoundaryOk = childWriteVisible
            && !childBridgeVisible
            && !childProbeVisible
          const executionOk = childStopReason === 'completed'
            && markerObserved === markerText
          const corePass = lineageOk && childBoundaryOk && executionOk

          result = {
            status: corePass
              ? 'POSTMAN_WORKER_SCOPE_PROBE_PASS'
              : 'POSTMAN_WORKER_SCOPE_PROBE_FAILED',
            verdict: corePass
              ? 'SPAWN_SUFFICIENT_FOR_SCOPE_HYPOTHESIS'
              : 'SPAWN_SCOPE_HYPOTHESIS_NOT_PROVEN',
            parent: {
              sessionId: parent.id,
              preset: parent.session?.header?.agentPreset ?? null,
              tools: parentTools,
              writeVisible: parentWrite !== undefined,
            },
            child: {
              sessionId: child.id,
              runId: String(run.id),
              preset: childPreset,
              tools: childTools,
              writeVisible: childWriteVisible,
              postmanBridgeVisible: childBridgeVisible,
              scopeProbeVisible: childProbeVisible,
              parentSession: header.parentSession ?? null,
              origin: header.origin ?? null,
              delegationDepth: header.delegationDepth ?? null,
              stopReason: childStopReason,
              ...(childDiagnostic === undefined ? {} : { diagnostic: childDiagnostic }),
            },
            marker: {
              relativePath: markerName,
              expected: markerText,
              actual: markerObserved,
              exactMatch: markerObserved === markerText,
            },
          }
        }
      } catch (error) {
        result = {
          status: 'POSTMAN_WORKER_SCOPE_PROBE_START_OR_EXECUTION_FAILED',
          verdict: 'SPAWN_SCOPE_HYPOTHESIS_NOT_PROVEN',
          parentTools,
          ...(child === undefined ? {} : {
            child: {
              sessionId: child.id,
              tools: childTools,
              writeVisible: childWriteVisible,
              postmanBridgeVisible: childBridgeVisible,
              scopeProbeVisible: childProbeVisible,
              stopReason: childStopReason,
            },
          }),
          diagnostic: diagnostic(error),
        }
      }

      const cleanupErrors = []
      if (run !== undefined) {
        await run.dispose().catch(error => {
          cleanupErrors.push(`child dispose: ${diagnostic(error)}`)
        })
      }
      await rm(markerAbsolute, { force: true }).catch(error => {
        cleanupErrors.push(`marker remove: ${diagnostic(error)}`)
      })
      let markerStillExists = false
      try {
        await stat(markerAbsolute)
        markerStillExists = true
        cleanupErrors.push('marker remove: marker still exists')
      } catch (error) {
        if (error?.code !== 'ENOENT') cleanupErrors.push(`marker verification: ${diagnostic(error)}`)
      }

      const cleanup = {
        childDisposed: run === undefined || !cleanupErrors.some(item => item.startsWith('child dispose:')),
        markerRemoved: !markerStillExists && !cleanupErrors.some(item => item.startsWith('marker')),
        errors: cleanupErrors,
      }

      if (cleanupErrors.length > 0) {
        ctx.logger.warn(`[postman-worker-scope-probe] cleanup warning: ${cleanupErrors.join('; ')}`)
        return {
          ...result,
          status: 'POSTMAN_WORKER_SCOPE_PROBE_CLEANUP_FAILED',
          verdict: 'SPAWN_SCOPE_HYPOTHESIS_NOT_PROVEN',
          cleanup,
        }
      }

      return { ...result, cleanup }
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
  ctx.tools.register(createPostmanWorkerScopeProbeTool(ctx))

  const boundaries = createPostmanBridgeBoundaryManager(sessionId => ctx.agents.get(sessionId))
  ctx.effect(
    () => () => boundaries.disposeAll(),
    'dsh-postman-harness-bridge.boundary-manager()',
  )
  ctx.on('agent/created', ({ agent }) => boundaries.install(agent))
  ctx.on('agent-preset/selected', sessionId => boundaries.refreshSession(sessionId))
  ctx.on('agent/disposed', ({ agent }) => boundaries.disposeAgent(agent))

  for (const agent of ctx.agents.list()) boundaries.install(agent)
}

export const POSTMAN_BRIDGE_VISIBLE_TOOLS = POSTMAN_BRIDGE_TOOL_ALLOWLIST
