import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { createPtcAdapter, SOL_WORKER_PROFILE } from './ptc-adapter.js'
import { CurrentAttachmentStore, createPostmanInputFilesTool, postmanInputGrants } from './postman-input-files.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parsePostmanUserTurn } from './direct-current-turn.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createImplementationArtifactGrants, createImplementationArtifactApplyTool } from './implementation-artifact.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { postmanTaskContexts, initializePostmanTaskContexts, releasePostmanTaskContexts } from './postman-task-context.js'
import { sharedPostmanTaskRegistry, closeSharedPostmanTaskRegistry } from './postman-task-registry.js'
import {
  POSTMAN_BRIDGE_TOOL_ALLOWLIST, POSTMAN_BRIDGE_TOOL_NAME, POSTMAN_BRIDGE_STATUS_TOOL_NAME, POSTMAN_BRIDGE_LIST_TOOL_NAME, POSTMAN_BRIDGE_STOP_TOOL_NAME, POSTMAN_TEAM_STATUS_TOOL_NAME, POSTMAN_CHILD_NOTIFY_TOOL_NAME, POSTMAN_TASK_PREPARE_TOOL_NAME, POSTMAN_TASK_RESTORE_TOOL_NAME, POSTMAN_TASK_CLOSE_TOOL_NAME, POSTMAN_YIELD_TOOL_NAME,
  createPostmanBridgeBoundaryManager, isTopLevelPostmanSupervisor, isTopLevelPostmanPtcLeader,
  postmanBridgeCallerAllowed, postmanBridgeRestrictionForAgent, postmanPtcDirectCallGuard,
} from './postman-bridge-core.js'

export const name = 'dsh-postman-harness-bridge'
export const Config = z.object({
  localDevelopment: z.boolean().default(false),
  fastBudget: z.object({ hardLimit: z.number().int().min(8).max(60).default(60) }).prefault({}),
}).prefault({})
export const inject = ['agents', 'subagents', 'tools', 'storageDomain', 'attachments', 'fs']

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

export function createPostmanTaskCloseTool(ctx, contexts = postmanTaskContexts, { jobs } = {}) {
  return defineTool({
    name: POSTMAN_TASK_CLOSE_TOOL_NAME,
    description: 'Explicitly retire this settled Leader task binding, including after external merge/cleanup removed its worktree. Retire child bindings first. Active/queued/uncertain work rejects close. No Git cleanup or success claim; this Session may then prepare an independent task.',
    parameters: {}, output: output(),
    async execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TASK_CALLER_REJECTED' }
      return contexts.close(exec.agent, {
        isBusy: id => Boolean(jobs?.hasActive(id)),
        beforeClose: async id => {
          // Missing mappings are not proof: refuse live/queued or unreadable orphans.
          if (typeof ctx.subagents?.listDescendants !== 'function') return false
          const descendants = await ctx.subagents.listDescendants(id, exec.signal)
          for (const child of descendants) {
            if (child.kind !== 'child' || child.activity !== 'inactive' || ctx.agents.get(child.id)) return false
            if (child.mode === 'continuable') {
              const saved = await ctx.get?.('sessionPersistence')?.inspect?.(child.id, exec.signal)
              if (!saved?.events?.some(event => event.type === 'subagent/closed')) return false
            }
          }
          return true
        },
      })
    },
  })
}

export function createPostmanTaskRestoreTool(ctx, contexts = postmanTaskContexts, { jobs, worker } = {}) {
  return defineTool({
    name: POSTMAN_TASK_RESTORE_TOOL_NAME,
    description: 'After a runner FAIL, restore only uncommitted changes (localDevelopment preserves a private recovery copy first) in this Leader’s existing bound temporary task worktree and restore its exact remote branch HEAD; never recreate bindings, grants, or Workers.',
    parameters: {}, output: output(),
    async execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TASK_CALLER_REJECTED' }
      return contexts.restore(exec.agent, {
        isBusy: id => Boolean(jobs?.hasActive(id)),
        beforeRestore: async id => worker ? await worker.prepareRestore(id) : true,
      })
    },
  })
}

export function createPostmanBridgeTool(ctx, jobs, contexts) {
  return defineTool({
    name: POSTMAN_BRIDGE_TOOL_NAME,
    description: 'Accept a fresh exact @Postman, @PostmanAsk or @PostmanImage delegation in a background Bridge job. Acceptance is not a Web result; read the trusted terminal via postman_bridge_status after POSTMAN_BRIDGE_READY.',
    parameters: { message: { type: 'string', required: true,
      description: 'Complete model-authored delegation beginning with exact @Postman, @PostmanAsk or @PostmanImage.' } },
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
      if (parsed.inputFiles?.length && !postmanInputGrants.owns(exec.agent, contexts.get(exec.agent.id), parsed.inputFiles))
        return { status: 'POSTMAN_INPUT_PROVENANCE_REJECTED' }
      if (typeof contexts?.isRestoring === 'function' && contexts.isRestoring(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      if (typeof contexts?.hasActiveOperation === 'function' && contexts.hasActiveOperation(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      const inputBinding = parsed.inputFiles?.length
        ? postmanInputGrants.pin(exec.agent, contexts.get(exec.agent.id), parsed.inputFiles) : undefined
      try {
        const result = await jobs.accept(exec.agent, args.message, parsed.transportKind, inputBinding)
        if (result.status !== 'POSTMAN_BRIDGE_ACCEPTED') postmanInputGrants.unpin(inputBinding)
        return result
      } catch (error) { postmanInputGrants.unpin(inputBinding); throw error }
    },
  })
}

export function createPostmanBridgeStatusTool(ctx, jobs) {
  return defineTool({
    name: POSTMAN_BRIDGE_STATUS_TOOL_NAME,
    description: 'Read the authoritative trusted Direct Postman terminal of this Leader session background Bridge job.',
    parameters: { bridge_job_id: { type: 'string', required: true,
      description: 'Exact bridgeJobId from POSTMAN_BRIDGE_ACCEPTED or POSTMAN_BRIDGE_READY.' },
      retrySync: { type: 'boolean', description: 'Retry only local task publication synchronization; never send Direct again.' },
      recover: { type: 'boolean', description: 'Request one same-chat recovery. Host reads exact Direct capability and Direct durably claims the one-shot budget; no prompt/state arguments.' } },
    output: output(),
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      const status = await jobs.status(exec.agent, args?.bridge_job_id, args?.retrySync === true, args?.recover === true)
      const terminalResult = status?.result
      const details = terminalResult?.details
      const journal = details?.transportEventJournal
      if (Array.isArray(journal) && journal.length > 0) {
        const summary = { eventCount: journal.length, droppedCount: journal.length }
        const last = journal.at(-1)
        if (last && typeof last === 'object') {
          const fields = ['timestamp', 'eventId', 'type', 'phase', 'code', 'reason', 'templateId']
          const event = Object.fromEntries(fields.filter(key => Object.hasOwn(last, key) &&
            (typeof last[key] === 'string' || typeof last[key] === 'number' || typeof last[key] === 'boolean'))
            .map(key => [key, last[key]]))
          if (Object.keys(event).length) summary.lastEvent = event
        }
        const { transportEventJournal: _journal, ...compactDetails } = details
        return { ...status, result: { ...terminalResult,
          details: { ...compactDetails, transportEventJournalSummary: summary } } }
      }
      return status
    },
  })
}

export function createPostmanBridgeListTool(ctx, jobs) {
  return defineTool({
    name: POSTMAN_BRIDGE_LIST_TOOL_NAME,
    description: 'Observe all Bridge operations and exact slot occupancy for this Leader. Read-only: no recovery, child resume, Direct Send, synchronization or grant registration.',
    parameters: {}, output: output(),
    async execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      return jobs.list(exec.agent)
    },
  })
}

export function createPostmanBridgeStopTool(ctx, jobs) {
  return defineTool({
    name: POSTMAN_BRIDGE_STOP_TOOL_NAME,
    description: 'Request cancellation of one exact owned live Bridge job. Not proof of NOT_SENT; trusted Direct terminal remains authoritative. No recovery or Web resend.',
    parameters: { bridge_job_id: { type: 'string', required: true, description: 'Exact owned bridgeJobId.' } },
    output: output(),
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      return jobs.stop(exec.agent, args.bridge_job_id)
    },
  })
}

export function createPostmanTeamStatusTool(ctx, contexts, worker, jobs) {
  return defineTool({
    name: POSTMAN_TEAM_STATUS_TOOL_NAME,
    description: 'Compact read-only snapshot of this Leader task and team for routing. No recovery, synchronization, journals, full ledger/results or completion polling; idle is not completed.',
    parameters: {}, output: output(),
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TEAM_CALLER_REJECTED' }
      const id = exec.agent.id, context = contexts.get(id), row = contexts.record(id)
      return { status: 'POSTMAN_TEAM_STATUS',
        task: { contextReady: Boolean(context), branch: context?.branch ?? row?.branch ?? null,
          ...(row ? { stage: row.stage, closedAt: row.closedAt ?? null } : {}),
          restoring: contexts.isRestoring(id), activeOperation: contexts.hasActiveOperation(id) },
        ...worker.teamSnapshot(exec.agent), bridge: jobs.teamSnapshot(exec.agent) }
    },
  })
}

export function createPostmanYieldTool(ctx) {
  return defineTool({
    name: POSTMAN_YIELD_TOOL_NAME,
    description: 'Finish only this active Leader turn without a user-facing final; wait for native report, failure, or user input.',
    parameters: {}, output: output(),
    execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_YIELD_CALLER_REJECTED' }
      if (typeof exec.concludeTurn !== 'function') return { status: 'POSTMAN_YIELD_UNSUPPORTED' }
      exec.concludeTurn()
      return { status: 'POSTMAN_YIELDED', taskCompleted: false }
    },
  })
}

export function createPostmanChildNotifyTool(ctx, contexts, worker) {
  return defineTool({
    name: POSTMAN_CHILD_NOTIFY_TOOL_NAME,
    description: 'Steer one decision-relevant untrusted notification to the exact immediate Postman parent (Leader or Sol Worker); do not cancel a running tool.',
    parameters: { message: { type: 'string', required: true, description: 'Factual intermediate update for your direct parent.' } },
    output: output(),
    execute(args, exec) {
      const child = exec?.agent
      const header = child?.session?.header
      if (typeof args?.message !== 'string' || args.message.trim() === '')
        return { status: 'PARENT_NOTIFICATION_INVALID' }
      if (header?.origin !== 'subagent' || ![1, 2].includes(header.delegationDepth) ||
          typeof header.parentSession !== 'string' || ctx.agents.get(child.id) !== child)
        return { status: 'PARENT_NOTIFICATION_CALLER_REJECTED' }
      const leader = ctx.agents.get(header.parentSession)
      if (!leader || leader.id !== header.parentSession || !(isTopLevelPostmanSupervisor(leader) || worker?.roleOf(leader) === 'sol') ||
          typeof leader.steer !== 'function' ||
          !((contexts?.child(child.id) != null && contexts.child(child.id) === contexts.get(leader.id)) ||
            worker?.ownsNotification(child, leader.id)))
        return { status: 'PARENT_NOTIFICATION_CALLER_REJECTED' }
      if (worker?.ownsNotification(child, leader.id) && !['NEEDS_LEADER_GUIDANCE:', 'NEEDS_PARENT_GUIDANCE:'].some(prefix => args.message.startsWith(prefix)))
        return { status: 'POSTMAN_WORKER_NOTIFICATION_REJECTED', diagnostic: 'Use NEEDS_PARENT_GUIDANCE: only when an immediate parent decision is needed now; keep FYI for report' }
      const message = createUserMessage({
        content: [{ type: 'text', text: 'Background subagent ' + child.id + ':\n' + args.message }],
        source: { kind: 'subagent-report', form: 'relay', senderSessionId: child.id },
      })
      leader.steer(message)
      return { status: 'PARENT_NOTIFICATION_ACCEPTED', messageId: message.id }
    },
  })
}

export function installPostmanLeaderBoundary(agent) {
  const leader = isTopLevelPostmanSupervisor(agent)
  const restriction = postmanBridgeRestrictionForAgent(agent)
  agent.ctx.effect(() => agent.ctx.tools.restrict(restriction),
    leader ? 'dsh-postman-harness-bridge.leader-tool-boundary()'
      : 'dsh-postman-harness-bridge.non-leader-tool-boundary()')
  return leader
}

export function installPostmanWorkerReportObserver(ctx, worker) {
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind === 'accept' && exec.name === 'report') {
      try { await worker.observeReport(exec, result) } catch { /* fail closed without invalidating native delivery */ }
    }
    return decision
  })
}

export async function apply(ctx, config = {}) {
  const registry = await sharedPostmanTaskRegistry(ctx.storageDomain)
  const contexts = initializePostmanTaskContexts(registry, { localDevelopment: config.localDevelopment === true })
  const currentAttachments = new CurrentAttachmentStore(ctx)
  const coordinator = createPostmanBridgeLaunchCoordinator()
  const grants = createImplementationArtifactGrants(registry)
  if (config.localDevelopment === true) ctx.get?.('systemPrompt')?.section({
    name: 'postman-local-development', order: 130,
    text: ({ scope } = {}) => isTopLevelPostmanSupervisor(scope) ?
      'Host localDevelopment is explicitly enabled by the user, but does not bypass initial execution-plan approval. Every new non-trivial task: Leader routing decision -> compact plan -> explicit user approval -> execution. Before approval: minimal necessary Leader read-only understanding only; no Worker/Secretary/Sol, Bridge/Postman transport, implementation, tests/build or mutating Git/product operations. Truly trivial read-only/factual requests execute directly. Within the approved plan, no repeated approval per tool, same-scope continuation, local preparation or routine close/cancel/restore. Sol is an expensive Leader-selectable route, no separate role permission; preapproved conditional escalation needs no repeated approval. Choose cheapest reliable routing through the next meaningful decision boundary; unknown != complex, useful cheap bounded evidence first, direct Sol for obviously difficult local engineering/review. Local deep engineering/review -> Sol; external/current research or useful independent outside opinion -> PostmanAsk. New independent outcomes require a new plan; material cost/scope/access/destructive-operation/transport changes: STOP -> revised plan -> approval. Do not add an approval state machine or change Harness permissions. Close releases an idle session, not a successful task. Addressed cancel needs no approval prompt and never certifies completion. Restore preserves dirty files/index in a private local recovery directory before resetting only the bound temporary worktree. Never bypass secret disclosure consent, overwrite permanent worktrees, or invent execution status.' : '',
  })
  let boundaries, ptc
  const refreshWorker = id => {
    const agent = ctx.agents.get(id)
    if (agent && boundaries && ptc) {
      boundaries.refreshSession(id)
      ptc.refresh(agent)
    }
  }
  const worker = createPostmanWorkerTools(ctx, grants, postmanTaskContexts, { onBindingChange: refreshWorker, localDevelopment: config.localDevelopment === true, fastBudget: config.fastBudget })
  const stopContextWatch = contexts.onContextChange(id => {
    postmanInputGrants.releaseStale(ctx.agents.get(id), contexts.get(id))
    worker.refreshLeader(id)
  })
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants, postmanTaskContexts, worker)
  const ownsPtcWorker = agent => worker.roleOf(agent) === 'sol' && worker.ownsLiveWorker(agent) && Boolean(worker.ptcContextOf(agent))
  ptc = createPtcAdapter(ctx, { authorize: isTopLevelPostmanPtcLeader, workerContextOf: worker.ptcContextOf,
    resolveAssignment: (agent, leaderProfile) => isTopLevelPostmanPtcLeader(agent) ?
      { profile: leaderProfile, role: 'leader' } : ownsPtcWorker(agent) ? { profile: SOL_WORKER_PROFILE, role: 'sol' } : null })
  // Guard model-direct operations, not ordinary visibility: nested PTC calls carry the outer token.
  ctx.tools.guard(exec => postmanPtcDirectCallGuard(exec, id => ctx.agents.get(id), ownsPtcWorker))
  ctx.tools.register(ptc.tool)
  ctx.tools.register(createPostmanTaskPrepareTool(ctx, contexts))
  ctx.tools.register(createPostmanTaskCloseTool(ctx, contexts, { jobs }))
  ctx.tools.register(createPostmanInputFilesTool(ctx, contexts, { currentAttachments,
    resolveAttachment: (ref, signal) => ctx.attachments.readImage(ref, signal) }))
  ctx.tools.register(createPostmanBridgeTool(ctx, jobs, postmanTaskContexts))
  ctx.tools.register(createPostmanBridgeStatusTool(ctx, jobs))
  ctx.tools.register(createPostmanBridgeListTool(ctx, jobs))
  ctx.tools.register(createPostmanBridgeStopTool(ctx, jobs))
  ctx.tools.register(createPostmanTeamStatusTool(ctx, postmanTaskContexts, worker, jobs))
  ctx.tools.register(createPostmanTaskRestoreTool(ctx, postmanTaskContexts, { jobs, worker }))
  ctx.tools.register(worker.taskTool)
  ctx.tools.register(worker.solTaskTool)
  ctx.tools.register(worker.secretaryTool)
  ctx.tools.register(worker.ledgerTool)
  ctx.tools.register(worker.freshTool)
  ctx.tools.register(worker.interruptTool)
  ctx.tools.register(worker.stopTool)
  ctx.tools.register(createPostmanYieldTool(ctx))
  installPostmanWorkerReportObserver(ctx, worker)
  ctx.tools.register(worker.listTool)
  ctx.tools.register(worker.compactTool)
  ctx.tools.register(createPostmanChildNotifyTool(ctx, postmanTaskContexts, worker))
  ctx.tools.register(createImplementationArtifactApplyTool(ctx, grants, worker, { taskContexts: postmanTaskContexts, jobs }))
  ctx.effect(() => async () => {
    try { await jobs.dispose() } finally {
      currentAttachments.dispose()
      postmanInputGrants.dispose()
      worker.dispose()
      stopContextWatch()
      await ptc.dispose()
      releasePostmanTaskContexts(contexts)
      await closeSharedPostmanTaskRegistry()
    }
  }, 'dsh-postman-harness-bridge.shared-service()')

  boundaries = createPostmanBridgeBoundaryManager(sessionId => ctx.agents.get(sessionId), ownsPtcWorker, worker.roleOf)
  ctx.effect(() => () => boundaries.disposeAll(), 'dsh-postman-harness-bridge.boundary-manager()')
  ctx.on('agent/created', async ({ agent }) => {
    // Admission confirmation performs its provisional refresh synchronously.
    const activation = worker.confirmActivation(agent)
    boundaries.install(agent)
    ptc.refresh(agent)
    await activation
    boundaries.refreshSession(agent.id)
    ptc.refresh(agent)
  })
  ctx.on('agent-preset/selected', sessionId => {
    const agent = ctx.agents.get(sessionId)
    if (agent) currentAttachments.release(agent)
    ptc.remove(agent); boundaries.refreshSession(sessionId); ptc.refresh(agent)
    for (const child of ctx.agents.list()) if (child.session?.header?.parentSession === sessionId) refreshWorker(child.id)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    worker.releaseActivation(agent)
    worker.suspendLeader(agent)
    currentAttachments.release(agent)
    postmanInputGrants.release(agent)
    ptc.remove(agent); boundaries.disposeAgent(agent)
    for (const child of ctx.agents.list()) if (child.session?.header?.parentSession === agent.id) refreshWorker(child.id)
  })
  ctx.on('tools/change', () => { boundaries.refreshAll(); ptc.permissionsChanged() })
  for (const agent of ctx.agents.list()) { boundaries.install(agent); ptc.refresh(agent) }
}

export const POSTMAN_BRIDGE_VISIBLE_TOOLS = POSTMAN_BRIDGE_TOOL_ALLOWLIST
