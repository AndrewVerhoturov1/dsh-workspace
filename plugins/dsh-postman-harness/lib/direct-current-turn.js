import { createHash, randomInt as cryptoRandomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'

const REQ_PATTERN = /^REQ_\d{8}T\d{6}Z_\d{4}$/
const TERMINAL_OK = new Set([
  'RESULT_DURABLE',
  'ASSISTANT_COMPLETED_NO_ARTIFACT',
  'ARTIFACT_REJECTED',
])
const MAX_CAPTURE_CHARS = 1024 * 1024
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024
const STATUS_WAIT_MS = 480_000

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function requiredAgent(exec, name) {
  const agent = exec?.agent
  if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') {
    throw new Error(`${name} requires a calling Harness agent`)
  }
  return agent
}

function workspaceOf(agent) {
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('POSTMAN_CURRENT_TURN_WORKSPACE_UNAVAILABLE')
  }
  return cwd
}

function exactUserText(event) {
  if (event?.type !== 'user/message') return null
  const data = event.data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const source = data.source
  if (source === null || typeof source !== 'object' || source.kind !== 'user') return null
  if (!Array.isArray(data.content)) {
    return { error: 'POSTMAN_CURRENT_TURN_UNSUPPORTED_CONTENT' }
  }
  const textBlocks = []
  let unsupported = false
  for (const block of data.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push(block.text)
    } else {
      unsupported = true
    }
  }
  if (unsupported || textBlocks.length !== 1) {
    return { error: 'POSTMAN_CURRENT_TURN_UNSUPPORTED_CONTENT' }
  }
  const text = textBlocks[0]
  if (text.length > MAX_CAPTURE_CHARS) {
    return { error: 'POSTMAN_CURRENT_TURN_TOO_LARGE' }
  }
  return { text }
}

export class CurrentUserTurnStore {
  constructor(ctx) {
    this.records = new Map()
    this.disposeEvent = typeof ctx?.on === 'function'
      ? ctx.on('session/event', (session, event) => this.capture(session, event))
      : undefined
  }

  capture(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const exact = exactUserText(event)
    if (exact === null) return
    const seq = Number.isSafeInteger(event?.seq) ? event.seq : -1
    if (exact.error !== undefined) {
      this.records.set(sessionId, Object.freeze({ seq, error: exact.error, consumed: false }))
      return
    }
    this.records.set(sessionId, Object.freeze({
      seq,
      text: exact.text,
      length: exact.text.length,
      sha256: sha256(exact.text),
      consumed: false,
    }))
  }

  get(sessionId) {
    return this.records.get(sessionId)
  }

  consume(sessionId, seq) {
    const current = this.records.get(sessionId)
    if (current === undefined || current.seq !== seq || current.consumed) return false
    this.records.set(sessionId, Object.freeze({ ...current, consumed: true }))
    return true
  }

  release(sessionId, seq) {
    const current = this.records.get(sessionId)
    if (current === undefined || current.seq !== seq || !current.consumed) return false
    this.records.set(sessionId, Object.freeze({ ...current, consumed: false }))
    return true
  }

  dispose() {
    this.disposeEvent?.()
    this.records.clear()
  }
}

function parseError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function parsePostmanUserTurn(raw) {
  if (typeof raw !== 'string') throw parseError('POSTMAN_CURRENT_TURN_UNAVAILABLE')

  // Initial whitespace is transport framing, then exact @Postman and at most
  // one immediately-following separator character. Everything after that is
  // preserved byte-for-byte at the JS-string/UTF-8 boundary.
  const trigger = /^(\s*)@Postman(?:(\s)|$)/u.exec(raw)
  if (trigger === null) throw parseError('POSTMAN_TRIGGER_PARSE_FAILED')

  const afterTrigger = raw.slice(trigger[0].length)
  if (trigger[2] === undefined && afterTrigger === '') {
    throw parseError('POSTMAN_EMPTY_PAYLOAD')
  }

  // If the semantic payload begins with the reserved --chat token, malformed
  // syntax fails closed instead of silently turning it into a fresh request.
  if (/^--chat(?:\s|$)/u.test(afterTrigger)) {
    const chat = /^--chat[ \t]+(REQ_\d{8}T\d{6}Z_\d{4})(?:(\s)|$)/u.exec(afterTrigger)
    if (chat === null || !REQ_PATTERN.test(chat[1])) {
      throw parseError('POSTMAN_CHAT_TRIGGER_PARSE_FAILED')
    }
    const payload = afterTrigger.slice(chat[0].length)
    if (chat[2] === undefined || payload.trim() === '') {
      throw parseError('POSTMAN_EMPTY_PAYLOAD')
    }
    const removedTransportPrefix = raw.slice(0, trigger[0].length) + afterTrigger.slice(0, chat[0].length)
    if (raw !== removedTransportPrefix + payload) {
      throw parseError('POSTMAN_PAYLOAD_MISMATCH')
    }
    return {
      mode: 'chat',
      chatRequestId: chat[1],
      payload,
      removedTransportPrefix,
    }
  }

  const payload = afterTrigger
  if (payload.trim() === '') throw parseError('POSTMAN_EMPTY_PAYLOAD')
  const removedTransportPrefix = raw.slice(0, trigger[0].length)
  if (raw !== removedTransportPrefix + payload) {
    throw parseError('POSTMAN_PAYLOAD_MISMATCH')
  }
  return { mode: 'fresh', chatRequestId: undefined, payload, removedTransportPrefix }
}

export function makeRequestId(now = () => new Date(), randomInt = cryptoRandomInt) {
  const date = now()
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const suffix = String(randomInt(0, 10_000)).padStart(4, '0')
  return `REQ_${stamp}_${suffix}`
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString('utf8')
  return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(-MAX_OUTPUT_CHARS)
}

function parseTerminalJson(stdout) {
  const trimmed = stdout.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim()
      if (!line.startsWith('{') || !line.endsWith('}')) continue
      try {
        return JSON.parse(line)
      } catch {
        // Continue looking for the last valid JSON line.
      }
    }
    return undefined
  }
}

function terminalGate(job) {
  const parsed = parseTerminalJson(job.stdout)
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'POSTMAN_RESULT_JSON_INVALID',
      requestId: job.requestId,
      transportMessage: 'Direct Postman completed without a valid terminal JSON object.',
    }
  }
  if (parsed.requestId !== job.requestId) {
    return {
      ok: false,
      code: 'POSTMAN_RESULT_CORRELATION_FAILED',
      requestId: job.requestId,
      transportMessage: 'Direct Postman terminal requestId does not match the started request.',
    }
  }

  if (job.exitCode === 0) {
    if (parsed.ok !== true || !TERMINAL_OK.has(parsed.code) || parsed.state !== parsed.code) {
      return {
        ok: false,
        code: 'POSTMAN_RESULT_GATE_FAILED',
        requestId: job.requestId,
        transportMessage: 'Direct Postman returned an invalid success terminal object.',
      }
    }
    if (parsed.code === 'RESULT_DURABLE' && (typeof parsed.resultZip !== 'string' || parsed.resultZip === '')) {
      return {
        ok: false,
        code: 'POSTMAN_DURABLE_RESULT_ZIP_MISSING',
        requestId: job.requestId,
        transportMessage: 'RESULT_DURABLE did not contain resultZip.',
      }
    }
    return parsed
  }

  if (
    parsed.ok === false
    && parsed.code === 'POSTMAN_TRANSPORT_FAILED'
    && typeof parsed.transportCode === 'string' && parsed.transportCode !== ''
    && typeof parsed.transportMessage === 'string' && parsed.transportMessage !== ''
    && parsed.details !== null && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
  ) {
    return parsed
  }

  return {
    ok: false,
    code: 'POSTMAN_BACKGROUND_JOB_FAILED',
    requestId: job.requestId,
    transportMessage: `Direct Postman exited with code ${String(job.exitCode)} without a correlated transport failure receipt.`,
  }
}

function continuationPayload(result) {
  if (result?.code === 'ASSISTANT_COMPLETED_NO_ARTIFACT') {
    return 'Продолжи выполнение предыдущей задачи с того места, где остановился. Не начинай заново. Доведи исходную задачу до полного результата и выдай итоговый ZIP.'
  }
  if (result?.code === 'ARTIFACT_REJECTED') {
    const code = typeof result.validationCode === 'string' ? result.validationCode : 'UNKNOWN_VALIDATION_CODE'
    const message = typeof result.validationMessage === 'string' ? result.validationMessage : 'ZIP был отклонён transport validator.'
    return `Продолжи выполнение предыдущей задачи с того места, где остановился. Не начинай заново. Транспорт отклонил итоговый ZIP: ${code}: ${message}. Пересобери итоговый ZIP с исправлением этой transport-проблемы и доведи исходную задачу до полного результата.`
  }
  throw parseError('POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED')
}

export class DirectPostmanJobManager {
  constructor({
    spawn = nodeSpawn,
    exists = existsSync,
    now = () => new Date(),
    randomInt = cryptoRandomInt,
    pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh',
  } = {}) {
    this.spawn = spawn
    this.exists = exists
    this.now = now
    this.randomInt = randomInt
    this.pwsh = pwsh
    this.jobs = new Map()
  }

  latest(sessionId) {
    return this.jobs.get(sessionId)
  }

  async start({ sessionId, workspace, payload, chatRequestId, automaticContinuation = false, proof }) {
    const previous = this.jobs.get(sessionId)
    if (previous?.state === 'running') throw parseError('POSTMAN_CURRENT_TURN_JOB_ALREADY_RUNNING')
    if (typeof payload !== 'string' || payload.trim() === '') throw parseError('POSTMAN_EMPTY_PAYLOAD')

    const bridge = join(workspace, 'postman', 'direct', 'postman.ps1')
    if (!this.exists(bridge)) throw parseError('POSTMAN_DIRECT_BRIDGE_MISSING')

    const requestId = makeRequestId(this.now, this.randomInt)
    const jobId = `DIRECT_${requestId}`
    const taskBase64 = Buffer.from(payload, 'utf8').toString('base64')
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', bridge,
      '-RequestId', requestId,
      '-TaskBase64', taskBase64,
    ]
    if (chatRequestId !== undefined) args.push('-ChatRequestId', chatRequestId)
    if (automaticContinuation) args.push('-AutomaticContinuation')

    const job = {
      sessionId,
      requestId,
      jobId,
      state: 'starting',
      stdout: '',
      stderr: '',
      exitCode: undefined,
      signal: undefined,
      startedAt: new Date().toISOString(),
      chatRequestId,
      automaticContinuation,
      proof,
      waiters: new Set(),
    }
    this.jobs.set(sessionId, job)

    let child
    try {
      child = this.spawn(this.pwsh, args, {
        cwd: workspace,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.jobs.delete(sessionId)
      const wrapped = parseError('POSTMAN_INVOCATION_NOT_STARTED')
      wrapped.cause = error
      throw wrapped
    }

    job.child = child
    child.stdout?.on('data', (chunk) => { job.stdout = appendBounded(job.stdout, chunk) })
    child.stderr?.on('data', (chunk) => { job.stderr = appendBounded(job.stderr, chunk) })

    const onClose = (code, signal) => {
      job.exitCode = typeof code === 'number' ? code : -1
      job.signal = signal ?? undefined
      job.state = 'completed'
      job.result = terminalGate(job)
      job.finishedAt = new Date().toISOString()
      this.finish(job)
    }
    child.on('close', onClose)

    const started = await new Promise((resolve, reject) => {
      const onSpawn = () => {
        job.state = 'running'
        cleanup()
        resolve(true)
      }
      const onError = (error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        child.off?.('spawn', onSpawn)
        child.off?.('error', onError)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    }).catch((error) => {
      child.off?.('close', onClose)
      this.jobs.delete(sessionId)
      const wrapped = parseError('POSTMAN_INVOCATION_NOT_STARTED')
      wrapped.cause = error
      throw wrapped
    })

    if (started !== true) throw parseError('POSTMAN_INVOCATION_NOT_STARTED')

    child.on('error', (error) => {
      if (job.state === 'completed') return
      job.state = 'failed'
      job.spawnError = String(error?.message ?? error)
      this.finish(job)
    })

    return {
      status: 'STARTED',
      requestId,
      jobId,
      parseMode: proof?.parseMode,
      chatRequestId: chatRequestId ?? null,
      sourceMessageLength: proof?.sourceMessageLength,
      sourceMessageSha256: proof?.sourceMessageSha256,
      payloadLength: proof?.payloadLength,
      payloadSha256: proof?.payloadSha256,
      removedTransportPrefixLength: proof?.removedTransportPrefixLength,
      removedTransportPrefixSha256: proof?.removedTransportPrefixSha256,
    }
  }

  finish(job) {
    for (const wake of job.waiters) wake()
    job.waiters.clear()
  }

  view(sessionId) {
    const job = this.jobs.get(sessionId)
    if (job === undefined) return { status: 'NO_JOB' }
    if (job.state === 'starting' || job.state === 'running') {
      return { status: 'RUNNING', requestId: job.requestId, jobId: job.jobId }
    }
    if (job.state === 'failed') {
      return {
        status: 'FAILED',
        requestId: job.requestId,
        jobId: job.jobId,
        result: {
          ok: false,
          code: 'POSTMAN_BACKGROUND_JOB_FAILED',
          requestId: job.requestId,
          transportMessage: job.spawnError ?? 'Direct Postman child process failed.',
        },
      }
    }
    return {
      status: 'COMPLETED',
      requestId: job.requestId,
      jobId: job.jobId,
      exitCode: job.exitCode,
      result: job.result,
    }
  }

  async wait(sessionId, timeoutMs = STATUS_WAIT_MS) {
    const current = this.view(sessionId)
    if (current.status !== 'RUNNING') return current
    const job = this.jobs.get(sessionId)
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        job.waiters.delete(wake)
        resolve()
      }, timeoutMs)
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      job.waiters.add(wake)
    })
    return this.view(sessionId)
  }

  async continueLast(sessionId, workspace) {
    const previous = this.jobs.get(sessionId)
    if (previous === undefined || previous.state !== 'completed' || previous.result === undefined) {
      throw parseError('POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED')
    }
    const payload = continuationPayload(previous.result)
    return this.start({
      sessionId,
      workspace,
      payload,
      chatRequestId: previous.requestId,
      automaticContinuation: true,
      proof: {
        parseMode: 'automatic-continuation',
        sourceMessageLength: 0,
        sourceMessageSha256: null,
        payloadLength: payload.length,
        payloadSha256: sha256(payload),
        removedTransportPrefixLength: 0,
        removedTransportPrefixSha256: null,
      },
    })
  }

  dispose() {
    // Deliberately do not kill a running Direct Postman child during plugin
    // teardown. Killing it could leave browser-send outcome ambiguous. The
    // process owns its own transport deadline and durable Direct state.
  }
}

function toolOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: { status: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

export function createDirectCurrentTurnToolConfigs(ctx, { store, jobs } = {}) {
  const turnStore = store ?? new CurrentUserTurnStore(ctx)
  const manager = jobs ?? new DirectPostmanJobManager()

  const sendCurrent = {
    name: 'postman_send_current_turn',
    description: 'Production @Postman orchestration. Takes NO task/prompt argument. Reads the exact current user/message captured by trusted Harness runtime, strips only transport syntax, and starts the existing Direct Postman bridge.',
    parameters: {},
    output: toolOutput(),
    async execute(_args, exec) {
      const agent = requiredAgent(exec, 'postman_send_current_turn')
      const record = turnStore.get(agent.id)
      if (record === undefined) throw parseError('POSTMAN_CURRENT_TURN_UNAVAILABLE')
      if (record.consumed) throw parseError('POSTMAN_CURRENT_TURN_ALREADY_USED')
      if (record.error !== undefined) throw parseError(record.error)
      const parsed = parsePostmanUserTurn(record.text)
      const proof = {
        parseMode: parsed.mode,
        sourceMessageLength: record.length,
        sourceMessageSha256: record.sha256,
        payloadLength: parsed.payload.length,
        payloadSha256: sha256(parsed.payload),
        removedTransportPrefixLength: parsed.removedTransportPrefix.length,
        removedTransportPrefixSha256: sha256(parsed.removedTransportPrefix),
      }
      if (!turnStore.consume(agent.id, record.seq)) {
        throw parseError('POSTMAN_CURRENT_TURN_CHANGED_DURING_START')
      }
      try {
        return await manager.start({
          sessionId: agent.id,
          workspace: workspaceOf(agent),
          payload: parsed.payload,
          chatRequestId: parsed.chatRequestId,
          proof,
        })
      } catch (error) {
        turnStore.release(agent.id, record.seq)
        throw error
      }
    },
  }

  const statusCurrent = {
    name: 'postman_current_turn_status',
    description: 'Wait briefly for the current session Direct Postman background job and return its correlated terminal result. Takes no arguments and never starts a second request.',
    parameters: {},
    output: toolOutput(),
    async execute(_args, exec) {
      const agent = requiredAgent(exec, 'postman_current_turn_status')
      return manager.wait(agent.id)
    },
  }

  const continueLast = {
    name: 'postman_continue_last_request',
    description: 'Start the deterministic automatic continuation for the last non-durable Postman terminal result in this session. Takes no user text and is allowed only after ASSISTANT_COMPLETED_NO_ARTIFACT or ARTIFACT_REJECTED.',
    parameters: {},
    output: toolOutput(),
    async execute(_args, exec) {
      const agent = requiredAgent(exec, 'postman_continue_last_request')
      return manager.continueLast(agent.id, workspaceOf(agent))
    },
  }

  return {
    tools: [sendCurrent, statusCurrent, continueLast],
    store: turnStore,
    jobs: manager,
    dispose() {
      turnStore.dispose()
      manager.dispose()
    },
  }
}

export const DIRECT_CURRENT_TURN_TOOL_NAMES = Object.freeze([
  'postman_send_current_turn',
  'postman_current_turn_status',
  'postman_continue_last_request',
])
