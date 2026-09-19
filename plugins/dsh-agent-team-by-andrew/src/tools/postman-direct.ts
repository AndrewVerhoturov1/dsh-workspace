import { randomInt } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

export interface DirectPostmanBridgeResult {
  readonly ok: boolean
  readonly requestId: string
  readonly state: string
  readonly code: string
  readonly resultZip?: string
  readonly resultHandoffPath?: string
  readonly conversationUrl?: string
  readonly conversationId?: string
  readonly continuedFromRequestId?: string
  readonly errorCode?: string
  readonly error?: string
}

export interface DirectPostmanInvocation {
  readonly task: string
  readonly chatRequestId?: string
  readonly signal?: AbortSignal
}

export type DirectPostmanInvoker = (request: DirectPostmanInvocation) => Promise<DirectPostmanBridgeResult>

const REQUEST_ID_PATTERN = /^REQ_\d{8}T\d{6}Z_\d{4}$/
const MAX_STDOUT_CHARS = 2_000_000
const MAX_STDERR_CHARS = 100_000

function appendTail(current: string, chunk: string, limit: number): string {
  const next = current + chunk
  return next.length <= limit ? next : next.slice(next.length - limit)
}

function directRoot(): string {
  const local = process.env.LOCALAPPDATA
  return local === undefined || local.trim() === ''
    ? path.join(homedir(), '.dsh', 'postman', 'direct')
    : path.join(local, 'DSH', 'Postman', 'direct')
}

export function resolveDirectPostmanBridgePath(cwd: string = process.cwd()): string {
  return path.join(cwd, 'postman', 'direct', 'postman.ps1')
}

function powershellBinary(): string {
  return process.env.DSH_POSTMAN_POWERSHELL?.trim() || 'powershell.exe'
}

function utcStamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function allocatePostmanRequestId(): Promise<string> {
  const root = directRoot()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestId = `REQ_${utcStamp()}_${String(randomInt(0, 10_000)).padStart(4, '0')}`
    if (!await pathExists(path.join(root, 'requests', `${requestId}.json`))) return requestId
  }
  throw new Error('POSTMAN_REQUEST_ID_COLLISION')
}

function parseTerminal(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim()
  if (trimmed === '') return undefined
  try {
    const value = JSON.parse(trimmed)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    const lines = trimmed.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim()
      // Only the final nonempty record is authoritative; never revive an older success.
      if (!line.startsWith('{')) return undefined
      try {
        const value = JSON.parse(line)
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

function normalizeTerminal(
  value: Record<string, unknown> | undefined,
  requestId: string,
  exitCode: number | null,
  stderr: string,
): DirectPostmanBridgeResult {
  if (value === undefined) {
    return {
      ok: false,
      requestId,
      state: 'FAILED',
      code: 'POSTMAN_RESULT_JSON_INVALID',
      errorCode: 'POSTMAN_RESULT_JSON_INVALID',
      error: `Direct Postman returned no parseable JSON (exit ${exitCode ?? 'unknown'}).${stderr === '' ? '' : ` ${stderr.slice(-2_000)}`}`,
    }
  }
  const terminalRequestId = stringField(value, 'requestId')
  const ok = value['ok'] === true
  const code = stringField(value, 'code') ?? 'DIRECT_POSTMAN_FAILED'
  const state = stringField(value, 'state') ?? 'FAILED'
  const result: DirectPostmanBridgeResult = {
    ok,
    requestId: terminalRequestId ?? requestId,
    state,
    code,
    ...(stringField(value, 'resultZip') === undefined ? {} : { resultZip: stringField(value, 'resultZip')! }),
    ...(stringField(value, 'resultHandoffPath') === undefined ? {} : { resultHandoffPath: stringField(value, 'resultHandoffPath')! }),
    ...(stringField(value, 'conversationUrl') === undefined ? {} : { conversationUrl: stringField(value, 'conversationUrl')! }),
    ...(stringField(value, 'conversationId') === undefined ? {} : { conversationId: stringField(value, 'conversationId')! }),
    ...(stringField(value, 'continuedFromRequestId') === undefined ? {} : { continuedFromRequestId: stringField(value, 'continuedFromRequestId')! }),
    ...ok ? {} : {
      errorCode: code,
      error: stringField(value, 'error') ?? (stderr.trim() === '' ? `Direct Postman failed with exit ${exitCode ?? 'unknown'}` : stderr.trim().slice(-2_000)),
    },
  }
  if ((ok || terminalRequestId !== undefined) && terminalRequestId !== requestId) {
    return {
      ok: false,
      requestId,
      state: 'FAILED',
      code: 'POSTMAN_REQUEST_ID_MISMATCH',
      errorCode: 'POSTMAN_REQUEST_ID_MISMATCH',
      error: `Direct Postman returned requestId ${terminalRequestId} for expected ${requestId}`,
    }
  }
  if (ok && (code !== 'RESULT_DURABLE' || state !== 'RESULT_DURABLE'
    || result.resultZip === undefined || result.resultHandoffPath === undefined)) {
    return {
      ok: false,
      requestId,
      state: 'FAILED',
      code: 'POSTMAN_RESULT_NOT_DURABLE',
      errorCode: 'POSTMAN_RESULT_NOT_DURABLE',
      error: `Direct Postman terminal result was not exact RESULT_DURABLE (${code}/${state})`,
    }
  }
  return result
}

/** Invoke the canonical Direct Postman PowerShell entrypoint without putting the user task on the process command line. */
export async function invokeDirectPostman(request: DirectPostmanInvocation): Promise<DirectPostmanBridgeResult> {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      requestId: 'REQ_00000000T000000Z_0000',
      state: 'FAILED',
      code: 'POSTMAN_WINDOWS_REQUIRED',
      errorCode: 'POSTMAN_WINDOWS_REQUIRED',
      error: 'Direct Postman bridge is configured for the Windows Harness runtime.',
    }
  }
  if (request.signal?.aborted === true) throw request.signal.reason ?? new Error('Postman bridge cancelled before start')
  if (request.task.trim() === '') throw new Error('Postman bridge task must not be empty')
  if (request.chatRequestId !== undefined && !REQUEST_ID_PATTERN.test(request.chatRequestId)) {
    throw new Error('chatRequestId must be a canonical REQ_YYYYMMDDTHHMMSSZ_NNNN value')
  }

  const bridge = resolveDirectPostmanBridgePath()
  if (!await pathExists(bridge)) {
    const requestId = await allocatePostmanRequestId()
    return {
      ok: false,
      requestId,
      state: 'FAILED',
      code: 'POSTMAN_DIRECT_BRIDGE_MISSING',
      errorCode: 'POSTMAN_DIRECT_BRIDGE_MISSING',
      error: `Direct Postman bridge not found: ${bridge}`,
    }
  }

  const requestId = await allocatePostmanRequestId()
  const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-team-postman-'))
  const taskFile = path.join(tempDir, 'task.txt')
  try {
  await writeFile(taskFile, request.task, { encoding: 'utf8' })
  const env = {
    ...process.env,
    ATG_POSTMAN_BRIDGE: bridge,
    ATG_POSTMAN_REQUEST_ID: requestId,
    ATG_POSTMAN_TASK_FILE: taskFile,
    // Clear inherited transport state: a normal request must never continue an old chat.
    ATG_POSTMAN_CHAT_REQUEST_ID: request.chatRequestId ?? '',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  const wrapper = String.raw`$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$task = [System.IO.File]::ReadAllText($env:ATG_POSTMAN_TASK_FILE, $utf8)
if ([string]::IsNullOrWhiteSpace($env:ATG_POSTMAN_CHAT_REQUEST_ID)) {
  & $env:ATG_POSTMAN_BRIDGE -RequestId $env:ATG_POSTMAN_REQUEST_ID -Task $task
} else {
  & $env:ATG_POSTMAN_BRIDGE -RequestId $env:ATG_POSTMAN_REQUEST_ID -ChatRequestId $env:ATG_POSTMAN_CHAT_REQUEST_ID -Task $task
}
exit $LASTEXITCODE
`

    request.signal?.throwIfAborted()
    let settled: { exitCode: number | null; stdout: string; stderr: string }
    try {
      settled = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(powershellBinary(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
          env,
          cwd: process.cwd(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', chunk => { stdout = appendTail(stdout, String(chunk), MAX_STDOUT_CHARS) })
        child.stderr.on('data', chunk => { stderr = appendTail(stderr, String(chunk), MAX_STDERR_CHARS) })
        child.once('error', reject)
        child.once('close', code => resolve({ exitCode: code, stdout, stderr }))
        // EPIPE must become a transport failure rather than an unhandled process error.
        child.stdin.once('error', reject)
        child.stdin.end(wrapper)
      })
    } catch (error: unknown) {
      return {
        ok: false,
        requestId,
        state: 'FAILED',
        code: 'POSTMAN_INVOCATION_NOT_STARTED',
        errorCode: 'POSTMAN_INVOCATION_NOT_STARTED',
        error: error instanceof Error ? error.message : String(error),
      }
    }
    const terminal = normalizeTerminal(parseTerminal(settled.stdout), requestId, settled.exitCode, settled.stderr)
    if (terminal.ok && settled.exitCode !== 0) {
      return {
        ok: false,
        requestId,
        state: 'FAILED',
        code: 'POSTMAN_PROCESS_EXIT_NONZERO',
        errorCode: 'POSTMAN_PROCESS_EXIT_NONZERO',
        error: `Direct Postman reported success but PowerShell exited with ${settled.exitCode ?? 'unknown'}.`,
      }
    }
    return terminal
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export interface CapabilityToolOptions {
  readonly name: string
  readonly parent: Agent
  readonly task: string
  readonly chatRequestId?: string
  readonly invoke?: DirectPostmanInvoker
  readonly isAuthorizedChild: (agent: Agent) => boolean
  readonly onResult: (result: DirectPostmanBridgeResult) => void
}

/** One-shot internal tool exposed only while one Postman Bridge child is running. */
export function createPostmanDirectCapabilityTool(options: CapabilityToolOptions) {
  let consumed = false
  const invoke = options.invoke ?? invokeDirectPostman
  return defineTool({
    name: options.name,
    description: 'Internal one-shot Direct Postman capability. Call exactly once, then return its JSON result unchanged.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          requestId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          code: { type: 'string', required: true },
          resultZip: { type: 'string' },
          resultHandoffPath: { type: 'string' },
          conversationUrl: { type: 'string' },
          conversationId: { type: 'string' },
          continuedFromRequestId: { type: 'string' },
          errorCode: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('internal Postman capability requires a calling child agent')
      const header = exec.agent.session.header
      if (header.origin !== 'subagent' || (header.delegationDepth ?? 0) < 1) {
        throw new Error('internal Postman capability is restricted to delegated child agents')
      }
      if (header.parentSession !== options.parent.id) {
        throw new Error('internal Postman capability belongs to a different parent session')
      }
      if (!options.isAuthorizedChild(exec.agent)) {
        throw new Error('internal Postman capability belongs to a different Bridge child')
      }
      if (consumed) throw new Error('internal Postman capability is one-shot and was already consumed')
      consumed = true
      const result = await invoke({
        task: options.task,
        ...(options.chatRequestId === undefined ? {} : { chatRequestId: options.chatRequestId }),
        signal: exec.signal,
      })
      options.onResult(result)
      return result
    },
  })
}
