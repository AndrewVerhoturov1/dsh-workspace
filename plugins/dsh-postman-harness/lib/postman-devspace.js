import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'


export function devspaceRoot() {
  return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'DSH', 'Postman', 'devspace') : join(homedir(), '.dsh', 'postman', 'devspace')
}

export function createDevspaceChannel({ root = devspaceRoot(), bridgeJobId, leaderSessionId, lunaSessionId, requestId, worktree, mode, sourceRoot }) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bridgeJobId ?? '') || !/^REQ_\d{8}T\d{6}Z_\d{4}$/.test(requestId ?? '') ||
      !leaderSessionId || !lunaSessionId || !['READ_ONLY', 'WRITE_TEST'].includes(mode)) throw Error('POSTMAN_DEVSPACE_BINDING_INVALID')
  const channel = join(root, bridgeJobId)
  mkdirSync(channel, { recursive: true })
  if (realpathSync(channel) !== resolve(channel)) throw Error('POSTMAN_DEVSPACE_CHANNEL_REDIRECTED')
  const workspaceRef = realpathSync(worktree)
  const writeRoot = mode === 'WRITE_TEST' ? join(channel, 'workspace') : null
  if (writeRoot) mkdirSync(writeRoot)
  const binding = Object.freeze({ version: 1, jobId: bridgeJobId, requestId, leaderSessionId, lunaSessionId,
    channel, capability: randomBytes(32).toString('hex'), mode, workspaceRef, writeRoot })
  writeFileSync(join(channel, 'binding.json'), JSON.stringify(binding), { flag: 'wx', mode: 0o600 })
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  const command = join(channel, 'signal.ps1')
  const launcher = [
    '[CmdletBinding()]',
    "param([Parameter(Mandatory=$true)][ValidateSet('done','need-decision','blocked')][string]$Outcome,[string]$Message='',[string]$Report='')",
    '& python -X utf8 ' + quote(join(sourceRoot, 'postman', 'devspace', 'signal.py')) + ' $Outcome --channel ' + quote(channel) + ' --capability ' + quote(binding.capability) + ' --message $Message --report $Report',
    'exit $LASTEXITCODE', ''
  ].join('\n')
  writeFileSync(command, launcher, { flag: 'wx', mode: 0o600 })
  return Object.freeze({ ...binding, signalCommand: '& ' + quote(command) })
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
  if (!event && observed.source !== 'transport_diagnostic' && observed.source !== 'text_fallback') throw Error('POSTMAN_DEVSPACE_EVENT_MISSING')
  const source = event ? 'bell' : observed.source
  const code = event ? 'DEVSPACE_SIGNAL_RECEIVED' : 'DEVSPACE_DIAGNOSTIC'
  return { ok: true, code, state: code, jobId: binding.jobId, requestId: binding.requestId,
    leaderSessionId: binding.leaderSessionId, lunaSessionId: binding.lunaSessionId,
    source, reportedOutcome: event?.reportedOutcome ?? 'BLOCKED', deliveryState: 'DELIVERED',
    evidenceState: 'REPORTED_NOT_VERIFIED', workspaceRef: binding.workspaceRef, writeRoot: binding.writeRoot,
    reportRef, message: event?.message ?? '',
    assistantText: typeof observed.assistantText === 'string' ? observed.assistantText : '',
    conversationRef: typeof observed.conversationRef === 'string' && /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(observed.conversationRef) ? observed.conversationRef : null,
    diagnostic: event ? null : observed.diagnostic === 'CAPABILITY_UNAVAILABLE' ? 'CAPABILITY_UNAVAILABLE' : 'BLOCKED',
    warnings: event ? ['REPORT_UNVERIFIED', ...(!reportRef || !existsReport(reportRef) ? ['REPORT_UNAVAILABLE'] : [])] : ['NO_LOCAL_SIGNAL'] }
}
