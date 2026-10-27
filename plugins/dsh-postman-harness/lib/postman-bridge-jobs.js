import { randomUUID } from 'node:crypto'
import { postmanInputGrants } from './postman-input-files.js'
import { DirectPostmanJobManager } from './direct-current-turn.js'
import { createPostmanDevspaceLanes } from './postman-devspace-lanes.js'
import { requestDevspaceControl, readDevspaceControls, loadDevspaceChannelForOwner,
  revokeDevspaceChannel, readDevspaceEvent, devspaceTerminal, readDevspaceObservation, readDevspaceImageAction } from './postman-devspace.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildPostmanBridgeStartRequest, isTopLevelPostmanSupervisor, isTopLevelPostmanNodesLeader, POSTMAN_BRIDGE_PROVIDER,
  settleTrustedPostmanStatus } from './postman-bridge-core.js'

function diagnostic(error) {
  const text = String(error?.message ?? error ?? 'unknown error')
  return text.length <= 512 ? text : text.slice(0, 509) + '...'
}

// Transport outputs are ordinary JSON. Serialization errors are local job
// diagnostics; ToolRuntime owns validation of the model-facing output.
const jsonValue = value => JSON.parse(JSON.stringify(value))

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

function snapshot(job) {
  return {
    bridgeJobId: job.bridgeJobId, state: job.state,
    transportKind: job.transportKind ?? null, createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
    childSessionId: job.childSessionId ?? null, requestId: job.requestId ?? null,
    ...(job.laneId ? { laneId: job.laneId } : {}),
  }
}

/** Host executes addressed commands and retains facts; the Leader chooses recovery. */
export function createPostmanBridgeJobs(ctx, coordinator, grants, contexts, worker,
  direct = new DirectPostmanJobManager(), nodesService = null) {
  if (typeof coordinator?.run !== 'function') throw new Error('POSTMAN_BRIDGE_COORDINATOR_REQUIRED')
  const jobs = new Map()
  const admissionTails = new Map()
  function withAdmission(parentSessionId, action) {
    const previous = admissionTails.get(parentSessionId) ?? Promise.resolve()
    const result = previous.then(action, action)
    const tail = result.then(() => undefined, () => undefined)
    admissionTails.set(parentSessionId, tail)
    void tail.then(() => { if (admissionTails.get(parentSessionId) === tail)
      admissionTails.delete(parentSessionId) })
    return result
  }
  const bootstrapAgents = new WeakMap()
  const devspaceLuna = createPostmanDevspaceLanes(ctx, contexts, direct)
  const devspaceCoordinator = coordinator.fork?.() ?? coordinator
  let disposed = false
  const live = job => Boolean(job && !job.finishedAt && ['QUEUED', 'STARTING', 'RUNNING'].includes(job.state))
  const ownedJob = (parent, id) => jobs.get(id)?.parentSessionId === parent.id ? jobs.get(id) : null
  const operation = (parent, id) => operationIn(contexts?.record?.(parent.id), id)
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
    if (job.transportKind === 'devspace' && contexts?.changeRecord) {
      try { await contexts.changeRecord(job.parentSessionId, row =>
        updateHistoricalOperation(row, job.bridgeJobId, before => ({ ...before, startedAt: job.startedAt }))) }
      catch { /* Live Host start is still known; cold startedAt remains unproven. */ }
    }
    let parent
    try { parent = ctx.agents.get(job.parentSessionId) }
    catch { return { status: 'POSTMAN_BRIDGE_PARENT_UNAVAILABLE' } }
    // Resolve at actual admission, not when the tool accepted the queued job.
    try {
      if (parent?.id !== job.parentSessionId || !isTopLevelPostmanSupervisor(parent)) {
        return { status: 'POSTMAN_BRIDGE_PARENT_UNAVAILABLE' }
      }
    } catch { return { status: 'POSTMAN_BRIDGE_PARENT_UNAVAILABLE' } }
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
    if (contexts?.bindChild && !contexts.bindChild(job.parentSessionId, job.childSessionId, job.bridgeJobId)) {
      try { await run.dispose() } catch {}
      return { status: 'POSTMAN_BRIDGE_CHILD_BINDING_FAILED' }
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
      terminal = jsonValue({ ...trusted, transportKind: job.transportKind, childStopReason,
        ...(childDiagnostic === undefined ? {} : { childDiagnostic }) })
      job.requestId = terminal.requestId ?? null
    } finally {
      // A failed cleanup must not be reported as clean completion or release early.
      try { await run.dispose() }
      finally {
        contexts?.releaseChild?.(job.childSessionId)
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


  function accept(parent, message, transportKind, inputBinding, _recoveryFrom, devspaceMode, requestedLaneId, approvedScope, options = {}) {
    if (disposed) return { status: 'POSTMAN_BRIDGE_UNAVAILABLE' }
    if (!contexts?.changeRecord) {
      const running = [...jobs.values()].filter(job => job.parentSessionId === parent.id && live(job))
      if (running.filter(job => (job.transportKind === 'devspace') === (transportKind === 'devspace')).length >= 3)
        return { status: transportKind === 'devspace' ? 'POSTMAN_DEVSPACE_CAPACITY_REACHED' : 'POSTMAN_BRIDGE_LIMIT_REACHED' }
      return startJob({ bridgeJobId: randomUUID(), parentSessionId: parent.id,
        taskContext: contexts?.get?.(parent.id) ?? { leaderSessionId: parent.id, worktree: parent.session?.header?.cwd },
        transportKind, state: 'QUEUED', createdAt: new Date().toISOString(), controller: new AbortController(),
        inputBinding, imageMode: options.imageMode === true, notification: 'PENDING' }, message)
    }
    const admit = async () => {
      if (contexts?.ensure) await contexts.ensure(parent)
      const taskContext = contexts?.get(parent.id) ?? {
        leaderSessionId: parent.id, worktree: parent.session?.header?.cwd, workspaceOnly: true,
      }
      const running = [...jobs.values()].filter(job => job.parentSessionId === parent.id && live(job))
      if (running.filter(job => (job.transportKind === 'devspace') === (transportKind === 'devspace')).length >= 3)
        return { status: transportKind === 'devspace' ? 'POSTMAN_DEVSPACE_CAPACITY_REACHED' : 'POSTMAN_BRIDGE_LIMIT_REACHED' }
      let laneId = requestedLaneId
      const row = contexts?.record?.(parent.id)
      const lanes = { ...(row?.devspaceLanes ?? {}),
        ...(row?.devspaceLuna && !row.devspaceLanes?.legacy ? { legacy: row.devspaceLuna } : {}) }
      if (transportKind === 'devspace') {
        if (isTopLevelPostmanNodesLeader(parent) && nodesService) {
          const current = nodesService()?.runForAgent(parent)
          if (current?.status !== 'RUNNING' || !laneId ||
              !Object.values(current.lunaSelections ?? {}).includes(laneId))
            return { status: 'NODES_LUNA_EXACT_LANE_REQUIRED' }
        }
        if (!laneId && isTopLevelPostmanNodesLeader(parent) &&
            Object.keys(lanes).some(id => id.startsWith('nodes:')))
          return { status: 'NODES_LUNA_EXACT_LANE_REQUIRED' }
        if (laneId && !lanes[laneId]) return { status: 'POSTMAN_DEVSPACE_LANE_UNKNOWN' }
        if (laneId && lanes[laneId].state === 'closed')
          return { status: 'POSTMAN_DEVSPACE_LANE_CLOSED' }
        const occupied = id => running.some(job => job.transportKind === 'devspace' && job.laneId === id)
        if (laneId && occupied(laneId)) return { status: 'POSTMAN_DEVSPACE_LUNA_BUSY' }
        if (laneId?.startsWith('nodes:')) {
          const group = laneId.split(':').slice(0, 3).join(':')
          if (running.some(job => job.transportKind === 'devspace' &&
              (job.laneId === group || job.laneId?.startsWith(group + ':'))))
            return { status: 'NODES_LUNA_BUSY' }
        }
        const hasAddress = lane => {
          if (!lane.requestIds?.length || lane.conversationRef) return true
          return Object.entries(row?.bridgeOperations ?? {}).some(([id, op]) => {
            if (op.childSessionId !== lane.childId || !op.devspace?.channel || !op.requestId) return false
            try { return Boolean(readDevspaceObservation(loadDevspaceChannelForOwner(op.devspace.channel,
              { bridgeJobId: id, leaderSessionId: parent.id, lunaSessionId: lane.childId, requestId: op.requestId })).conversationRef) }
            catch { return false }
          })
        }
        laneId ??= Object.keys(lanes).find(id => lanes[id].state !== 'closed' && !occupied(id) && hasAddress(lanes[id])) ?? randomUUID()
      }
      const job = { bridgeJobId: randomUUID(), parentSessionId: parent.id, taskContext, transportKind,
        state: 'QUEUED', createdAt: new Date().toISOString(), controller: new AbortController(), inputBinding,
        notification: 'PENDING', devspaceMode: devspaceMode ?? (approvedScope?.access === 'write' ? 'WRITE_APPROVED_TARGET' : 'WRITE_TEST'),
        approvedScope, imageMode: options.imageMode === true, computerUse: options.computerUse ?? 'allow', ...(laneId ? { laneId } : {}) }
      job.priorOperations = Object.entries(row?.bridgeOperations ?? {})
        .filter(([id, op]) => op.devspace?.laneId === laneId && !op.executionRevoked)
        .slice(-3).map(([bridgeJobId, op]) => ({ bridgeJobId, requestId: op.requestId ?? null,
          state: op.state, runtime: live(jobs.get(bridgeJobId)) ? 'active' : 'not-observed', source: 'bridgeOperations' }))
      if (contexts?.changeRecord) await contexts.changeRecord(parent.id, old => {
        const lane = lanes[laneId]
        return { ...old,
          ...(laneId ? { devspaceLanes: { ...old.devspaceLanes, [laneId]: lane
            ? { ...lane, activeBridgeJobId: job.bridgeJobId }
            : { state: 'reserved', activeBridgeJobId: job.bridgeJobId, requestIds: [], conversationRef: null } } } : {}),
          bridgeOperations: { ...old.bridgeOperations, [job.bridgeJobId]: {
            state: 'pending', phase: 'reserved', transportKind, createdAt: job.createdAt,
            ...(laneId ? { devspace: { mode: job.devspaceMode, laneId,
              computerUse: job.computerUse, ...(job.imageMode ? { imageMode: true } : {}),
              ...(approvedScope ? { approvedRoot: approvedScope.root, approvedAccess: approvedScope.access } : {}),
              ...(lane?.archiveSource ? { archiveSource: lane.archiveSource } : {}) } } : {}) } } }
      })
      return startJob(job, message)
    }
    return withAdmission(parent.id, admit)
  }

  async function registerGrant(job) {
    if (job.trustedTerminal?.status !== 'POSTMAN_BRIDGE_TERMINAL') return
    try {
      if (await grants?.register(job.parentSessionId, job.trustedTerminal, job.taskContext) !== true && job.trustedTerminal.result?.code === 'RESULT_DURABLE')
        job.grantDiagnostic = 'Artifact grant registration rejected.'
    } catch (error) { job.grantDiagnostic = diagnostic(error) }
  }

  function startJob(job, message) {
    jobs.set(job.bridgeJobId, job)
    let admission
    try { admission = (job.transportKind === 'devspace' ? devspaceCoordinator : coordinator)
      .run(job.controller.signal, () => lifecycle(job, message)) }
    catch (error) { admission = Promise.reject(error) }
    job.completion = Promise.resolve(admission).then(async result => {
      job.trustedTerminal = jsonValue(result)
      job.requestId = result.requestId ?? job.requestId ?? null
      job.state = result.status === 'POSTMAN_BRIDGE_TERMINAL' ? 'TERMINAL'
        : result.status === 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN' ? 'INTERRUPTED' : 'FAILED'
      // Persist the result before grants, liaison delivery or the READY wake.
      if (contexts?.changeRecord) await contexts.changeRecord(job.parentSessionId, row =>
        updateHistoricalOperation(row, job.bridgeJobId, before => ({ ...before,
          ...(before.executionRevoked ? { lateTerminal: job.trustedTerminal } : {
            state: job.state === 'TERMINAL' ? 'received' : 'unknown',
            phase: job.state === 'TERMINAL' ? 'terminal' : before.phase,
            requestId: job.requestId ?? before.requestId,
            terminal: job.state === 'TERMINAL' ? job.trustedTerminal : before.terminal,
            synchronization: 'not-required',
            ...(job.state !== 'TERMINAL' ? { hostDiagnostic: job.trustedTerminal } : {}),
          }) })))
      job.synchronization = 'not-required'
      await registerGrant(job)
    }).catch(error => {
      if (job.trustedTerminal?.status !== 'POSTMAN_BRIDGE_TERMINAL') job.state = 'FAILED'
      job.diagnostic = diagnostic(error)
    }).then(async () => {
      postmanInputGrants.unpin(job.inputBinding)
      delete job.inputBinding
      job.finishedAt = new Date().toISOString()
      if (contexts?.changeRecord) {
        try { await contexts.changeRecord(job.parentSessionId, row => {
          const op = row.bridgeOperations?.[job.bridgeJobId]
          if (!op) return row
          const laneId = op.devspace?.laneId, lane = row.devspaceLanes?.[laneId]
          return { ...row,
            ...(lane?.activeBridgeJobId === job.bridgeJobId ? { devspaceLanes: {
              ...row.devspaceLanes, [laneId]: { ...lane, activeBridgeJobId: null } } } : {}),
            bridgeOperations: { ...row.bridgeOperations, [job.bridgeJobId]: { ...op,
              finishedAt: job.finishedAt, ...(job.grantDiagnostic ? { grantDiagnostic: job.grantDiagnostic } : {}),
              ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}) } } }
        }) } catch (error) { job.diagnostic ??= diagnostic(error) }
      }
      notify(job)
      if (contexts?.changeRecord) {
        try { await contexts.changeRecord(job.parentSessionId, row => updateHistoricalOperation(row,
          job.bridgeJobId, before => ({ ...before, notification: job.notification === 'DELIVERED' ? 'delivered' : 'unknown' }))) }
        catch (error) { job.notificationDiagnostic = diagnostic(error) }
      }
    })
    return { status: 'POSTMAN_BRIDGE_ACCEPTED', ...snapshot(job),
      ...(job.priorOperations?.length ? { priorOperations: job.priorOperations } : {}) }
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
        if (!job || !operation || job.parentSessionId !== parent.id ||
        job.transportKind !== 'devspace' ||
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
    // Native output retains reasoning alongside the visible ACK (the observed
    // regression had an empty block). Only the exact visible ACK is technical;
    // questions, reports, tool calls and rich output retain ordinary delivery.
    const visible = content => content.filter(block => block?.type !== 'reasoning')
    if (terminal.output === undefined) {
      const messages = child.session.events.filter(e => e.type === 'assistant/message')
      return messages.every(e => {
        const output = e.data?.message?.content
        if (!Array.isArray(output)) return false
        const parts = visible(output)
        return parts.length === 1 && parts[0]?.type === 'text' && bootstrapAcknowledgement(parts[0].text)
      })
    }
    if (!Array.isArray(terminal.output)) return false
    if (terminal.output.length === 0) return true
    const parts = visible(terminal.output)
    if (parts.length !== 1) return false
    const output = parts[0]
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
    return admissionTails.has(parentSessionId) || [...jobs.values()].some(job => job.parentSessionId === parentSessionId && live(job))
  }
  function hasActiveWork(parent) {
    return !disposed && controlCallerAllowed(parent) && hasActive(parent.id)
  }

  function observedTerminal(parent, bridgeJobId, op, fallback) {
    if (op?.transportKind === 'devspace' && op.devspace?.channel && op.requestId && op.childSessionId) {
      try {
        const binding = loadDevspaceChannelForOwner(op.devspace.channel, { bridgeJobId,
          leaderSessionId: parent.id, lunaSessionId: op.childSessionId, requestId: op.requestId })
        const saved = readDevspaceObservation(binding)
        const observed = { ...saved, ...(fallback?.result ?? {}), conversationRef: saved.conversationRef ?? fallback?.result?.conversationRef ?? null }
        if (readDevspaceEvent(binding) || observed.source === 'text_fallback' || observed.source === 'image_result' || observed.source === 'transport_diagnostic') return { status: 'POSTMAN_BRIDGE_TERMINAL',
          terminalStatus: 'COMPLETED', requestId: op.requestId, transportKind: 'devspace',
          result: devspaceTerminal(binding, observed) }
      } catch { /* A foreign or malformed event has no authority. */ }
    }
    if (!fallback && op?.requestId && ['artifact', 'text', 'image'].includes(op.transportKind) && direct.inspectRequest) {
      const proof = direct.inspectRequest(op.requestId, undefined, op.transportKind)
      if (proof?.state === 'terminal') return proof.terminal
    }
    return fallback
  }

  // Observation can read durable transport facts. It never starts a model,
  // sends, registers a grant, reconciles writers or edits task journals.
  async function status(parent, bridgeJobId) {
    const known = jobs.get(bridgeJobId)
    const caller = ctx.agents?.get?.(parent?.id)
    if (known && known.parentSessionId !== parent.id || caller && caller !== parent ||
        ctx.agents?.get && !caller && !known) return { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    const job = ownedJob(parent, bridgeJobId), op = operation(parent, bridgeJobId)
    if (!job && !op) return { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    const terminal = observedTerminal(parent, bridgeJobId, op, op?.terminal ?? job?.trustedTerminal)
    if (op?.executionRevoked || op?.archivedAt) return { status: 'POSTMAN_BRIDGE_ARCHIVED', bridgeJobId,
      requestId: op.requestId ?? null, executionRevoked: op.executionRevoked === true,
      archivedAt: op.archivedAt ?? null, result: op.terminal?.result ?? null,
      lateResult: observedTerminal(parent, bridgeJobId, op, op.lateTerminal)?.result ?? null,
      processStopProven: false }
    let imageActions = {}
    if (op?.transportKind === 'devspace' && !op.executionRevoked) {
      try {
        const binding = loadDevspaceChannelForOwner(op.devspace?.channel, { bridgeJobId,
          leaderSessionId: parent.id, lunaSessionId: op.childSessionId, requestId: op.requestId })
        if (binding.imageMode === true) imageActions = {
          imageInspection: readDevspaceImageAction(binding, 'image_inspect'),
          imageDownload: readDevspaceImageAction(binding, 'image_download') }
      } catch (error) { imageActions = { imageActionDiagnostic: diagnostic(error) } }
    }
    if (terminal?.status === 'POSTMAN_BRIDGE_TERMINAL') return {
      ...imageActions,
      ...(job ? snapshot(job) : { bridgeJobId, transportKind: op.transportKind ?? null,
        requestId: op.requestId ?? terminal.requestId ?? null, childSessionId: op.childSessionId ?? null, laneId: op.devspace?.laneId ?? null }),
      status: 'POSTMAN_BRIDGE_TERMINAL', state: 'TERMINAL', terminalStatus: terminal.terminalStatus ?? null,
      trustedStatus: terminal.status, result: terminal.result ?? null, checks: terminal.checks ?? null,
      childStopReason: terminal.childStopReason ?? null, childDiagnostic: terminal.childDiagnostic ?? null,
      synchronization: 'not-required', diagnostic: terminal.diagnostic ?? op?.diagnostic ?? job?.diagnostic ?? null,
      notification: job?.notification ?? op?.notification ?? null,
      ...(op?.grantDiagnostic ?? job?.grantDiagnostic ? { grantDiagnostic: op?.grantDiagnostic ?? job.grantDiagnostic } : {}) }
    if (job && live(job)) return { status: job.state === 'QUEUED' ? 'POSTMAN_BRIDGE_QUEUED' : 'POSTMAN_BRIDGE_RUNNING', ...snapshot(job) }
    if (job?.state === 'FAILED') return { ...snapshot(job), status: 'POSTMAN_BRIDGE_FAILED',
      trustedStatus: terminal?.status ?? null, result: terminal?.result ?? null,
      diagnostic: terminal?.diagnostic ?? job.diagnostic ?? null, notification: job.notification ?? null }
    return { status: terminal?.status === 'POSTMAN_BRIDGE_NOT_SENT' || op?.phase === 'not-sent'
      ? 'POSTMAN_BRIDGE_NOT_SENT' : 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN', bridgeJobId,
      state: 'INTERRUPTED', requestId: op?.requestId ?? job?.requestId ?? null,
      childSessionId: op?.childSessionId ?? job?.childSessionId ?? null, laneId: op?.devspace?.laneId ?? job?.laneId ?? null,
      diagnostic: op?.hostDiagnostic?.status ?? job?.diagnostic ?? terminal?.diagnostic ?? null,
      facts: ['No live Host execution is registered; the previous external outcome may be unknown.'] }
  }

  function list(parent) {
    const row = contexts?.record?.(parent.id)
    const all = Object.assign({}, ...[...(row?.retiredTasks ?? []), row].filter(Boolean).map(task => task.bridgeOperations ?? {}))
    for (const job of jobs.values()) if (job.parentSessionId === parent.id) all[job.bridgeJobId] ??= {}
    const operations = Object.entries(all).map(([bridgeJobId, op]) => {
      const job = ownedJob(parent, bridgeJobId), occupied = live(job)
      return { bridgeJobId, state: job?.state ?? op.state ?? 'unknown', phase: op.phase ?? 'unknown',
        transportKind: job?.transportKind ?? op.transportKind ?? null,
        requestId: job?.requestId ?? op.requestId ?? null, childSessionId: job?.childSessionId ?? op.childSessionId ?? null,
        laneId: job?.laneId ?? op.devspace?.laneId ?? null,
        countsAgainstLimit: occupied, slotReason: occupied ? 'Host execution is active' : 'No active Host execution',
        executionRevoked: op.executionRevoked === true, archivedAt: op.archivedAt ?? null,
        cancellationRequested: job?.cancellationRequested === true || op.cancellationRequested === true }
    })
    return { status: 'POSTMAN_BRIDGE_LIST', limit: 3, used: operations.filter(op => op.countsAgainstLimit).length, operations }
  }
  // Read-only projection for the optional NodesAgent communication graph.
  // A saved URL is exposed only with exact Host operation/channel evidence.
  function nodesLunaSnapshot(parentOrId, laneIds) {
    // A string root ID is the internal, read-only cold-history path supplied
    // by NodesAgent from its exact persisted TeamRun. Tool callers still need
    // the live Supervisor identity on the ordinary parent-object route.
    const coldId = typeof parentOrId === 'string' ? parentOrId : null
    const parent = coldId ? { id: coldId } : parentOrId
    if (!Array.isArray(laneIds) || (coldId
      ? !laneIds.every(id => typeof id === 'string' && id.startsWith('nodes:'))
      : !controlCallerAllowed(parent))) return []
    const row = contexts?.record?.(parent.id)
    if (coldId && row?.leaderSessionId !== coldId) return []
    const operations = Object.assign({}, ...[...(row?.retiredTasks ?? []), row]
      .filter(Boolean).map(task => task.bridgeOperations ?? {}))
    const urlPattern = /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/
    return laneIds.map(laneId => {
      const lane = row?.devspaceLanes?.[laneId] ??
        (laneId === 'legacy' ? row?.devspaceLuna : null)
      const entries = Object.entries(operations).filter(([, op]) =>
        op?.transportKind === 'devspace' && op.devspace?.laneId === laneId)
      const conversations = [], observations = new Map()
      for (const [bridgeJobId, op] of entries) {
        if (!op.requestId || !op.childSessionId || !op.devspace?.channel) continue
        let verified
        try {
          const binding = loadDevspaceChannelForOwner(op.devspace.channel, {
            bridgeJobId, leaderSessionId: parent.id, lunaSessionId: op.childSessionId,
            requestId: op.requestId })
          verified = readDevspaceObservation(binding)
          observations.set(bridgeJobId, verified)
        } catch { continue }
        if (!verified.conversationObserved) continue
        const terminalUrl = op.terminal?.result?.conversationRef
        const url = terminalUrl && terminalUrl === verified.conversationRef ? terminalUrl :
          verified?.conversationRef
        if (typeof url !== 'string' || !urlPattern.test(url)) continue
        const slots = verified.transportDiagnostics?.reminderSlots ??
          op.terminal?.result?.transportDiagnostics?.reminderSlots
        const reminderSent = slots && typeof slots === 'object' ?
          Object.values(slots).filter(slot => slot?.state === 'SENT_CONFIRMED').length : null
        conversations.push({ id: bridgeJobId, conversationRef: url,
          sourceLeaderSessionId: parent.id, sourceLaneId: laneId,
          requestId: op.requestId, sourceChildSessionId: op.childSessionId,
          createdAt: op.createdAt ?? null, reminderSent })
      }
      const active = entries.filter(([, op]) => !op.executionRevoked)
        .map(([id]) => ownedJob(parent, id)).find(job => live(job))
      const last = conversations.at(-1), mostRecent = entries.at(-1)
      const currentId = active?.bridgeJobId ?? mostRecent?.[0]
      const currentOp = currentId && operations[currentId]
      const job = currentId && ownedJob(parent, currentId)
      const startedAt = job?.startedAt ?? currentOp?.startedAt ?? null
      const finishedAt = active ? null : job?.finishedAt ?? currentOp?.finishedAt ?? null
      const end = active ? Date.now() : finishedAt ? Date.parse(finishedAt) : NaN
      const elapsedMs = startedAt && Number.isFinite(end) && end >= Date.parse(startedAt)
        ? end - Date.parse(startedAt) : null
      const slots = observations.get(currentId)?.transportDiagnostics?.reminderSlots ??
        currentOp?.terminal?.result?.transportDiagnostics?.reminderSlots
      const reminderSent = slots && typeof slots === 'object' ?
        Object.values(slots).filter(slot => slot?.state === 'SENT_CONFIRMED').length : null
      const reminderState = !slots ? 'UNKNOWN' :
        Object.values(slots).some(slot => ['PENDING', 'ATTEMPTING'].includes(slot?.state)) ? 'PENDING' :
        Object.values(slots).some(slot => slot?.state === 'BLOCKED_UNKNOWN') ? 'UNKNOWN' : 'OBSERVED'
      const currentRef = last?.conversationRef ?? lane?.archiveSource?.conversationRef ?? null
      return { laneId, status: active ? active.state === 'QUEUED' ? 'QUEUED' : 'WORKING' :
          entries.some(([, op]) => !op.executionRevoked && op.state === 'pending' && !op.terminal) ? 'UNKNOWN' :
          lane?.state === 'closed' ? 'CLOSED' : currentRef ? 'IDLE' : 'POTENTIAL',
        hostJobState: active?.state ?? (mostRecent?.[1]?.terminal ? 'TERMINAL' :
          mostRecent?.[1]?.state === 'pending' ? 'UNKNOWN' : 'IDLE'),
        activeJobId: active?.bridgeJobId ?? null, startedAt, finishedAt, elapsedMs,
        timeBasis: 'HOST_JOB', lastRequestId: mostRecent?.[1]?.requestId ?? null,
        conversationRef: currentRef, reminderSent, reminderState, conversations }
    })
  }
  function teamSnapshot(parent) {
    if (!controlCallerAllowed(parent)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
    const result = list(parent)
    return { ...result, status: 'POSTMAN_BRIDGE_TEAM_SNAPSHOT', operations: result.operations.slice(-30),
      truncated: result.operations.length > 30 }
  }
  function controlCallerAllowed(parent) {
    try { return isTopLevelPostmanSupervisor(parent) &&
      (typeof ctx.agents?.get !== 'function' || ctx.agents.get(parent.id) === parent) }
    catch { return false }
  }

  function devspaceControl(parent, bridgeJobId, action, message, priority = 'normal') {
    if (disposed || !controlCallerAllowed(parent)) return { status: 'POSTMAN_DEVSPACE_CONTROL_CALLER_REJECTED' }
    const op = operation(parent, bridgeJobId), job = ownedJob(parent, bridgeJobId)
    if (!op || op.transportKind !== 'devspace' || !op.requestId || !op.childSessionId ||
      op.executionRevoked || job && (job.childSessionId !== op.childSessionId || job.requestId !== op.requestId))
      return { status: 'POSTMAN_DEVSPACE_CONTROL_JOB_NOT_FOUND' }
    let binding
    try { binding = loadDevspaceChannelForOwner(op.devspace?.channel, { bridgeJobId,
      leaderSessionId: parent.id, lunaSessionId: op.childSessionId, requestId: op.requestId }) }
    catch (error) { return { status: 'POSTMAN_DEVSPACE_CONTROL_CHANNEL_UNAVAILABLE', diagnostic: diagnostic(error) } }
    if (action === 'image_inspect' || action === 'image_download') {
      const execute = async () => {
        const current = operation(parent, bridgeJobId), row = contexts.record(parent.id)
        const laneId = current?.devspace?.laneId
        const lane = laneId === 'legacy' ? row.devspaceLuna : row.devspaceLanes?.[laneId]
        if (disposed || !controlCallerAllowed(parent) || !current || current.executionRevoked ||
            binding.imageMode !== true || current.terminal?.status !== 'POSTMAN_BRIDGE_TERMINAL' || live(ownedJob(parent, bridgeJobId)) ||
            lane?.activeBridgeJobId && lane.activeBridgeJobId !== bridgeJobId ||
            [...jobs.values()].some(other => other.parentSessionId === parent.id && other.laneId === laneId && live(other)))
          return { status: 'POSTMAN_DEVSPACE_IMAGE_ACTION_REJECTED', diagnostic: 'OWNED_TERMINAL_IMAGE_REQUIRED' }
        if (!direct.imageAction) return { status: 'POSTMAN_DEVSPACE_IMAGE_ACTION_UNAVAILABLE' }
        try {
          const receipt = await direct.imageAction(binding, action)
          return { status: receipt ? 'POSTMAN_DEVSPACE_IMAGE_ACTION_RESULT' : 'POSTMAN_DEVSPACE_IMAGE_ACTION_UNKNOWN',
            bridgeJobId, requestId: op.requestId, receipt }
        } catch (error) { return { status: 'POSTMAN_DEVSPACE_IMAGE_ACTION_UNKNOWN', diagnostic: diagnostic(error),
            bridgeJobId, requestId: op.requestId } }
      }
      // Reuse admission serialization so a new Send cannot occupy this lane mid-action.
      const result = (admissionTails.get(parent.id) ?? Promise.resolve()).then(execute, execute)
      const tail = result.then(() => undefined, () => undefined)
      admissionTails.set(parent.id, tail)
      void tail.then(() => { if (admissionTails.get(parent.id) === tail) admissionTails.delete(parent.id) })
      return result
    }
    if (action === 'status') {
      try { return { status: 'POSTMAN_DEVSPACE_CONTROL_STATUS', bridgeJobId, requestId: op.requestId,
        controls: readDevspaceControls(binding), runtime: live(job) ? 'active' : 'not-observed' } }
      catch (error) { return { status: 'POSTMAN_DEVSPACE_CONTROL_STATUS_UNKNOWN', diagnostic: diagnostic(error) } }
    }
    try { return { ...requestDevspaceControl(binding, { kind: action, message, priority }), bridgeJobId,
      ...(!live(job) ? { facts: ['Control queued at the saved address; live observer availability is unknown.'] } : {}) } }
    catch (error) { return { status: 'POSTMAN_DEVSPACE_CONTROL_REJECTED', diagnostic: diagnostic(error) } }
  }

  async function stop(parent, bridgeJobId, abandon = false) {
    if (!controlCallerAllowed(parent)) return { status: 'POSTMAN_BRIDGE_CALLER_REJECTED' }
    const op = operation(parent, bridgeJobId), job = ownedJob(parent, bridgeJobId)
    if (!op && !job) return { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    if (abandon) {
      let stopReceipt = null, revokeDiagnostic
      if (op?.transportKind === 'devspace' && op.devspace?.channel) {
        try {
          const binding = loadDevspaceChannelForOwner(op.devspace.channel, { bridgeJobId,
            leaderSessionId: parent.id, lunaSessionId: op.childSessionId, requestId: op.requestId })
          stopReceipt = requestDevspaceControl(binding, { kind: 'stop' })
          revokeDevspaceChannel(binding)
        } catch (error) { revokeDiagnostic = diagnostic(error) }
      }
      if (contexts?.changeRecord) await contexts.changeRecord(parent.id, row => updateHistoricalOperation(row,
        bridgeJobId, before => ({ ...before, archivedAt: before.archivedAt ?? new Date().toISOString(),
          executionRevoked: true, cancellationRequested: true })))
      if (job) { job.cancellationRequested = true; job.controller.abort() }
      return { status: 'POSTMAN_BRIDGE_ARCHIVED', bridgeJobId, requestId: op?.requestId ?? job?.requestId ?? null,
        processStopProven: false, stopReceipt, ...(revokeDiagnostic ? { diagnostic: revokeDiagnostic } : {}) }
    }
    if (op?.executionRevoked) return { status: 'POSTMAN_BRIDGE_ARCHIVED', bridgeJobId }
    if (op?.terminal?.status === 'POSTMAN_BRIDGE_TERMINAL' || job?.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL')
      return { status: 'POSTMAN_BRIDGE_ALREADY_TERMINAL', bridgeJobId }
    const external = op?.transportKind === 'devspace' ? devspaceControl(parent, bridgeJobId, 'stop') : null
    if (contexts?.changeRecord && op) await contexts.changeRecord(parent.id, row => updateHistoricalOperation(row,
      bridgeJobId, before => ({ ...before, cancellationRequested: true })))
    if (job && live(job)) { job.cancellationRequested = true; job.controller.abort() }
    return { status: job && live(job) || external?.status === 'POSTMAN_DEVSPACE_CONTROL_QUEUED'
      ? 'POSTMAN_BRIDGE_STOP_REQUESTED' : 'POSTMAN_BRIDGE_STOP_NOT_LIVE', bridgeJobId,
      cancellationRequested: true, ...(external ? { control: external } : {}) }
  }
  async function abandonAll(parent) {
    const results = []
    for (const id of Object.keys(contexts?.record?.(parent.id)?.bridgeOperations ?? {}))
      results.push(await stop(parent, id, true))
    return { status: 'POSTMAN_BRIDGE_ARCHIVED', results }
  }

  // Startup delivers existing results only. There is no browser replay or Luna
  // prerequisite. Explicit status reads remain free of notification side effects.
  async function recoverDevspacePending(parent) {
    if (disposed || !controlCallerAllowed(parent)) return { status: 'POSTMAN_DEVSPACE_RECOVERY_UNAVAILABLE' }
    const recovered = [], unresolved = []
    const entries = Object.entries(contexts?.record?.(parent.id)?.bridgeOperations ?? {})
    for (const [bridgeJobId, op] of entries) {
      if (op.transportKind !== 'devspace' || op.executionRevoked || op.notification === 'delivered' || op.notification === 'intent') continue
      const terminal = observedTerminal(parent, bridgeJobId, op, op.terminal)
      if (terminal?.status !== 'POSTMAN_BRIDGE_TERMINAL') { unresolved.push({ bridgeJobId }); continue }
      await contexts.changeRecord(parent.id, row => updateHistoricalOperation(row, bridgeJobId, before => ({
        ...before, state: 'received', phase: 'terminal', terminal, synchronization: 'not-required', notification: 'intent' })))
      const job = { bridgeJobId, parentSessionId: parent.id, requestId: op.requestId, transportKind: 'devspace' }
      notify(job)
      await contexts.changeRecord(parent.id, row => updateHistoricalOperation(row, bridgeJobId, before => ({
        ...before, notification: job.notification === 'DELIVERED' ? 'delivered' : 'unknown' })))
      recovered.push({ bridgeJobId, notification: job.notification })
    }
    return { status: 'POSTMAN_DEVSPACE_RECOVERY_SUMMARY', recovered, unresolved }
  }
  async function dispose() {
    if (disposed) return
    disposed = true
    for (const job of jobs.values()) job.controller.abort()
    direct.dispose?.()
    coordinator.dispose()
    if (devspaceCoordinator !== coordinator) devspaceCoordinator.dispose()
    await Promise.allSettled([...jobs.values()].map(job => job.completion).concat([...admissionTails.values()]))
    jobs.clear()
  }
  return { accept, status, list, teamSnapshot, nodesLunaSnapshot, withAdmission, stop, abandonAll, hasActive, hasActiveWork, dispose,
    canDeferLunaBootstrapReport, canDeferLunaBootstrapSettlement, devspaceControl, recoverDevspacePending,
    devspaceLunaClose: (parent, laneId) => devspaceLuna.close(parent, contexts?.get(parent.id), laneId),
    devspaceLunaSnapshot: parent => devspaceLuna.snapshot(parent) }
}
