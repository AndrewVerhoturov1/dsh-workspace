import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildPostmanBridgeStartRequest, isTopLevelPostmanSupervisor, POSTMAN_BRIDGE_PROVIDER,
  settleTrustedPostmanStatus } from './postman-bridge-core.js'

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

function snapshot(job) {
  return {
    bridgeJobId: job.bridgeJobId, state: job.state,
    transportKind: job.transportKind, createdAt: job.createdAt,
    startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
    childSessionId: job.childSessionId ?? null, requestId: job.requestId ?? null,
  }
}

/** Process-local jobs live through tool invocation and retain terminal until plugin disposal. */
export function createPostmanBridgeJobs(ctx, coordinator, grants, contexts, worker) {
  if (typeof coordinator?.run !== 'function') throw new Error('POSTMAN_BRIDGE_COORDINATOR_REQUIRED')
  const jobs = new Map()
  const admissionTails = new Map()
  let disposed = false

  async function trustedStatusReader(child, signal) {
    const statusTool = ctx.tools.get('postman_current_turn_status', child)
    if (typeof statusTool?.execute !== 'function') return { status: 'NO_JOB' }
    return statusTool.execute({}, { agent: child, signal })
  }

  async function lifecycle(job, message) {
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
    let run
    try {
      run = await ctx.subagents.start(POSTMAN_BRIDGE_PROVIDER, buildPostmanBridgeStartRequest({
        parent, message, signal: job.controller.signal, transportKind: job.transportKind,
      }))
    } catch (error) {
      return { status: 'POSTMAN_BRIDGE_START_FAILED', diagnostic: diagnostic(error) }
    }
    job.childSessionId = String(run.id)
    if (contexts && !contexts.bindChild(job.parentSessionId, job.childSessionId)) {
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
      const trusted = await settleTrustedPostmanStatus(
        () => trustedStatusReader(child, job.controller.signal), job.controller.signal)
      terminal = losslessValue({ ...trusted, transportKind: job.transportKind, childStopReason,
        ...(childDiagnostic === undefined ? {} : { childDiagnostic }) })
      job.requestId = terminal.requestId ?? null
    } finally {
      // A failed cleanup must not be reported as clean completion or release early.
      try { await run.dispose() }
      finally { contexts?.releaseChild(job.childSessionId) }
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

  function accept(parent, message, transportKind) {
    const taskContext = contexts?.get(parent.id)
    if (contexts && !taskContext) return { status: 'POSTMAN_TASK_CONTEXT_REQUIRED' }
    if (typeof contexts?.isRestoring === 'function' && contexts.isRestoring(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
    if (typeof contexts?.hasActiveOperation === 'function' && contexts.hasActiveOperation(parent.id)) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
    if (disposed) return { status: 'POSTMAN_BRIDGE_UNAVAILABLE' }
    const job = {
      bridgeJobId: randomUUID(), parentSessionId: parent.id, taskContext, transportKind, state: 'QUEUED',
      createdAt: new Date().toISOString(), controller: new AbortController(),
      notification: 'PENDING',
    }
    if (typeof contexts?.changeRecord !== 'function') {
      // Unit fixtures without a durable registry retain the synchronous API.
      const live = [...jobs.values()].filter(item => item.parentSessionId === parent.id &&
        !['TERMINAL', 'FAILED'].includes(item.state)).length
      return live >= 3 ? { status: 'POSTMAN_BRIDGE_LIMIT_REACHED' } : startJob(job, message)
    }
    // Serialize only durable admissions for this Leader, never Web lifecycles.
    // Concurrent calls each see the preceding persisted intent before counting slots.
    const prior = admissionTails.get(parent.id) ?? Promise.resolve()
    const admit = async () => {
      try {
        const row = contexts.record?.(parent.id)
        const unresolved = Object.values(row?.bridgeOperations ?? {}).filter(op =>
          op.state === 'pending' || op.state === 'unknown').length + (row?.bridge ? 1 : 0)
        const awaitingSync = Object.values(row?.bridgeOperations ?? {}).filter(op =>
          op.state === 'received' && !['synchronized', 'not-required'].includes(op.synchronization)).length
        if (unresolved >= 3 || awaitingSync >= 3) return { status: 'POSTMAN_BRIDGE_LIMIT_REACHED' }
        await contexts.changeRecord(parent.id, old => {
          const operations = old.bridgeOperations ?? {}
          const count = Object.values(operations).filter(op =>
            op.state === 'pending' || op.state === 'unknown').length + (old.bridge ? 1 : 0)
          const awaitingSync = Object.values(operations).filter(op =>
            op.state === 'received' && !['synchronized', 'not-required'].includes(op.synchronization)).length
          if (count >= 3 || awaitingSync >= 3) throw new Error('POSTMAN_BRIDGE_LIMIT_REACHED')
          return { ...old, bridgeOperations: { ...operations, [job.bridgeJobId]: { state: 'pending' } } }
        })
        return startJob(job, message)
      } catch (error) {
        return { status: error?.message === 'POSTMAN_BRIDGE_LIMIT_REACHED'
          ? 'POSTMAN_BRIDGE_LIMIT_REACHED' : 'POSTMAN_BRIDGE_ADMISSION_FAILED',
          diagnostic: diagnostic(error) }
      }
    }
    const result = prior.then(admit, admit)
    const tail = result.then(() => undefined, () => undefined)
    admissionTails.set(parent.id, tail)
    void tail.then(() => { if (admissionTails.get(parent.id) === tail) admissionTails.delete(parent.id) })
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

  // Only a correlated Direct pre-publication rejection with explicit null
  // publicationReceipt proves that there is no task commit. Absence is unknown.
  function noPublicationProven(terminal) {
    const result = terminal?.result
    return terminal.status === 'POSTMAN_BRIDGE_TERMINAL' && terminal.terminalStatus === 'FAILED' &&
      result?.ok === false && result.code === 'POSTMAN_TRANSPORT_FAILED' &&
      result.publicationReceipt === null && result.requestId === terminal.requestId &&
      typeof result.transportMessage === 'string' && result.transportMessage.length > 0 &&
      result.details !== null && typeof result.details === 'object' && !Array.isArray(result.details) &&
      ['DIRECT_INVALID_TASK', 'DIRECT_RESULT_ROOT_UNAVAILABLE',
        'DIRECT_INVALID_CONTINUATION', 'POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED']
        .includes(result.transportCode)
  }

  function publicationOf(terminal) {
    const result = terminal?.result
    return result?.ok === true ? result :
      result?.ok === false && result.code === 'POSTMAN_TRANSPORT_FAILED' ? result.publicationReceipt : null
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
        [job.bridgeJobId]: { ...op, synchronization: 'not-required' } } }
    })
    job.synchronization = 'not-required'
  }

  async function synchronize(job, publication) {
    const leaderId = job.parentSessionId
    let synchronized = false
    try {
      synchronized = await contexts.sync(leaderId, publication.taskPublicationCommit,
        publication.baseCommit, id => worker ? worker.pauseForOperation(id) : true)
    } catch (error) { job.syncDiagnostic = diagnostic(error) }
    if (!synchronized) { job.synchronization = 'busy'; return }
    // Grant registration is subordinate to verified publication and ZIP hash.
    await registerGrant(job)
    if (typeof contexts?.changeRecord === 'function') await contexts.changeRecord(leaderId, row => {
      const op = row.bridgeOperations?.[job.bridgeJobId]
      if (op?.state !== 'received') throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
      const operations = { ...row.bridgeOperations }
      if (job.grantDiagnostic && job.trustedTerminal.result?.code === 'RESULT_DURABLE')
        operations[job.bridgeJobId] = { ...op, synchronization: 'synchronized', grantDiagnostic: job.grantDiagnostic }
      else delete operations[job.bridgeJobId]
      return { ...row, bridgeOperations: operations }
    })
    job.synchronization = 'synchronized'
    if (!job.grantDiagnostic && job.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL') job.state = 'TERMINAL'
  }

  function startJob(job, message) {
    jobs.set(job.bridgeJobId, job)
    // Coordinator holds the active slot only through child disposal, never through grants.
    let admission
    try { admission = coordinator.run(job.controller.signal, () => lifecycle(job, message)) }
    catch (error) { admission = Promise.reject(error) }
    job.completion = admission.then(async result => {
        // A verified terminal is delivery evidence even when the shared tree is
        // temporarily busy. Persist it before any synchronization attempt.
        const safe = losslessValue(result)
        job.trustedTerminal = safe
        job.requestId = safe.requestId ?? job.requestId ?? null
        job.state = safe.status === 'POSTMAN_BRIDGE_TERMINAL' ? 'TERMINAL' : 'FAILED'
        if (job.state === 'TERMINAL' && typeof contexts?.changeRecord === 'function') {
          await contexts.changeRecord(job.parentSessionId, row => {
            if (row.bridgeOperations?.[job.bridgeJobId]?.state !== 'pending')
              throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
            return { ...row, bridgeOperations: { ...row.bridgeOperations,
              [job.bridgeJobId]: { state: 'received', terminal: safe, synchronization: 'pending' } } }
          })
        }
        const publication = publicationOf(safe)
        // Keep uncertain publication outcomes blocked; a missing receipt by
        // itself does not establish that the external operation did nothing.
        job.synchronization = contexts ? 'busy' : 'not-required'
        if (job.state === 'TERMINAL' && publication && contexts)
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
              if (current?.state === 'received') return row
              if (!current) {
                if (job.synchronization === 'synchronized') return row
                throw new Error('POSTMAN_BRIDGE_JOURNAL_MISSING')
              }
              return { ...row, bridgeOperations: { ...row.bridgeOperations,
                [job.bridgeJobId]: { state: 'unknown' } } }
            })
          } catch (error) { job.state = 'FAILED'; job.diagnostic = diagnostic(error) }
        }
        job.finishedAt = new Date().toISOString()
        notify(job)
      })
    return { status: 'POSTMAN_BRIDGE_ACCEPTED', ...snapshot(job) }
  }

  function hasActive(parentSessionId) {
    return [...jobs.values()].some(job => job.parentSessionId === parentSessionId &&
      !['TERMINAL', 'FAILED'].includes(job.state))
  }

  async function status(parent, bridgeJobId, retrySync = false) {
    let job = jobs.get(bridgeJobId)
    if (!job) {
      const row = contexts?.record?.(parent.id)
      const operation = Object.hasOwn(row?.bridgeOperations ?? {}, bridgeJobId)
        ? row.bridgeOperations[bridgeJobId] : row?.bridge?.id === bridgeJobId ? row.bridge : null
      if (operation?.state === 'received' && operation.terminal) {
        // Pin this one recovered owner before deleting its only durable copy.
        // Thereafter reads and overlapping retries use the same mutable object.
        const terminal = losslessValue(operation.terminal)
        job = { bridgeJobId, parentSessionId: parent.id, transportKind: terminal.transportKind,
          trustedTerminal: terminal, requestId: terminal.requestId ?? null,
          state: operation.grantDiagnostic ? 'FAILED' : 'TERMINAL',
          finishedAt: new Date().toISOString(), synchronization: operation.synchronization === 'pending' ? 'busy' : operation.synchronization ?? 'busy',
          grantDiagnostic: operation.grantDiagnostic, controller: new AbortController() }
        jobs.set(bridgeJobId, job)
      } else return operation
        ? { status: 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN', bridgeJobId, state: 'INTERRUPTED' }
        : { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    }
    if (job.parentSessionId !== parent.id) return { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    if (retrySync && job.finishedAt && job.trustedTerminal?.status === 'POSTMAN_BRIDGE_TERMINAL' &&
        (job.synchronization === 'busy' || job.synchronization === 'pending' ||
          job.grantDiagnostic && job.trustedTerminal.result?.code === 'RESULT_DURABLE')) {
      const publication = publicationOf(job.trustedTerminal)
      if (publication) await retryPublication(job, publication)
      else if (noPublicationProven(job.trustedTerminal)) {
        if (job.noPublicationAttempt) await job.noPublicationAttempt
        else {
          const attempt = completeWithoutPublication(job)
          job.noPublicationAttempt = attempt
          try { await attempt } finally { if (job.noPublicationAttempt === attempt) job.noPublicationAttempt = null }
        }
      }
    }
    const common = snapshot(job)
    if (job.state === 'QUEUED') return { status: 'POSTMAN_BRIDGE_QUEUED', ...common }
    if (!job.finishedAt || job.state === 'STARTING' || job.state === 'RUNNING') {
      return { status: 'POSTMAN_BRIDGE_RUNNING', ...common }
    }
    const terminal = job.trustedTerminal
    return { ...common,
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

  async function dispose() {
    if (disposed) return
    disposed = true
    for (const job of jobs.values()) job.controller.abort()
    coordinator.dispose()
    await Promise.allSettled([...jobs.values()].map(job => job.completion))
    jobs.clear()
  }

  return { accept, status, hasActive, dispose }
}
