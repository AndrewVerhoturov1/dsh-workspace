import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { createPtcAdapter, WORKER_MUTATION_PROFILE } from './ptc-adapter.js'
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
  POSTMAN_BRIDGE_TOOL_ALLOWLIST, POSTMAN_BRIDGE_TOOL_NAME, POSTMAN_BRIDGE_STATUS_TOOL_NAME, POSTMAN_BRIDGE_LIST_TOOL_NAME, POSTMAN_CHILD_NOTIFY_TOOL_NAME, POSTMAN_TASK_PREPARE_TOOL_NAME, POSTMAN_TASK_RESTORE_TOOL_NAME, POSTMAN_YIELD_TOOL_NAME,
  createPostmanBridgeBoundaryManager, isTopLevelPostmanSupervisor, isTopLevelPostmanPtcLeader,
  postmanBridgeCallerAllowed, postmanBridgeRestrictionForAgent, postmanPtcDirectCallGuard,
} from './postman-bridge-core.js'

export const name = 'dsh-postman-harness-bridge'
export const Config = z.object({ localDevelopment: z.boolean().default(false) }).default({})
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
    description: 'Steer an untrusted intermediate message to the direct Postman Leader at the next safe step boundary; do not cancel a running tool.',
    parameters: { message: { type: 'string', required: true, description: 'Factual intermediate update for your direct parent.' } },
    output: output(),
    execute(args, exec) {
      const child = exec?.agent
      const header = child?.session?.header
      if (typeof args?.message !== 'string' || args.message.trim() === '')
        return { status: 'PARENT_NOTIFICATION_INVALID' }
      if (header?.origin !== 'subagent' || header.delegationDepth !== 1 ||
          typeof header.parentSession !== 'string' || ctx.agents.get(child.id) !== child)
        return { status: 'PARENT_NOTIFICATION_CALLER_REJECTED' }
      const leader = ctx.agents.get(header.parentSession)
      if (!leader || leader.id !== header.parentSession || !isTopLevelPostmanSupervisor(leader) ||
          typeof leader.steer !== 'function' ||
          !((contexts?.child(child.id) != null && contexts.child(child.id) === contexts.get(leader.id)) ||
            worker?.ownsNotification(child, leader.id)))
        return { status: 'PARENT_NOTIFICATION_CALLER_REJECTED' }
      if (worker?.ownsNotification(child, leader.id) && !args.message.startsWith('NEEDS_LEADER_GUIDANCE:'))
        return { status: 'POSTMAN_WORKER_NOTIFICATION_REJECTED', diagnostic: 'Use NEEDS_LEADER_GUIDANCE: only when a Leader decision is needed now; keep FYI for report' }
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
      'Host localDevelopment is explicitly enabled by the user. Within the user task, do not ask for repeated approval of local task preparation, Luna Worker assignment, close/cancel or restore. Sol Worker assignments are an exception: only on an explicit user request; before the first assignment and every new separate task, ask through ask_user_question and wait for a positive answer before calling postman_sol_worker. Refusal, cancellation or no answer means no assignment. That answer is sufficient; do not request a second system Allow once or change Harness permissions. Close releases an idle session, not a successful task. Addressed cancel needs no approval prompt and never certifies completion. Restore preserves dirty files/index in a private local recovery directory before resetting only the bound temporary worktree. Never bypass secret disclosure consent, overwrite permanent worktrees, or invent execution status.' : '',
  })
  let boundaries, ptc
  const refreshWorker = id => {
    const agent = ctx.agents.get(id)
    if (agent && boundaries && ptc) {
      boundaries.refreshSession(id)
      ptc.refresh(agent)
    }
  }
  const worker = createPostmanWorkerTools(ctx, grants, postmanTaskContexts, { onBindingChange: refreshWorker, localDevelopment: config.localDevelopment === true })
  const stopContextWatch = contexts.onContextChange(id => {
    postmanInputGrants.releaseStale(ctx.agents.get(id), contexts.get(id))
    worker.refreshLeader(id)
  })
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants, postmanTaskContexts, worker)
  const ownsPtcWorker = agent => worker.ownsLiveWorker(agent) &&
    isTopLevelPostmanPtcLeader(ctx.agents.get(agent.session.header.parentSession))
  ptc = createPtcAdapter(ctx, { workerContextOf: agent =>
    ownsPtcWorker(agent) ? worker.ptcContextOf(agent) : null, resolveAssignment: (agent, leaderProfile) => {
    if (isTopLevelPostmanPtcLeader(agent)) return { profile: leaderProfile, role: 'leader' }
    return ownsPtcWorker(agent) ? { profile: WORKER_MUTATION_PROFILE, role: 'worker' } : null
  } })
  // Guard model-direct operations, not ordinary visibility: nested PTC calls carry the outer token.
  ctx.tools.guard(exec => postmanPtcDirectCallGuard(exec, id => ctx.agents.get(id), ownsPtcWorker))
  ctx.tools.register(ptc.tool)
  ctx.tools.register(createPostmanTaskPrepareTool(ctx, contexts))
  ctx.tools.register(createPostmanInputFilesTool(ctx, contexts, { currentAttachments,
    resolveAttachment: (ref, signal) => ctx.attachments.readImage(ref, signal) }))
  ctx.tools.register(createPostmanBridgeTool(ctx, jobs, postmanTaskContexts))
  ctx.tools.register(createPostmanBridgeStatusTool(ctx, jobs))
  ctx.tools.register(createPostmanBridgeListTool(ctx, jobs))
  ctx.tools.register(createPostmanTaskRestoreTool(ctx, postmanTaskContexts, { jobs, worker }))
  ctx.tools.register(worker.taskTool)
  ctx.tools.register(worker.solTaskTool)
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

  boundaries = createPostmanBridgeBoundaryManager(sessionId => ctx.agents.get(sessionId), ownsPtcWorker)
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
  ctx.on('tools/change', () => ptc.permissionsChanged())
  for (const agent of ctx.agents.list()) { boundaries.install(agent); ptc.refresh(agent) }
}

export const POSTMAN_BRIDGE_VISIBLE_TOOLS = POSTMAN_BRIDGE_TOOL_ALLOWLIST
