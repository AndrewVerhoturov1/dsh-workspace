import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { buildPostmanBridgeStartRequest, isTopLevelPostmanLeader, POSTMAN_BRIDGE_PROVIDER,
  settleTrustedPostmanStatus } from './postman-bridge-core.js'

function diagnostic(error) {
  const text = String(error?.message ?? error ?? 'unknown error')
  return text.length <= 512 ? text : text.slice(0, 509) + '...'
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
export function createPostmanBridgeJobs(ctx, coordinator, grants) {
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
    let run
    try {
      run = await ctx.subagents.start(POSTMAN_BRIDGE_PROVIDER, buildPostmanBridgeStartRequest({
        parent, message, signal: job.controller.signal, transportKind: job.transportKind,
      }))
    } catch (error) {
      return { status: 'POSTMAN_BRIDGE_START_FAILED', diagnostic: diagnostic(error) }
    }
    job.childSessionId = String(run.id)
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
        childStopReason = childResult.stopReason
        childDiagnostic = childResult.diagnostic
      } catch (error) {
        childDiagnostic = diagnostic(error)
      }
      const trusted = await settleTrustedPostmanStatus(
        () => trustedStatusReader(child, job.controller.signal), job.controller.signal)
      job.requestId = trusted.requestId ?? null
      terminal = { ...trusted, transportKind: job.transportKind, childStopReason,
        ...(childDiagnostic === undefined ? {} : { childDiagnostic }) }
    } finally {
      // A failed cleanup must not be reported as clean completion or release early.
      await run.dispose()
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
    if (disposed) return { status: 'POSTMAN_BRIDGE_UNAVAILABLE' }
    const job = {
      bridgeJobId: randomUUID(), parentSessionId: parent.id, transportKind, state: 'QUEUED',
      createdAt: new Date().toISOString(), controller: new AbortController(),
      notification: 'PENDING',
    }
    jobs.set(job.bridgeJobId, job)
    // Coordinator holds the active slot only through child disposal, never through grants.
    let admission
    try { admission = coordinator.run(job.controller.signal, () => lifecycle(job, message)) }
    catch (error) { admission = Promise.reject(error) }
    job.completion = admission.then(async result => {
        job.trustedTerminal = result
        job.requestId = result.requestId ?? job.requestId ?? null
        // Only a trusted terminal from a fully cleaned child may authorize a grant.
        if (result.status === 'POSTMAN_BRIDGE_TERMINAL') {
          try { await grants?.register(job.parentSessionId, result) }
          catch (error) { job.grantDiagnostic = diagnostic(error) }
        }
        job.state = result.status === 'POSTMAN_BRIDGE_TERMINAL' ? 'TERMINAL' : 'FAILED'
      }, error => {
        job.state = 'FAILED'
        job.diagnostic = diagnostic(error)
      })
      .then(() => {
        job.finishedAt = new Date().toISOString()
        notify(job)
      })
    return { status: 'POSTMAN_BRIDGE_ACCEPTED', ...snapshot(job) }
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
    return { ...common, ...(terminal ? { terminalStatus: terminal.terminalStatus,
      trustedStatus: terminal.status, checks: terminal.checks, result: terminal.result,
      childStopReason: terminal.childStopReason, childDiagnostic: terminal.childDiagnostic,
      diagnostic: terminal.diagnostic } : { diagnostic: job.diagnostic }),
      status: job.state === 'TERMINAL' ? 'POSTMAN_BRIDGE_TERMINAL' : 'POSTMAN_BRIDGE_FAILED',
      notification: job.notification,
      ...(job.grantDiagnostic ? { grantDiagnostic: job.grantDiagnostic } : {}) }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    for (const job of jobs.values()) job.controller.abort()
    coordinator.dispose()
    await Promise.allSettled([...jobs.values()].map(job => job.completion))
    jobs.clear()
  }

  return { accept, status, dispose }
}
