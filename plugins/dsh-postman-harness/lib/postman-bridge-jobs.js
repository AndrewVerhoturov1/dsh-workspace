import { randomUUID } from 'node:crypto'
import { relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postmanInputGrants } from './postman-input-files.js'
import { DirectPostmanJobManager, parsePostmanUserTurn } from './direct-current-turn.js'
import { createPostmanDevspaceLanes } from './postman-devspace-lanes.js'
import { requestDevspaceControl, readDevspaceControls, loadDevspaceChannelForOwner,
  revokeDevspaceChannel, readDevspaceEvent, devspaceTerminal } from './postman-devspace.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildPostmanBridgeStartRequest, isTopLevelPostmanSupervisor, POSTMAN_BRIDGE_PROVIDER,
  settleTrustedPostmanStatus } from './postman-bridge-core.js'

const HOST_SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function diagnostic(error) {
  const text = String(error?.message ?? error ?? 'unknown error')
  return text.length <= 512 ? text : text.slice(0, 509) + '...'
}

// Copy trusted data without JSON.stringify: that operation silently drops invalid fields.
// A malformed terminal fails closed instead of losing text or artifact metadata.
function losslessValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('POSTMAN_BRIDGE_NON_JSON_TERMINAL')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('POSTMAN_BRIDGE_NON_JSON_TERMINAL')
  }
  const keys = Reflect.ownKeys(value)
  if (array && (keys.length !== value.length + 1 || keys.some(key =>
    key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= value.length)))) throw new Error('POSTMAN_BRIDGE_NON_JSON_TERMINAL')
  const copy = array ? [] : {}
  ancestors.add(value)
  try {
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string') throw new Error('POSTMAN_BRIDGE_NON_JSON_TERMINAL')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || (!array && !descriptor.enumerable)) {
        throw new Error('POSTMAN_BRIDGE_NON_JSON_TERMINAL')
      }
      if (array && (!descriptor.enumerable || !Object.hasOwn(value, key))) {
        throw new Error('POSTMAN_BRIDGE_NON_JSON_TERMINAL')
      }
      Object.defineProperty(copy, key, { value: losslessValue(descriptor.value, ancestors),
        enumerable: true, writable: true, configurable: true })
    }
    if (array && copy.length !== value.length) throw new Error('POSTMAN_BRIDGE_NON_JSON_TERMINAL')
    return copy
  } finally { ancestors.delete(value) }
}

// Legacy operations may omit the newer correlation fields, but terminal identity
// is required and known fields must agree before synchronization or grants.
function hasTrustedTerminal(operation) {
  const terminal = operation.terminal
  return terminal?.status === 'POSTMAN_BRIDGE_TERMINAL' &&
    ['COMPLETED', 'FAILED'].includes(terminal.terminalStatus) &&
    Object.hasOwn(terminal, 'requestId') && typeof terminal.requestId === 'string' &&
    /^REQ_\d{8}T\d{6}Z_\d{4}$/.test(terminal.requestId) &&
    Object.hasOwn(terminal, 'transportKind') && ['artifact', 'text', 'image', 'devspace'].includes(terminal.transportKind) &&
    terminal.result !== null && typeof terminal.result === 'object' && !Array.isArray(terminal.result) &&
    (operation.requestId === undefined || operation.requestId === terminal.requestId) &&
    (operation.transportKind === undefined || operation.transportKind === terminal.transportKind) &&
    (terminal.result.requestId === undefined || terminal.result.requestId === terminal.requestId)
}

function countsAgainstLimit(operation) {
  if (operation.executionRevoked) return false
  return operation.state === 'pending' || operation.state === 'unknown' ||
    operation.state === 'received' &&
      (!['synchronized', 'not-required'].includes(operation.synchronization) ||
        !hasTrustedTerminal(operation) && !(operation.phase === 'not-sent' &&
          operation.synchronization === 'not-required' &&
          (operation.requestId || operation.cancellationRequested === true ||
            operation.transportKind === 'devspace' && operation.preSendFailure === NOT_SENT_WORKTREE_PREFLIGHT &&
            !operation.childSessionId) && !operation.terminal))
}

function operationIn(row, bridgeJobId) {
  return row?.bridgeOperations?.[bridgeJobId] ??
    row?.retiredTasks?.find(task => task?.bridgeOperations?.[bridgeJobId])?.bridgeOperations[bridgeJobId]
}

function updateHistoricalOperation(row, bridgeJobId, update) {
  if (row.bridgeOperations?.[bridgeJobId]) return { ...row, bridgeOperations: {
    ...row.bridgeOperations, [bridgeJobId]: update(row.bridgeOperations[bridgeJobId]) } }
  if (row.retiredTasks?.some(task => task?.bridgeOperations?.[bridgeJobId])) return { ...row,
    retiredTasks: row.retiredTasks.map(task => task?.bridgeOperations?.[bridgeJobId]
      ? { ...task, bridgeOperations: { ...task.bridgeOperations,
          [bridgeJobId]: update(task.bridgeOperations[bridgeJobId]) } } : task) }
  return row
}

// An exact native worktree preflight returned before Luna, REQ allocation or Web Send.
// A missing REQ alone is never proof: require the explicit Host status and one
// matching, never-used lane reservation before releasing the resource.
const NOT_SENT_WORKTREE_PREFLIGHT = 'POSTMAN_DEVSPACE_WORKTREE_NOT_READY'
function preflightReservation(row, bridgeJobId) {
  const op = row?.bridgeOperations?.[bridgeJobId]
  const laneId = op?.devspace?.laneId
  const lane = row?.devspaceLanes?.[laneId]
  return op && op.transportKind === 'devspace' &&
    ['pending', 'unknown'].includes(op.state) && op.phase === 'reserved' &&
    op.devspace?.mode === 'WRITE_ISOLATED' &&
    !op.requestId && !op.childSessionId && !op.terminal && !op.devspace?.channel &&
    typeof laneId === 'string' && lane?.state === 'reserved' &&
    lane.activeBridgeJobId === bridgeJobId && !lane.childId &&
    Array.isArray(lane.requestIds) && lane.requestIds.length === 0 &&
    lane.conversationRef == null
}
function recordProvenPreflightFailure(row, bridgeJobId) {
  if (!preflightReservation(row, bridgeJobId)) throw Error('POSTMAN_BRIDGE_PRE_SEND_PROOF_CHANGED')
  const lanes = { ...row.devspaceLanes }
  delete lanes[row.bridgeOperations[bridgeJobId].devspace.laneId]
  return { ...row, devspaceLanes: lanes, bridgeOperations: {
    ...row.bridgeOperations, [bridgeJobId]: { ...row.bridgeOperations[bridgeJobId],
      state: 'received', phase: 'not-sent', synchronization: 'not-required',
      preSendFailure: NOT_SENT_WORKTREE_PREFLIGHT },
  } }
}
function trustedPreflightReceipt(parent, bridgeJobId, row) {
  if (!preflightReservation(row, bridgeJobId)) return false
  const createdAt = row.bridgeOperations[bridgeJobId].createdAt
  const laneId = row.bridgeOperations[bridgeJobId].devspace.laneId
  // tool/code-dispatch is written by native ToolRuntime, not model prose or a
  // user-supplied PTC return. Rebind exactly to this owner, job and generation.
  return parent?.session?.events?.some(event => {
    if (event.type !== 'tool/code-dispatch') return false
    const d = event.data
    if (d?.name !== 'postman_bridge_status' || d.isError !== false ||
        d.arguments?.bridge_job_id !== bridgeJobId ||
        !Array.isArray(d.content) || d.content.length !== 1 || d.content[0]?.type !== 'text') return false
    let result
    try { result = JSON.parse(d.content[0].text) } catch { return false }
    return result?.bridgeJobId === bridgeJobId && result?.createdAt === createdAt &&
      result?.laneId === laneId && result?.status === 'POSTMAN_BRIDGE_FAILED' &&
      result?.state === 'FAILED' && result?.trustedStatus === NOT_SENT_WORKTREE_PREFLIGHT &&
      result?.childSessionId == null && result?.requestId == null &&
      result?.recoveryEligible === false
  }) === true
}

function snapshot(job) {
  return {
    bridgeJobId: job.bridgeJobId, state: job.state,
    transportKind: job.transportKind ?? null, createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
    childSessionId: job.childSessionId ?? null, requestId: job.requestId ?? null,
    ...(job.laneId ? { laneId: job.laneId } : {}),
  }
}

/** Process-local jobs live through tool invocation and retain terminal until plugin disposal. */
export function createPostmanBridgeJobs(ctx, coordinator, grants, contexts, worker, direct = new DirectPostmanJobManager()) {
  if (typeof coordinator?.run !== 'function') throw new Error('POSTMAN_BRIDGE_COORDINATOR_REQUIRED')
  const jobs = new Map()
  const admissionTails = new Map()
  const coldRecovery = new Map()
  const bootstrapAgents = new WeakMap()
  const devspaceLuna = createPostmanDevspaceLanes(ctx, contexts, direct)
  const devspaceCoordinator = coordinator.fork?.() ?? coordinator
  let disposed = false

  async function trustedStatusReader(child, signal) {
    const statusTool = ctx.tools.get('postman_current_turn_status', child)
    if (typeof statusTool?.execute !== 'function') return { status: signal?.aborted
      ? 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN' : 'NO_JOB' }
    return statusTool.execute({}, { agent: child, signal })
  }

  // Stop cancels the Bridge child, not the separately owned Direct transport.
  // Observe its trusted terminal even after abort; RUNNING then remains unknown.
  function settleStatus(job, readStatus) {
    return settleTrustedPostmanStatus(async () => {
      const value = await readStatus()
      return job.controller.signal.aborted && (value?.status === 'RUNNING' ||
        value?.status === 'NO_JOB' && value.requestId != null)
        ? { status: 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN', requestId: value.requestId ?? null } : value
    })
  }

  async function lifecycle(job, message) {
    if (contexts?.record?.(job.parentSessionId)?.bridgeOperations?.[job.bridgeJobId]?.executionRevoked)
      return { status: 'POSTMAN_BRIDGE_ARCHIVED' }
    job.state = 'STARTING'
    job.startedAt = new Date().toISOString()
    let parent
    try { parent = ctx.agents.get(job.parentSessionId) }
    catch { return { status: 'POSTMAN_BRIDGE_PARENT_UNAVAILABLE' } }
    // Resolve at actual admission, not when the tool accepted the queued job.
    try {
      if (parent?.id !== job.parentSessionId || !isTopLevelPostmanSupervisor(parent)) {
        return { status: 'POSTMAN_BRIDGE_PARENT_UNAVAILABLE' }
      }
    } catch { return { status: 'POSTMAN_BRIDGE_PARENT_UNAVAILABLE' } }
    if (contexts && contexts.get(parent.id) !== job.taskContext) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    if (typeof contexts?.hasActiveOperation === 'function' && contexts.hasActiveOperation(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
    if (job.recoveryFrom) {
      job.state = 'RUNNING'
      const previous = { state: 'completed', requestId: job.recoveryFrom.requestId,
        result: job.recoveryFrom.result, transportKind: job.transportKind, branch: job.taskContext.branch,
        repository: job.taskContext.repository }
      const started = await direct.continueLast(job.bridgeJobId,
        job.taskContext.universalProject ? HOST_SOURCE_ROOT : parent.session.header.cwd, previous,
        async requestId => {
          if (typeof contexts?.changeRecord === 'function') await contexts.changeRecord(job.parentSessionId, row => {
            const op = row.bridgeOperations?.[job.bridgeJobId]
            if (op?.state !== 'pending') throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
            return { ...row, bridgeOperations: { ...row.bridgeOperations, [job.bridgeJobId]:
              { ...op, requestId, phase: 'request-known' } } }
          })
        })
      job.requestId = started.requestId
      return { ...await settleStatus(job, () => direct.wait(job.bridgeJobId, undefined, job.controller.signal)),
        transportKind: job.transportKind }
    }
    if (job.transportKind === 'devspace') return devspaceLuna.run(job, message, parent)
    let run
    try {
      run = await ctx.subagents.start(POSTMAN_BRIDGE_PROVIDER, buildPostmanBridgeStartRequest({
        parent, message, signal: job.controller.signal, transportKind: job.transportKind,
      }))
    } catch (error) {
      return { status: 'POSTMAN_BRIDGE_START_FAILED', diagnostic: diagnostic(error) }
    }
    job.childSessionId = String(run.id)
    if (typeof contexts?.changeRecord === 'function') {
      try {
        await contexts.changeRecord(job.parentSessionId, row => {
          const op = row.bridgeOperations?.[job.bridgeJobId]
          if (op?.state !== 'pending') throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
          return { ...row, bridgeOperations: { ...row.bridgeOperations, [job.bridgeJobId]:
            { ...op, childSessionId: job.childSessionId, phase: 'child-known' } } }
        })
      } catch (error) {
        try { await run.dispose() } catch {}
        return { status: 'POSTMAN_BRIDGE_CHILD_BINDING_FAILED', diagnostic: diagnostic(error) }
      }
    }
    if (contexts && !contexts.bindChild(job.parentSessionId, job.childSessionId, job.bridgeJobId)) {
      try { await run.dispose() } catch {}
      return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    }
    let terminal
    try {
      const child = run.localAgent
      if (child === undefined) {
        Promise.resolve(run.result).catch(() => undefined)
        return { status: 'POSTMAN_BRIDGE_CHILD_UNAVAILABLE' }
      }
      if (job.inputBinding && !postmanInputGrants.bindChild(job.inputBinding, parent, job.taskContext, child))
        return { status: 'POSTMAN_INPUT_PROVENANCE_REJECTED' }
      job.state = 'RUNNING'
      let childStopReason = 'error'
      let childDiagnostic
      try {
        const childResult = await run.result
        childStopReason = childResult?.stopReason ?? null
        childDiagnostic = childResult.diagnostic
      } catch (error) {
        childDiagnostic = diagnostic(error)
      }
      const trusted = await settleStatus(job,
        () => trustedStatusReader(child, job.controller.signal))
      terminal = losslessValue({ ...trusted, transportKind: job.transportKind, childStopReason,
        ...(childDiagnostic === undefined ? {} : { childDiagnostic }) })
      job.requestId = terminal.requestId ?? null
    } finally {
      // A failed cleanup must not be reported as clean completion or release early.
      try { await run.dispose() }
      finally {
        contexts?.releaseChild(job.childSessionId)
        postmanInputGrants.unpin(job.inputBinding)
        delete job.inputBinding
      }
    }
    // Coordinator releases its slot when this cleaned terminal is returned.
    return terminal
  }

  function notify(job) {
    if (disposed) return
    let leader
    try { leader = ctx.agents.get(job.parentSessionId) } catch (error) {
      job.notification = 'UNDELIVERED'
      job.notificationDiagnostic = diagnostic(error)
      return
    }
    try {
      if (leader?.id !== job.parentSessionId || !isTopLevelPostmanSupervisor(leader) ||
        typeof leader.followup !== 'function') {
        job.notification = 'UNDELIVERED'
        return
      }
    } catch (error) {
      job.notification = 'UNDELIVERED'
      job.notificationDiagnostic = diagnostic(error)
      return
    }
    const text = ['POSTMAN_BRIDGE_READY', 'protocol_version: 1',
      'bridge_job_id: ' + job.bridgeJobId, 'request_id: ' + (job.requestId ?? ''),
      'The trusted result must be read through postman_bridge_status.'].join('\n')
    try {
      leader.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-postman-harness-bridge', form: 'bridge-ready',
          targetSessionId: job.parentSessionId, bridgeJobId: job.bridgeJobId },
      }))
      job.notification = 'DELIVERED'
    } catch (error) {
      job.notification = 'UNDELIVERED'
      job.notificationDiagnostic = diagnostic(error)
    }
  }

  function accept(parent, message, transportKind, inputBinding, recoveryFrom, devspaceMode, requestedLaneId, approvedScope, options = {}) {
    const taskContext = contexts?.get(parent.id)
    if (contexts && !taskContext) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    if (typeof contexts?.isRestoring === 'function' && contexts.isRestoring(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
    if (typeof contexts?.hasActiveOperation === 'function' && contexts.hasActiveOperation(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
    if (disposed) return { status: 'POSTMAN_BRIDGE_UNAVAILABLE' }
    if (transportKind !== 'devspace' && (requestedLaneId !== undefined || approvedScope))
      return { status: 'POSTMAN_DEVSPACE_LANE_NOT_ALLOWED' }
    if (approvedScope && (!approvedScope.root || !['read', 'write'].includes(approvedScope.access)))
      return { status: 'POSTMAN_DEVSPACE_SCOPE_INVALID' }
    if (requestedLaneId !== undefined && (typeof requestedLaneId !== 'string' ||
        !(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestedLaneId) ||
          requestedLaneId === 'legacy')))
      return { status: 'POSTMAN_DEVSPACE_LANE_INVALID' }
    // The ordinary Devspace route owns a private output folder by default.
    // A Leader-prepared task branch opens its isolated worktree for writing.
    // The old explicit modes remain compatible and continue to restrict scope.
    if (transportKind === 'devspace' && devspaceMode === undefined)
      devspaceMode = taskContext?.devspaceReadOnly ? 'WRITE_TEST' : 'WRITE_ISOLATED'
    if (approvedScope && devspaceMode === 'READ_ONLY' && approvedScope.access === 'write')
      return { status: 'POSTMAN_DEVSPACE_SCOPE_INVALID' }
    devspaceMode = transportKind === 'devspace' && approvedScope
      ? options.recovery?.isolated && approvedScope.access === 'read' ? 'WRITE_TEST'
        : approvedScope.access === 'write'
        ? approvedScope.root === taskContext?.worktree && !taskContext?.devspaceReadOnly
          ? 'WRITE_ISOLATED' : 'WRITE_APPROVED_TARGET'
        : 'READ_ONLY'
      : devspaceMode
    if (transportKind === 'devspace' && devspaceMode === 'WRITE_ISOLATED' &&
        (taskContext?.devspaceReadOnly || !taskContext?.worktree))
      return { status: 'POSTMAN_DEVSPACE_ISOLATED_CONTEXT_REQUIRED' }
    if (taskContext?.devspaceReadOnly && (transportKind !== 'devspace' ||
        !['READ_ONLY', 'WRITE_TEST', 'WRITE_APPROVED_TARGET'].includes(devspaceMode)))
      return { status: 'POSTMAN_DEVSPACE_READ_ONLY_SCOPE_REQUIRED' }
    // Durable reservations plus the existing launch FIFO serialize overlapping
    // writers. Checking only this parent's live jobs before await is racy.
    const job = {
      bridgeJobId: randomUUID(), parentSessionId: parent.id, taskContext, transportKind, state: 'QUEUED',
      createdAt: new Date().toISOString(), controller: new AbortController(), inputBinding,
      notification: 'PENDING', recoveryFrom, devspaceMode, approvedScope,
      computerUse: options.computerUse ?? 'deny', devspaceRecovery: options.recovery,
      recoverySourceChannel: options.sourceChannel,
      ...(requestedLaneId ? { laneId: requestedLaneId } : {}),
    }
    if (typeof contexts?.changeRecord !== 'function') {
      // Unit fixtures without a durable registry retain the synchronous API.
      const live = [...jobs.values()].filter(item => item.parentSessionId === parent.id &&
        !['TERMINAL', 'FAILED', 'INTERRUPTED'].includes(item.state)).length
      return live >= 3 ? { status: 'POSTMAN_BRIDGE_LIMIT_REACHED' } : startJob(job, message)
    }
    // Serialize only durable admissions for this Leader, never Web lifecycles.
    // Concurrent calls each see the preceding persisted intent before counting slots.
    const prior = admissionTails.get('host') ?? Promise.resolve()
    const admit = async () => {
      try {
        // Read-only refusal is deterministic even if the durable storage backend
        // is unavailable. The atomic check below remains the admission authority.
        const existing = contexts.record?.(parent.id)
        const recoverySource = job.devspaceRecovery &&
          existing?.bridgeOperations?.[job.devspaceRecovery.sourceJobId]
        if (job.devspaceRecovery && (!recoverySource || recoverySource.archivedAt ||
            recoverySource.transportKind !== 'devspace' ||
            (options.recovery.freshConversation
              ? requestedLaneId !== undefined || !recoverySource.devspace?.recoveryRetired
              : recoverySource.devspace?.laneId !== requestedLaneId)))
          return { status: 'POSTMAN_DEVSPACE_RECOVERY_SOURCE_CHANGED' }
        if (recoverySource?.devspace?.recoveryNextJobId)
          return { status: 'POSTMAN_DEVSPACE_RECOVERY_ALREADY_RESERVED',
            bridgeJobId: recoverySource.devspace.recoveryNextJobId }
        const occupied = Object.values(existing?.bridgeOperations ?? {}).filter(countsAgainstLimit)
        const count = occupied.filter(op => (op.transportKind === 'devspace') ===
          (transportKind === 'devspace')).length +
          (transportKind !== 'devspace' && existing?.bridge ? 1 : 0)
        if (count >= 3) return { status: transportKind === 'devspace'
          ? 'POSTMAN_DEVSPACE_CAPACITY_REACHED' : 'POSTMAN_BRIDGE_LIMIT_REACHED' }
        let selectedLaneId
        await contexts.changeRecord(parent.id, old => {
          const operations = old.bridgeOperations ?? {}
          const sourceId = job.devspaceRecovery?.sourceJobId
          const source = sourceId && operations[sourceId]
          if (sourceId && (!source || source.archivedAt || source.devspace?.recoveryNextJobId ||
              (options.recovery.freshConversation
                ? requestedLaneId !== undefined || !source.devspace?.recoveryRetired
                : source.devspace?.laneId !== requestedLaneId)))
            throw Error('POSTMAN_DEVSPACE_RECOVERY_SOURCE_CHANGED')
          const occupied = Object.values(operations).filter(countsAgainstLimit)
          const count = occupied.filter(op => (op.transportKind === 'devspace') ===
            (transportKind === 'devspace')).length + (transportKind !== 'devspace' && old.bridge ? 1 : 0)
          if (count >= 3) throw new Error(transportKind === 'devspace'
            ? 'POSTMAN_DEVSPACE_CAPACITY_REACHED' : 'POSTMAN_BRIDGE_LIMIT_REACHED')
          let devspaceLanes = old.devspaceLanes
          if (transportKind === 'devspace') {
            // Do not migrate an in-flight historical Luna. It remains counted
            // independently until its own owner settles and adopts it.
            const available = { ...(old.devspaceLanes ?? {}) }
            if (old.devspaceLuna && !Object.hasOwn(available, 'legacy'))
              available.legacy = old.devspaceLuna
            selectedLaneId = requestedLaneId ??
              (options.recovery?.freshConversation ? undefined :
                Object.entries(available).find(([, lane]) => lane.state === 'ready' &&
                  !lane.activeBridgeJobId)?.[0])
            if (requestedLaneId && (!available[requestedLaneId] ||
                available[requestedLaneId].state !== 'ready' ||
                available[requestedLaneId].activeBridgeJobId))
              throw new Error('POSTMAN_DEVSPACE_LANE_UNAVAILABLE')
            if (!selectedLaneId) {
              if (Object.values(available).filter(lane => lane.state !== 'closed').length >= 3)
                throw new Error('POSTMAN_DEVSPACE_CAPACITY_REACHED')
              selectedLaneId = randomUUID()
            }
            const lane = available[selectedLaneId]
            if (lane?.requestIds?.length > 0 &&
                !(typeof lane.conversationRef === 'string' && /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(lane.conversationRef)))
              throw new Error('POSTMAN_DEVSPACE_CONTINUATION_UNPROVEN')
            if (lane && (lane.state !== 'ready' || lane.activeBridgeJobId))
              throw new Error('POSTMAN_DEVSPACE_LANE_UNAVAILABLE')
            devspaceLanes = { ...(old.devspaceLanes ?? {}),
              [selectedLaneId]: lane
                ? { ...lane, activeBridgeJobId: job.bridgeJobId }
                : { state: 'reserved', activeBridgeJobId: job.bridgeJobId,
                  requestIds: [], conversationRef: null } }
          }
          return { ...old,
            ...(devspaceLanes ? { devspaceLanes } : {}),
            bridgeOperations: { ...operations,
              ...(sourceId ? { [sourceId]: { ...source, devspace: {
                ...source.devspace, recoveryNextJobId: job.bridgeJobId } } } : {}),
              [job.bridgeJobId]: {
              state: 'pending', phase: 'reserved', transportKind, createdAt: job.createdAt,
              ...(transportKind === 'devspace' ? { devspace: {
                mode: devspaceMode, laneId: selectedLaneId,
                computerUse: job.computerUse, payload: source?.devspace?.payload ?? message,
                ...(job.devspaceRecovery ? { recovery: job.devspaceRecovery } : {}),
                ...(approvedScope ? { approvedRoot: approvedScope.root,
                  approvedAccess: approvedScope.access } : {}) } } : {}),
            } } }
        })
        if (selectedLaneId) job.laneId = selectedLaneId
        return startJob(job, message)
      } catch (error) {
        return { status: ['POSTMAN_BRIDGE_LIMIT_REACHED', 'POSTMAN_DEVSPACE_CAPACITY_REACHED',
          'POSTMAN_DEVSPACE_LANE_UNAVAILABLE', 'POSTMAN_DEVSPACE_CONTINUATION_UNPROVEN'].includes(error?.message)
          ? error.message : 'POSTMAN_BRIDGE_ADMISSION_FAILED',
          diagnostic: diagnostic(error) }
      }
    }
    const result = prior.then(admit, admit)
    const tail = result.then(() => undefined, () => undefined)
    admissionTails.set('host', tail)
    void tail.then(() => { if (admissionTails.get('host') === tail) admissionTails.delete('host') })
    return result
  }

  async function registerGrant(job) {
    const terminal = job.trustedTerminal
    if (terminal?.status !== 'POSTMAN_BRIDGE_TERMINAL' || terminal.result?.ok === false) return
    const artifact = terminal.result?.code === 'RESULT_DURABLE'
    job.grantDiagnostic = undefined
    try {
      if (await grants?.register(job.parentSessionId, terminal) !== true && artifact)
        job.grantDiagnostic = 'Artifact grant registration rejected.'
    } catch (error) { job.grantDiagnostic = diagnostic(error) }
    if (artifact && job.grantDiagnostic) job.state = 'FAILED'
  }

  // Use the owned Direct publication fact, not an error-code list.
  // Missing publicationReceipt alone is never proof that nothing was published.
  function noPublicationProven(terminal) {
    const result = terminal?.result
    return terminal.status === 'POSTMAN_BRIDGE_TERMINAL' &&
      ['FAILED', 'COMPLETED'].includes(terminal.terminalStatus) &&
      result?.ok === false && result.code === 'POSTMAN_TRANSPORT_FAILED' &&
      result.publicationReceipt === undefined && result.requestId === terminal.requestId &&
      typeof result.transportMessage === 'string' && result.transportMessage.length > 0 &&
      result.details !== null && typeof result.details === 'object' && !Array.isArray(result.details) &&
      result.publicationStarted === false
  }

  function publicationOf(terminal) {
    const result = terminal?.result
    if (terminal?.transportKind === 'devspace') return null // Private tasks never publish REQ or synchronize Git.
    return result?.ok === true ? result :
      result?.ok === false && ['POSTMAN_TRANSPORT_FAILED', 'ARTIFACT_CANDIDATE_SAVED', 'ARTIFACT_CANDIDATE_CHOICES', 'ARTIFACT_REJECTED'].includes(result.code) ? result.publicationReceipt : null
  }

  // Serialize retries on the one owned job, including the read-after-restart path.
  function retryPublication(job, publication) {
    if (job.syncAttempt) return job.syncAttempt
    const attempt = synchronize(job, publication)
    job.syncAttempt = attempt
    const clear = () => { if (job.syncAttempt === attempt) job.syncAttempt = null }
    void attempt.then(clear, clear)
    return attempt
  }

  async function completeWithoutPublication(job) {
    if (typeof contexts?.changeRecord === 'function') await contexts.changeRecord(job.parentSessionId, row => {
      const op = row.bridgeOperations?.[job.bridgeJobId]
      if (op?.state !== 'received') throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
      if (op.synchronization === 'not-required') return row
      return { ...row, bridgeOperations: { ...row.bridgeOperations,
        [job.bridgeJobId]: { ...op, phase: 'synchronized', synchronization: 'not-required' } } }
    })
    job.synchronization = 'not-required'
    job.syncDiagnostic = null
  }

  async function synchronize(job, publication) {
    const leaderId = job.parentSessionId
    let synchronized = false
    try {
      synchronized = await contexts.sync(leaderId, publication.taskPublicationCommit,
        publication.baseCommit, id => worker ? worker.pauseForOperation(id) : true)
    } catch { synchronized = { ok: false, diagnostic: { code: 'GIT_SYNC_FAILED' } } }
    if (synchronized !== true) {
      job.syncDiagnostic = synchronized?.diagnostic ?? { code: 'GIT_SYNC_FAILED' }
      job.synchronization = 'busy'
      return
    }
    job.syncDiagnostic = null
    // Grant registration is subordinate to verified publication and ZIP hash.
    await registerGrant(job)
    if (typeof contexts?.changeRecord === 'function') await contexts.changeRecord(leaderId, row => {
      const op = row.bridgeOperations?.[job.bridgeJobId]
      if (op?.state !== 'received') throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
      const operations = { ...row.bridgeOperations }
      if (job.grantDiagnostic && job.trustedTerminal.result?.code === 'RESULT_DURABLE')
        operations[job.bridgeJobId] = { ...op, phase: 'synchronized', synchronization: 'synchronized', grantDiagnostic: job.grantDiagnostic }
      else delete operations[job.bridgeJobId]
      return { ...row, bridgeOperations: operations }
    })
    job.synchronization = 'synchronized'
    if (!job.grantDiagnostic && job.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL') job.state = 'TERMINAL'
  }

  function resourceReady(job) {
    if (!['WRITE_ISOLATED','WRITE_APPROVED_TARGET'].includes(job.devspaceMode)) return true
    const root = job.approvedScope?.root ?? job.taskContext?.worktree
    const overlaps = other => other && (other === root ||
      !relative(other,root).startsWith('..') && !isAbsolute(relative(other,root)) ||
      !relative(root,other).startsWith('..') && !isAbsolute(relative(root,other)))
    const rows = contexts?.records?.() ?? [[job.parentSessionId,contexts?.record?.(job.parentSessionId)]]
    for (const [owner,row] of rows) {
      if (!row) continue
      for (const historical of [row, ...(row.retiredTasks ?? [])]) {
        if (Object.values(historical.bridgeOperations ?? {}).some(op => {
          if (op.writerSettlement) return false
          // Dirty isolation may preserve a task even when browser revocation
          // failed. Its saved writer scope still protects the original files.
          const unresolved = !op.executionRevoked &&
            (['pending', 'unknown'].includes(op.state) || technicalFailure(op))
          const retainedRoot = op.residualWriteRoot ??
            ((historical !== row || row.stage === 'closed') && unresolved
              ? op.devspace?.approvedAccess === 'write' ? op.devspace.approvedRoot
                : op.devspace?.mode === 'WRITE_ISOLATED' ? historical.worktree : null
              : null)
          return retainedRoot && overlaps(retainedRoot)
        })) return false
      }
      if (row.stage === 'closed') continue
      if (overlaps(row.worktree) && worker?.hasActiveWork?.(ctx.agents.get(owner))) return false
      for (const [id,op] of Object.entries(row.bridgeOperations ?? {})) {
        if (id === job.bridgeJobId || !countsAgainstLimit(op)) continue
        const otherRoot = op.devspace?.approvedAccess === 'write' ? op.devspace.approvedRoot
          : op.devspace?.mode === 'WRITE_ISOLATED' ? row.worktree : null
        if (!overlaps(otherRoot)) continue
        const other = jobs.get(id)
        // Cold pending/UNKNOWN reservations remain held; no replay or takeover.
        if (!other || other.state !== 'QUEUED' ||
            [...jobs.keys()].indexOf(id) < [...jobs.keys()].indexOf(job.bridgeJobId)) return false
      }
    }
    return true
  }
  const stopResourceChanges = contexts?.onContextChange?.(() => devspaceCoordinator.refresh?.())
  ctx.on?.('agent/status', () => devspaceCoordinator.refresh?.())

  function recoveryChain(parent, bridgeJobId) {
    const row = contexts?.record?.(parent.id), operations = row?.bridgeOperations ?? {}
    const rootJobId = operations[bridgeJobId]?.devspace?.recovery?.rootJobId ?? bridgeJobId
    const entries = [], seen = new Set()
    let id = rootJobId, successAt = null
    while (id) {
      const value = operations[id], previous = entries.at(-1)
      if (seen.has(id) || !value || value.transportKind !== 'devspace' ||
          !previous && value.devspace?.recovery ||
          previous && (value.devspace?.recovery?.rootJobId !== rootJobId ||
            value.devspace.recovery.sourceJobId !== previous.id ||
            value.devspace.recovery.attempt !== (previous.value.devspace?.recovery?.attempt ?? 0) + 1 ||
            previous.value.requestId && value.devspace.recovery.sourceRequestId !== previous.value.requestId ||
            !value.devspace.recovery.freshConversation && value.devspace.laneId !== previous.value.devspace?.laneId))
        return { rootJobId, entries, error: 'POSTMAN_DEVSPACE_RECOVERY_CHAIN_INVALID' }
      seen.add(id); entries.push({ id, value })
      if (recoveryOutcome(value).kind === 'received') successAt ??= id
      id = value.devspace?.recoveryNextJobId
    }
    if (!seen.has(bridgeJobId)) return { rootJobId, entries, error: 'POSTMAN_DEVSPACE_RECOVERY_CHAIN_INVALID' }
    return { rootJobId, entries, leaf: entries.at(-1), successAt }
  }

  function recoverySummary(parent, bridgeJobId) {
    const chain = recoveryChain(parent, bridgeJobId), rootJobId = chain.rootJobId
    const attempts = chain.entries.filter(entry => entry.id !== rootJobId).map(({ id, value }) => ({
        bridgeJobId: id, attempt: value.devspace.recovery.attempt,
        sourceJobId: value.devspace.recovery.sourceJobId,
        sourceRequestId: value.devspace.recovery.sourceRequestId ?? null,
        requestId: value.requestId ?? null, state: value.state,
        observation: value.terminal?.result?.transportDiagnostics?.recoveryObservation ?? null,
        sendState: value.terminal?.result?.transportDiagnostics?.submitProof?.sendState ??
          value.terminal?.result?.transportDiagnostics?.sendProof?.sendState ?? null,
        source: value.terminal?.result?.source ?? null,
        diagnostic: value.terminal?.result?.diagnostic ?? null,
        hostFailure: value.devspace?.hostFailure ?? null,
        classification: recoveryOutcome(value),
      })).sort((a, b) => a.attempt - b.attempt)
    const lastOp = chain.leaf?.value
    const exhausted = !chain.error && !chain.successAt &&
      (lastOp?.devspace?.recovery?.attempt ?? 0) >= 3 && technicalFailure(lastOp) &&
      lastOp?.state !== 'pending'
    return { rootJobId, attempts, exhausted,
      nextJobId: lastOp?.state === 'pending' && !lastOp.executionRevoked ? chain.leaf.id : null,
      lastJobId: chain.leaf?.id ?? null,
      resultJobId: chain.successAt ?? null,
      ...(chain.error ? { diagnostic: chain.error } : {}),
      ...(lastOp ? { classification: recoveryOutcome(lastOp) } : {}),
      ...(exhausted ? { choices: ['retry', 'new-conversation-or-executor', 'archive'] } : {}) }
  }

  function recoveryOutcome(op) {
    if (!op || op.transportKind !== 'devspace' || op.archivedAt || op.cancellationRequested ||
        op.executionRevoked && !op.devspace?.recoveryRetired)
      return { kind: 'decision', reason: 'operation-authority-revoked' }
    const result = op.terminal?.result
    const sourceObserved = result?.transportDiagnostics?.recoverySourceCompleted === true
    const sourceOutcome = sourceObserved ? result.transportDiagnostics.recoverySourceOutcome : null
    if (result?.reportedOutcome === 'DONE' || sourceOutcome === 'DONE')
      return { kind: 'received', reason: 'result-received-not-engineering-pass' }
    const codes = [result?.diagnostic, result?.transportCode, result?.code,
      op.devspace?.hostFailure?.status, op.devspace?.hostFailure?.diagnostic].filter(value => typeof value === 'string').join(' ')
    const blocker = result?.reportedOutcome === 'NEED_DECISION' || sourceOutcome === 'NEED_DECISION' ||
      sourceObserved && !['DONE', 'BLOCKED', 'NEED_DECISION'].includes(sourceOutcome) || result?.recoveryEligible === false ||
      result?.transportDiagnostics?.supersededByUserTurn === true ||
      /(?:NEED_DECISION|LEADER_DECISION_REQUIRED|PERMISSION_(?:DENIED|REQUIRED)|INPUT_PROVENANCE_REJECTED|ACCESS_DENIED|SCOPE_(?:DENIED|INVALID)|SAFETY|SECURITY|CAPABILITY_UNAVAILABLE|PERMANENT|CALLER_REJECTED|BINDING_(?:CHANGED|INVALID)|REPROOF_FAILED|WORKTREE_NOT_READY|LUNA_UNAVAILABLE)/i.test(codes) ||
      /(?:NEED_DECISION|NEEDS_(?:PARENT|LEADER)_GUIDANCE|permission denied|access denied|new (?:user )?permission required|out of (?:the )?(?:approved )?scope|нет разрешения|требуется (?:новое )?разрешение|отказано в доступе|постоянно недоступ)/i
        .test([result?.message, result?.assistantText, result?.transportDiagnostics?.recoverySourceMessage,
          op.devspace?.hostFailure?.diagnostic]
          .filter(value => typeof value === 'string').map(value => value.slice(0, 2000)).join('\n'))
    if (blocker) return { kind: 'decision', reason: 'permission-scope-or-leader-decision-required' }
    const retry = result?.reportedOutcome === 'BLOCKED' || sourceOutcome === 'BLOCKED' || result?.diagnostic === 'BLOCKED' ||
      result?.source === 'transport_diagnostic' || result?.diagnostic === 'PARTIAL' ||
      op.terminal?.terminalStatus === 'FAILED' || result?.ok === false ||
      !op.terminal && ['unknown', 'pending'].includes(op.state)
    return retry ? { kind: 'retry', reason: 'transient-or-ambiguous-failure-observe-first' }
      : { kind: 'received', reason: 'result-received-not-engineering-pass' }
  }
  const technicalFailure = op => recoveryOutcome(op).kind === 'retry'

  async function continueDevspaceRecovery(parent, bridgeJobId, manual = false) {
    if (disposed || !controlCallerAllowed(parent))
      return { status: 'POSTMAN_DEVSPACE_RECOVERY_UNAVAILABLE' }
    if (manual) {
      const chain = recoveryChain(parent, bridgeJobId)
      if (chain.error) return { status: chain.error, recovery: recoverySummary(parent, bridgeJobId) }
      if (chain.entries.some(entry => entry.value.archivedAt || entry.value.cancellationRequested ||
          entry.value.executionRevoked && !entry.value.devspace?.recoveryRetired))
        return { status: 'POSTMAN_DEVSPACE_RECOVERY_AUTHORITY_REVOKED', recovery: recoverySummary(parent, bridgeJobId) }
      if (chain.successAt) return { status: 'POSTMAN_DEVSPACE_RECOVERY_NOT_REQUIRED',
        bridgeJobId: chain.successAt, recovery: recoverySummary(parent, bridgeJobId) }
      bridgeJobId = chain.leaf.id
    }
    let row = contexts?.record?.(parent.id), op = row?.bridgeOperations?.[bridgeJobId]
    if (!technicalFailure(op)) return { status: recoveryOutcome(op).kind === 'decision'
      ? 'POSTMAN_DEVSPACE_RECOVERY_LEADER_DECISION_REQUIRED' : 'POSTMAN_DEVSPACE_RECOVERY_NOT_REQUIRED',
      bridgeJobId, recovery: recoverySummary(parent, bridgeJobId) }
    if (op.devspace?.recoveryNextJobId) return {
      status: 'POSTMAN_DEVSPACE_RECOVERY_ALREADY_RESERVED', bridgeJobId: op.devspace.recoveryNextJobId,
      recovery: recoverySummary(parent, bridgeJobId) }
    const attempt = (op.devspace?.recovery?.attempt ?? 0) + 1
    if (!manual && attempt > 3) return { status: 'POSTMAN_DEVSPACE_RECOVERY_EXHAUSTED',
      recovery: recoverySummary(parent, bridgeJobId) }
    const laneId = op.devspace?.laneId
    const lane = row.devspaceLanes?.[laneId] ?? (laneId === 'legacy' ? row.devspaceLuna : null)
    if (!op.devspace?.payload || op.childSessionId && lane?.childId !== op.childSessionId)
      return { status: 'POSTMAN_DEVSPACE_RECOVERY_SOURCE_CHANGED', bridgeJobId }
    const freshConversation = !lane?.childId ||
      !/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(lane.conversationRef ?? '')
    let live = jobs.get(bridgeJobId)
    if (live && !live.finishedAt) return { status: 'POSTMAN_DEVSPACE_RECOVERY_RUNNING', bridgeJobId,
      recovery: recoverySummary(parent, bridgeJobId) }
    if (!live && op.terminal && !op.executionRevoked) {
      await status(parent, bridgeJobId)
      live = jobs.get(bridgeJobId)
      op = contexts.record(parent.id).bridgeOperations[bridgeJobId]
      if (!technicalFailure(op)) return { status: 'POSTMAN_DEVSPACE_RECOVERY_NOT_REQUIRED', bridgeJobId }
    }
    if (live && !op.executionRevoked) {
      try {
        if (await devspaceLuna.upgradeLateBell(parent, live)) {
          op = contexts.record(parent.id).bridgeOperations[bridgeJobId]
          if (!technicalFailure(op)) return { status: 'POSTMAN_DEVSPACE_RECOVERY_NOT_REQUIRED', bridgeJobId }
        }
      } catch { /* A missing old event cannot authorize a fabricated result. */ }
    }
    if (op.devspace.channel) {
      try { revokeDevspaceChannel(loadDevspaceChannelForOwner(op.devspace.channel, {
        bridgeJobId, leaderSessionId: parent.id, lunaSessionId: op.childSessionId, requestId: op.requestId })) }
      catch (error) { return { status: 'POSTMAN_DEVSPACE_RECOVERY_FENCE_FAILED', diagnostic: diagnostic(error) } }
    }
    const sendState = op.terminal?.result?.transportDiagnostics?.submitProof?.sendState ??
      op.terminal?.result?.transportDiagnostics?.sendProof?.sendState
    const possibleWriteRoot = op.requestId && !op.writerSettlement && sendState !== 'PROVEN_NOT_SENT'
      ? op.devspace.approvedAccess === 'write' ? op.devspace.approvedRoot
        : op.devspace.mode === 'WRITE_ISOLATED' ? row.worktree : null
      : null
    const isolated = Boolean(possibleWriteRoot || op.devspace.recovery?.isolated)
    // A cold reservation is an uncertain old action. Revoke its browser rights
    // before reserving a fresh attempt; never replay an old click or REQ.
    if (!op.terminal || freshConversation || possibleWriteRoot) {
      await contexts.changeRecord(parent.id, current => {
        const before = current.bridgeOperations?.[bridgeJobId]
        if (before?.devspace?.recoveryNextJobId) return current
        const child = current.devspaceLanes?.[laneId] ?? (laneId === 'legacy' ? current.devspaceLuna : null)
        if (!before || before.archivedAt || before.requestId !== op.requestId ||
            child?.childId !== lane?.childId || child?.activeBridgeJobId && child.activeBridgeJobId !== bridgeJobId)
          throw Error('POSTMAN_DEVSPACE_RECOVERY_SOURCE_CHANGED')
        const nextLane = child ? { ...child, state: freshConversation ? 'closed' : 'ready', activeBridgeJobId: null } : null
        return { ...current, ...(nextLane ? laneId === 'legacy' && !current.devspaceLanes?.legacy
          ? { devspaceLuna: nextLane } : { devspaceLanes: { ...current.devspaceLanes, [laneId]: nextLane } } : {}),
          bridgeOperations: { ...current.bridgeOperations, [bridgeJobId]: {
            ...before, ...(!before.terminal ? { state: 'unknown' } : {}),
            ...(freshConversation || !before.terminal ? { executionRevoked: true,
              devspace: { ...before.devspace, recoveryRetired: true } } : {}),
            ...(possibleWriteRoot ? { residualWriteRoot: possibleWriteRoot } : {}) } } }
      })
      row = contexts.record(parent.id); op = row.bridgeOperations[bridgeJobId]
      if (op.devspace?.recoveryNextJobId) return { status: 'POSTMAN_DEVSPACE_RECOVERY_ALREADY_RESERVED',
        bridgeJobId: op.devspace.recoveryNextJobId, recovery: recoverySummary(parent, bridgeJobId) }
    }
    const sourceRequestId = op.requestId ?? op.devspace.recovery?.sourceRequestId ?? lane?.requestIds?.at(-1)
    const sourceChannel = op.devspace.channel ??
      row.bridgeOperations?.[op.devspace.recovery?.sourceJobId]?.devspace?.channel
    const original = parsePostmanUserTurn(op.devspace.payload)
    let inputBinding
    if (original.inputFiles?.length) {
      try { inputBinding = postmanInputGrants.pin(parent, contexts.get(parent.id), original.inputFiles) }
      catch {
        await contexts.changeRecord(parent.id, current => updateHistoricalOperation(current, bridgeJobId, before => ({
          ...before, devspace: { ...before.devspace, hostFailure: {
            status: 'POSTMAN_INPUT_PROVENANCE_REJECTED', diagnostic: 'Select the original inputs again through the owned input tool' } },
        })))
        return { status: 'POSTMAN_INPUT_PROVENANCE_REJECTED', bridgeJobId,
          recovery: recoverySummary(parent, bridgeJobId), action: 'Select the original inputs again through the owned input tool' }
      }
    }
    const message = '@PostmanDevspace' + (original.inputFiles?.length
      ? ' --input-files-json ' + JSON.stringify(original.inputFiles) + '\n' : ' ') +
      'Восстановление разрешённой задачи, попытка ' + attempt +
      ', после REQ ' + (sourceRequestId ?? 'без выделенного REQ') + '. Сначала проверь историю, ' +
      'результат, уже изменённые файлы и ещё выполняющиеся процессы. Продолжи с места остановки: ' +
      'выполни только недостающий шаг. Не повторяй уже выполненные команды и не запускай ' +
      'конфликтующую запись, пока прежний процесс не завершён. Неопределённость старой отправки ' +
      'не означает её отсутствие. ' + (freshConversation
        ? 'Сохранённый разговор недоступен: не выдумывай его историю. Начни с проверки фактов. ' : '') +
      (isolated ? 'Восстановление изолировано: прежнюю область только читай, новые результаты сохраняй ' +
        'только в новой приватной writeRoot. Перенос в прежние файлы требует проверки завершения старого writer. ' : '') +
      'Исходное разрешённое намерение:\n' +
      original.payload
    const approvedScope = isolated ? { root: possibleWriteRoot ?? op.devspace.approvedRoot ?? row.worktree, access: 'read' }
      : op.devspace.approvedRoot ? { root: op.devspace.approvedRoot, access: op.devspace.approvedAccess } : undefined
    let accepted
    try {
      accepted = await accept(parent, message, 'devspace', inputBinding, undefined,
        isolated ? 'WRITE_TEST' : op.devspace.mode, freshConversation ? undefined : laneId, approvedScope,
        { computerUse: op.devspace.computerUse ?? 'deny', ...(!freshConversation && sourceChannel ? { sourceChannel } : {}), recovery: {
          rootJobId: op.devspace.recovery?.rootJobId ?? bridgeJobId,
          sourceJobId: bridgeJobId, ...(sourceRequestId ? { sourceRequestId } : {}), attempt,
          ...(freshConversation ? { freshConversation: true } : {}), ...(isolated ? { isolated: true } : {}) } })
    } catch (error) { postmanInputGrants.unpin(inputBinding); throw error }
    if (accepted.status !== 'POSTMAN_BRIDGE_ACCEPTED') postmanInputGrants.unpin(inputBinding)
    return { ...accepted, recovery: recoverySummary(parent, bridgeJobId) }
  }

  function startJob(job, message) {
    jobs.set(job.bridgeJobId, job)
    // Coordinator holds the active slot only through child disposal, never through grants.
    let admission
    try { admission = (job.transportKind === 'devspace' ? devspaceCoordinator : coordinator)
        .run(job.controller.signal, () => lifecycle(job, message), () => resourceReady(job)) }
    catch (error) { admission = Promise.reject(error) }
    job.completion = admission.then(async result => {
        // A verified terminal is delivery evidence even when the shared tree is
        // temporarily busy. Persist it before any synchronization attempt.
        const safe = losslessValue(result)
        const archived = operationIn(contexts?.record?.(job.parentSessionId), job.bridgeJobId)
        if (archived?.executionRevoked || contexts?.get?.(job.parentSessionId) !== job.taskContext) {
          if (safe.status === 'POSTMAN_BRIDGE_TERMINAL')
            await contexts.changeRecord(job.parentSessionId, row =>
              updateHistoricalOperation(row, job.bridgeJobId, before => ({ ...before, lateTerminal: safe })))
          job.trustedTerminal = safe
          job.state = 'INTERRUPTED'
          return
        }
        job.trustedTerminal = safe
        job.requestId = safe.requestId ?? job.requestId ?? null
        job.state = safe.status === 'POSTMAN_BRIDGE_TERMINAL' ? 'TERMINAL'
          : safe.status === 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN' ? 'INTERRUPTED' : 'FAILED'
        // Local lifecycle failures are not Direct delivery authority. Retain only
        // already journaled correlation; settlement below marks it unknown.
        if (job.state !== 'TERMINAL') return
        if (typeof contexts?.changeRecord === 'function') {
          await contexts.changeRecord(job.parentSessionId, row => {
            const op = row.bridgeOperations?.[job.bridgeJobId]
            if (op?.state !== 'pending' || op.requestId && safe.requestId && op.requestId !== safe.requestId)
              throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
            return { ...row, bridgeOperations: { ...row.bridgeOperations,
              [job.bridgeJobId]: { ...op, state: 'received', phase: 'terminal',
                requestId: safe.requestId ?? op.requestId, terminal: safe,
                publication: publicationOf(safe) ?? op.publication, synchronization: 'pending' } } }
          })
        }
        const publication = publicationOf(safe)
        // Keep uncertain publication outcomes blocked; a missing receipt by
        // itself does not establish that the external operation did nothing.
        job.synchronization = contexts ? 'busy' : 'not-required'
        if (job.state === 'TERMINAL' && job.transportKind === 'devspace')
          await completeWithoutPublication(job)
        else if (job.state === 'TERMINAL' && publication && contexts)
          await retryPublication(job, publication)
        else if (job.state === 'TERMINAL' && noPublicationProven(safe) && contexts?.changeRecord)
          await completeWithoutPublication(job)
        else if (job.state === 'TERMINAL' && !contexts) await registerGrant(job)
      })
      .catch(error => {
        if (job.trustedTerminal?.status !== 'POSTMAN_BRIDGE_TERMINAL') job.state = 'FAILED'
        job.diagnostic = diagnostic(error)
        if (job.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL') job.synchronization = 'busy'
      })
      .then(async () => {
        if (typeof contexts?.changeRecord === 'function') {
          try {
            await contexts.changeRecord(job.parentSessionId, row => {
              const current = row.bridgeOperations?.[job.bridgeJobId]
              // Received terminal is authoritative even if a later sync or grant
              // fails. Never reinterpret it as unknown external delivery.
              if (current?.state === 'received' || current?.executionRevoked) return row
              if (!current) {
                if (operationIn(row, job.bridgeJobId)?.executionRevoked ||
                    contexts.get(job.parentSessionId) !== job.taskContext) return row
                if (job.synchronization === 'synchronized') return row
                throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
              }
              // A rejected isolated worktree is verified before any Luna/REQ.
              // Release only the matching empty lane, preserving a precise
              // not-sent refusal for subsequent cold reads and audit.
              if (job.trustedTerminal?.status === NOT_SENT_WORKTREE_PREFLIGHT &&
                  !job.childSessionId && !job.requestId && preflightReservation(row, job.bridgeJobId))
                return recordProvenPreflightFailure(row, job.bridgeJobId)
              // Only an actual Direct NO_JOB plus a pre-request journal proves
              // that a started child stopped before transport. Missing tools do not.
              const notSent = job.cancellationRequested && job.requestId == null && current.requestId == null &&
                !current.terminal && ['reserved', 'child-known'].includes(current.phase) &&
                (!job.startedAt || job.trustedTerminal?.status === 'POSTMAN_BRIDGE_NO_TRANSPORT')
              return { ...row, bridgeOperations: { ...row.bridgeOperations,
                [job.bridgeJobId]: notSent
                  ? { ...current, state: 'received', phase: 'not-sent', synchronization: 'not-required' }
                  : { ...current, state: 'unknown', ...(job.transportKind === 'devspace' ? {
                    devspace: { ...current.devspace, hostFailure: {
                      status: job.trustedTerminal?.status ?? 'POSTMAN_DEVSPACE_HOST_LIFECYCLE_FAILED',
                      ...(job.trustedTerminal?.diagnostic || job.diagnostic ? {
                        diagnostic: String(job.trustedTerminal?.diagnostic ?? job.diagnostic) } : {}) } } } : {}) } } }
            })
            if (job.cancellationRequested && job.trustedTerminal?.status !== 'POSTMAN_BRIDGE_TERMINAL') {
              const settled = contexts.record?.(job.parentSessionId)?.bridgeOperations?.[job.bridgeJobId]
              const notSent = settled?.state === 'received' && settled.phase === 'not-sent'
              job.trustedTerminal = { status: notSent ? 'POSTMAN_BRIDGE_NOT_SENT' : 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN' }
              job.synchronization = notSent ? 'not-required' : undefined
              job.state = 'INTERRUPTED'
            }
          } catch (error) { job.state = 'FAILED'; job.diagnostic = diagnostic(error) }
        }
        postmanInputGrants.unpin(job.inputBinding)
        delete job.inputBinding
        job.finishedAt = new Date().toISOString()
        if (!disposed && job.transportKind === 'devspace' && !job.cancellationRequested) {
          try { job.recovery = await continueDevspaceRecovery(ctx.agents.get(job.parentSessionId), job.bridgeJobId) }
          catch (error) { job.recovery = { status: 'POSTMAN_DEVSPACE_RECOVERY_UNKNOWN', diagnostic: diagnostic(error) } }
        }
        notify(job)
      })
    return { status: 'POSTMAN_BRIDGE_ACCEPTED', ...snapshot(job) }
  }

  // A newly created communications-only Luna has only the bootstrap prompt,
  // not a Host terminal or a Worker assignment. Its first report/settlement is
  // an untrusted technical lifecycle fact. Retain it in the native inbox; the
  // exact Bridge READY is the separate authoritative wake.
  function bootstrapLunaJob(parent, child, settled = false) {
    if (disposed || !isTopLevelPostmanSupervisor(parent) || ctx.agents.get(parent?.id) !== parent ||
        !child || (settled
          ? ctx.agents.get(child.id) && ctx.agents.get(child.id) !== child ||
            !bootstrapAgents.has(child)
          : ctx.agents.get(child.id) !== child) || child.session?.header?.origin !== 'subagent' ||
        child.session.header.parentSession !== parent.id || child.session.header.delegationDepth !== 1 ||
        child.inbox?.hasPending || !contexts?.record || !contexts?.get) return null
    const row = contexts.record(parent.id)
    const lanes = [...Object.entries(row?.devspaceLanes ?? {}),
      ...(row?.devspaceLuna && !row.devspaceLanes?.legacy ? [['legacy', row.devspaceLuna]] : [])]
      .filter(([, lane]) => lane?.childId === child.id && ['intent', 'ready'].includes(lane.state) &&
        typeof lane.activeBridgeJobId === 'string')
    if (lanes.length !== 1) return null
    const [laneId, lane] = lanes[0], job = jobs.get(lane.activeBridgeJobId)
    const operation = row?.bridgeOperations?.[lane.activeBridgeJobId]
    if (settled && bootstrapAgents.get(child) !== contexts.get(parent.id)) return null
    if (!job || !operation || job.parentSessionId !== parent.id ||
        job.taskContext !== contexts.get(parent.id) || job.transportKind !== 'devspace' ||
        job.laneId && job.laneId !== laneId || job.childSessionId && job.childSessionId !== child.id ||
        !['STARTING', 'RUNNING'].includes(job.state) || job.finishedAt ||
        job.controller.signal.aborted || job.notification !== 'PENDING' ||
        operation.state !== 'pending' || operation.transportKind !== 'devspace' ||
        operation.devspace?.laneId && operation.devspace.laneId !== laneId ||
        operation.childSessionId && operation.childSessionId !== child.id ||
        operation.terminal) return null
    const events = child.session.events
    const seed = child.session.header.seedLength ?? 0
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > events.length) return null
    const current = events.slice(seed)
    // Later coordinator assignments, output, or resumed turns can carry genuine
    // facts/questions. Never defer those as mere bootstrap acknowledgements.
    if (settled && current.findLast(e => e.type === 'turn/end')?.data.reason?.kind !== 'completed') return null
    if (current.filter(e => e.type === 'turn/start').length !== 1 ||
        current.some(e => e.type === 'user/message' && e.data.source?.kind === 'coordinator'))
      return null
    return job
  }
  // Capture the exact registered native Agent while its first turn is live.
  // Native settlement disposes both registry/session entries before notifying.
  // This also covers the requested no-report ACK, not only report-tool output.
  ctx.on?.('agent/created', ({agent:child}) => {
    const parent=ctx.agents.get(child.session?.header?.parentSession)
    if(ctx.agents.get(child.id)===child && ctx.agents.get(parent?.id)===parent &&
       isTopLevelPostmanSupervisor(parent) && child.session.header.origin==='subagent' &&
       child.session.header.delegationDepth===1 && contexts?.get(parent.id))
      bootstrapAgents.set(child,contexts.get(parent.id))
  })
  // Do not infer harmlessness from arbitrary model prose: only this exact
  // technical acknowledgement is deferrable. All other text wakes normally.
  const bootstrapAcknowledgement = text => text === 'POSTMAN_LUNA_BOOTSTRAP_ACK'
  function canDeferLunaBootstrapReport(parent, child, content) {
    const job = bootstrapLunaJob(parent, child)
    if (!job || !Array.isArray(content) ||
        content.some(block => block?.type !== 'text')) return false
    // An explicit problem or question is immediately decision-relevant.
    // Otherwise the initial untrusted status remains in the durable inbox for READY.
    if (content.length !== 1 || !bootstrapAcknowledgement(content[0].text)) return false
    // Native disposal releases both AgentRegistry and SessionStore entries.
    // Only the exact registered bootstrap Agent may pair with its completed
    // settlement; IDs or copied headers are insufficient.
    bootstrapAgents.set(child, job.taskContext)
    return true
  }
  function canDeferLunaBootstrapSettlement(parent, child, terminal) {
    if (terminal?.stopReason !== 'completed' || !bootstrapLunaJob(parent, child, true)) return false
    if (terminal.output === undefined) {
      const messages = child.session.events.filter(e => e.type === 'assistant/message')
      return messages.every(e => e.data?.message?.content?.every(block =>
        block.type === 'text' && bootstrapAcknowledgement(block.text)))
    }
    if (!Array.isArray(terminal.output)) return false
    if (terminal.output.length === 0) return true
    if (terminal.output.length !== 1) return false
    const output = terminal.output[0]
    // A harmless first-turn text acknowledgement is also only bootstrap; a
    // question, failure, rich output or later Host assignment must wake normally.
    if (output?.type === 'text') return bootstrapAcknowledgement(output.text)
    const call = child.session.events.findLast(e => e.type === 'tool/call')
    return output?.type === 'tool-call' && output.name === 'report' &&
      call?.data.name === 'report' && output.id === call.data.callId &&
      output.arguments === call.data.arguments && (() => {
        try { return bootstrapAcknowledgement(JSON.parse(output.arguments).output) }
        catch { return false }
      })()
  }

  function hasActive(parentSessionId) {
    return [...jobs.values()].some(job => job.parentSessionId === parentSessionId &&
      !['TERMINAL', 'FAILED', 'INTERRUPTED'].includes(job.state))
  }

  function hasActiveWork(parent) {
    if (disposed || ctx.agents.get(parent?.id) !== parent || !isTopLevelPostmanSupervisor(parent)) return false
    return [...jobs.values()].some(job => job.parentSessionId === parent.id &&
      (!contexts || contexts.get(parent.id) === job.taskContext) &&
      ['QUEUED', 'STARTING', 'RUNNING'].includes(job.state) && job.completion &&
      !job.finishedAt && !job.controller.signal.aborted && job.notification === 'PENDING')
  }

  async function status(parent, bridgeJobId, retrySync = false, recover = false, reconcileWriter = false) {
    if (reconcileWriter) {
      if (!controlCallerAllowed(parent)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
      if (typeof contexts?.reconcileWriter !== 'function') return { status: 'POSTMAN_WRITER_EXIT_UNPROVEN',
        bridgeJobId, diagnostic: 'Native writer settlement evidence is unavailable',
        alternative: 'Use a separate isolated write folder' }
      const reconciled = await contexts.reconcileWriter(parent.id, bridgeJobId)
      devspaceCoordinator.refresh?.()
      return reconciled
    }
    let archived = operationIn(contexts?.record?.(parent.id), bridgeJobId)
    if (archived?.archivedAt) {
      if (archived.transportKind === 'devspace' && archived.devspace?.channel && !archived.lateTerminal) {
        try {
          const binding = loadDevspaceChannelForOwner(archived.devspace.channel, {
            bridgeJobId, requestId: archived.requestId, leaderSessionId: parent.id,
            lunaSessionId: archived.childSessionId })
          if (readDevspaceEvent(binding)) {
            const lateTerminal = { status: 'POSTMAN_BRIDGE_TERMINAL', terminalStatus: 'COMPLETED',
              transportKind: 'devspace', requestId: archived.requestId,
              result: devspaceTerminal(binding) }
            await contexts.changeRecord(parent.id, row => updateHistoricalOperation(row, bridgeJobId,
              before => ({ ...before, lateTerminal })))
            archived = operationIn(contexts.record(parent.id), bridgeJobId)
          }
        } catch { /* Unverified late data has no authority over any operation. */ }
      }
      return { status: 'POSTMAN_BRIDGE_ARCHIVED', bridgeJobId,
      state: archived.state, requestId: archived.requestId ?? null, archivedAt: archived.archivedAt,
      result: archived.terminal?.result ?? null, lateResult: archived.lateTerminal?.result ?? null,
      executionRevoked: archived.executionRevoked === true,
      processStopProven: false, residualWriteRoot: archived.residualWriteRoot ?? null }
    }
    if (recover && archived?.transportKind === 'devspace')
      return continueDevspaceRecovery(parent, bridgeJobId, true)
    let job = jobs.get(bridgeJobId)
    if (!job) {
      const pending = coldRecovery.get(bridgeJobId)
      if (pending) { await pending; return status(parent, bridgeJobId, retrySync, recover) }
      const row = contexts?.record?.(parent.id)
      const operation = Object.hasOwn(row?.bridgeOperations ?? {}, bridgeJobId)
        ? row.bridgeOperations[bridgeJobId] : row?.bridge?.id === bridgeJobId ? row.bridge : null
      if (operation?.state === 'received' && hasTrustedTerminal(operation)) {
        // Pin this one recovered owner before deleting its only durable copy.
        // Thereafter reads and overlapping retries use the same mutable object.
        const terminal = losslessValue(operation.terminal)
        job = { bridgeJobId, parentSessionId: parent.id, transportKind: terminal.transportKind,
          taskContext: contexts?.get?.(parent.id) ?? null, childSessionId: operation.childSessionId ?? null,
          trustedTerminal: terminal, requestId: terminal.requestId ?? null,
          laneId: operation.devspace?.laneId,
          state: operation.grantDiagnostic ? 'FAILED' : 'TERMINAL',
          finishedAt: new Date().toISOString(), synchronization: operation.synchronization === 'pending' ? 'busy' : operation.synchronization ?? 'busy',
          grantDiagnostic: operation.grantDiagnostic, controller: new AbortController() }
        jobs.set(bridgeJobId, job)
        // Recover legacy synchronized artifacts that predate Leader-owned durable grants.
        // Concurrent status reads share this one exact registration attempt.
        if (job.synchronization === 'synchronized' && !job.grantDiagnostic &&
            terminal.result?.code === 'RESULT_DURABLE' &&
            !row?.artifactGrants?.[terminal.requestId]) job.grantRecovery = registerGrant(job)
      } else if (operation?.transportKind === 'devspace' && ['pending', 'unknown'].includes(operation.state)) {
        // Stage 4: never directly promote a Host bell. First verify and follow up
        // the exact persisted continuable Luna with an idempotent durable intent.
        // Serialize concurrent cold status reads without rerunning Web or Direct.
        if (operation.requestId && operation.childSessionId && operation.devspace?.channel &&
            !operation.devspace?.coldBellRecovery && !coldRecovery.has(bridgeJobId)) {
          const attempt = devspaceLuna.recoverColdBell(parent, bridgeJobId)
          coldRecovery.set(bridgeJobId, attempt)
          let recovered = false
          try { recovered = await attempt } catch { recovered = false }
          finally { if (coldRecovery.get(bridgeJobId) === attempt) coldRecovery.delete(bridgeJobId) }
          if (recovered) return status(parent, bridgeJobId, retrySync, recover)
        }
        return { status: 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN', bridgeJobId,
          requestId: operation.requestId ?? null, childSessionId: operation.childSessionId ?? null,
          laneId: operation.devspace?.laneId ?? null,
          diagnostic: operation.devspace?.hostFailure?.status ?? 'POSTMAN_DEVSPACE_LUNA_TERMINAL_UNAVAILABLE',
          recovery: recoverySummary(parent, bridgeJobId) }
      } else if (operation && operation.requestId && ['pending', 'unknown'].includes(operation.state) &&
                 typeof direct.inspectRequest === 'function') {
        const proof = direct.inspectRequest(operation.requestId, row?.branch, operation.transportKind, row?.repository)
        if (proof.state === 'terminal' && typeof contexts?.changeRecord === 'function') {
          const safe = losslessValue(proof.terminal)
          const pending = contexts.changeRecord(parent.id, previous => {
            const current = previous.bridgeOperations?.[bridgeJobId]
            if (!['pending', 'unknown'].includes(current?.state) || current.requestId !== operation.requestId)
              throw new Error('POSTMAN_BRIDGE_JOURNAL_CHANGED')
            return { ...previous, bridgeOperations: { ...previous.bridgeOperations, [bridgeJobId]:
              { ...current, state: 'received', phase: 'terminal', publication: proof.publication,
                terminal: safe, synchronization: 'pending' } } }
          })
          coldRecovery.set(bridgeJobId, pending)
          try { await pending } finally { coldRecovery.delete(bridgeJobId) }
          return status(parent, bridgeJobId, retrySync, recover)
        }
        if (proof.state === 'proven-not-sent' && typeof contexts?.changeRecord === 'function') {
          const pending = contexts.changeRecord(parent.id, previous => {
            const current = previous.bridgeOperations?.[bridgeJobId]
            if (!['pending', 'unknown'].includes(current?.state) || current.requestId !== operation.requestId)
              throw new Error('POSTMAN_BRIDGE_JOURNAL_CHANGED')
            return { ...previous, bridgeOperations: { ...previous.bridgeOperations, [bridgeJobId]:
              { ...current, state: 'received', phase: 'not-sent', synchronization: 'not-required' } } }
          })
          coldRecovery.set(bridgeJobId, pending)
          try { await pending } finally { coldRecovery.delete(bridgeJobId) }
          return { status: 'POSTMAN_BRIDGE_NOT_SENT', bridgeJobId, requestId: operation.requestId,
            synchronization: 'not-required' }
        }
        return { status: 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN', bridgeJobId, state: 'INTERRUPTED',
          requestId: operation.requestId, publication: proof.state === 'published' ? proof.publication : 'unknown',
          candidate: operation.transportKind === 'artifact' ? direct.observeArtifactCandidate?.(operation.requestId) ?? null : null,
          verified: false, applyEligible: false }
      } else if (operation?.state === 'received' && operation.phase === 'not-sent' &&
                 operation.synchronization === 'not-required' &&
                 (operation.requestId || operation.cancellationRequested === true ||
                   operation.preSendFailure === NOT_SENT_WORKTREE_PREFLIGHT) && !operation.terminal)
        return { status: 'POSTMAN_BRIDGE_NOT_SENT', bridgeJobId, requestId: operation.requestId ?? null,
          synchronization: 'not-required', ...(operation.preSendFailure
            ? { preSendFailure: operation.preSendFailure } : {}) }
      else return operation
        ? { status: 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN', bridgeJobId, state: 'INTERRUPTED',
          requestId: operation.requestId ?? null }
        : { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    }
    if (job.parentSessionId !== parent.id) return { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    if (job.grantRecovery) await job.grantRecovery
    if (retrySync && job.synchronization === 'synchronized' && job.grantDiagnostic &&
        job.trustedTerminal?.result?.code === 'RESULT_DURABLE') {
      if (!job.grantRecovery) job.grantRecovery = (async () => {
        await registerGrant(job)
        if (!job.grantDiagnostic && typeof contexts?.changeRecord === 'function')
          await contexts.changeRecord(job.parentSessionId, row => {
            const op = row.bridgeOperations?.[bridgeJobId]
            if (!op || op.terminal?.requestId !== job.requestId || op.synchronization !== 'synchronized')
              throw new Error('POSTMAN_BRIDGE_JOURNAL_CHANGED')
            const operations = { ...row.bridgeOperations }
            delete operations[bridgeJobId]
            return { ...row, bridgeOperations: operations }
          })
        if (!job.grantDiagnostic) job.state = 'TERMINAL'
      })()
      try { await job.grantRecovery } finally { job.grantRecovery = null }
    }
    if (retrySync && job.finishedAt && job.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL' &&
        (job.synchronization === 'busy' || job.synchronization === 'pending')) {
      const publication = publicationOf(job.trustedTerminal)
      if (publication) await retryPublication(job, publication)
      else if (noPublicationProven(job.trustedTerminal)) {
        if (job.noPublicationAttempt) await job.noPublicationAttempt
        else {
          const attempt = completeWithoutPublication(job)
          job.noPublicationAttempt = attempt
          try { await attempt } finally { if (job.noPublicationAttempt === attempt) job.noPublicationAttempt = null }
        }
      } else job.syncDiagnostic = { code: 'PUBLICATION_PROOF_MISSING' }
    }
    if (job.transportKind === 'devspace' && job.finishedAt &&
        job.trustedTerminal?.result?.source !== 'bell') {
      try {
        if (await devspaceLuna.upgradeLateBell(parent, job)) notify(job)
      } catch { /* The immutable bell remains available; never forge promotion. */ }
    }
    const common = snapshot(job)
    if (job.state === 'QUEUED') return { status: 'POSTMAN_BRIDGE_QUEUED', ...common }
    if (!job.finishedAt || job.state === 'STARTING' || job.state === 'RUNNING') {
      return { status: 'POSTMAN_BRIDGE_RUNNING', ...common }
    }
    const terminal = job.trustedTerminal
    if (terminal?.status === 'POSTMAN_BRIDGE_NOT_SENT')
      return { status: 'POSTMAN_BRIDGE_NOT_SENT', bridgeJobId, requestId: job.requestId, synchronization: 'not-required' }
    if (terminal?.status === 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN' && !recover)
      return { status: 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN', bridgeJobId, state: 'INTERRUPTED',
        requestId: job.requestId, publication: 'unknown' }
    let capability = { recovery_eligible: false }
    if (terminal?.status === 'POSTMAN_BRIDGE_TERMINAL' &&
        ['POSTMAN_TRANSPORT_FAILED', 'ASSISTANT_COMPLETED_NO_ARTIFACT', 'ARTIFACT_REJECTED'].includes(terminal.result?.code)) {
      try { capability = await direct.recoveryCapability(job.taskContext?.universalProject ? HOST_SOURCE_ROOT : parent.session.header.cwd, terminal.requestId) }
      catch (error) { capability = { recovery_eligible: false, code: diagnostic(error) } }
    }
    if (recover) {
      if (!capability.recovery_eligible) return { status: capability.automatic_recovery_used
        ? 'POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED' : 'POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED', bridgeJobId }
      return accept(parent, null, job.transportKind, undefined, terminal)
    }
    const devspaceRecovery = job.transportKind === 'devspace' ? recoverySummary(parent, bridgeJobId) : null
    return { ...common, recoveryEligible: devspaceRecovery
        ? !devspaceRecovery.diagnostic && !devspaceRecovery.resultJobId && devspaceRecovery.classification?.kind === 'retry'
        : capability.recovery_eligible === true,
      ...(devspaceRecovery ? { recovery: devspaceRecovery,
        recoveryContinuation: job.recovery ?? null } : {}),
      status: job.state === 'TERMINAL' ? 'POSTMAN_BRIDGE_TERMINAL' : 'POSTMAN_BRIDGE_FAILED',
      terminalStatus: terminal?.terminalStatus ?? null,
      trustedStatus: terminal?.status ?? null,
      checks: terminal?.checks ?? null,
      result: terminal?.result ?? null,
      childStopReason: terminal?.childStopReason ?? null,
      childDiagnostic: terminal?.childDiagnostic ?? null,
      diagnostic: terminal?.diagnostic ?? job.diagnostic ?? null,
      notification: job.notification ?? null,
      synchronization: job.synchronization ?? null,
      syncDiagnostic: job.syncDiagnostic ?? null,
      ...(job.grantDiagnostic === undefined ? {} : { grantDiagnostic: job.grantDiagnostic }) }
  }

  // Read-only observation: Direct inspection reads exact REQ evidence but never writes journals or grants.
  function list(parent) {
    const row = contexts?.record?.(parent.id)
    const all = Object.assign({}, ...[...(row?.retiredTasks ?? []), row].filter(Boolean)
      .map(task => task.bridgeOperations ?? {}))
    const operations = Object.entries(all).map(([bridgeJobId, op]) => {
      const occupied = countsAgainstLimit(op)
      const proof = op.requestId && ['text', 'artifact', 'image'].includes(op.transportKind) &&
        typeof direct.inspectRequest === 'function'
        ? direct.inspectRequest(op.requestId, row.branch, op.transportKind, row.repository) : null
      return { bridgeJobId, state: op.state, phase: op.phase ?? 'unknown',
        transportKind: op.transportKind ?? op.terminal?.transportKind ?? 'unknown',
        createdAt: op.createdAt ?? 'unknown', childSessionId: op.childSessionId ?? 'unknown',
        requestId: op.requestId ?? op.terminal?.requestId ?? 'unknown',
        publication: op.publication ?? (op.terminal ? publicationOf(op.terminal) ?? 'unknown' :
          ['published', 'terminal'].includes(proof?.state) ? proof.publication : 'unknown'),
        publicationState: proof?.state ?? 'unknown',
        synchronization: op.synchronization ?? 'unknown', grantDiagnostic: op.grantDiagnostic ?? null,
        grantState: !op.terminal && !op.transportKind ? 'unknown' :
          (op.transportKind ?? op.terminal?.transportKind) !== 'artifact' ||
          (op.terminal?.result?.code && op.terminal.result.code !== 'RESULT_DURABLE') ? 'not-applicable' :
            row.artifactGrants?.[op.requestId ?? op.terminal?.requestId] ? 'durable-registered' : 'pending-or-rejected',
        countsAgainstLimit: occupied, slotReason: occupied
          ? op.state === 'received' && hasTrustedTerminal(op) ? 'trusted terminal awaiting local synchronization or grant'
            : op.requestId ? 'Direct outcome not yet proven' : 'correlation unavailable; outcome unknown'
          : op.executionRevoked ? 'execution revoked; old outcome retained'
          : 'terminal synchronized or publication proven unnecessary',
        archivedAt: op.archivedAt ?? null, executionRevoked: op.executionRevoked === true }
    })
    if (row?.bridge) operations.push({ bridgeJobId: row.bridge.id, state: row.bridge.state,
      phase: 'unknown', transportKind: 'unknown', createdAt: 'unknown', childSessionId: 'unknown',
      requestId: 'unknown', publication: 'unknown', publicationState: 'unknown', synchronization: 'unknown', grantDiagnostic: null, grantState: 'unknown',
      countsAgainstLimit: true, slotReason: 'legacy correlation unavailable; outcome unknown' })
    return { status: 'POSTMAN_BRIDGE_LIST', limit: 3,
      used: operations.filter(op => op.countsAgainstLimit).length, operations }
  }

  function controlCallerAllowed(parent) {
    try {
      return isTopLevelPostmanSupervisor(parent) &&
        (typeof ctx.agents?.get !== 'function' || ctx.agents.get(parent.id) === parent)
    } catch { return false }
  }

  async function stop(parent, bridgeJobId, abandon = false) {
    if (!controlCallerAllowed(parent)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
    if (abandon) return abandonJob(parent, bridgeJobId)
    const job = jobs.get(bridgeJobId)
    if (job && job.parentSessionId !== parent.id) return { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    if (job?.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL')
      return { status: 'POSTMAN_BRIDGE_ALREADY_TERMINAL', bridgeJobId, cancellationRequested: job.cancellationRequested === true }
    if (!job || !job.completion || job.finishedAt || disposed) {
      const row = contexts?.record?.(parent.id)
      const op = Object.hasOwn(row?.bridgeOperations ?? {}, bridgeJobId)
        ? row.bridgeOperations[bridgeJobId] : row?.bridge?.id === bridgeJobId ? row.bridge : null
      // Cold/retired job: exact Host-recorded pre-transport refusal can be
      // stopped without treating every no-REQ UNKNOWN as safe to clear.
      if (op && trustedPreflightReceipt(parent, bridgeJobId, row) &&
          typeof contexts?.changeRecord === 'function') {
        try {
          await contexts.changeRecord(parent.id, current => {
            if (!trustedPreflightReceipt(parent, bridgeJobId, current))
              throw Error('POSTMAN_BRIDGE_PRE_SEND_PROOF_CHANGED')
            return recordProvenPreflightFailure(current, bridgeJobId)
          })
          devspaceCoordinator.refresh?.()
          return { status: 'POSTMAN_BRIDGE_NOT_SENT', bridgeJobId,
            preSendFailure: NOT_SENT_WORKTREE_PREFLIGHT, synchronization: 'not-required' }
        } catch (error) {
          return { status: 'POSTMAN_BRIDGE_STOP_NOT_LIVE', bridgeJobId,
            diagnostic: diagnostic(error) }
        }
      }
      return job || op ? { status: job?.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL'
        ? 'POSTMAN_BRIDGE_ALREADY_TERMINAL' : 'POSTMAN_BRIDGE_STOP_NOT_LIVE', bridgeJobId,
        cancellationRequested: job?.cancellationRequested === true || op?.cancellationRequested === true }
        : { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    }
    let intentPersisted = false
    let intentDiagnostic
    if (typeof contexts?.changeRecord === 'function') {
      try {
        await contexts.changeRecord(parent.id, row => {
          const op = row.bridgeOperations?.[bridgeJobId]
          // Settlement may already have synchronized and removed this intent.
          if (!op && job.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL') return row
          if (!op) throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
          return { ...row, bridgeOperations: { ...row.bridgeOperations,
            [bridgeJobId]: { ...op, cancellationRequested: true } } }
        })
        intentPersisted = true
      } catch (error) { intentDiagnostic = diagnostic(error) }
    }
    job.cancellationRequested = true
    if (job.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL')
      return { status: 'POSTMAN_BRIDGE_ALREADY_TERMINAL', bridgeJobId, cancellationRequested: true }
    job.controller.abort()
    return { status: 'POSTMAN_BRIDGE_STOP_REQUESTED', ...snapshot(job), cancellationRequested: true,
      intentPersisted, ...(intentDiagnostic ? { diagnostic: intentDiagnostic } : {}) }
  }

  async function abandonJob(parent, bridgeJobId, seen = new Set()) {
    if (!controlCallerAllowed(parent)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
    const row = contexts?.record?.(parent.id), op = row?.bridgeOperations?.[bridgeJobId]
    const job = jobs.get(bridgeJobId)
    if (!op || job && job.parentSessionId !== parent.id)
      return { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    if (seen.has(bridgeJobId)) return { status: 'POSTMAN_BRIDGE_ARCHIVE_BINDING_CHANGED', bridgeJobId }
    seen.add(bridgeJobId)
    const nextId = op.devspace?.recoveryNextJobId
    if (nextId) {
      const next = row.bridgeOperations?.[nextId]
      if (next?.devspace?.recovery?.sourceJobId !== bridgeJobId)
        return { status: 'POSTMAN_BRIDGE_ARCHIVE_BINDING_CHANGED', bridgeJobId }
      const descendant = await abandonJob(parent, nextId, seen)
      if (descendant.status !== 'POSTMAN_BRIDGE_ARCHIVED') return descendant
    }
    if (op.archivedAt) return { status: 'POSTMAN_BRIDGE_ARCHIVED', bridgeJobId,
      requestId: op.requestId ?? null, processStopProven: false }
    const ownedDirect = op.childSessionId && direct.latest?.(op.childSessionId)
    if (op.transportKind !== 'devspace' && ownedDirect?.requestId === op.requestId &&
        ['running', 'starting'].includes(ownedDirect.state)) {
      if (job) { job.cancellationRequested = true; job.controller.abort() }
      return { status: 'POSTMAN_BRIDGE_ARCHIVE_PROCESS_ACTIVE', bridgeJobId,
        requestId: op.requestId, stopRequested: Boolean(job), processStopProven: false }
    }
    let stopReceipt = null
    if (op.transportKind === 'devspace' && op.devspace?.channel) {
      try {
        const binding = loadDevspaceChannelForOwner(op.devspace.channel, {
          bridgeJobId, requestId: op.requestId, leaderSessionId: parent.id,
          lunaSessionId: op.childSessionId })
        const liveDirect = direct.latest?.(op.childSessionId)
        if (liveDirect?.requestId === op.requestId && ['running', 'starting'].includes(liveDirect.state))
          stopReceipt = requestDevspaceControl(binding, { kind: 'stop' })
        revokeDevspaceChannel(binding)
      } catch (error) { return { status: 'POSTMAN_BRIDGE_ARCHIVE_FENCE_FAILED', bridgeJobId,
        diagnostic: diagnostic(error) } }
    }
    if (job) { job.cancellationRequested = true; job.controller.abort() }
    await contexts.changeRecord(parent.id, current => {
      const before = current.bridgeOperations?.[bridgeJobId]
      if (!before || before.requestId !== op.requestId || before.childSessionId !== op.childSessionId)
        throw Error('POSTMAN_BRIDGE_ARCHIVE_BINDING_CHANGED')
      const laneId = before.devspace?.laneId
      const lane = current.devspaceLanes?.[laneId] ?? (laneId === 'legacy' ? current.devspaceLuna : null)
      const closeLane = lane && (lane.activeBridgeJobId === bridgeJobId ||
        !lane.activeBridgeJobId && lane.requestIds?.at(-1) === before.requestId)
      const nextLane = closeLane ? { ...lane, state: 'closed', activeBridgeJobId: null } : null
      const residualWriteRoot = before.devspace?.mode === 'WRITE_ISOLATED' ? current.worktree
        : before.devspace?.approvedAccess === 'write' ? before.devspace.approvedRoot : null
      return { ...current,
        ...(nextLane ? laneId === 'legacy' && !current.devspaceLanes?.legacy
          ? { devspaceLuna: nextLane } : { devspaceLanes: { ...current.devspaceLanes, [laneId]: nextLane } } : {}),
        bridgeOperations: { ...current.bridgeOperations, [bridgeJobId]: { ...before,
          archivedAt: new Date().toISOString(), executionRevoked: true,
          cancellationRequested: true, ...(residualWriteRoot ? { residualWriteRoot } : {}) } } }
    })
    devspaceCoordinator.refresh?.()
    return { status: 'POSTMAN_BRIDGE_ARCHIVED', bridgeJobId, requestId: op.requestId ?? null,
      processStopProven: false, stopReceipt, outcome: op.terminal?.result ?? null }
  }

  async function abandonAll(parent) {
    if (!controlCallerAllowed(parent)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
    const results = []
    for (const id of Object.keys(contexts?.record?.(parent.id)?.bridgeOperations ?? {})) {
      const receipt = await abandonJob(parent, id)
      results.push(receipt)
      if (receipt.status !== 'POSTMAN_BRIDGE_ARCHIVED')
        return { status: 'POSTMAN_BRIDGE_ARCHIVE_INCOMPLETE', results }
    }
    return { status: 'POSTMAN_BRIDGE_ARCHIVED', results }
  }

  // Team observation must not inspect Direct, recover, synchronize or register grants.
  function teamSnapshot(parent) {
    if (!controlCallerAllowed(parent)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
    const row = contexts?.record?.(parent.id)
    const operations = []
    const seen = new Set()
    let used = 0
    let total = 0
    const add = (bridgeJobId, op, live, occupied) => {
      seen.add(bridgeJobId)
      total++
      if (occupied) used++
      if (operations.length >= 30) return
      operations.push({ bridgeJobId, state: live?.state ?? op?.state ?? 'unknown',
        transportKind: live?.transportKind ?? op?.transportKind ?? null,
        requestId: live?.requestId ?? op?.requestId ?? null,
        synchronization: live?.synchronization ?? op?.synchronization ?? null,
        countsAgainstLimit: occupied,
        cancellationRequested: live?.cancellationRequested === true || op?.cancellationRequested === true })
    }
    for (const [id, op] of Object.entries(row?.bridgeOperations ?? {})) {
      const live = jobs.get(id)
      add(id, op, live?.parentSessionId === parent.id ? live : null, countsAgainstLimit(op))
    }
    if (row?.bridge && !seen.has(row.bridge.id)) add(row.bridge.id, row.bridge, null, true)
    for (const job of jobs.values()) {
      if (job.parentSessionId !== parent.id || seen.has(job.bridgeJobId)) continue
      add(job.bridgeJobId, null, job, !job.finishedAt)
    }
    return { status: 'POSTMAN_BRIDGE_TEAM_SNAPSHOT', used, limit: 3, operations, truncated: total > operations.length }
  }

  function devspaceControl(parent, bridgeJobId, action, message, priority = 'normal') {
    if (disposed || !controlCallerAllowed(parent)) return { status: 'POSTMAN_DEVSPACE_CONTROL_CALLER_REJECTED' }
    const job = jobs.get(bridgeJobId)
    const operation = contexts?.record?.(parent.id)?.bridgeOperations?.[bridgeJobId]
      if (!job || job.parentSessionId !== parent.id || job.transportKind !== 'devspace' ||
        !operation || operation.transportKind !== 'devspace' ||
        operation.executionRevoked ||
        operation.childSessionId !== job.childSessionId ||
        !job.childSessionId || (operation.requestId && operation.requestId !== job.requestId))
      return { status: 'POSTMAN_DEVSPACE_CONTROL_JOB_NOT_FOUND' }
    const directJob = direct.latest?.(job.childSessionId)
    let binding = directJob?.devspaceChannel
    const matches = value => value?.leaderSessionId === parent.id &&
      value.lunaSessionId === job.childSessionId && value.jobId === bridgeJobId &&
      value.requestId === job.requestId
    // Status for a settled earlier REQ must not accidentally inspect the next
    // REQ's live channel on this same persistent Luna.
    if (action === 'status' && !matches(binding) && operation.devspace?.channel) {
      try { binding = loadDevspaceChannelForOwner(operation.devspace.channel, {
        bridgeJobId, leaderSessionId: parent.id,
        lunaSessionId: job.childSessionId, requestId: job.requestId }) }
      catch { binding = null }
    }
    if (!matches(binding))
      return { status: 'POSTMAN_DEVSPACE_CONTROL_CHANNEL_UNAVAILABLE' }
    if (action === 'status') {
      try { return { status: 'POSTMAN_DEVSPACE_CONTROL_STATUS', bridgeJobId,
        requestId: job.requestId, controls: readDevspaceControls(binding) } }
      catch (error) { return { status: 'POSTMAN_DEVSPACE_CONTROL_STATUS_UNKNOWN', diagnostic: diagnostic(error) } }
    }
    if (!['steer', 'preempt', 'stop'].includes(action) ||
        (action !== 'stop' && (typeof message !== 'string' || !message.trim())) ||
        !['normal', 'urgent'].includes(priority)) return { status: 'POSTMAN_DEVSPACE_CONTROL_INVALID' }
    if (job.state !== 'RUNNING' || !['running', 'starting'].includes(directJob.state))
      return { status: 'POSTMAN_DEVSPACE_CONTROL_ALREADY_SETTLED' }
    try { return { ...requestDevspaceControl(binding, { kind: action, message, priority }), bridgeJobId } }
    catch (error) { return { status: 'POSTMAN_DEVSPACE_CONTROL_REJECTED', diagnostic: diagnostic(error) } }
  }

  /** After the exact Leader task is reattached, deliver a cold bell through
   * its persisted Luna and then an owner-only READY wake. Never resume Direct.
   * The write-before-wake intent means uncertain notification is never retried.
   */
  async function recoverDevspacePending(parent) {
    if (disposed || !controlCallerAllowed(parent) || !contexts?.get(parent.id))
      return { status: 'POSTMAN_DEVSPACE_RECOVERY_UNAVAILABLE' }
    const operations = contexts.record?.(parent.id)?.bridgeOperations ?? {}
    const candidates = Object.entries(operations).filter(([, op]) => op.transportKind === 'devspace' && !op.executionRevoked &&
      (['pending', 'unknown'].includes(op.state) && op.requestId && op.devspace?.channel ||
       op.state === 'received' && op.devspace?.coldBellRecovery === 'intent') &&
      !op.devspace?.coldReadyWake)
    const recovered = [], unresolved = []
    for (const [bridgeJobId] of candidates.slice(0, 12)) {
      let outcome
      try { outcome = await status(parent, bridgeJobId) }
      catch { unresolved.push({ bridgeJobId, status: 'STATUS_UNKNOWN' }); continue }
      const job = jobs.get(bridgeJobId)
      if (outcome.status !== 'POSTMAN_BRIDGE_TERMINAL' || outcome.result?.source !== 'bell' ||
          !job || job.parentSessionId !== parent.id) {
        unresolved.push({ bridgeJobId, status: 'OUTCOME_UNKNOWN' }); continue
      }
      try {
        await contexts.changeRecord(parent.id, row => {
          const op = row.bridgeOperations?.[bridgeJobId]
          if (!op || op.state !== 'received' || op.devspace?.coldBellRecovery !== 'intent' ||
              op.devspace?.coldReadyWake || op.terminal?.requestId !== job.requestId)
            throw Error('POSTMAN_DEVSPACE_COLD_WAKE_INTENT_CHANGED')
          return { ...row, bridgeOperations: { ...row.bridgeOperations,
            [bridgeJobId]: { ...op, devspace: { ...op.devspace, coldReadyWake: 'intent' } } } }
        })
      } catch { unresolved.push({ bridgeJobId, status: 'WAKE_INTENT_UNKNOWN' }); continue }
      notify(job)
      const delivered = job.notification === 'DELIVERED'
      try {
        await contexts.changeRecord(parent.id, row => {
          const op = row.bridgeOperations?.[bridgeJobId]
          if (!op || op.devspace?.coldReadyWake !== 'intent')
            throw Error('POSTMAN_DEVSPACE_COLD_WAKE_STATE_CHANGED')
          return { ...row, bridgeOperations: { ...row.bridgeOperations,
            [bridgeJobId]: { ...op, devspace: { ...op.devspace,
              coldReadyWake: delivered ? 'sent' : 'unknown' } } } }
        })
      } catch { /* Durable intent already prevents duplicate wake. */ }
      recovered.push({ bridgeJobId, requestId: job.requestId,
        notification: delivered ? 'DELIVERED' : 'UNKNOWN' })
    }
    const continuations = []
    for (const [bridgeJobId, op] of Object.entries(contexts.record?.(parent.id)?.bridgeOperations ?? {})) {
      if (!technicalFailure(op) || !op.devspace?.payload || op.devspace.recoveryNextJobId ||
          (op.devspace.recovery?.attempt ?? 0) >= 3) continue
      try { continuations.push({ sourceJobId: bridgeJobId,
        ...await continueDevspaceRecovery(parent, bridgeJobId) }) }
      catch (error) { continuations.push({ sourceJobId: bridgeJobId,
        status: 'POSTMAN_DEVSPACE_RECOVERY_UNKNOWN', diagnostic: diagnostic(error) }) }
    }
    return { status: 'POSTMAN_DEVSPACE_RECOVERY_SUMMARY', recovered, unresolved, continuations }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    stopResourceChanges?.()
    for (const job of jobs.values()) job.controller.abort()
    direct.dispose?.()
    coordinator.dispose()
    if (devspaceCoordinator !== coordinator) devspaceCoordinator.dispose()
    await Promise.allSettled([...jobs.values()].map(job => job.completion))
    jobs.clear()
  }

  return { accept, status, list, teamSnapshot, stop, abandonAll, hasActive, hasActiveWork, dispose,
    canDeferLunaBootstrapReport, canDeferLunaBootstrapSettlement,
    devspaceControl, recoverDevspacePending,
    devspaceLunaClose: (parent, laneId) => devspaceLuna.close(parent, contexts?.get(parent.id), laneId),
    devspaceLunaSnapshot: parent => devspaceLuna.snapshot(parent) }
}
