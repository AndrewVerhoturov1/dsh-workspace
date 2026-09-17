import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isolatedLaunchEnvironment } from './credentials-policy.ts'

export interface ProcessRecord {
  readonly pid: number
  readonly executablePath: string
  readonly commandLine: string
}

export interface ControllerState {
  readonly runtimeId: string
  readonly pid: number
  readonly port: number
  readonly profile: string
  readonly cwd: string
  readonly home: string
  readonly launcherRoot: string
  readonly dshBin: string
  readonly nodePath: string
  readonly logPath: string
  readonly startedAt: string
}

export interface ControllerLaunchResult {
  readonly pid: number
  readonly port: number
  readonly authenticatedUrl: string
  readonly logPath: string
}

export type ControllerStatus =
  | { readonly state: 'RUNNING'; readonly controller: ControllerState; readonly authenticatedUrl?: string | undefined }
  | { readonly state: 'STOPPED'; readonly controller?: ControllerState }
  | { readonly state: 'FOREIGN_PROCESS'; readonly controller: ControllerState; readonly process?: ProcessRecord }

/** Small process controller scoped to one runtime launcher root; never scans or kills unrelated DSH instances. */
export class BranchRuntimeController {
  private readonly startTimeoutMs: number
  private readonly stopTimeoutMs: number

  constructor(startTimeoutMs = 60_000, stopTimeoutMs = 8_000) {
    this.startTimeoutMs = startTimeoutMs
    this.stopTimeoutMs = stopTimeoutMs
  }

  async start(input: {
    readonly runtimeId: string
    readonly cwd: string
    readonly home: string
    readonly launcherRoot: string
    readonly profile: string
    readonly port: number
  }): Promise<ControllerLaunchResult> {
    mkdirSync(input.launcherRoot, { recursive: true })
    const statePath = join(input.launcherRoot, 'dsh-runtime.json')
    if (existsSync(statePath)) {
      const current = this.status(input.launcherRoot)
      if (current.state === 'RUNNING') throw new Error('branch runtime: controller is already running')
      if (current.state === 'FOREIGN_PROCESS') throw new Error('branch runtime: stale launcher state points at a foreign process')
      rmSync(statePath, { force: true })
      rmSync(join(input.launcherRoot, 'dsh.pid'), { force: true })
    }
    if (listeningPids(input.port).length > 0) throw new Error(`branch runtime: port ${String(input.port)} is already in use`)

    const runtime = resolveDshRuntime()
    const logPath = join(input.launcherRoot, 'logs', 'dsh.log')
    mkdirSync(dirname(logPath), { recursive: true })
    const stdoutFd = openSync(logPath, 'a')
    const stderrFd = openSync(logPath, 'a')
    let child
    try {
      child = spawn(runtime.nodePath, [
        '--expose-internals',
        runtime.dshBin,
        '--profile', input.profile,
        '--port', String(input.port),
        '--no-open',
      ], {
        cwd: input.cwd,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        env: isolatedLaunchEnvironment(input.home),
      })
      child.unref()
    } finally {
      closeSync(stdoutFd)
      closeSync(stderrFd)
    }
    if (child.pid === undefined || child.pid <= 0) throw new Error('branch runtime: DSH process did not expose a PID')

    const controller: ControllerState = {
      runtimeId: input.runtimeId,
      pid: child.pid,
      port: input.port,
      profile: input.profile,
      cwd: resolve(input.cwd),
      home: resolve(input.home),
      launcherRoot: resolve(input.launcherRoot),
      dshBin: runtime.dshBin,
      nodePath: runtime.nodePath,
      logPath,
      startedAt: new Date().toISOString(),
    }
    writeControllerState(controller)

    const deadline = Date.now() + this.startTimeoutMs
    let authenticatedUrl: string | undefined
    try {
      do {
        const record = processRecord(controller.pid)
        if (record === undefined) break
        if (!isExpectedProcessRecord(record, controller)) {
          throw new Error('branch runtime: spawned PID no longer matches the expected DSH command')
        }
        authenticatedUrl = readAuthenticatedUrl(logPath, input.port)
        const listeners = listeningPids(input.port)
        if (authenticatedUrl !== undefined && listeners.includes(controller.pid)) {
          return { pid: controller.pid, port: controller.port, authenticatedUrl, logPath }
        }
        await sleep(200)
      } while (Date.now() < deadline)
    } catch (error) {
      await this.cleanupFailedStart(controller).catch(() => {})
      throw error
    }

    await this.cleanupFailedStart(controller).catch(() => {})
    throw new Error(`branch runtime: DSH did not become ready on port ${String(input.port)}`)
  }

  status(launcherRoot: string): ControllerStatus {
    const controller = readControllerState(launcherRoot)
    if (controller === undefined) return { state: 'STOPPED' }
    const record = processRecord(controller.pid)
    if (record === undefined) return { state: 'STOPPED', controller }
    if (!isExpectedProcessRecord(record, controller)) return { state: 'FOREIGN_PROCESS', controller, process: record }
    const listeners = listeningPids(controller.port)
    if (!canTerminateNormally(record, controller, listeners)) return { state: 'FOREIGN_PROCESS', controller, process: record }
    return { state: 'RUNNING', controller, authenticatedUrl: readAuthenticatedUrl(controller.logPath, controller.port) }
  }

  async stop(launcherRoot: string): Promise<void> {
    const current = this.status(launcherRoot)
    if (current.state === 'STOPPED') {
      clearControllerState(launcherRoot)
      return
    }
    if (current.state === 'FOREIGN_PROCESS') {
      throw new Error('branch runtime: refusing to stop a process whose identity cannot be proven')
    }
    const pid = current.controller.pid
    await terminateProcess(pid, this.stopTimeoutMs)
    if (listeningPids(current.controller.port).length > 0) {
      throw new Error(`branch runtime: port ${String(current.controller.port)} remained occupied after stop`)
    }
    clearControllerState(launcherRoot)
  }

  private async cleanupFailedStart(expected: ControllerState): Promise<boolean> {
    const current = readControllerState(expected.launcherRoot)
    if (!sameControllerState(current, expected)) return false
    const record = processRecord(expected.pid)
    if (record === undefined) {
      clearControllerState(expected.launcherRoot)
      return true
    }
    if (!canTerminateFailedStart(current, expected, record)) return false
    await terminateProcess(expected.pid, this.stopTimeoutMs)
    clearControllerState(expected.launcherRoot)
    return true
  }
}

export function findFreePort(start = 4174, end = 4214): number {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
    throw new Error('branch runtime: invalid port range')
  }
  for (let port = start; port <= end; port += 1) {
    if (listeningPids(port).length === 0) return port
  }
  throw new Error(`branch runtime: no free port in ${String(start)}-${String(end)}`)
}

/** Pure command-line identity check used by tests and stop safety. */
export function isExpectedProcessRecord(record: ProcessRecord, expected: {
  readonly pid: number
  readonly port: number
  readonly profile: string
  readonly dshBin: string
  readonly nodePath: string
}): boolean {
  if (record.pid !== expected.pid) return false
  const command = normalize(record.commandLine)
  if (!command.includes(normalize(expected.dshBin))) return false
  if (!normalize(record.executablePath).includes(normalize(expected.nodePath))) return false
  return hasArgumentPair(record.commandLine, '--profile', expected.profile)
    && hasArgumentPair(record.commandLine, '--port', String(expected.port))
}

/** Normal stop additionally requires listener ownership; failed-start cleanup does not. */
export function canTerminateNormally(
  record: ProcessRecord | undefined,
  expected: ControllerState,
  listeners: readonly number[],
): boolean {
  return record !== undefined && isExpectedProcessRecord(record, expected) && listeners.includes(expected.pid)
}

/** Fail-closed decision for the child recorded by this exact start attempt. */
export function canTerminateFailedStart(
  launcherState: ControllerState | undefined,
  expected: ControllerState,
  record: ProcessRecord | undefined,
): boolean {
  return record !== undefined && sameControllerState(launcherState, expected) && isExpectedProcessRecord(record, expected)
}

function sameControllerState(left: ControllerState | undefined, right: ControllerState): boolean {
  return left !== undefined
    && left.runtimeId === right.runtimeId
    && left.pid === right.pid
    && left.port === right.port
    && left.profile === right.profile
    && left.cwd === right.cwd
    && left.home === right.home
    && left.launcherRoot === right.launcherRoot
    && left.dshBin === right.dshBin
    && left.nodePath === right.nodePath
    && left.logPath === right.logPath
    && left.startedAt === right.startedAt
}

function resolveDshRuntime(): { readonly nodePath: string; readonly dshBin: string } {
  const shim = process.platform === 'win32'
    ? firstLine(execText('where.exe', ['dsh.cmd']))
    : firstLine(execText('which', ['dsh']))
  if (shim === undefined) throw new Error('branch runtime: dsh executable was not found in PATH')
  const npmBin = dirname(shim)
  const dshBin = resolve(npmBin, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(dshBin)) throw new Error(`branch runtime: DSH entry was not found: ${dshBin}`)
  const candidateNode = resolve(npmBin, process.platform === 'win32' ? 'node.exe' : 'node')
  return { nodePath: existsSync(candidateNode) ? candidateNode : process.execPath, dshBin }
}

function readAuthenticatedUrl(logPath: string, expectedPort: number): string | undefined {
  if (!existsSync(logPath)) return undefined
  const text = readFileSync(logPath, 'utf8')
  const pattern = /dsh web:\s+(https?:\/\/127\.0\.0\.1:(\d+)\/\?token=[^\s()]+)/gu
  let match: RegExpExecArray | null
  let last: string | undefined
  while ((match = pattern.exec(text)) !== null) {
    const url = match[1]
    if (url !== undefined && Number(match[2]) === expectedPort) last = url
  }
  return last
}

function writeControllerState(state: ControllerState): void {
  const statePath = join(state.launcherRoot, 'dsh-runtime.json')
  mkdirSync(state.launcherRoot, { recursive: true })
  const temporary = `${statePath}.tmp-${String(process.pid)}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, statePath)
  writeFileSync(join(state.launcherRoot, 'dsh.pid'), `${String(state.pid)}\n`, 'ascii')
}

function readControllerState(launcherRoot: string): ControllerState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(launcherRoot, 'dsh-runtime.json'), 'utf8')) as ControllerState
    if (!parsed || typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return undefined
    return parsed
  } catch { return undefined }
}

function clearControllerState(launcherRoot: string): void {
  rmSync(join(launcherRoot, 'dsh-runtime.json'), { force: true })
  rmSync(join(launcherRoot, 'dsh.pid'), { force: true })
}

async function terminateProcess(pid: number, timeoutMs: number): Promise<void> {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    if (!(await waitUntil(() => processRecord(pid) === undefined, timeoutMs))) {
      try { execFileSync('taskkill.exe', ['/F', '/PID', String(pid), '/T'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    }
  } else {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  if (!(await waitUntil(() => processRecord(pid) === undefined, timeoutMs))) {
    throw new Error(`branch runtime: timed out stopping PID ${String(pid)}`)
  }
}

function processRecord(pid: number): ProcessRecord | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform !== 'win32') {
    try { process.kill(pid, 0); return { pid, executablePath: '', commandLine: '' } } catch { return undefined }
  }
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter \"ProcessId=${String(pid)}\"`,
    'if ($null -ne $p) {',
    '  [pscustomobject]@{',
    '    pid = [int]$p.ProcessId',
    '    executablePath = [string]$p.ExecutablePath',
    '    commandLine = [string]$p.CommandLine',
    '  } | ConvertTo-Json -Compress',
    '}',
  ].join('\n')
  try {
    const text = execText('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
    return text.trim() === '' ? undefined : JSON.parse(text) as ProcessRecord
  } catch { return undefined }
}

function listeningPids(port: number): number[] {
  if (process.platform !== 'win32') return []
  let text: string
  try { text = execText('netstat.exe', ['-ano', '-p', 'tcp']) } catch { return [] }
  const result = new Set<number>()
  const pattern = new RegExp(`^\\s*TCP\\s+[^\\s:]+:${String(port)}\\s+[^\\s]+\\s+LISTENING\\s+(\\d+)\\s*$`, 'iu')
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(pattern)
    if (match !== null) result.add(Number(match[1]))
  }
  return [...result]
}

function execText(file: string, args: readonly string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
}

function hasArgumentPair(commandLine: string, name: string, value: string): boolean {
  const escapedName = escapeRegex(name)
  const escapedValue = escapeRegex(value)
  return new RegExp(`(?:^|\\s)${escapedName}(?:=|\\s+)[\"']?${escapedValue}[\"']?(?=\\s|$)`, 'iu').test(commandLine)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function normalize(value: string): string {
  const normalized = value.replaceAll('\\', '/').toLowerCase()
  return normalized.replace(/^"|"$/gu, '')
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/u).map(line => line.trim()).find(Boolean)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  do {
    if (check()) return true
    await sleep(100)
  } while (Date.now() < deadline)
  return check()
}
