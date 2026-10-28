import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { resolve } from 'node:path'
import { createPtcAdapter, SOL_WORKER_PROFILE, NODES_LEADER_PROFILE, NODES_SOL_PROFILE } from './ptc-adapter.js'
import { CurrentAttachmentStore, createPostmanInputFilesTool, postmanInputGrants } from './postman-input-files.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createPostmanAppTool } from './postman-app.js'
import {inspectLoadedRuntime} from '../../../devspace/runtime-identity.mjs'
import { parsePostmanUserTurn } from './direct-current-turn.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createImplementationArtifactGrants, createImplementationArtifactApplyTool } from './implementation-artifact.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { postmanTaskContexts, initializePostmanTaskContexts, releasePostmanTaskContexts } from './postman-task-context.js'
import { sharedPostmanTaskRegistry, closeSharedPostmanTaskRegistry } from './postman-task-registry.js'
import {
  POSTMAN_BRIDGE_TOOL_ALLOWLIST, POSTMAN_BRIDGE_TOOL_NAME, POSTMAN_BRIDGE_STATUS_TOOL_NAME, POSTMAN_BRIDGE_LIST_TOOL_NAME, POSTMAN_BRIDGE_STOP_TOOL_NAME, POSTMAN_DEVSPACE_LUNA_CLOSE_TOOL_NAME, POSTMAN_DEVSPACE_CONTROL_TOOL_NAME, POSTMAN_TEAM_STATUS_TOOL_NAME, POSTMAN_CHILD_NOTIFY_TOOL_NAME,
  createPostmanBridgeBoundaryManager, isTopLevelPostmanSupervisor, isTopLevelPostmanPtcLeader, isTopLevelPostmanNodesLeader,
  postmanBridgeCallerAllowed, postmanBridgeRestrictionForAgent, postmanPtcDirectCallGuard,
} from './postman-bridge-core.js'

export const name = 'dsh-postman-harness-bridge'
export const Config = z.object({
  localDevelopment: z.boolean().default(false),
  fastBudget: z.object({ hardLimit: z.number().int().min(8).max(100).default(60) }).prefault({}),
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

export function createPostmanBridgeTool(ctx, jobs, contexts, nodesService = () => null) {
  return defineTool({
    name: POSTMAN_BRIDGE_TOOL_NAME,
    description: 'Universal @PostmanDevspace is the default ChatGPT executor, with up to three independent persistent Luna/chat lanes per Leader. Legacy @Postman/Ask/Image remain available. Accepted is not completed; use POSTMAN_BRIDGE_READY then exact postman_bridge_status.',
    parameters: { message: { type: 'string', required: true,
      description: 'Complete model-authored delegation beginning with exact @Postman, @PostmanAsk, @PostmanImage or @PostmanDevspace. For Devspace include only the concrete task, necessary facts/paths, task constraints and done conditions. Host supplies standard instruction file refs and task scope; do not copy manuals or Host boilerplate.' },
      image_mode: { type: 'boolean', description: 'Devspace only: generate one native ChatGPT image from the visual message alone; no GitHub task links, bell, input files or automatic resend. Original download and metadata are returned through bridge status.' },
      devspace_mode: { type: 'string', enum: ['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED'], description: 'Task instructions: WRITE_TEST uses private output by default; READ_ONLY requests no output files; WRITE_ISOLATED uses the directory selected by Leader. These do not change actual connector permissions.' },
      lane_id: { type: 'string', description: 'Optional exact returned Devspace laneId, to continue the same Luna and ChatGPT conversation. Omit for a free lane.' },
      workspace_root: { type: 'string', description: 'Optional local working folder selected by Leader; no Git preparation is required.' },
      workspace_access: { type: 'string', enum: ['read', 'write'], description: 'Read or write permission paired with workspace_root.' },
      computer_use: { type: 'string', enum: ['allow', 'deny'], description: 'Computer Use is allowed by default within the user task scope. Use deny only for an explicit task restriction. Actual tool availability is determined by ChatGPT; this does not widen filesystem or Host authority.' },
      computer_use_target: { type: 'string', description: 'Legacy indication of Computer Use intent; equivalent to allow unless computer_use explicitly says deny. Does not impose a Host application allowlist.' } },
    output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      if (exec.signal?.aborted) return { status: 'POSTMAN_BRIDGE_ADMISSION_ABORTED' }
      await contexts?.ensure?.(exec.agent)
      let parsed
      try { parsed = parsePostmanUserTurn(args?.message) }
      catch (error) { return { status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED', diagnostic: String(error?.message ?? error) } }
      if (parsed.transportKind === 'devspace' && (parsed.mode !== 'fresh' ||
          args.devspace_mode !== undefined && !['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED'].includes(args.devspace_mode)))
        return { status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED', diagnostic: 'POSTMAN_DEVSPACE_STAGE1_SCOPE' }
      if (isTopLevelPostmanNodesLeader(exec.agent) && parsed.transportKind === 'devspace') {
        const run = nodesService()?.runForAgent(exec.agent)
        if (run?.status !== 'RUNNING' || !args.lane_id ||
            !Object.values(run.lunaSelections ?? {}).includes(args.lane_id))
          return { status: 'NODES_LUNA_EXACT_LANE_REQUIRED' }
      }
      if (parsed.transportKind !== 'devspace' &&
          (args.image_mode !== undefined || args.devspace_mode !== undefined || args.lane_id !== undefined ||
           args.workspace_root !== undefined || args.workspace_access !== undefined ||
           args.computer_use_target !== undefined || args.computer_use !== undefined))
        return { status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED', diagnostic: 'POSTMAN_DEVSPACE_MODE_MISMATCH' }
      if (args.computer_use !== undefined && !['allow', 'deny'].includes(args.computer_use))
        return { status: 'POSTMAN_DEVSPACE_SCOPE_INVALID' }
      if (args.image_mode !== undefined && typeof args.image_mode !== 'boolean' ||
          args.image_mode === true && parsed.inputFiles?.length)
        return { status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED', diagnostic: 'POSTMAN_DEVSPACE_IMAGE_INPUT_INVALID' }
      const computerUse = args.computer_use ?? 'allow'
      let approvedScope
      if (args.workspace_root !== undefined) approvedScope = {
        root: resolve(args.workspace_root), access: args.workspace_access ?? 'read',
      }
      if (parsed.inputFiles?.length && !postmanInputGrants.owns(exec.agent, contexts.get(exec.agent.id), parsed.inputFiles))
        return { status: 'POSTMAN_INPUT_PROVENANCE_REJECTED' }
      const inputBinding = parsed.inputFiles?.length
        ? postmanInputGrants.pin(exec.agent, contexts.get(exec.agent.id), parsed.inputFiles) : undefined
      if (exec.nodesInvocation && (parsed.transportKind !== 'devspace' ||
          !nodesService()?.chatInvocationAllowed(exec.nodesInvocation, exec.agent, args.lane_id)))
        return { status: 'NODES_CHAT_INVOCATION_REJECTED' }
      try {
        const result = await jobs.accept(exec.agent, args.message, parsed.transportKind, inputBinding,
          undefined, args.devspace_mode, args.lane_id, approvedScope,
          { computerUse, imageMode: args.image_mode === true,
            ...(exec.nodesInvocation ? { nodesInvocation: exec.nodesInvocation } : {}) })
        if (result.status !== 'POSTMAN_BRIDGE_ACCEPTED') postmanInputGrants.unpin(inputBinding)
        return result
      } catch (error) { postmanInputGrants.unpin(inputBinding); throw error }
    },
  })
}

export function createPostmanBridgeStatusTool(ctx, jobs) {
  return defineTool({
    name: POSTMAN_BRIDGE_STATUS_TOOL_NAME,
    description: 'Read the owned Bridge result and recorded facts. This never sends, resumes Luna, revokes authority or changes Git.',
    parameters: { bridge_job_id: { type: 'string', required: true,
      description: 'Exact bridgeJobId from POSTMAN_BRIDGE_ACCEPTED or POSTMAN_BRIDGE_READY.' },
    },
    output: output(),
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      const status = await jobs.status(exec.agent, args?.bridge_job_id)
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
    description: 'Request cancellation of one exact owned Bridge job. abandon:true archives its logical authority and frees its lane, preserving outcomes and late results; this does not prove shell stopped. Not proof of NOT_SENT or task success.',
    parameters: { bridge_job_id: { type: 'string', required: true, description: 'Exact owned bridgeJobId.' },
      abandon: { type: 'boolean', description: 'Archive/revoke the old operation while preserving audit and files.' } },
    output: output(),
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      return jobs.stop(exec.agent, args.bridge_job_id, args.abandon === true)
    },
  })
}

export function createPostmanDevspaceControlTool(ctx, jobs) {
  return defineTool({
    name: POSTMAN_DEVSPACE_CONTROL_TOOL_NAME,
    description: 'Exact Leader-owned @PostmanDevspace: queue steer/preempt/Stop, read status, or explicitly image_inspect then image_download on a settled image job without Send. Inspection opens only its proved preview; download is one native original attempt. Historical terminal is preserved. QUEUED is not Send/Stop proof. Stop generation does not prove shell stopped; new sends are recorded separately.',
    parameters: {
      bridge_job_id: { type: 'string', required: true, description: 'Exact active owned bridgeJobId.' },
      action: { type: 'string', required: true, enum: ['steer', 'preempt', 'stop', 'status', 'image_inspect', 'image_download'] },
      priority: { type: 'string', enum: ['normal', 'urgent'] },
      message: { type: 'string', description: 'Host-owned new instruction; required for steer/preempt.' },
    },
    output: output(), isConcurrencySafe: () => true,
    execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_DEVSPACE_CONTROL_CALLER_REJECTED' }
      return jobs.devspaceControl(exec.agent, args?.bridge_job_id, args?.action, args?.message, args?.priority)
    },
  })
}

export function createPostmanDevspaceLunaCloseTool(ctx, jobs) {
  return defineTool({
    name: POSTMAN_DEVSPACE_LUNA_CLOSE_TOOL_NAME,
    description: 'Close one exact idle Devspace lane or, without lane_id, all settled idle lines for this Leader. Never cancels an active ChatGPT task.',
    parameters: { lane_id: { type: 'string', description: 'Optional exact laneId to close only that line.' } }, output: output(),
    async execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_DEVSPACE_LUNA_CALLER_REJECTED' }
      return jobs.devspaceLunaClose(exec.agent, _args?.lane_id)
    },
  })
}

export function createPostmanTeamStatusTool(ctx, contexts, worker, jobs) {
  return defineTool({
    name: POSTMAN_TEAM_STATUS_TOOL_NAME,
    description: 'Compact read-only snapshot of this Leader task and team for routing. No recovery, synchronization, journals, full ledger/results or completion polling; idle is not completed.',
    parameters: { runtime: {type:'boolean',description:'Explicit read-only inspection of loaded Host/DevSpace module hashes. No Git SHA substitution, process start, restart or polling.'} }, output: output(),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TEAM_CALLER_REJECTED' }
      const id = exec.agent.id, context = contexts.get(id), row = contexts.record(id)
      return { status: 'POSTMAN_TEAM_STATUS',
        task: { cwd: context?.worktree ?? exec.agent.session?.header?.cwd ?? null },
        ...worker.teamSnapshot(exec.agent), bridge: jobs.teamSnapshot(exec.agent),
        devspaceLuna: jobs.devspaceLunaSnapshot(exec.agent),
        ...(args.runtime===true ? {runtime:{
          host:await inspectLoadedRuntime(['postman-bridge.js','ptc-adapter.js','postman-worker.js','postman-task-context.js',
            'postman-bridge-jobs.js','postman-devspace.js','postman-writer-proof.js',
            'postman-task-registry.js','implementation-artifact.js'].map(name=>({name,url:new URL(name,import.meta.url)}))),
          devspace:await contexts.inspectDevspaceRuntime()
        }} : {}) }
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
          !worker?.ownsNotification(child, leader.id))
        return { status: 'PARENT_NOTIFICATION_CALLER_REJECTED' }
      const message = createUserMessage({
        content: [{ type: 'text', text: 'Background subagent ' + child.id + ':\n' + args.message }],
        source: { kind: 'subagent-report', form: 'relay', senderSessionId: child.id },
      })
      leader.steer(message)
      return { status: 'PARENT_NOTIFICATION_ACCEPTED', messageId: message.id }
    },
  })
}

// Host-owned Nodes Luna adapter: one archive proof and one exact Bridge Send
// route for both agent tools and UI RPC. It never chooses a destination.
export function createNodesLunaNativeBridge(ctx, contexts, jobs, bridgeTool) {
  return {
    lunaSnapshot: (parent, laneIds) => jobs.nodesLunaSnapshot(parent, laneIds),
    async reserveLunas(parent, laneIds, archive = null, previousLaneId = null) {
      if (!isTopLevelPostmanNodesLeader(parent) || ctx.agents.get(parent.id) !== parent ||
          !Array.isArray(laneIds) || !laneIds.length || laneIds.length > 3 ||
          laneIds.some(id => typeof id !== 'string' || !/^nodes:[^:]+:[^:]+(?::[^:]+)?$/.test(id)) ||
          previousLaneId && (laneIds.length !== 1 ||
            previousLaneId.split(':').slice(0, 3).join(':') !== laneIds[0].split(':').slice(0, 3).join(':')))
        return { status: 'NODES_LUNA_OWNER_REJECTED' }
      return jobs.withAdmission(parent.id, async () => {
      let archiveSource = null
      if (archive) {
        const { id, sourceLeaderSessionId, sourceChildSessionId, sourceLaneId, requestId, conversationRef } = archive
        if (!id || !sourceLeaderSessionId || !sourceChildSessionId || !requestId ||
            !sourceLaneId?.startsWith('nodes:') || !/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(conversationRef) ||
            laneIds.length !== 1 || laneIds[0].split(':')[2] !== sourceLaneId.split(':')[2])
          return { status: 'NODES_LUNA_ARCHIVE_UNPROVEN' }
        const proven = jobs.nodesLunaSnapshot(sourceLeaderSessionId, [sourceLaneId])?.[0]?.conversations?.find(a =>
          a.id === id && a.sourceLeaderSessionId === sourceLeaderSessionId &&
          a.sourceChildSessionId === sourceChildSessionId && a.sourceLaneId === sourceLaneId &&
          a.requestId === requestId && a.conversationRef === conversationRef)
        if (!proven) return { status: 'NODES_LUNA_ARCHIVE_UNPROVEN' }
        archiveSource = { bridgeJobId: id, sourceLeaderSessionId, sourceChildSessionId,
          sourceLaneId, requestId, conversationRef }
      }
      if (previousLaneId) {
        const current = jobs.nodesLunaSnapshot(parent, [previousLaneId])?.[0]
        if (current?.activeJobId || ['QUEUED', 'WORKING'].includes(current?.status))
          return { status: 'NODES_LUNA_BUSY' }
      }
      await contexts.ensure?.(parent)
      try {
        await contexts.changeRecord(parent.id, row => {
          const lanes = { ...row.devspaceLanes }
          if (previousLaneId && (!lanes[previousLaneId] || lanes[previousLaneId].state === 'closed'))
            throw Error('NODES_LUNA_PREVIOUS_CHANGED')
          if (previousLaneId && jobs.list(parent).operations.some(op =>
            op.countsAgainstLimit && op.laneId?.split(':').slice(0, 3).join(':') ===
              previousLaneId.split(':').slice(0, 3).join(':')))
            throw Error('NODES_LUNA_BUSY')
          for (const laneId of laneIds) {
            if (Object.hasOwn(lanes, laneId)) throw Error('NODES_LUNA_LANE_EXISTS')
            lanes[laneId] = { state: 'reserved', activeBridgeJobId: null,
              requestIds: [], conversationRef: archiveSource?.conversationRef ?? null,
              ...(archiveSource ? { archiveSource } : {}) }
          }
          if (previousLaneId) lanes[previousLaneId] = { ...lanes[previousLaneId], state: 'closed' }
          return { ...row, devspaceLanes: lanes }
        })
        return { status: 'NODES_LUNA_RESERVED' }
      } catch (error) { return { status: error?.message === 'NODES_LUNA_BUSY'
        ? 'NODES_LUNA_BUSY' : 'NODES_LUNA_RESERVATION_FAILED' } }
      })
    },
    async chatStatus(parent, bridgeJobId) {
      return { ...await jobs.status(parent, bridgeJobId),
        nodesInvocation: jobs.chatInvocation(parent, bridgeJobId) };
    },
    sendLuna(parent, laneId, args, signal = new AbortController().signal, invocation = null) {
      if (!isTopLevelPostmanNodesLeader(parent) || ctx.agents.get(parent.id) !== parent ||
          typeof laneId !== 'string' || !laneId.startsWith('nodes:') || !bridgeTool)
        return { status: 'NODES_LUNA_OWNER_REJECTED' }
      return bridgeTool.execute({ ...args, lane_id: laneId }, { agent: parent, signal, nodesInvocation: invocation })
    },
  }
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
      'The Leader chooses routing, retries, recovery and acceptance within the user task. Host executes explicit commands and reports facts. Git preparation belongs to a Worker under repository policy; no Host task preparation or closure is required. Preserve user files and actual tool permissions.' : '',
  })
  let boundaries, ptc
  const refreshWorker = id => {
    const agent = ctx.agents.get(id)
    if (agent && boundaries && ptc) {
      boundaries.refreshSession(id)
      ptc.refresh(agent)
    }
  }
  let currentNodesService = null
  ctx.inject(['nodesAgent'], nodesCtx => {
    currentNodesService = nodesCtx.nodesAgent
    return () => { currentNodesService = null }
  })
  const worker = createPostmanWorkerTools(ctx, grants, postmanTaskContexts, {
    onBindingChange: refreshWorker, localDevelopment: config.localDevelopment === true,
    fastBudget: config.fastBudget, nodesService: () => currentNodesService,
  })
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants, postmanTaskContexts, worker,
    undefined, () => currentNodesService)
  const bridgeTool = createPostmanBridgeTool(ctx, jobs, postmanTaskContexts, () => currentNodesService)
  ctx.provide('postmanNativeNodes', { start: worker.startNodesTeam, nodeAction: worker.nativeNodeAction,
    deliverMessage: worker.deliverNodesMessage,
    ...createNodesLunaNativeBridge(ctx, postmanTaskContexts, jobs, bridgeTool) })
  // Workspace policy asks the same exact current Host role predicate used by PTC.
  ctx.on('postman/workspace-role', agent => worker.roleOf(agent))
  const stopContextWatch = contexts.onContextChange(id => {
    worker.refreshLeader(id)
  })
  const ownsPtcWorker = agent => worker.roleOf(agent) === 'sol' && worker.ownsLiveWorker(agent) && Boolean(worker.ptcContextOf(agent))
  ptc = createPtcAdapter(ctx, { authorize: isTopLevelPostmanPtcLeader, workerContextOf: worker.ptcContextOf,
    readWait: agent => {
      const parent = agent.session?.header?.parentSession
      const row = contexts.record(parent ?? agent.id)
      return (parent ? row?.workers?.[agent.id] : row)?.waitingForEvent === true
    },
    writeWait: async (agent, waitingForEvent) => {
      const parent = agent.session?.header?.parentSession, id = parent ?? agent.id
      if (!contexts.record(id)) await contexts.ensure(parent ? ctx.agents.get(parent) : agent)
      await contexts.changeRecord(id, row => parent ? { ...row, workers: { ...row.workers,
        ...(row.workers?.[agent.id] ? { [agent.id]: { ...row.workers[agent.id], waitingForEvent } } : {}) } } : { ...row, waitingForEvent })
    },
    resolveAssignment: (agent, leaderProfile) => isTopLevelPostmanNodesLeader(agent) ?
      { profile: NODES_LEADER_PROFILE, role: 'leader' } : isTopLevelPostmanPtcLeader(agent) ?
      { profile: leaderProfile, role: 'leader' } : ownsPtcWorker(agent) ? { profile: currentNodesService?.runForAgent(agent) ? NODES_SOL_PROFILE : SOL_WORKER_PROFILE, role: 'sol' } : null })
  ctx.on('postman/subagent-report-defer', (parent, child, content) =>
    jobs.canDeferLunaBootstrapReport(parent, child, content) ? true : undefined)
  ctx.on('postman/subagent-settlement-defer', (parent, child, terminal) =>
    jobs.canDeferLunaBootstrapSettlement(parent, child, terminal) ||
    parent?.phase?.kind === 'idle' && parent.inbox?.hasPending === false &&
    worker.canDeferSettlement(parent, child, terminal) ? true : undefined)
  // Guard model-direct operations, not ordinary visibility: nested PTC calls carry the outer token.
  ctx.tools.guard(exec => postmanPtcDirectCallGuard(exec, id => ctx.agents.get(id), ownsPtcWorker))
  ctx.tools.register(ptc.tool)
  ctx.tools.register(createPostmanInputFilesTool(ctx, contexts, { currentAttachments,
    resolveAttachment: (ref, signal) => ctx.attachments.readImage(ref, signal) }))
  ctx.tools.register(bridgeTool)
  ctx.tools.register(createPostmanBridgeStatusTool(ctx, jobs))
  ctx.tools.register(createPostmanBridgeListTool(ctx, jobs))
  ctx.tools.register(createPostmanBridgeStopTool(ctx, jobs))
  ctx.tools.register(createPostmanDevspaceLunaCloseTool(ctx, jobs))
  ctx.tools.register(createPostmanDevspaceControlTool(ctx, jobs))
  ctx.tools.register(createPostmanTeamStatusTool(ctx, postmanTaskContexts, worker, jobs))
  ctx.tools.register(createPostmanAppTool(ctx, worker, contexts))
  ctx.tools.register(worker.taskTool)
  ctx.tools.register(worker.solTaskTool)
  ctx.tools.register(worker.secretaryTool)
  ctx.tools.register(worker.ledgerTool)
  ctx.tools.register(worker.freshTool)
  ctx.tools.register(worker.interruptTool)
  ctx.tools.register(worker.stopTool)
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

  boundaries = createPostmanBridgeBoundaryManager(sessionId => ctx.agents.get(sessionId), ownsPtcWorker, worker.roleOf,
    agent => isTopLevelPostmanNodesLeader(ctx.agents.get(agent?.session?.header?.parentSession)))
  ctx.effect(() => () => boundaries.disposeAll(), 'dsh-postman-harness-bridge.boundary-manager()')
  ctx.on('agent/created', async ({ agent }) => {
    // Admission confirmation performs its provisional refresh synchronously.
    const activation = worker.confirmActivation(agent)
    boundaries.install(agent)
    ptc.refresh(agent)
    await Promise.all([activation, isTopLevelPostmanSupervisor(agent) ? contexts.ensure(agent) : undefined])
    if (isTopLevelPostmanSupervisor(agent)) await jobs.recoverDevspacePending(agent)
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
  for (const agent of ctx.agents.list()) {
    boundaries.install(agent); ptc.refresh(agent)
    if (isTopLevelPostmanSupervisor(agent)) { await contexts.ensure(agent); await jobs.recoverDevspacePending(agent) }
  }
}

export const POSTMAN_BRIDGE_VISIBLE_TOOLS = POSTMAN_BRIDGE_TOOL_ALLOWLIST
