import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, realpathSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'


export function devspaceRoot() {
  return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH', 'Postman', 'devspace') : join(homedir(), '.dsh', 'postman', 'devspace')
}

export function createDevspaceChannel({ root = devspaceRoot(), bridgeJobId, leaderSessionId, lunaSessionId, requestId, worktree, mode, sourceRoot, conversationUrl }) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bridgeJobId ?? '') || !/^REQ_\d{8}T\d{6}Z_\d{4}$/.test(requestId ?? '') ||
      !leaderSessionId || !lunaSessionId || !['READ_ONLY', 'WRITE_TEST', 'WRITE_ISOLATED', 'WRITE_APPROVED_TARGET'].includes(mode) ||
      (conversationUrl !== undefined && !/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(conversationUrl))) throw Error('POSTMAN_DEVSPACE_BINDING_INVALID')
  const channel = join(root, bridgeJobId)
  mkdirSync(channel, { recursive: true })
  if (realpathSync(channel) !== resolve(channel)) throw Error('POSTMAN_DEVSPACE_CHANNEL_REDIRECTED')
  const workspaceRef = realpathSync(worktree)
  if (['WRITE_ISOLATED', 'WRITE_APPROVED_TARGET'].includes(mode) &&
      workspaceRef !== resolve(worktree))
    throw Error('POSTMAN_DEVSPACE_WORKTREE_REDIRECTED')
  const writeRoot = mode === 'WRITE_TEST' ? join(channel, 'workspace') :
    ['WRITE_ISOLATED', 'WRITE_APPROVED_TARGET'].includes(mode) ? workspaceRef : null
  if (mode === 'WRITE_TEST') mkdirSync(writeRoot)
  const binding = Object.freeze({ version: 1, jobId: bridgeJobId, requestId, leaderSessionId, lunaSessionId,
    channel, capability: randomBytes(32).toString('hex'), mode, workspaceRef, writeRoot,
    ...(conversationUrl ? { conversationUrl } : {}) })
  writeFileSync(join(channel, 'binding.json'), JSON.stringify(binding), { flag: 'wx', mode: 0o600 })
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  const command = join(channel, 'signal.ps1')
  const launcher = [
    '[CmdletBinding()]',
    "param([Parameter(Mandatory=$true)][ValidateSet('done','need-decision','blocked')][string]$Outcome,[string]$Message='',[string]$Report='')",
    '& python -X utf8 ' + quote(join(sourceRoot, 'postman', 'devspace', 'signal.py')) + ' $Outcome --channel ' + quote(channel) + ' --capability ' + quote(binding.capability) + ' ("--message=" + $Message) ("--report=" + $Report)',
    'exit $LASTEXITCODE', ''
  ].join('\n')
  writeFileSync(command, launcher, { flag: 'wx', mode: 0o600 })
  const bashQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  return Object.freeze({ ...binding, signalCommand: 'pwsh -NoProfile -NonInteractive -File ' + bashQuote(command) })
}

/** Host-only, one-per-ID control intent. The user never supplies channel authority.
 * Python reads each immutable file and writes a separate exact ack. No blind retry.
 */
export function requestDevspaceControl(binding, { kind, message = '', priority = 'normal' }) {
  if (!['steer', 'preempt', 'stop'].includes(kind) || !['normal', 'urgent'].includes(priority) ||
      typeof message !== 'string' || message.length > 6000 ||
      (kind !== 'stop' && !message.trim()) || !binding?.capability ||
      realpathSync(binding.channel) !== resolve(binding.channel)) throw Error('POSTMAN_DEVSPACE_CONTROL_INVALID')
  const controlId = randomUUID()
  const directory = join(binding.channel, 'controls')
  mkdirSync(directory, { recursive: true })
  const intent = { version: 1, controlId, kind, priority,
    message: kind === 'stop' ? '' : message, issuedAt: new Date().toISOString(),
    ...Object.fromEntries(['jobId', 'requestId', 'leaderSessionId', 'lunaSessionId', 'capability']
      .map(key => [key, binding[key]])) }
  const path = join(directory, controlId + '.json')
  const temp = join(directory, '.' + controlId + '.tmp')
  writeFileSync(temp, JSON.stringify(intent), { flag: 'wx', mode: 0o600 })
  renameSync(temp, path)
  return { controlId, requestId: binding.requestId, status: 'POSTMAN_DEVSPACE_CONTROL_QUEUED', kind }
}

export function readDevspaceControls(binding) {
  const directory = join(binding.channel, 'controls')
  try {
    if (realpathSync(binding.channel) !== resolve(binding.channel)) throw Error('POSTMAN_DEVSPACE_CHANNEL_REDIRECTED')
    const entries = readdirSync(directory).filter(name => /^[0-9a-f-]{36}[.]json$/.test(name)).sort()
    return entries.slice(-32).map(name => {
      const controlId = name.slice(0, -5)
      const control = JSON.parse(readFileSync(join(directory, name), 'utf8'))
      for (const key of ['jobId', 'requestId', 'leaderSessionId', 'lunaSessionId', 'capability'])
        if (control[key] !== binding[key]) throw Error('POSTMAN_DEVSPACE_CONTROL_OWNER_MISMATCH')
      const ackFile = join(directory, controlId + '.ack.json')
      let state = 'QUEUED', stopState = null, sendState = null
      try {
        if (lstatSync(ackFile).isSymbolicLink()) throw Error('POSTMAN_DEVSPACE_CONTROL_ACK_INVALID')
        const ack = JSON.parse(readFileSync(ackFile, 'utf8'))
        if (ack.controlId !== controlId || ack.requestId !== binding.requestId ||
            !['STOP_UI_PROVEN', 'STOP_UNKNOWN', 'SENT_CONFIRMED', 'SEND_UNKNOWN', 'PROVEN_NOT_SENT', 'ALREADY_IDLE'].includes(ack.state))
          throw Error('POSTMAN_DEVSPACE_CONTROL_ACK_INVALID')
        state = ack.state; stopState = ack.stopState ?? null; sendState = ack.sendState ?? null
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      return { controlId, kind: control.kind, state, stopState, sendState, issuedAt: control.issuedAt }
    })
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

/** Only journal-scoped owned channels can be considered for late bell promotion. */
export function loadDevspaceChannelForOwner(channel, { bridgeJobId, leaderSessionId, lunaSessionId, requestId }) {
  if (typeof channel !== 'string' || realpathSync(channel) !== resolve(channel) ||
      realpathSync(join(channel, '..')) !== realpathSync(devspaceRoot()) ||
      channel !== join(devspaceRoot(), bridgeJobId)) throw Error('POSTMAN_DEVSPACE_CHANNEL_REJECTED')
  const file = join(channel, 'binding.json')
  if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 65536) throw Error('POSTMAN_DEVSPACE_BINDING_REJECTED')
  const binding = JSON.parse(readFileSync(file, 'utf8'))
  if (binding.version !== 1 || binding.channel !== channel ||
      binding.jobId !== bridgeJobId || binding.leaderSessionId !== leaderSessionId ||
      binding.lunaSessionId !== lunaSessionId || binding.requestId !== requestId ||
      typeof binding.capability !== 'string' || !/^[0-9a-f]{64}$/.test(binding.capability))
    throw Error('POSTMAN_DEVSPACE_BINDING_REJECTED')
  return binding
}

// Only the saved Host binding supplies authority. Event/report prose never chooses a recipient or path.
export function readDevspaceEvent(binding) {
  const path = join(binding.channel, 'event.json')
  try {
    if (realpathSync(binding.channel) !== resolve(binding.channel) || lstatSync(path).isSymbolicLink() ||
        !lstatSync(path).isFile() || lstatSync(path).size > 65536) throw Error('POSTMAN_DEVSPACE_EVENT_INVALID')
    const event = JSON.parse(readFileSync(path, 'utf8'))
    for (const key of ['jobId', 'requestId', 'leaderSessionId', 'lunaSessionId', 'capability'])
      if (event[key] !== binding[key]) throw Error('POSTMAN_DEVSPACE_EVENT_OWNER_MISMATCH')
    if (event.version !== 1 || !['DONE', 'NEED_DECISION', 'BLOCKED'].includes(event.reportedOutcome) ||
        typeof event.message !== 'string' || event.message.length > 16000 ||
        (event.reportRef !== null && typeof event.reportRef !== 'string')) throw Error('POSTMAN_DEVSPACE_EVENT_INVALID')
    return { reportedOutcome: event.reportedOutcome, message: event.message, reportRef: event.reportRef }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function existsReport(path) { try { return lstatSync(path).isFile() } catch { return false } }

export function devspaceTerminal(binding, observed = {}) {
  const event = readDevspaceEvent(binding)
  let reportRef = event?.reportRef ?? null
  if (reportRef) {
    const allowed = binding.writeRoot ?? binding.workspaceRef
    const target = (() => { try { return realpathSync(reportRef) } catch { return resolve(reportRef) } })()
    const diff = relative(allowed, target)
    if (diff === '..' || diff.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(diff)) reportRef = null
  }
  // No external stdout can name an arbitrary image path. The exact file
  // must belong to this private job channel, with stable hash/format/size.
  let image = null
  if (observed.source === 'image_result' || observed.resultImage !== undefined) {
    const extension = observed.imageFormat
    const expected = 'POSTMAN_IMAGE_' + binding.requestId + '.' + extension
    const format = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[extension]
    const filename = join(binding.channel, expected)
    if (!format || observed.resultImage !== filename ||
        observed.imageMimeType !== format ||
        !/^[0-9a-f]{64}$/.test(observed.imageSha256 ?? '') ||
        !Number.isSafeInteger(observed.imageByteLength) ||
        observed.imageByteLength < 1 || observed.imageByteLength > 48 * 1024 * 1024 ||
        !Number.isSafeInteger(observed.imageWidth) || observed.imageWidth < 64 ||
        !Number.isSafeInteger(observed.imageHeight) || observed.imageHeight < 64 ||
        lstatSync(filename).isSymbolicLink() || !lstatSync(filename).isFile() ||
        realpathSync(filename) !== filename)
      throw Error('POSTMAN_DEVSPACE_IMAGE_PROOF_INVALID')
    const bytes = readFileSync(filename)
    const signature = extension === 'png'
      ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : extension === 'jpg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        : bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
          bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
    if (!signature || bytes.length !== observed.imageByteLength ||
        createHash('sha256').update(bytes).digest('hex') !== observed.imageSha256)
      throw Error('POSTMAN_DEVSPACE_IMAGE_PROOF_INVALID')
    image = { resultImage: filename, imageFormat: extension,
      imageSha256: observed.imageSha256, imageByteLength: bytes.length,
      imageWidth: observed.imageWidth, imageHeight: observed.imageHeight,
      imageMimeType: observed.imageMimeType }
  }
  if (!event && !image && observed.source !== 'transport_diagnostic' && observed.source !== 'text_fallback')
    throw Error('POSTMAN_DEVSPACE_EVENT_MISSING')
  const source = event ? 'bell' : observed.source
  const code = event ? 'DEVSPACE_SIGNAL_RECEIVED' :
    image ? 'DEVSPACE_IMAGE_RESULT_DURABLE' : 'DEVSPACE_DIAGNOSTIC'
  return { ok: true, code, state: code, jobId: binding.jobId, requestId: binding.requestId,
    leaderSessionId: binding.leaderSessionId, lunaSessionId: binding.lunaSessionId,
    source, reportedOutcome: event?.reportedOutcome ?? (observed.diagnostic === 'PARTIAL' ? 'PARTIAL' : (observed.source === 'text_fallback' || image ? 'UNKNOWN' : 'BLOCKED')), deliveryState: 'DELIVERED',
    evidenceState: image ? 'BROWSER_VERIFIED_IMAGE' : 'REPORTED_NOT_VERIFIED', ...image, workspaceRef: binding.workspaceRef, writeRoot: binding.writeRoot,
    reportRef, message: event?.message ?? (typeof observed.message === 'string' ? observed.message : ''),
    transportDiagnostics: observed.transportDiagnostics ?? null,
    assistantText: typeof observed.assistantText === 'string' ? observed.assistantText : '',
    conversationRef: typeof observed.conversationRef === 'string' && /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(observed.conversationRef) ? observed.conversationRef : null,
    diagnostic: event ? null : ['CAPABILITY_UNAVAILABLE', 'BLOCKED', 'PARTIAL', 'UNKNOWN'].includes(observed.diagnostic) ? observed.diagnostic : 'UNKNOWN',
    warnings: event ? ['REPORT_UNVERIFIED', ...(!reportRef || !existsReport(reportRef) ? ['REPORT_UNAVAILABLE'] : [])] : image ? [] : ['NO_LOCAL_SIGNAL'] }
}
