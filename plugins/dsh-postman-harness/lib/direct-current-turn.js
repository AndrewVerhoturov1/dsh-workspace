import { createHash, randomInt as cryptoRandomInt } from 'node:crypto'
import { existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { postmanTaskContexts, POSTMAN_TASK_BRANCH_PATTERN } from './postman-task-context.js'
import { CurrentAttachmentStore, postmanInputGrants, stageStandaloneCurrentAttachments } from './postman-input-files.js'

// Standalone transport publishes REQ task files to main; Leader children use their exact prepared task branch.
const STANDALONE_TASK_PUBLICATION_BRANCH = 'main'

const REQ_PATTERN = /^REQ_\d{8}T\d{6}Z_\d{4}$/
const ARTIFACT_TERMINAL_OK = new Set([
  'RESULT_DURABLE',
  'ASSISTANT_COMPLETED_NO_ARTIFACT',
  'ARTIFACT_REJECTED',
])
const TEXT_TERMINAL_OK = new Set(['TEXT_RESULT_DURABLE'])
const IMAGE_TERMINAL_OK = new Set(['IMAGE_RESULT_DURABLE'])
const IMAGE_FORMATS = Object.freeze({ png: ['.png'], jpg: ['.jpg', '.jpeg'], webp: ['.webp'] })
const MAX_CAPTURE_CHARS = 1024 * 1024
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024
const STATUS_WAIT_MS = 480_000

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
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
  let unsupported = false, attachmentCount = 0
  for (const block of data.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      textBlocks.push(block.text)
    } else if (block && typeof block === 'object' && typeof block.type === 'string' && block.type !== 'text') {
      attachmentCount++
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
  return { text, attachmentCount }
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
      session,
      attachmentCount: exact.attachmentCount,
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

function extractInputMetadata(payload) {
  // Only a model-authored delegation may opt in; ordinary user text is unchanged.
  if (!payload.startsWith('--input-files-json ')) return { payload, inputFiles: [] }
  const newline = payload.indexOf('\n')
  if (newline < 0) throw parseError('POSTMAN_INPUT_METADATA_INVALID')
  let inputFiles
  try { inputFiles = JSON.parse(payload.slice('--input-files-json '.length, newline)) }
  catch { throw parseError('POSTMAN_INPUT_METADATA_INVALID') }
  if (!Array.isArray(inputFiles) || !inputFiles.length || inputFiles.length > 20 ||
      inputFiles.some(file => !file || typeof file !== 'object' || Array.isArray(file) ||
        !Object.keys(file).every(key => ['source_kind', 'media_type', 'name', 'repository', 'commit', 'path', 'sha256', 'byte_length', 'raw_url'].includes(key)) ||
        typeof file.name !== 'string' || !file.name.trim() || !/^[0-9a-fA-F]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.byte_length) || file.byte_length <= 0 ||
        (file.source_kind === 'native'
          ? ['repository', 'commit', 'path', 'raw_url'].some(key => key in file)
          : (file.source_kind !== undefined && file.source_kind !== 'github') || typeof file.repository !== 'string' ||
            !/^[0-9a-fA-F]{40}$/.test(file.commit) || typeof file.path !== 'string' || !file.path)))
    throw parseError('POSTMAN_INPUT_METADATA_INVALID')
  const intent = payload.slice(newline + 1)
  if (!intent.trim()) throw parseError('POSTMAN_EMPTY_PAYLOAD')
  return { payload: intent, inputFiles }
}

export function parsePostmanUserTurn(raw) {
  if (typeof raw !== 'string') throw parseError('POSTMAN_CURRENT_TURN_UNAVAILABLE')

  // Initial whitespace is transport framing, then one exact production marker
  // and at most one immediately-following separator character. Everything
  // after that is preserved byte-for-byte at the JS-string/UTF-8 boundary.
  const trigger = /^(\s*)@(PostmanImage|PostmanAsk|Postman)(?:(\s)|$)/u.exec(raw)
  if (trigger === null) throw parseError('POSTMAN_TRIGGER_PARSE_FAILED')
  const transportKind = trigger[2] === 'PostmanAsk' ? 'text' : trigger[2] === 'PostmanImage' ? 'image' : 'artifact'

  const afterTrigger = raw.slice(trigger[0].length)
  if (trigger[3] === undefined && afterTrigger === '') {
    throw parseError('POSTMAN_EMPTY_PAYLOAD')
  }

  // If the semantic payload begins with the reserved --chat token, malformed
  // syntax fails closed instead of silently turning it into a fresh request.
  if (/^--chat(?:\s|$)/u.test(afterTrigger)) {
    const chat = /^--chat[ \t]+(REQ_\d{8}T\d{6}Z_\d{4})(?:(\s)|$)/u.exec(afterTrigger)
    if (chat === null || !REQ_PATTERN.test(chat[1])) {
      throw parseError('POSTMAN_CHAT_TRIGGER_PARSE_FAILED')
    }
    const framedPayload = afterTrigger.slice(chat[0].length)
    const { payload, inputFiles } = extractInputMetadata(framedPayload)
    if (chat[2] === undefined || payload.trim() === '') {
      throw parseError('POSTMAN_EMPTY_PAYLOAD')
    }
    const removedTransportPrefix = raw.slice(0, trigger[0].length) + afterTrigger.slice(0, chat[0].length)
    if (raw !== removedTransportPrefix + framedPayload) {
      throw parseError('POSTMAN_PAYLOAD_MISMATCH')
    }
    return {
      mode: 'chat',
      transportKind,
      chatRequestId: chat[1],
      payload,
      ...(inputFiles.length ? { inputFiles } : {}),
      removedTransportPrefix,
    }
  }

  const { payload, inputFiles } = extractInputMetadata(afterTrigger)
  if (payload.trim() === '') throw parseError('POSTMAN_EMPTY_PAYLOAD')
  const removedTransportPrefix = raw.slice(0, trigger[0].length)
  if (raw !== removedTransportPrefix + afterTrigger) {
    throw parseError('POSTMAN_PAYLOAD_MISMATCH')
  }
  return { mode: 'fresh', transportKind, chatRequestId: undefined, payload, ...(inputFiles.length ? { inputFiles } : {}), removedTransportPrefix }
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

function validPublicationReceipt(value, job) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { requestId, repository, branch, taskUrl, baseCommit, taskPublicationCommit } = value
  if (requestId !== job.requestId || repository !== 'AndrewVerhoturov1/dsh-workspace' ||
      branch !== job.branch || (branch !== STANDALONE_TASK_PUBLICATION_BRANCH && !POSTMAN_TASK_BRANCH_PATTERN.test(branch ?? '')) ||
      !/^[0-9a-f]{40}$/.test(baseCommit ?? '') || !/^[0-9a-f]{40}$/.test(taskPublicationCommit ?? '')) return false
  return taskUrl === 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + taskPublicationCommit + '/' + requestId + '.md'
}

function trustedPublication(job) {
  const root = job.directRoot ?? (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'DSH', 'Postman', 'direct')
    : join(homedir(), '.dsh', 'postman', 'direct'))
  let state
  try { state = JSON.parse(job.readPublicationState(join(root, 'requests', job.requestId + '.json'), 'utf8')) }
  catch { return null }
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !new Set(['FAILED', 'ASK_FAILED', 'TASK_PUBLISHED', 'ASK_TASK_PUBLISHED',
        'BROWSER_READY', 'ASK_BROWSER_READY', 'WEB_RUNNING', 'ASK_WEB_RUNNING']).has(state.state)) return null
  const receipt = { requestId: state.requestId, repository: state.repository, branch: state.branch,
    taskUrl: state.taskUrl, baseCommit: state.baseCommit, taskPublicationCommit: state.taskPublicationCommit }
  return validPublicationReceipt(receipt, job) ? receipt : null
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

  if (job.transportKind === "artifact" && parsed.ok === false
      && ["ARTIFACT_CANDIDATE_SAVED", "ARTIFACT_CANDIDATE_CHOICES", "ARTIFACT_REJECTED", "POSTMAN_TRANSPORT_FAILED"].includes(parsed.code)) {
    const checkpoint = trustedPublication(job)
    const manager = new DirectPostmanJobManager({ directRoot: job.directRoot, readPublicationState: job.readPublicationState })
    const observed = manager.observeArtifactCandidate(job.requestId)
    if (observed || Array.isArray(parsed.choices) && parsed.choices.length) {
      return { ok: false, code: observed ? "ARTIFACT_CANDIDATE_SAVED" : "ARTIFACT_CANDIDATE_CHOICES",
        state: observed ? "ARTIFACT_CANDIDATE_SAVED" : "ARTIFACT_CANDIDATE_CHOICES",
        requestId: job.requestId, candidate: observed, choices: Array.isArray(parsed.choices) ? parsed.choices.slice(0, 8).map(item => ({
          label: typeof item?.label === "string" ? item.label.slice(0, 512) : "",
          path: typeof item?.path === "string" && /^[0-9]+(?:[/][0-9]+)*$/.test(item.path) ? item.path : "" })) : [],
        candidateReasons: parsed.candidateReasons ?? [], verified: false, applyEligible: false,
        unresolvedSendUnknown: parsed.unresolvedSendUnknown === true,
        publicationReceipt: checkpoint ?? undefined,
        transportCode: parsed.transportCode ?? parsed.code, transportMessage: parsed.transportMessage ?? "Unverified artifact observation.",
        details: {} }
    }
  }

  if (job.exitCode === 0) {
    const allowed = job.transportKind === 'text' ? TEXT_TERMINAL_OK : job.transportKind === 'image' ? IMAGE_TERMINAL_OK : ARTIFACT_TERMINAL_OK
    if (parsed.ok !== true || !allowed.has(parsed.code) || parsed.state !== parsed.code) {
      return {
        ok: false,
        code: 'POSTMAN_RESULT_GATE_FAILED',
        requestId: job.requestId,
        transportMessage: 'Direct Postman returned an invalid success terminal object.',
      }
    }
    if (parsed.code === 'RESULT_DURABLE' && (parsed.verified === false || parsed.applyEligible === false || parsed.unresolvedSendUnknown === true || typeof parsed.resultZip !== 'string' || parsed.resultZip === '')) {
      return {
        ok: false,
        code: 'POSTMAN_DURABLE_RESULT_ZIP_MISSING',
        requestId: job.requestId,
        transportMessage: 'RESULT_DURABLE did not contain resultZip.',
      }
    }
    if (parsed.code === 'IMAGE_RESULT_DURABLE') {
      const format = parsed.imageFormat
      const imagePath = parsed.resultImage
      if (parsed.resultZip !== undefined || typeof imagePath !== 'string' || !isAbsolute(imagePath) ||
          !Object.hasOwn(IMAGE_FORMATS, format) ||
          !IMAGE_FORMATS[format].includes(basename(imagePath).slice(basename(imagePath).lastIndexOf('.')).toLowerCase()) ||
          !/^[0-9a-f]{64}$/.test(parsed.imageSha256 ?? '') ||
          !Number.isSafeInteger(parsed.imageByteLength) || parsed.imageByteLength < 1) {
        return { ok: false, code: 'POSTMAN_IMAGE_RESULT_DESCRIPTOR_INVALID', requestId: job.requestId,
          transportMessage: 'Image result descriptor is incomplete or invalid.' }
      }
      let bytes
      try { bytes = readFileSync(imagePath) }
      catch { return { ok: false, code: 'POSTMAN_IMAGE_RESULT_UNREADABLE', requestId: job.requestId,
        transportMessage: 'Image result could not be read.' } }
      if (bytes.length !== parsed.imageByteLength || sha256Bytes(bytes) !== parsed.imageSha256) {
        return { ok: false, code: 'POSTMAN_IMAGE_RESULT_SHA_MISMATCH', requestId: job.requestId,
          transportMessage: 'Image result bytes do not match its durable descriptor.' }
      }
    }
    if (parsed.code === 'TEXT_RESULT_DURABLE') {
      const deliveryMode = parsed.deliveryMode ?? 'inline'
      parsed.deliveryMode = deliveryMode
      if (deliveryMode === 'inline') {
        if (typeof parsed.assistantText !== 'string' || parsed.assistantText.trim() === '') {
          return {
            ok: false,
            code: 'POSTMAN_TEXT_RESULT_MISSING',
            requestId: job.requestId,
            transportMessage: 'Inline TEXT_RESULT_DURABLE did not contain assistantText.',
          }
        }
        if (typeof parsed.assistantTextSha256 !== 'string' || parsed.assistantTextSha256 !== sha256(parsed.assistantText)) {
          return {
            ok: false,
            code: 'POSTMAN_TEXT_RESULT_SHA_MISMATCH',
            requestId: job.requestId,
            transportMessage: 'Inline TEXT_RESULT_DURABLE assistantText SHA-256 is invalid.',
          }
        }
        if (parsed.resultFile !== undefined) {
          return {
            ok: false,
            code: 'POSTMAN_TEXT_RESULT_INLINE_FILE_UNEXPECTED',
            requestId: job.requestId,
            transportMessage: 'Inline TEXT_RESULT_DURABLE must not include resultFile.',
          }
        }
      } else if (deliveryMode === 'file') {
        const expectedName = `POSTMAN_${job.requestId}_ANSWER.md`
        if (parsed.assistantText !== undefined) {
          return {
            ok: false,
            code: 'POSTMAN_TEXT_RESULT_FILE_CONTAINS_INLINE_TEXT',
            requestId: job.requestId,
            transportMessage: 'File TEXT_RESULT_DURABLE must not expose assistantText to Luna.',
          }
        }
        if (
          typeof parsed.resultFile !== 'string' || parsed.resultFile === '' || !isAbsolute(parsed.resultFile)
          || parsed.resultFileName !== expectedName || basename(parsed.resultFile) !== expectedName
          || parsed.resultMimeType !== 'text/markdown' || parsed.resultEncoding !== 'utf-8'
          || !Number.isInteger(parsed.assistantTextLength) || parsed.assistantTextLength < 1
          || !Number.isInteger(parsed.assistantTextByteLength) || parsed.assistantTextByteLength < 1
          || typeof parsed.assistantTextSha256 !== 'string' || parsed.assistantTextSha256 === ''
          || parsed.resultFileSha256 !== parsed.assistantTextSha256
        ) {
          return {
            ok: false,
            code: 'POSTMAN_TEXT_RESULT_FILE_DESCRIPTOR_INVALID',
            requestId: job.requestId,
            transportMessage: 'File TEXT_RESULT_DURABLE descriptor is incomplete or invalid.',
          }
        }
        let bytes
        try {
          bytes = readFileSync(parsed.resultFile)
        } catch (error) {
          return {
            ok: false,
            code: 'POSTMAN_TEXT_RESULT_FILE_UNREADABLE',
            requestId: job.requestId,
            transportMessage: `PostmanAsk Markdown result could not be read: ${String(error?.message ?? error)}`,
          }
        }
        if (bytes.length !== parsed.assistantTextByteLength || sha256Bytes(bytes) !== parsed.assistantTextSha256) {
          return {
            ok: false,
            code: 'POSTMAN_TEXT_RESULT_FILE_SHA_MISMATCH',
            requestId: job.requestId,
            transportMessage: 'PostmanAsk Markdown result bytes do not match the durable descriptor.',
          }
        }
        const decoded = bytes.toString('utf8')
        if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
          return {
            ok: false,
            code: 'POSTMAN_TEXT_RESULT_FILE_UTF8_INVALID',
            requestId: job.requestId,
            transportMessage: 'PostmanAsk Markdown result is not exact valid UTF-8.',
          }
        }
      } else {
        return {
          ok: false,
          code: 'POSTMAN_TEXT_RESULT_DELIVERY_MODE_INVALID',
          requestId: job.requestId,
          transportMessage: 'TEXT_RESULT_DURABLE deliveryMode is invalid.',
        }
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
    const checkpoint = trustedPublication(job)
    if (parsed.publicationReceipt !== undefined &&
        (!checkpoint || !validPublicationReceipt(parsed.publicationReceipt, job) ||
          Object.keys(checkpoint).some(key => checkpoint[key] !== parsed.publicationReceipt[key]))) {
      return { ok: false, code: 'POSTMAN_PUBLICATION_RECEIPT_INVALID', requestId: job.requestId,
        transportMessage: 'Direct Postman publication receipt did not match its exact request checkpoint.' }
    }
    if (checkpoint) parsed.publicationReceipt = checkpoint
    else delete parsed.publicationReceipt
    // Only the owned Direct state, not arbitrary terminal fields, proves this fact.
    delete parsed.publicationStarted
    try {
      const root = job.directRoot ?? (process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'DSH', 'Postman', 'direct')
        : join(homedir(), '.dsh', 'postman', 'direct'))
      const state = JSON.parse(job.readPublicationState(join(root, 'requests', job.requestId + '.json'), 'utf8'))
      if (!checkpoint && state.requestId === job.requestId && state.branch === job.branch &&
          state.repository === 'AndrewVerhoturov1/dsh-workspace' && state.publicationStarted === false &&
          !state.taskPublicationCommit && !state.taskUrl) parsed.publicationStarted = false
    } catch { /* Absent or ambiguous state remains synchronization-required. */ }
    return parsed
  }

  return {
    ok: false,
    code: 'POSTMAN_BACKGROUND_JOB_FAILED',
    requestId: job.requestId,
    transportMessage: `Direct Postman exited with code ${String(job.exitCode)} without a correlated transport failure receipt.`,
  }
}

export class DirectPostmanJobManager {
  constructor({
    spawn = nodeSpawn,
    exists = existsSync,
    now = () => new Date(),
    randomInt = cryptoRandomInt,
    pwsh = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh',
    directRoot,
    readPublicationState = readFileSync,
    inputGrants = postmanInputGrants,
  } = {}) {
    this.spawn = spawn
    this.exists = exists
    this.now = now
    this.randomInt = randomInt
    this.pwsh = pwsh
    this.directRoot = directRoot
    this.readPublicationState = readPublicationState
    this.inputGrants = inputGrants
    this.jobs = new Map()
    this.exactAskReplies = new Map()
    this.disposed = false
  }

  latest(sessionId) {
    return this.jobs.get(sessionId)
  }

  async start({ sessionId, workspace, payload, inputFiles = [], inputBinding, chatRequestId, automaticContinuation = false, transportKind = 'artifact', proof, branch, onRequestAllocated }) {
    const previous = this.jobs.get(sessionId)
    if (previous?.state === 'running' || previous?.state === 'starting') throw parseError('POSTMAN_CURRENT_TURN_JOB_ALREADY_RUNNING')
    if (typeof payload !== 'string' || payload.trim() === '') throw parseError('POSTMAN_EMPTY_PAYLOAD')
    if (!['artifact', 'text', 'image'].includes(transportKind)) throw parseError('POSTMAN_RESULT_MODE_INVALID')
    if (branch !== STANDALONE_TASK_PUBLICATION_BRANCH && !POSTMAN_TASK_BRANCH_PATTERN.test(branch ?? '')) throw parseError('POSTMAN_TASK_BRANCH_INVALID')

    // A new request in this Luna session supersedes any exact-reply slot left
    // by the previous PostmanAsk result.
    this.exactAskReplies.delete(sessionId)

    const bridgeName = transportKind === 'text' ? 'postman-ask.ps1' : 'postman.ps1'
    const bridge = join(workspace, 'postman', 'direct', bridgeName)
    if (!this.exists(bridge)) throw parseError('POSTMAN_DIRECT_BRIDGE_MISSING')

    // Child sessions share this host manager; avoid a same-second random suffix
    // collision before either Direct process claims its immutable REQ.
    let requestId
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = makeRequestId(this.now, this.randomInt)
      if (![...this.jobs.values()].some(job => job.requestId === candidate)) {
        requestId = candidate
        break
      }
    }
    if (requestId === undefined) throw parseError('POSTMAN_REQUEST_ID_COLLISION')
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
    args.push('-Branch', branch)
    if (inputFiles.length) args.push('-InputFilesBase64', Buffer.from(JSON.stringify(inputFiles), 'utf8').toString('base64'))
    if (chatRequestId !== undefined) args.push('-ChatRequestId', chatRequestId)
    if (automaticContinuation) args.push('-AutomaticContinuation')
    if (transportKind === 'image') args.push('-ImageMode')

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
      transportKind,
      branch,
      proof,
      directRoot: this.directRoot,
      readPublicationState: this.readPublicationState,
      waiters: new Set(),
    }
    if (onRequestAllocated) await onRequestAllocated(requestId) // Durable Bridge correlation precedes any Direct side effect.
    this.jobs.set(sessionId, job)

    if (inputFiles.length) {
      try {
        job.inputBundle = await this.inputGrants.build(inputBinding, sessionId, requestId, inputFiles, transportKind)
        args.push('-InputBundleManifest', job.inputBundle.handoffPath)
      } catch (error) {
        // Every build failure precedes Direct spawn/publication, including helper
        // spawn, malformed output and filesystem errors. Never lose this allocated REQ.
        const message = String(error?.message ?? '')
        const code = /^POSTMAN_INPUT_[A-Z_]+$/.test(message) ? message : 'POSTMAN_INPUT_BUNDLE_BUILD_FAILED'
        job.state = 'completed'
        job.exitCode = -1
        job.result = { ok: false, code: 'POSTMAN_TRANSPORT_FAILED', requestId,
          transportCode: code, transportMessage: code, publicationStarted: false,
          details: { sendState: 'PROVEN_NOT_SENT', inputBundlePhase: 'host-build' } }
        job.finishedAt = new Date().toISOString()
        this.finish(job)
        const wrapped = parseError(code)
        wrapped.cause = error
        throw wrapped
      }
    }
    let child
    try {
      child = this.spawn(this.pwsh, args, {
        cwd: workspace,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      job.inputBundle?.cleanup()
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
      job.inputBundle?.cleanup()
      if (
        job.result?.ok === true
        && job.result.code === 'TEXT_RESULT_DURABLE'
        && job.result.deliveryMode === 'inline'
        && typeof job.result.assistantText === 'string'
      ) {
        this.exactAskReplies.set(job.sessionId, Object.freeze({
          requestId: job.requestId,
          text: job.result.assistantText,
        }))
      }
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
      job.inputBundle?.cleanup()
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
      transportKind,
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

  async wait(sessionId, timeoutMs = STATUS_WAIT_MS, signal) {
    const current = this.view(sessionId)
    if (current.status !== 'RUNNING' || signal?.aborted || this.disposed) return current
    const job = this.jobs.get(sessionId)
    await new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        job.waiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      job.waiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
      if (signal?.aborted) wake()
    })
    // Cancel only observation; the Direct process and its terminal authority survive.
    return this.view(sessionId)
  }

  validateExactAskReply(sessionId, requestId, candidate) {
    if (typeof requestId !== 'string' || !REQ_PATTERN.test(requestId)) {
      return { status: 'EXACT_REPLY_REQUEST_INVALID', requestId: String(requestId ?? '') }
    }
    const stored = this.exactAskReplies.get(sessionId)
    if (stored === undefined) {
      return { status: 'EXACT_REPLY_UNAVAILABLE', requestId }
    }
    if (stored.requestId !== requestId) {
      return {
        status: 'EXACT_REPLY_REQUEST_MISMATCH',
        requestId,
        storedRequestId: stored.requestId,
      }
    }
    if (typeof candidate !== 'string' || candidate !== stored.text) {
      return {
        status: 'EXACT_REPLY_MISMATCH',
        requestId,
        expectedLength: stored.text.length,
        candidateLength: typeof candidate === 'string' ? candidate.length : null,
      }
    }
    return { status: 'EXACT_REPLY_MATCH', requestId }
  }

  observeArtifactCandidate(requestId) {
    if (!REQ_PATTERN.test(requestId ?? "")) return null
    const root = this.directRoot ?? (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "DSH", "Postman", "direct")
      : join(homedir(), ".dsh", "postman", "direct"))
    const rawDirectory = join(root, "candidates", requestId)
    const legacyRoot = process.env.DSH_POSTMAN_RESULT_ROOT ?? resolve(root, "..", "results")
    const legacy = !existsSync(join(rawDirectory, "capture.bin"))
    const captureRoot = legacy ? legacyRoot : join(root, "candidates")
    const directory = legacy ? join(legacyRoot, requestId) : rawDirectory
    const physical = join(directory, legacy ? "result.zip" : "capture.bin")
    try {
      for (const path of [captureRoot, directory, physical])
        if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path)) return null
      const descriptorPath = join(directory, "candidate.json")
      const missingDescriptor = !legacy && !existsSync(descriptorPath)
      if (!legacy && !missingDescriptor && lstatSync(descriptorPath).isSymbolicLink()) return null
      const claimed = legacy || missingDescriptor ? { path: physical, byteLength: lstatSync(physical).size,
        completeness: legacy ? "complete" : "partial",
        reasons: legacy ? ["LEGACY_FILE_CORRELATION_UNVERIFIED", "LEGACY_FILE_COMPLETENESS_UNVERIFIED"]
          : ["CANDIDATE_METADATA_MISSING", "CANDIDATE_COMPLETENESS_UNVERIFIED"], provenance: { requestId } }
        : JSON.parse(readFileSync(descriptorPath, "utf8"))
      if (claimed?.provenance?.requestId !== requestId || !["complete", "partial"].includes(claimed.completeness)
          || !Number.isSafeInteger(claimed.byteLength) || claimed.byteLength < 0
          || claimed.byteLength > 50 * 1024 * 1024 || resolve(claimed.path ?? "") !== resolve(physical)) return null
      const size = lstatSync(physical).size
      if (size > 50 * 1024 * 1024 || !lstatSync(physical).isFile()) return null
      const actualSha = sha256Bytes(readFileSync(physical))
      return { path: physical, byteLength: size, sha256: actualSha,
        originalFilename: typeof claimed.originalFilename === "string" ? claimed.originalFilename.slice(0, 512) : "",
        completeness: claimed.completeness,
        reasons: [...(Array.isArray(claimed.reasons) ? claimed.reasons.filter(x => typeof x === "string").slice(0, 32) : []),
          ...(legacy || missingDescriptor || actualSha === claimed.sha256 ? [] : ["CANDIDATE_SHA_CHANGED"]),
          ...(size === claimed.byteLength ? [] : ["CANDIDATE_LENGTH_CHANGED"]), "OWNERSHIP_RECEIPT_NOT_VERIFIED"],
        provenance: { requestId, chatUrl: typeof claimed.provenance.chatUrl === "string" ? claimed.provenance.chatUrl : null },
        verified: false, applyEligible: false }
    } catch { return null }
  }

  // Read-only Direct checkpoint: absence, corruption or publication ambiguity never proves a safe outcome.
  inspectRequest(requestId, branch, transportKind) {
    if (!REQ_PATTERN.test(requestId ?? '')) return { state: 'unknown' }
    const root = this.directRoot ?? (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'DSH', 'Postman', 'direct')
      : join(homedir(), '.dsh', 'postman', 'direct'))
    try {
      const state = JSON.parse(this.readPublicationState(join(root, 'requests', requestId + '.json'), 'utf8'))
      if (state?.requestId !== requestId || state.repository !== 'AndrewVerhoturov1/dsh-workspace' ||
          state.branch !== branch) return { state: 'unknown' }
      const publication = { requestId: state.requestId, repository: state.repository, branch: state.branch,
        taskUrl: state.taskUrl, baseCommit: state.baseCommit, taskPublicationCommit: state.taskPublicationCommit }
      if (validPublicationReceipt(publication, { requestId, branch })) {
        if (transportKind === "artifact") {
          try {
            const handoff = JSON.parse(this.readPublicationState(join(root, "results", requestId + ".json"), "utf8"))
            const candidate = this.observeArtifactCandidate(requestId)
            if (candidate && handoff.requestId === requestId && handoff.branch === branch
                && handoff.repository === publication.repository && handoff.baseCommit === publication.baseCommit
                && handoff.taskPublicationCommit === publication.taskPublicationCommit && handoff.taskUrl === publication.taskUrl
                && handoff.ok === false && handoff.code === "ARTIFACT_CANDIDATE_SAVED") {
              return { state: "terminal", publication, terminal: { status: "POSTMAN_BRIDGE_TERMINAL",
                terminalStatus: "FAILED", transportKind, requestId, result: { ok: false,
                  code: "ARTIFACT_CANDIDATE_SAVED", state: "ARTIFACT_CANDIDATE_SAVED", requestId,
                  candidate, verified: false, applyEligible: false, publicationReceipt: publication,
                  unresolvedSendUnknown: handoff.unresolvedSendUnknown === true } } }
            }
          } catch {}
        }
        { // A durable handoff can precede its final state checkpoint after a crash.
          const stateTerminal = ['RESULT_DURABLE', 'IMAGE_RESULT_DURABLE', 'TEXT_RESULT_DURABLE',
            'ASSISTANT_COMPLETED_NO_ARTIFACT', 'ARTIFACT_REJECTED', 'FAILED', 'ASK_FAILED'].includes(state.state)
          try {
            const handoff = JSON.parse(this.readPublicationState(join(root, 'results', requestId + '.json'), 'utf8'))
            if (handoff.ok === false && handoff.code === 'POSTMAN_TRANSPORT_FAILED' &&
                (!stateTerminal || ['FAILED', 'ASK_FAILED'].includes(state.state)) && handoff.requestId === requestId &&
                handoff.publicationReceipt?.requestId === requestId &&
                handoff.publicationReceipt.repository === publication.repository &&
                handoff.publicationReceipt.branch === branch &&
                handoff.publicationReceipt.taskPublicationCommit === publication.taskPublicationCommit &&
                handoff.publicationReceipt.baseCommit === publication.baseCommit &&
                handoff.publicationReceipt.taskUrl === publication.taskUrl &&
                typeof handoff.transportMessage === 'string' && handoff.transportMessage.length &&
                typeof handoff.transportCode === 'string' && handoff.transportCode.length)
              return { state: 'terminal', terminal: { status: 'POSTMAN_BRIDGE_TERMINAL',
                terminalStatus: 'FAILED', requestId, transportKind, result: handoff }, publication }
            if (handoff.ok === true && handoff.state === handoff.code &&
                (!stateTerminal || state.state === handoff.code) &&
                handoff.requestId === requestId && handoff.repository === publication.repository &&
                handoff.branch === branch && handoff.baseCommit === publication.baseCommit &&
                handoff.taskPublicationCommit === publication.taskPublicationCommit &&
                handoff.taskUrl === publication.taskUrl &&
                ((transportKind === 'text' && handoff.code === 'TEXT_RESULT_DURABLE' &&
                  (handoff.deliveryMode === 'inline' ? typeof handoff.assistantText === 'string' &&
                    handoff.assistantText.trim() && sha256(handoff.assistantText) === handoff.assistantTextSha256 &&
                    (!stateTerminal || handoff.assistantText === state.assistantText && handoff.assistantTextSha256 === state.assistantTextSha256) && handoff.resultFile === undefined :
                    handoff.deliveryMode === 'file' && handoff.assistantText === undefined &&
                    handoff.resultFileName === 'POSTMAN_' + requestId + '_ANSWER.md' &&
                    isAbsolute(handoff.resultFile ?? '') && basename(handoff.resultFile) === handoff.resultFileName &&
                    handoff.resultFileSha256 === handoff.assistantTextSha256 &&
                    (!stateTerminal || handoff.assistantTextSha256 === state.assistantTextSha256 &&
                    handoff.resultFile === state.resultFile) && handoff.resultMimeType === 'text/markdown' &&
                    handoff.resultEncoding === 'utf-8' &&
                    sha256Bytes(readFileSync(handoff.resultFile)) === handoff.assistantTextSha256)) ||
                (transportKind === 'image' && handoff.code === 'IMAGE_RESULT_DURABLE' &&
                  isAbsolute(handoff.resultImage ?? '') && (!stateTerminal || handoff.resultImage === state.resultImage &&
                  handoff.imageSha256 === state.imageSha256) &&
                  sha256Bytes(readFileSync(handoff.resultImage)) === handoff.imageSha256) ||
                (transportKind === 'artifact' &&
                  (handoff.code === 'RESULT_DURABLE' && handoff.verified !== false && handoff.applyEligible !== false && handoff.unresolvedSendUnknown !== true && (!stateTerminal || handoff.resultZip === state.resultZip &&
                    handoff.sha256 === state.artifactSha256) && /^[0-9a-f]{64}$/.test(handoff.sha256 ?? '') &&
                    handoff.expectedFilename === 'POSTMAN_' + requestId + '_RESULT.zip' &&
                    typeof handoff.resultZip === 'string' && isAbsolute(handoff.resultZip) &&
                    sha256Bytes(readFileSync(handoff.resultZip)) === handoff.sha256 ||
                   ['ASSISTANT_COMPLETED_NO_ARTIFACT', 'ARTIFACT_REJECTED'].includes(handoff.code) &&
                    typeof handoff.assistantText === 'string' &&
                    sha256(handoff.assistantText) === handoff.assistantTextSha256 &&
                    (!stateTerminal || handoff.assistantText === state.assistantText &&
                    handoff.assistantTextSha256 === state.assistantTextSha256)))))
              return { state: 'terminal', terminal: { status: 'POSTMAN_BRIDGE_TERMINAL',
                terminalStatus: 'COMPLETED', requestId, transportKind, result: handoff }, publication }
          } catch { /* Failed handoff validation is ambiguous, never success. */ }
        }
        return { state: 'published', publication }
      }
      if (state.publicationStarted === false && ['FAILED', 'ASK_FAILED'].includes(state.state) &&
          !state.taskPublicationCommit && !state.taskUrl && !state.sendProof &&
          state.unresolvedSendUnknown !== true)
        return { state: 'proven-not-sent' }
      return { state: 'unknown' }
    } catch { return { state: 'unknown' } }
  }

  async recoveryCapability(workspace, requestId) {
    const root = this.directRoot ?? (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'DSH', 'Postman', 'direct')
      : join(homedir(), '.dsh', 'postman', 'direct'))
    const { stdout } = await promisify(execFile)(process.env.POSTMAN_PYTHON ?? 'python',
      ['-X', 'utf8', join(workspace, 'postman', 'direct', 'chat_reference.py'),
        '--direct-root', root, '--request-id', requestId], { windowsHide: true, timeout: 10000 })
    return JSON.parse(stdout)
  }

  async continueLast(sessionId, workspace, previous = this.jobs.get(sessionId), onRequestAllocated) {
    if (previous === undefined || previous.state !== 'completed' || previous.result === undefined) {
      throw parseError('POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED')
    }
    if (new Set(['RESULT_DURABLE', 'TEXT_RESULT_DURABLE', 'IMAGE_RESULT_DURABLE']).has(previous.result.code))
      throw parseError('POSTMAN_AUTOMATIC_CONTINUATION_NOT_ALLOWED')
    if (previous.automaticContinuation || previous.result.automaticRecoveryUsed === true)
      throw parseError('POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED')
    // Direct owns the durable evidence and claim; it rejects ineligible failures before Send.
    const payload = 'Продолжи исходную незавершённую задачу с текущего места и доведи её до готового результата.'
    return this.start({
      sessionId,
      workspace,
      payload,
      chatRequestId: previous.requestId,
      automaticContinuation: true,
      onRequestAllocated,
      transportKind: previous.transportKind ?? 'artifact',
      branch: previous.branch,
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
    this.disposed = true
    for (const job of this.jobs.values()) this.finish(job)
    this.exactAskReplies.clear()
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

export function createDirectCurrentTurnToolConfigs(ctx, { store, jobs, taskContexts = postmanTaskContexts,
  currentAttachments, inputGrants = postmanInputGrants } = {}) {
  const turnStore = store ?? new CurrentUserTurnStore(ctx)
  const manager = jobs ?? new DirectPostmanJobManager({ inputGrants })
  const attachments = currentAttachments ?? (ctx?.agents?.get ? new CurrentAttachmentStore(ctx) : undefined)
  const stopDisposed = ctx?.on?.('agent/disposed', ({ agent }) => attachments?.release(agent))

  const sendCurrent = {
    name: 'postman_send_current_turn',
    description: 'Production @Postman/@PostmanAsk/@PostmanImage orchestration. Takes NO task/prompt argument. Reads the exact current user/message captured by trusted Harness runtime, strips only transport syntax, and starts the matching Direct Postman bridge.',
    parameters: {},
    output: toolOutput(),
    async execute(_args, exec) {
      const agent = requiredAgent(exec, 'postman_send_current_turn')
      const record = turnStore.get(agent.id)
      if (record === undefined) throw parseError('POSTMAN_CURRENT_TURN_UNAVAILABLE')
      if (record.consumed) throw parseError('POSTMAN_CURRENT_TURN_ALREADY_USED')
      if (record.error !== undefined) throw parseError(record.error)
      const parsed = parsePostmanUserTurn(record.text)
      const bridgeContext = taskContexts.child(agent.id)
      if (agent.session?.header?.origin === 'subagent' && agent.session.header.delegationDepth === 1 &&
          agent.session.header.parentSession && !bridgeContext) throw parseError('POSTMAN_TASK_CONTEXT_REQUIRED')
      if (bridgeContext && taskContexts.get(bridgeContext.leaderSessionId) !== bridgeContext) throw parseError('POSTMAN_TASK_CONTEXT_REQUIRED')
      if (parsed.inputFiles?.length && !bridgeContext) throw parseError('POSTMAN_INPUT_METADATA_LEADER_REQUIRED')
      let inputFiles = parsed.inputFiles ?? []
      let inputBinding = inputFiles.length ? inputGrants.child(agent, bridgeContext, inputFiles) : undefined
      if (inputFiles.length && !inputBinding) throw parseError('POSTMAN_INPUT_PROVENANCE_REJECTED')
      // Reserve this exact turn before an asynchronous read; concurrent sends cannot stage it twice.
      if (!turnStore.consume(agent.id, record.seq)) throw parseError('POSTMAN_CURRENT_TURN_CHANGED_DURING_START')
      let standaloneBinding, standaloneContext
      try {
        if (record.attachmentCount) {
          const current = attachments?.get(agent)
          if (bridgeContext || !current || current.session !== record.session || current.seq !== record.seq ||
              current.attachments.length !== record.attachmentCount) throw parseError('POSTMAN_INPUT_CURRENT_ATTACHMENT_MISMATCH')
          const staged = await stageStandaloneCurrentAttachments(ctx, agent, current, attachments, exec.signal, inputGrants)
          if (staged.status !== 'POSTMAN_INPUT_READY') {
            turnStore.release(agent.id, record.seq)
            return staged
          }
          standaloneContext = current
          inputFiles = staged.descriptors
          if (turnStore.get(agent.id)?.seq !== record.seq || attachments.get(agent) !== current)
            throw parseError('POSTMAN_CURRENT_TURN_CHANGED_DURING_START')
          standaloneBinding = inputGrants.pin(agent, current, inputFiles)
          if (!inputGrants.bindChild(standaloneBinding, agent, current, agent)) throw parseError('POSTMAN_INPUT_PROVENANCE_REJECTED')
          inputBinding = standaloneBinding
        }
        const proof = {
          parseMode: parsed.mode,
          transportKind: parsed.transportKind,
          sourceMessageLength: record.length,
          sourceMessageSha256: record.sha256,
          payloadLength: parsed.payload.length,
          payloadSha256: sha256(parsed.payload),
          removedTransportPrefixLength: parsed.removedTransportPrefix.length,
          removedTransportPrefixSha256: sha256(parsed.removedTransportPrefix),
          ...(inputFiles.length ? { inputMetadataSha256: sha256(JSON.stringify(inputFiles)) } : {}),
        }
        return await manager.start({
          sessionId: agent.id,
          workspace: workspaceOf(agent),
          payload: parsed.payload,
          inputFiles,
          inputBinding,
          chatRequestId: parsed.chatRequestId,
          transportKind: parsed.transportKind,
          branch: bridgeContext?.branch ?? STANDALONE_TASK_PUBLICATION_BRANCH,
          proof,
          ...(bridgeContext ? { onRequestAllocated: requestId => taskContexts.recordBridgeRequest(agent.id, requestId) } : {}),
        })
      } catch (error) {
        turnStore.release(agent.id, record.seq)
        throw error
      } finally {
        // The manager has finished building its independent request attachment before start returns.
        if (standaloneBinding) inputGrants.unpin(standaloneBinding)
        if (standaloneContext && inputGrants.owns(agent, standaloneContext, inputFiles)) inputGrants.release(agent)
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
      return manager.wait(agent.id, undefined, exec.signal)
    },
  }

  const validateAskReply = {
    name: 'postman_ask_validate_reply',
    description: 'Inline PostmanAsk only: compare a candidate final Luna reply with the exact TEXT_RESULT_DURABLE assistantText stored for this session. File delivery must be handed off by resultFile without this validator.',
    parameters: {
      request_id: {
        type: 'string',
        required: true,
        description: 'Exact current PostmanAsk REQ.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Candidate final user-visible reply to compare exactly with stored assistantText.',
      },
    },
    output: toolOutput(),
    async execute(args, exec) {
      const agent = requiredAgent(exec, 'postman_ask_validate_reply')
      return manager.validateExactAskReply(agent.id, args.request_id, args.text)
    },
  }

  const continueLast = {
    name: 'postman_continue_last_request',
    description: 'Start one automatic same-chat recovery of the last failed or non-durable request, preserving artifact/text/image mode. Takes no task text; Direct authorizes exact proven-sent capability and durably enforces one attempt.',
    parameters: {},
    output: toolOutput(),
    async execute(_args, exec) {
      const agent = requiredAgent(exec, 'postman_continue_last_request')
      return manager.continueLast(agent.id, workspaceOf(agent))
    },
  }

  return {
    tools: [sendCurrent, statusCurrent, validateAskReply, continueLast],
    store: turnStore,
    currentAttachments: attachments,
    jobs: manager,
    dispose() {
      turnStore.dispose()
      if (!currentAttachments) attachments?.dispose()
      stopDisposed?.()
      manager.dispose()
    },
  }
}

export const DIRECT_CURRENT_TURN_TOOL_NAMES = Object.freeze([
  'postman_send_current_turn',
  'postman_current_turn_status',
  'postman_ask_validate_reply',
  'postman_continue_last_request',
])
