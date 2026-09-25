import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildPostmanBridgeStartRequest, isTopLevelPostmanLeader, POSTMAN_BRIDGE_PROVIDER,
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
export function createPostmanBridgeJobs(ctx, coordinator, grants, contexts) {
  if (typeof coordinator?.run !== 'function') throw new Error('POSTMAN_BRIDGE_COORDINATOR_REQUIRED')
  const jobs = new Map()
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
      if (parent?.id !== job.parentSessionId || !isTopLevelPostmanLeader(parent)) {
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
      if (leader?.id !== job.parentSessionId || !isTopLevelPostmanLeader(leader) ||
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
    if (contexts && [...jobs.values()].some(job => job.parentSessionId === parent.id &&
        !['TERMINAL', 'FAILED'].includes(job.state))) return { status: 'POSTMAN_TASK_CONTEXT_BUSY' }
    const job = {
      bridgeJobId: randomUUID(), parentSessionId: parent.id, taskContext, transportKind, state: 'QUEUED',
      createdAt: new Date().toISOString(), controller: new AbortController(),
      notification: 'PENDING',
    }
    jobs.set(job.bridgeJobId, job)
    // Coordinator holds the active slot only through child disposal, never through grants.
    let admission
    try { admission = coordinator.run(job.controller.signal, () => lifecycle(job, message)) }
    catch (error) { admission = Promise.reject(error) }
    job.completion = admission.then(async result => {
        // Includes early lifecycle failures and invalid trusted statuses.
        const safe = losslessValue(result)
        job.trustedTerminal = safe
        job.requestId = safe.requestId ?? job.requestId ?? null
        // A successful Direct publication advances the same clean task worktree.
        // Never grant an artifact if the remote branch/parent cannot be proved.
        const publication = safe.result?.ok === true ? safe.result
          : safe.result?.ok === false && safe.result.code === 'POSTMAN_TRANSPORT_FAILED'
            ? safe.result.publicationReceipt : null
        if (contexts && safe.status === 'POSTMAN_BRIDGE_TERMINAL' && publication) {
          let synchronized = false
          let reason = 'Task branch publication cannot be synchronized safely.'
          try {
            synchronized = await contexts.sync(job.parentSessionId,
              publication.taskPublicationCommit, publication.baseCommit)
          } catch (error) { reason += ' ' + diagnostic(error) }
          if (!synchronized) {
            job.trustedTerminal = { status: 'POSTMAN_TASK_PUBLICATION_SYNC_FAILED',
              requestId: safe.requestId, diagnostic: reason,
              ...(safe.result?.ok === false ? { terminalStatus: safe.terminalStatus, result: safe.result } : {}) }
            job.state = 'FAILED'
            return
          }
        }
        // Only a trusted terminal from a fully cleaned child may authorize a grant.
        if (safe.status === 'POSTMAN_BRIDGE_TERMINAL' && safe.result?.ok !== false) {
          try { await grants?.register(job.parentSessionId, safe) }
          catch (error) { job.grantDiagnostic = diagnostic(error) }
        }
        job.state = safe.status === 'POSTMAN_BRIDGE_TERMINAL' ? 'TERMINAL' : 'FAILED'
      })
      .catch(error => {
        job.state = 'FAILED'
        job.diagnostic = diagnostic(error)
      })
      .then(() => {
        job.finishedAt = new Date().toISOString()
        notify(job)
      })
    return { status: 'POSTMAN_BRIDGE_ACCEPTED', ...snapshot(job) }
  }

  function hasActive(parentSessionId) {
    return [...jobs.values()].some(job => job.parentSessionId === parentSessionId &&
      !['TERMINAL', 'FAILED'].includes(job.state))
  }

  function status(parent, bridgeJobId) {
    const job = jobs.get(bridgeJobId)
    if (!job || job.parentSessionId !== parent.id) return { status: 'POSTMAN_BRIDGE_JOB_NOT_FOUND' }
    const common = snapshot(job)
    if (job.state === 'QUEUED') return { status: 'POSTMAN_BRIDGE_QUEUED', ...common }
    if (job.state === 'STARTING' || job.state === 'RUNNING') {
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
