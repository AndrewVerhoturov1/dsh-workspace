import { execFile as execFileCallback } from 'node:child_process'
import { spawn as spawnProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
export const GITHUB_REPOSITORY = 'AndrewVerhoturov1/dsh-workspace'
const BRIDGE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../chatgpt-desktop-uia-bridge/chatgpt_chat.ps1')
const POST_SUBMIT_GUARD_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../chatgpt-desktop-uia-bridge/chatgpt-post-submit-guard.ps1')
const activePostSubmitGuards = new WeakMap()

function commandError(error) {
  return String(error?.stderr || error?.stdout || error?.message || error).trim().slice(0, 2000)
}

function runCommand(file, args, options, runner) {
  return (runner ?? execFile)(file, args, {
    cwd: process.env.DSH_HOME || resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    ...options,
  })
}

export function waitingIssueBody(requestId) {
  return [
    `request_id: ${requestId}`,
    'status: WAITING',
    'protocol_version: 1',
    '',
  ].join('\n')
}

export function buildChatGptTransportPrompt({ requestId, issueNumber, repository = GITHUB_REPOSITORY, task }) {
  return [
    `REPOSITORY:\n${repository}`,
    `ISSUE:\n#${issueNumber}`,
    `REQUEST_ID:\n${requestId}`,
    `TASK:\n${task}`,
    'DELIVERY CONTRACT:',
    '',
    `Update GitHub Issue #${issueNumber} body exactly as:`,
    '',
    `request_id: ${requestId}`,
    'status: READY',
    'protocol_version: 1',
    '',
    '<full final response>',
    '',
    'Do not create another Issue.',
    'Do not close the Issue.',
    'Do not modify unrelated Issues.',
    'Do not create commits, PRs or files.',
    '',
    'GitHub update is a required part of the task.',
    '',
    'Only AFTER successful Issue update respond in this chat exactly:',
    '',
    'POSTMAN_SIGNAL_SENT',
  ].join('\n')
}

export async function createGitHubIssue({ requestId, repository = GITHUB_REPOSITORY, runner }) {
  const args = ['issue', 'create', '--repo', repository, '--title', `POSTMAN ${requestId}`, '--body', waitingIssueBody(requestId)]
  let result
  try {
    result = await runCommand('gh', args, {}, runner)
  } catch (error) {
    throw new Error(`ISSUE_CREATE_FAILED: ${commandError(error)}`)
  }
  const output = String(result.stdout).trim()
  const url = output.split(/\r?\n/).reverse().find((line) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(line.trim()))?.trim() ?? null
  const issueNumber = Number(url?.match(/\/issues\/(\d+)\/?$/)?.[1])
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error('ISSUE_CREATE_FAILED: gh returned an invalid issue number')
  return { repository, issueNumber, url }
}

export async function submitChatGptTransport({ prompt, bridgePath = BRIDGE_PATH, runner }) {
  const executable = process.env.DSH_POSTMAN_PWSH || 'pwsh.exe'
  const args = [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath,
    '-Mode', 'Quick', '-ChatPolicy', 'Fresh', '-Prompt', prompt, '-ReturnJson', '-SubmitOnly',
  ]
  let result
  try {
    result = await runCommand(executable, args, {}, runner)
  } catch (error) {
    throw new Error(`CHAT_SUBMIT_FAILED: ${commandError(error)}`)
  }
  let parsed
  try { parsed = JSON.parse(String(result.stdout).trim()) } catch { throw new Error('CHAT_SUBMIT_FAILED: bridge returned malformed JSON') }
  if (parsed.ok !== true || parsed.submitted !== true || parsed.userMessageConfirmed !== true) {
    const code = parsed.error?.code || 'SUBMIT_NOT_CONFIRMED'
    const message = parsed.error?.message || 'bridge did not confirm the submitted user message'
    throw new Error(`CHAT_SUBMIT_FAILED: ${code}: ${message}`)
  }
  return parsed
}

function hostHwndArgument(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return value
  if (Number.isSafeInteger(Number(value))) return `0x${Number(value).toString(16)}`
  return null
}

function guardSet(runtime) {
  let guards = activePostSubmitGuards.get(runtime)
  if (guards === undefined) {
    guards = new Set()
    activePostSubmitGuards.set(runtime, guards)
  }
  return guards
}

function journalGuardEvent(runtime, event, payload) {
  if (event === 'POST_SUBMIT_GUARD_STARTED' || event === 'POST_SUBMIT_GUARD_FINISHED' || event === 'WORK_PROMPT_DETECTED' || event === 'WORK_PROMPT_CONTINUE_HERE_INVOKED' || event === 'WORK_PROMPT_DISMISS_CONFIRMED' || event === 'WORK_PROMPT_LOOP' || event === 'UNKNOWN_POST_SUBMIT_MODAL' || event === 'WORK_PROMPT_CONTINUE_HERE_NOT_CONFIRMED') {
    runtime.journal(event, payload)
  }
}

function blockPostSubmitRequest(runtime, requestId, event, payload) {
  if (typeof runtime.markExternalFailure !== 'function') return
  const detail = payload?.reason || payload?.modalName || event
  try {
    runtime.markExternalFailure({
      requestId,
      status: 'POST_SUBMIT_GUARD_BLOCKED',
      error: `${event}: ${String(detail).slice(0, 1800)}`,
    })
  } catch { /* Keep the guard fail-closed even with a diagnostic-only runtime. */ }
}

export function startPostSubmitGuard({ runtime, requestId, issueNumber, confirmation, spawn = spawnProcess, executable = process.env.DSH_POSTMAN_PWSH || 'pwsh.exe', guardPath = POST_SUBMIT_GUARD_PATH, deadlineSeconds = 1800 }) {
  const hostPid = Number(confirmation?.hostPid ?? confirmation?.hostPID)
  const hostHwnd = hostHwndArgument(confirmation?.hostHwnd)
  if (!Number.isSafeInteger(hostPid) || hostPid <= 0 || hostHwnd === null) return null

  let child
  try {
    child = spawn(executable, [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPath,
      '-HostPid', String(hostPid), '-HostHwnd', hostHwnd, '-RequestId', requestId,
      '-DeadlineSeconds', String(deadlineSeconds),
    ], {
      cwd: process.env.DSH_HOME || resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    runtime.journal('POST_SUBMIT_GUARD_FINISHED', { requestId, issueNumber, reason: `spawn_error:${String(error?.message ?? error)}`, exitCode: null })
    return null
  }
  const handle = { child, requestId, issueNumber, stopped: false, timer: null }
  guardSet(runtime).add(handle)
  journalGuardEvent(runtime, 'POST_SUBMIT_GUARD_STARTED', { requestId, issueNumber, hostPid, hostHwnd, deadlineSeconds })

  const stdout = createInterface({ input: child.stdout })
  stdout.on('line', (line) => {
    try {
      const event = JSON.parse(line)
      if (event?.requestId !== requestId || typeof event.event !== 'string') return
      const payload = { issueNumber, ...event }
      delete payload.event
      delete payload.timestamp
      journalGuardEvent(runtime, event.event, payload)
      if (['UNKNOWN_POST_SUBMIT_MODAL', 'WORK_PROMPT_LOOP', 'WORK_PROMPT_CONTINUE_HERE_NOT_CONFIRMED'].includes(event.event)) {
        blockPostSubmitRequest(runtime, requestId, event.event, payload)
        stopPostSubmitGuard(handle, 'guard_blocked')
      }
    } catch { /* Ignore non-JSON diagnostics from PowerShell. */ }
  })
  child.stderr?.on('data', (chunk) => {
    const error = String(chunk).trim().slice(0, 1000)
    if (error) runtime.journal('POST_SUBMIT_GUARD_STDERR', { requestId, issueNumber, error })
  })
  const finish = (reason, exitCode = null) => {
    if (handle.timer !== null) clearInterval(handle.timer)
    guardSet(runtime).delete(handle)
    if (reason !== null) journalGuardEvent(runtime, 'POST_SUBMIT_GUARD_FINISHED', { requestId, issueNumber, reason, exitCode })
  }
  child.once('error', (error) => finish(`spawn_error:${String(error?.message ?? error)}`))
  child.once('close', (code) => finish(handle.stopped ? 'stopped' : 'process_exit', code))
  handle.timer = setInterval(() => {
    const current = runtime.getRequest(requestId)
    if (current === undefined || ['READY', 'DELIVERING', 'DELIVERED', 'DELIVERY_RETRY', 'DELIVERY_BLOCKED_ORIGIN_MISSING', 'POST_SUBMIT_GUARD_BLOCKED'].includes(current.status)) {
      stopPostSubmitGuard(handle, current?.status === 'READY' ? 'external_ready' : 'request_terminal')
    }
  }, 500)
  handle.timer.unref?.()
  return handle
}

export function stopPostSubmitGuard(handle, reason = 'runtime_shutdown') {
  if (!handle || handle.stopped) return
  handle.stopped = true
  if (handle.timer !== null) clearInterval(handle.timer)
  try { handle.child.kill() } catch { /* The process may already have exited. */ }
}

export function stopPostSubmitGuards(runtime, reason = 'runtime_shutdown') {
  const guards = activePostSubmitGuards.get(runtime)
  if (guards === undefined) return
  for (const guard of [...guards]) stopPostSubmitGuard(guard, reason)
  guards.clear()
}

export async function createAndSubmitExternal({ runtime, request, runner, issueCreator = createGitHubIssue, submitter = submitChatGptTransport, postSubmitGuard = startPostSubmitGuard }) {
  const current = runtime.getRequest(request.request_id) ?? request
  let issue
  try {
    if (current.repository && Number.isSafeInteger(Number(current.issue_number)) && Number(current.issue_number) > 0) {
      issue = { repository: current.repository, issueNumber: Number(current.issue_number), reused: true }
    } else {
      issue = await issueCreator({ requestId: request.request_id, repository: GITHUB_REPOSITORY, runner })
      runtime.registerExternalIssue({ requestId: request.request_id, source: 'github-web-chatgpt', repository: issue.repository, issueNumber: issue.issueNumber })
    }
  } catch (error) {
    runtime.markExternalFailure({ requestId: request.request_id, status: 'ISSUE_CREATE_FAILED', error: error?.message ?? String(error) })
    return { status: 'ISSUE_CREATE_FAILED', request_id: request.request_id, error: error?.message ?? String(error) }
  }

  const prompt = buildChatGptTransportPrompt({ requestId: request.request_id, issueNumber: issue.issueNumber, repository: issue.repository, task: current.payload })
  runtime.journal('CHAT_SUBMIT_STARTED', { requestId: request.request_id, messageId: request.message_id, originAgentId: request.origin_agent_id, issueNumber: issue.issueNumber, repository: issue.repository, status: request.status })
  try {
    const confirmation = await submitter({ prompt, bridgePath: BRIDGE_PATH, runner })
    const confirmed = runtime.confirmExternalSubmission({ requestId: request.request_id, source: 'github-web-chatgpt' })
    runtime.journal('CHAT_SUBMIT_CONFIRMED', { requestId: request.request_id, messageId: request.message_id, originAgentId: request.origin_agent_id, issueNumber: issue.issueNumber, repository: issue.repository, status: confirmed.status, bridgeRunId: confirmation.runId ?? null })
    const guard = postSubmitGuard({ runtime, requestId: request.request_id, issueNumber: issue.issueNumber, confirmation })
    return { status: 'WAITING', request_id: request.request_id, issue_number: issue.issueNumber, repository: issue.repository, confirmation, postSubmitGuardStarted: guard !== null }
  } catch (error) {
    runtime.markExternalFailure({ requestId: request.request_id, status: 'CHAT_SUBMIT_FAILED', error: error?.message ?? String(error) })
    return { status: 'CHAT_SUBMIT_FAILED', request_id: request.request_id, issue_number: issue.issueNumber, repository: issue.repository, error: error?.message ?? String(error) }
  }
}
