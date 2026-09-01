import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { POSTMAN_RESULT_ROOT } from './runtime.js'

export const WEB_WORKER_STATES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  WEB_STARTING: 'WEB_STARTING',
  PROMPT_SENT: 'PROMPT_SENT',
  WAITING_ASSISTANT: 'WAITING_ASSISTANT',
  ARTIFACT_FOUND: 'ARTIFACT_FOUND',
  RESULT_DURABLE: 'RESULT_DURABLE',
})

export const WEB_WORKER_RESULT_INVALID = 'WEB_WORKER_RESULT_INVALID'
export const WEB_WORKER_NOT_CONFIGURED = 'WEB_WORKER_NOT_CONFIGURED'

const SHA256 = /^[0-9a-f]{64}$/
const MAX_HANDLE_CHARS = 8192

function requestResultPath(requestId) {
  return join(POSTMAN_RESULT_ROOT, requestId)
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`)
  return value
}

function assertTaskUrl(value) {
  const text = requiredString(value, 'taskUrl')
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('taskUrl must be an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('taskUrl must be an absolute HTTP(S) URL')
  }
  return text
}

function compactDurableHandle(requestId, durableResult) {
  if (!durableResult || durableResult.ok !== true || durableResult.code !== WEB_WORKER_STATES.RESULT_DURABLE) {
    throw new Error('durableResult must be a successful RESULT_DURABLE proof')
  }
  const details = durableResult.details
  if (!details || typeof details !== 'object' || details.requestId !== requestId) {
    throw new Error('durableResult requestId mismatch')
  }

  const resultPath = requiredString(details.resultDirectory ?? details.resultPath, 'resultDirectory')
  const resultZip = requiredString(details.resultZip, 'resultZip')
  const sha256 = requiredString(details.sha256 ?? details.resultSha256, 'sha256').toLowerCase()
  if (!SHA256.test(sha256)) throw new Error('sha256 must be a lowercase SHA-256 value')
  for (const field of ['manifest', 'validation', 'metadata']) requiredString(details[field], field)

  const handle = JSON.stringify({
    protocolVersion: 1,
    requestId,
    state: WEB_WORKER_STATES.RESULT_DURABLE,
    resultPath,
    resultZip,
    manifest: details.manifest,
    validation: details.validation,
    metadata: details.metadata,
    sha256,
  })
  if (handle.length > MAX_HANDLE_CHARS) throw new Error('durable result handle is too large')
  return handle
}

/**
 * Bridge one already-registered Runtime request to an injected Web pipeline.
 * The runner is deliberately an adapter: browser ownership and all WP-003 to
 * WP-007 rules stay in the existing worker implementation.
 */
export class WebWorkerBridge {
  constructor({ runtime, run, now = Date.now } = {}) {
    if (!runtime) throw new Error('runtime is required')
    this.runtime = runtime
    this.run = run
    this.now = now
    this.jobs = new Map()
  }

  accept({ requestId, taskUrl }) {
    const request = this.runtime.getRequest(requestId)
    if (request === undefined) return { status: 'UNKNOWN_REQUEST', requestId }
    if (!['ACCEPTED', 'WAITING'].includes(request.status)) {
      return { status: request.status, requestId, resultPath: request.result_path }
    }
    const existing = this.jobs.get(requestId)
    if (existing !== undefined) return { ...existing, duplicate: true }

    const job = {
      requestId,
      taskUrl: assertTaskUrl(taskUrl),
      workerJobId: `WEB_${requestId}`,
      state: WEB_WORKER_STATES.ACCEPTED,
      resultPath: request.result_path ?? requestResultPath(requestId),
      acceptedAt: new Date(this.now()).toISOString(),
    }
    this.jobs.set(requestId, job)
    this.runtime.journal('WEB_WORKER_ACCEPTED', {
      requestId,
      workerJobId: job.workerJobId,
      status: WEB_WORKER_STATES.ACCEPTED,
      resultPath: job.resultPath,
    })

    if (typeof this.run !== 'function') {
      return { status: WEB_WORKER_NOT_CONFIGURED, ...job }
    }
    const started = { ...job, state: WEB_WORKER_STATES.WEB_STARTING }
    this.jobs.set(requestId, started)
    this.runtime.journal('WEB_WORKER_STARTED', {
      requestId,
      workerJobId: started.workerJobId,
      status: started.state,
    })
    return Promise.resolve(this.run({ request, ...started }))
      .then((durableResult) => markWebResultReady(this.runtime, {
        requestId,
        durableResult,
      }))
      .catch((error) => {
        this.runtime.journal('WEB_WORKER_FAILED', {
          requestId,
          workerJobId: started.workerJobId,
          status: started.state,
          error: String(error?.message ?? error),
        })
        return { status: WEB_WORKER_RESULT_INVALID, requestId, error: String(error?.message ?? error) }
      })
  }
}

/** Publish only a verified WP-007 RESULT_DURABLE proof into Runtime READY. */
export function markWebResultReady(runtime, { requestId, durableResult, result, deliveryKey, wake = true } = {}) {
  requiredString(requestId, 'requestId')
  const proof = durableResult ?? result
  const handle = compactDurableHandle(requestId, proof)
  const ready = runtime.markReady({ requestId, result: handle, deliveryKey, wake })
  if (ready?.status === 'READY') {
    runtime.journal('WEB_RESULT_DURABLE', {
      requestId,
      deliveryKey: ready.deliveryKey,
      status: WEB_WORKER_STATES.RESULT_DURABLE,
      resultPath: proof.details.resultDirectory ?? proof.details.resultPath,
      resultSha256: proof.details.sha256 ?? proof.details.resultSha256,
    })
  }
  return ready
}

export function durableResultSha256(durableResult) {
  const details = durableResult?.details
  const sha = details?.sha256 ?? details?.resultSha256
  if (typeof sha === 'string' && SHA256.test(sha)) return sha.toLowerCase()
  return createHash('sha256').update(JSON.stringify(durableResult ?? null), 'utf8').digest('hex')
}

export { compactDurableHandle, requestResultPath }
