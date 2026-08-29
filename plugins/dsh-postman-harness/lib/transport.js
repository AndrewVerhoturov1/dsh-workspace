import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
export const GITHUB_REPOSITORY = 'AndrewVerhoturov1/dsh-workspace'
const BRIDGE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../chatgpt-desktop-uia-bridge/chatgpt_chat.ps1')

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

export async function createAndSubmitExternal({ runtime, request, runner, issueCreator = createGitHubIssue, submitter = submitChatGptTransport }) {
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
    return { status: 'WAITING', request_id: request.request_id, issue_number: issue.issueNumber, repository: issue.repository, confirmation }
  } catch (error) {
    runtime.markExternalFailure({ requestId: request.request_id, status: 'CHAT_SUBMIT_FAILED', error: error?.message ?? String(error) })
    return { status: 'CHAT_SUBMIT_FAILED', request_id: request.request_id, issue_number: issue.issueNumber, repository: issue.repository, error: error?.message ?? String(error) }
  }
}
