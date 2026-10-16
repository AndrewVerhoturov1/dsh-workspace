import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { createPtcAdapter, SOL_WORKER_PROFILE } from './ptc-adapter.js'
import { CurrentAttachmentStore, createPostmanInputFilesTool, postmanInputGrants } from './postman-input-files.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createPostmanAppTool } from './postman-app.js'
import { parsePostmanUserTurn } from './direct-current-turn.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createImplementationArtifactGrants, createImplementationArtifactApplyTool } from './implementation-artifact.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { postmanTaskContexts, initializePostmanTaskContexts, releasePostmanTaskContexts } from './postman-task-context.js'
import { sharedPostmanTaskRegistry, closeSharedPostmanTaskRegistry } from './postman-task-registry.js'
import {
  POSTMAN_BRIDGE_TOOL_ALLOWLIST, POSTMAN_BRIDGE_TOOL_NAME, POSTMAN_BRIDGE_STATUS_TOOL_NAME, POSTMAN_BRIDGE_LIST_TOOL_NAME, POSTMAN_BRIDGE_STOP_TOOL_NAME, POSTMAN_DEVSPACE_LUNA_CLOSE_TOOL_NAME, POSTMAN_DEVSPACE_CONTROL_TOOL_NAME, POSTMAN_TEAM_STATUS_TOOL_NAME, POSTMAN_CHILD_NOTIFY_TOOL_NAME, POSTMAN_TASK_PREPARE_TOOL_NAME, POSTMAN_TASK_RESTORE_TOOL_NAME, POSTMAN_TASK_CLOSE_TOOL_NAME,
  createPostmanBridgeBoundaryManager, isTopLevelPostmanSupervisor, isTopLevelPostmanPtcLeader,
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

export function createPostmanTaskPrepareTool(ctx, contexts = postmanTaskContexts, { jobs, worker } = {}) {
  return defineTool({
    name: POSTMAN_TASK_PREPARE_TOOL_NAME,
    description: 'Prepare one exact Leader-owned GitHub project. project_path selects a canonical local Git root; if omitted use this Leader workspace. New non-DSH projects use a local-only isolated task worktree from the verified default branch, or a proven cached base offline. read_only creates no Git branch, fetch, push or worktree. Historical DSH tasks retain origin/main publication rules.',
    parameters: { read_only: { type: 'boolean', description: 'Read-only branchless research, no Git mutation.' },
      project_path: { type: 'string', description: 'Optional exact absolute existing local Git project root, selected by Leader.' } }, output: output(),
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TASK_CALLER_REJECTED' }
      if (args?.read_only !== undefined && typeof args.read_only !== 'boolean' ||
          args?.project_path !== undefined && (typeof args.project_path !== 'string' || !isAbsolute(args.project_path)))
        return { status: 'POSTMAN_TASK_ARGUMENTS_INVALID' }
      if (args?.read_only !== true && contexts?.get?.(exec.agent.id)?.devspaceReadOnly &&
          (jobs?.hasActive?.(exec.agent.id) || worker?.hasActiveWork?.(exec.agent)))
        return { status: 'POSTMAN_TASK_PROMOTION_BUSY' }
      const prepared = await (args?.read_only === true ? contexts.prepareReadOnly(exec.agent, args?.project_path) :
        contexts.prepare(exec.agent, args?.project_path))
      if (!['TASK_CONTEXT_READY', 'POSTMAN_TASK_READ_ONLY_READY', 'POSTMAN_TASK_CONTEXT_ALREADY_READY'].includes(prepared?.status) ||
          typeof jobs?.recoverDevspacePending !== 'function') return prepared
      // Reconcile only the exact owner after Host task preparation/recovery.
      // This never starts a new ChatGPT or Direct task.
      const devspaceReconciliation = await jobs.recoverDevspacePending(exec.agent)
      return { ...prepared, devspaceReconciliation }
    },
  })
}

export function createPostmanTaskCloseTool(ctx, contexts = postmanTaskContexts, { jobs, worker } = {}) {
  return defineTool({
    name: POSTMAN_TASK_CLOSE_TOOL_NAME,
    description: 'Retire this exact Leader task binding. abandon:true revokes old task authority, addresses owned operations and preserves journals, UNKNOWN/FAILED outcomes and files; this is not process-stop or success proof. A new task uses a separate worktree. Normal close requires settled children. No Git cleanup.',
    parameters: { abandon: { type: 'boolean', description: 'Explicitly abandon unfinished task; preserve audit and files without claiming PASS.' } }, output: output(),
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TASK_CALLER_REJECTED' }
      if (args?.abandon !== undefined && typeof args.abandon !== 'boolean') return { status: 'POSTMAN_TASK_ARGUMENTS_INVALID' }
      return contexts.close(exec.agent, {
        abandon: args?.abandon === true,
        isBusy: id => Boolean(jobs?.hasActive(id)),
        beforeClose: async id => {
          if (args?.abandon === true) {
            const archived = await jobs?.abandonAll?.(exec.agent)
            if (archived && archived.status !== 'POSTMAN_BRIDGE_ARCHIVED')
              throw Error('POSTMAN_TASK_ARCHIVE_FENCE_FAILED: '+archived.status)
            return worker ? await worker.prepareAbandon(id) : true
          }
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
    description: 'After runner FAIL preserve a dirty task worktree and continue in a new clean isolated task context. No reset/clean or deletion of user files. A clean tree may advance to its exact verified remote branch HEAD. Grants and old REQ keep their original binding.',
    parameters: {}, output: output(),
    async execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TASK_CALLER_REJECTED' }
      return contexts.restore(exec.agent, {
        isBusy: id => Boolean(jobs?.hasActive(id)),
        beforeRestore: async id => worker ? await worker.prepareRestore(id) : true,
        beforeIsolate: async () => jobs?.abandonAll?.(exec.agent) ?? null,
      })
    },
  })
}

export function createPostmanBridgeTool(ctx, jobs, contexts) {
  return defineTool({
    name: POSTMAN_BRIDGE_TOOL_NAME,
    description: 'Universal @PostmanDevspace is the default ChatGPT executor, with up to three independent persistent Luna/chat lanes per Leader. Legacy @Postman/Ask/Image remain available. Accepted is not completed; use POSTMAN_BRIDGE_READY then exact postman_bridge_status.',
    parameters: { message: { type: 'string', required: true,
      description: 'Complete model-authored delegation beginning with exact @Postman, @PostmanAsk, @PostmanImage or @PostmanDevspace.' },
      devspace_mode: { type: 'string', enum: ['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED'], description: 'Compatibility workspace scope only. READ_ONLY default. WRITE_ISOLATED uses an approved task worktree.' },
      lane_id: { type: 'string', description: 'Optional exact returned Devspace laneId, to continue the same Luna and ChatGPT conversation. Omit for a free lane.' },
      workspace_root: { type: 'string', description: 'Optional exact Leader-approved existing local folder. Explicit for every non-repository path.' },
      workspace_access: { type: 'string', enum: ['read', 'write'], description: 'Read or write permission paired with workspace_root.' },
      computer_use: { type: 'string', enum: ['allow', 'deny'], description: 'Explicit Leader decision for this task, delivered to ChatGPT as an instruction. Default deny. Actual tool availability is determined by ChatGPT.' },
      computer_use_target: { type: 'string', description: 'Legacy indication of Computer Use intent; equivalent to allow unless computer_use explicitly says deny. Does not impose a Host application allowlist.' } },
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
      if (parsed.transportKind === 'devspace' && (parsed.mode !== 'fresh' ||
          args.devspace_mode !== undefined && !['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED'].includes(args.devspace_mode)))
        return { status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED', diagnostic: 'POSTMAN_DEVSPACE_STAGE1_SCOPE' }
      if (parsed.transportKind !== 'devspace' &&
          (args.devspace_mode !== undefined || args.lane_id !== undefined ||
           args.workspace_root !== undefined || args.workspace_access !== undefined ||
           args.computer_use_target !== undefined || args.computer_use !== undefined))
        return { status: 'POSTMAN_BRIDGE_MESSAGE_REJECTED', diagnostic: 'POSTMAN_DEVSPACE_MODE_MISMATCH' }
      if (contexts && !contexts.get(exec.agent.id)) {
        if (parsed.transportKind !== 'devspace')
          return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
        // A universal Devspace read/file/image task needs only its Host owner;
        // no Git fetch, branch or worktree is created automatically.
        const prepared = await contexts.prepareReadOnly(exec.agent)
        if (!['POSTMAN_TASK_READ_ONLY_READY', 'POSTMAN_TASK_CONTEXT_ALREADY_READY'].includes(prepared.status))
          return prepared
      }
      if (args.computer_use !== undefined && !['allow', 'deny'].includes(args.computer_use))
        return { status: 'POSTMAN_DEVSPACE_SCOPE_INVALID' }
      const computerUse = args.computer_use ?? (args.computer_use_target !== undefined ? 'allow' : 'deny')
      const taskContext = contexts?.get(exec.agent.id)
      if (parsed.transportKind !== 'devspace' && taskContext?.universalProject &&
          !await contexts.verifyDirectPublication?.(exec.agent.id))
        return { status: 'POSTMAN_TASK_REMOTE_PUBLICATION_REQUIRED' }
      if ((args.workspace_root === undefined) !== (args.workspace_access === undefined))
        return { status: 'POSTMAN_DEVSPACE_SCOPE_INVALID' }
      let approvedScope
      if (args.workspace_root !== undefined) {
        if (typeof args.workspace_root !== 'string' || !isAbsolute(args.workspace_root))
          return { status: 'POSTMAN_DEVSPACE_SCOPE_INVALID' }
        try {
          const target = realpathSync(args.workspace_root)
          if (target !== resolve(args.workspace_root) || !lstatSync(target).isDirectory() ||
              lstatSync(target).isSymbolicLink()) throw Error('path_not_owned')
          const repoRoot = resolve(taskContext?.repositoryPath ?? taskContext?.worktree ?? '')
          const inside = relative(repoRoot, target), containsRepo = relative(target, repoRoot)
          const overlapsRepo = (inside === '' || !inside.startsWith('..') && !isAbsolute(inside)) ||
            (containsRepo === '' || !containsRepo.startsWith('..') && !isAbsolute(containsRepo))
          if (args.workspace_access === 'write' && overlapsRepo)
            return { status: 'POSTMAN_DEVSPACE_ISOLATED_CONTEXT_REQUIRED' }
          approvedScope = { root: target, access: args.workspace_access }
        } catch {
          return { status: 'POSTMAN_DEVSPACE_SCOPE_INVALID' }
        }
      }
      if (taskContext?.devspaceReadOnly && (parsed.transportKind !== 'devspace' ||
          args.devspace_mode !== undefined &&
            !['READ_ONLY', 'WRITE_TEST'].includes(args.devspace_mode)))
        return { status: 'POSTMAN_DEVSPACE_READ_ONLY_SCOPE_REQUIRED' }
      if (parsed.inputFiles?.length && !postmanInputGrants.owns(exec.agent, contexts.get(exec.agent.id), parsed.inputFiles))
        return { status: 'POSTMAN_INPUT_PROVENANCE_REJECTED' }
      if (typeof contexts?.isRestoring === 'function' && contexts.isRestoring(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      if (typeof contexts?.hasActiveOperation === 'function' && contexts.hasActiveOperation(exec.agent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
      const inputBinding = parsed.inputFiles?.length
        ? postmanInputGrants.pin(exec.agent, contexts.get(exec.agent.id), parsed.inputFiles) : undefined
      try {
        const result = await jobs.accept(exec.agent, args.message, parsed.transportKind, inputBinding,
          undefined, args.devspace_mode, args.lane_id, approvedScope, { computerUse })
        if (result.status !== 'POSTMAN_BRIDGE_ACCEPTED') postmanInputGrants.unpin(inputBinding)
        return result
      } catch (error) { postmanInputGrants.unpin(inputBinding); throw error }
    },
  })
}

export function createPostmanBridgeStatusTool(ctx, jobs) {
  return defineTool({
    name: POSTMAN_BRIDGE_STATUS_TOOL_NAME,
    description: 'Read the authoritative owned Bridge result. Explicit recover starts an addressed recovery; reconcileWriter checks Host native evidence before releasing an archived writer root. Neither action proves task success.',
    parameters: { bridge_job_id: { type: 'string', required: true,
      description: 'Exact bridgeJobId from POSTMAN_BRIDGE_ACCEPTED or POSTMAN_BRIDGE_READY.' },
      retrySync: { type: 'boolean', description: 'Retry only local task publication synchronization; never send Direct again.' },
      recover: { type: 'boolean', description: 'DevSpace: explicitly authorize the next recovery using the original or latest bridgeJobId; Host resolves the owned chain. Known chat continues; unavailable chat uses a new owned attempt with safe isolation if old writes are unknown. Legacy: existing one-shot Direct capability, no prompt/state arguments.' },
      reconcileWriter: { type: 'boolean', description: 'Explicitly check this exact archived writer using Host-owned native execution evidence. Releases its retained root only after revoked future tool authority, whole-process settlement and absence of other live writers. No caller-provided receipt.' } },
    output: output(),
    async execute(args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      if (args?.reconcileWriter === true && (args?.retrySync === true || args?.recover === true))
        return { status: 'POSTMAN_BRIDGE_ARGUMENTS_INVALID' }
      const status = await jobs.status(exec.agent, args?.bridge_job_id, args?.retrySync === true,
        args?.recover === true, args?.reconcileWriter === true)
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
    description: 'Exact Leader-owned running @PostmanDevspace: queue same-chat steer, explicit preempt/Stop even during active DevSpace, or read control receipts. QUEUED is not Send/Stop proof. Stop generation does not prove shell stopped; new sends are recorded separately.',
    parameters: {
      bridge_job_id: { type: 'string', required: true, description: 'Exact active owned bridgeJobId.' },
      action: { type: 'string', required: true, enum: ['steer', 'preempt', 'stop', 'status'] },
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
    parameters: {}, output: output(),
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      if (!authorized(exec, ctx)) return { status: 'POSTMAN_TEAM_CALLER_REJECTED' }
      const id = exec.agent.id, context = contexts.get(id), row = contexts.record(id)
      return { status: 'POSTMAN_TEAM_STATUS',
        task: { contextReady: Boolean(context), branch: context?.branch ?? row?.branch ?? null,
          ...(row ? { stage: row.stage, closedAt: row.closedAt ?? null,
            ...Object.fromEntries(['repository', 'repositoryPath', 'originUrl', 'baseCommit', 'worktree']
              .filter(key => row[key] !== undefined).map(key => [key, row[key]])),
            defaultBranch: row.defaultBranch ?? 'main',
            baseSource: row.baseSource ?? (row.universalProject ? 'unproven' : 'legacy') } : {}),
          restoring: contexts.isRestoring(id), activeOperation: contexts.hasActiveOperation(id) },
        ...worker.teamSnapshot(exec.agent), bridge: jobs.teamSnapshot(exec.agent),
        devspaceLuna: jobs.devspaceLunaSnapshot(exec.agent) }
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
  // Workspace policy asks the same exact current Host role predicate used by PTC.
  ctx.on('postman/workspace-role', agent => worker.roleOf(agent))
  const stopContextWatch = contexts.onContextChange(id => {
    postmanInputGrants.releaseStale(ctx.agents.get(id), contexts.get(id))
    worker.refreshLeader(id)
  })
  const jobs = createPostmanBridgeJobs(ctx, coordinator, grants, postmanTaskContexts, worker)
  const ownsPtcWorker = agent => worker.roleOf(agent) === 'sol' && worker.ownsLiveWorker(agent) && Boolean(worker.ptcContextOf(agent))
  ptc = createPtcAdapter(ctx, { authorize: isTopLevelPostmanPtcLeader, workerContextOf: worker.ptcContextOf,
    hasActiveWork: (agent, role) => worker.hasActiveWork(agent) || role === 'leader' && jobs.hasActiveWork(agent),
    resolveAssignment: (agent, leaderProfile) => isTopLevelPostmanPtcLeader(agent) ?
      { profile: leaderProfile, role: 'leader' } : ownsPtcWorker(agent) ? { profile: SOL_WORKER_PROFILE, role: 'sol' } : null })
  ctx.on('postman/subagent-report-defer', (parent, child, content) =>
    jobs.canDeferLunaBootstrapReport(parent, child, content) ? true : undefined)
  ctx.on('postman/subagent-settlement-defer', (parent, child, terminal) =>
    jobs.canDeferLunaBootstrapSettlement(parent, child, terminal) ||
    parent?.phase?.kind === 'idle' && parent.inbox?.hasPending === false &&
    worker.canDeferSettlement(parent, child, terminal) ? true : undefined)
  // Guard model-direct operations, not ordinary visibility: nested PTC calls carry the outer token.
  ctx.tools.guard(exec => postmanPtcDirectCallGuard(exec, id => ctx.agents.get(id), ownsPtcWorker))
  ctx.tools.register(ptc.tool)
  ctx.tools.register(createPostmanTaskPrepareTool(ctx, contexts, { jobs, worker }))
  ctx.tools.register(createPostmanTaskCloseTool(ctx, contexts, { jobs, worker }))
  ctx.tools.register(createPostmanInputFilesTool(ctx, contexts, { currentAttachments,
    resolveAttachment: (ref, signal) => ctx.attachments.readImage(ref, signal) }))
  ctx.tools.register(createPostmanBridgeTool(ctx, jobs, postmanTaskContexts))
  ctx.tools.register(createPostmanBridgeStatusTool(ctx, jobs))
  ctx.tools.register(createPostmanBridgeListTool(ctx, jobs))
  ctx.tools.register(createPostmanBridgeStopTool(ctx, jobs))
  ctx.tools.register(createPostmanDevspaceLunaCloseTool(ctx, jobs))
  ctx.tools.register(createPostmanDevspaceControlTool(ctx, jobs))
  ctx.tools.register(createPostmanTeamStatusTool(ctx, postmanTaskContexts, worker, jobs))
  ctx.tools.register(createPostmanTaskRestoreTool(ctx, postmanTaskContexts, { jobs, worker }))
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
