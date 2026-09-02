'use strict'

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')

const DEFAULT_WORKING_DIRECTORY = process.env.DSH_WORKING_DIRECTORY || 'C:\\Users\\andre\\.dsh'
const DEFAULT_PROFILE = process.env.DSH_PROFILE || 'web'
const DEFAULT_PORT = Number(process.env.DSH_PORT || 4173)

class ProcessControllerError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ProcessControllerError'
    this.code = code
    Object.assign(this, details)
  }
}

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^"|"$/g, '').toLowerCase()
}

function createConfig(overrides = {}) {
  const workingDirectory = path.resolve(overrides.workingDirectory || DEFAULT_WORKING_DIRECTORY)
  const launcherRoot = path.resolve(overrides.launcherRoot || process.env.DSH_LAUNCHER_ROOT || path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'DeepSeekHarnessLauncher',
  ))
  const port = Number(overrides.port || DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Некорректный порт Harness: ${overrides.port}`)
  }
  return Object.freeze({
    workingDirectory,
    profile: overrides.profile || DEFAULT_PROFILE,
    port,
    launcherRoot,
    statePath: path.join(launcherRoot, 'dsh-runtime.json'),
    pidPath: path.join(launcherRoot, 'dsh.pid'),
    logPath: path.join(launcherRoot, 'logs', 'dsh-controller.log'),
    preserveChildren: overrides.preserveChildren ?? process.env.DSH_PRESERVE_CHILDREN === '1',
    startTimeoutMs: Number(overrides.startTimeoutMs || 45_000),
    stopTimeoutMs: Number(overrides.stopTimeoutMs || 8_000),
  })
}

function log(config, message) {
  try {
    fs.mkdirSync(path.dirname(config.logPath), { recursive: true })
    fs.appendFileSync(config.logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // Logging must never prevent lifecycle management.
  }
}

function readState(config) {
  try {
    const state = JSON.parse(fs.readFileSync(config.statePath, 'utf8'))
    if (!state || !Number.isInteger(Number(state.pid)) || Number(state.pid) <= 0) return null
    return { ...state, pid: Number(state.pid) }
  } catch {
    return null
  }
}

function writeState(config, state) {
  fs.mkdirSync(config.launcherRoot, { recursive: true })
  const payload = {
    pid: Number(state.pid),
    port: config.port,
    profile: config.profile,
    workingDirectory: config.workingDirectory,
    startedAt: state.startedAt || new Date().toISOString(),
  }
  const temporaryPath = `${config.statePath}.tmp-${process.pid}`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, config.statePath)
  fs.writeFileSync(config.pidPath, `${payload.pid}\n`, 'ascii')
  return payload
}

function clearState(config) {
  for (const statePath of [config.statePath, config.pidPath]) {
    try { fs.rmSync(statePath, { force: true }) } catch { }
  }
}

function commandOutput(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function resolveRuntime(config) {
  const shimOutput = process.platform === 'win32'
    ? commandOutput('where.exe', ['dsh.cmd'])
    : commandOutput('which', ['dsh'])
  const shimPath = shimOutput.split(/\r?\n/).find(Boolean)
  if (!shimPath) throw new ProcessControllerError('DSH_NOT_FOUND', 'Команда dsh не найдена в PATH.')

  const npmBinDirectory = path.dirname(shimPath)
  const candidateDshBin = path.join(npmBinDirectory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(candidateDshBin)) {
    throw new ProcessControllerError('DSH_NOT_FOUND', `Файл DSH не найден: ${candidateDshBin}`)
  }

  let nodePath = process.execPath
  const candidateNode = path.join(npmBinDirectory, process.platform === 'win32' ? 'node.exe' : 'node')
  if (fs.existsSync(candidateNode)) nodePath = candidateNode
  return {
    nodePath: path.resolve(nodePath),
    dshBin: path.resolve(candidateDshBin),
  }
}

function getProcessRecord(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return null
  if (process.platform === 'win32') {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\"`,
      'if ($null -ne $p) {',
      '  [pscustomobject]@{',
      '    pid = [int]$p.ProcessId',
      '    parentPid = [int]$p.ParentProcessId',
      '    executablePath = [string]$p.ExecutablePath',
      '    commandLine = [string]$p.CommandLine',
      '  } | ConvertTo-Json -Compress',
      '}',
    ].join('\n')
    try {
      const output = commandOutput('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
      return output ? JSON.parse(output) : null
    } catch {
      return null
    }
  }
  try {
    process.kill(Number(pid), 0)
    return { pid: Number(pid), commandLine: '' }
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false
  if (process.platform === 'win32') {
    try {
      const output = commandOutput('tasklist.exe', ['/FI', `PID eq ${Number(pid)}`, '/NH'])
      return new RegExp(`\\b${Number(pid)}\\b`).test(output)
    } catch {
      return false
    }
  }
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function listListeningPids(port) {
  if (process.platform !== 'win32') return []
  let output
  try {
    output = commandOutput('netstat.exe', ['-ano', '-p', 'tcp'])
  } catch {
    return []
  }
  const result = []
  const portPattern = new RegExp(`^\\s*TCP\\s+[^\\s:]+:${port}\\s+[^\\s]+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i')
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(portPattern)
    if (match && !result.includes(Number(match[1]))) result.push(Number(match[1]))
  }
  return result
}

function hasArgumentPair(commandLine, name, value) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedValue = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escapedName}(?:=|\\s+)['\"]?${escapedValue}['\"]?(?=\\s|$)`, 'i').test(commandLine)
}

function isDshHarnessProcess(record, runtime, config) {
  if (!record) return false
  const commandLine = String(record.commandLine || '').replaceAll('\\', '/')
  const dshBin = normalizePath(runtime.dshBin)
  return normalizePath(commandLine).includes(dshBin)
    && hasArgumentPair(commandLine, '--profile', config.profile)
    && hasArgumentPair(commandLine, '--port', config.port)
}

function probeHttp(config) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port: config.port, path: '/', timeout: 3_000 }, (response) => {
      const statusCode = Number(response.statusCode)
      response.resume()
      resolve(statusCode >= 200 && statusCode < 500)
    })
    request.on('error', () => resolve(false))
    request.setTimeout(3_000, () => { request.destroy(); resolve(false) })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(check, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  do {
    if (await check()) return true
    if (Date.now() >= deadline) break
    await sleep(intervalMs)
  } while (Date.now() < deadline)
  return Boolean(await check())
}

function createProcessController({ config: configOverrides = {}, runtime, deps = {} } = {}) {
  const config = createConfig(configOverrides)
  const resolvedRuntime = runtime || resolveRuntime(config)
  const operations = {
    getProcessRecord,
    isProcessAlive,
    listListeningPids,
    probeHttp,
    spawn,
    execFileSync,
    ...deps,
  }

  async function discover() {
    const state = readState(config)
    const listenerPids = operations.listListeningPids(config.port)
    const candidates = [...new Set([state?.pid, ...listenerPids].filter(Boolean))]
    for (const pid of candidates) {
      const record = operations.getProcessRecord(pid)
      if (isDshHarnessProcess(record, resolvedRuntime, config)) {
        return {
          status: 'RUNNING',
          pid: Number(pid),
          record,
          state,
          source: state?.pid === Number(pid) ? 'state' : 'listener',
          listening: listenerPids.includes(Number(pid)),
        }
      }
    }
    const foreignPid = listenerPids.find((pid) => operations.getProcessRecord(pid))
    if (foreignPid) {
      return {
        status: 'PORT_OCCUPIED_BY_FOREIGN_PROCESS',
        pid: Number(foreignPid),
        record: operations.getProcessRecord(foreignPid),
        state,
      }
    }
    return { status: 'NOT_RUNNING', state }
  }

  function adopt(found) {
    return writeState(config, {
      pid: found.pid,
      startedAt: found.state?.startedAt,
    })
  }

  async function waitForReady(pid) {
    const httpReady = await waitUntil(() => operations.probeHttp(config), config.startTimeoutMs)
    if (!httpReady) return null
    const found = await discover()
    if (found.status === 'RUNNING') return found.pid
    return isDshHarnessProcess(operations.getProcessRecord(pid), resolvedRuntime, config) ? pid : null
  }

  async function start() {
    const found = await discover()
    if (found.status === 'PORT_OCCUPIED_BY_FOREIGN_PROCESS') {
      throw new ProcessControllerError('PORT_OCCUPIED_BY_FOREIGN_PROCESS', `Порт ${config.port} занят чужим процессом PID ${found.pid}.`, { pid: found.pid })
    }
    if (found.status === 'RUNNING') {
      adopt(found)
      if (!(await waitForReady(found.pid))) {
        throw new ProcessControllerError('DSH_NOT_READY', `DSH PID ${found.pid} существует, но Web UI не отвечает.`)
      }
      return { status: 'ALREADY_RUNNING', pid: found.pid, adopted: found.source !== 'state' }
    }

    const child = operations.spawn(resolvedRuntime.nodePath, [
      '--expose-internals',
      resolvedRuntime.dshBin,
      '--profile', config.profile,
      '--port', String(config.port),
      '--no-open',
    ], {
      cwd: config.workingDirectory,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    child.unref()
    writeState(config, { pid: child.pid })
    const readyPid = await waitForReady(child.pid)
    if (!readyPid) {
      const foundAfterFailure = await discover()
      if (foundAfterFailure.status === 'RUNNING') {
        await terminateProcess(foundAfterFailure.pid)
      } else {
        const record = operations.getProcessRecord(child.pid)
        if (isDshHarnessProcess(record, resolvedRuntime, config)) await terminateProcess(child.pid)
      }
      clearState(config)
      throw new ProcessControllerError('DSH_NOT_READY', `DSH не запустил Web UI за ${config.startTimeoutMs} мс.`)
    }
    writeState(config, { pid: readyPid })
    log(config, `Started DSH PID ${readyPid} on port ${config.port}`)
    return { status: 'STARTED', pid: readyPid }
  }

  async function terminateProcess(pid) {
    if (process.platform === 'win32') {
      const gracefulArguments = ['/PID', String(pid)]
      if (!config.preserveChildren) gracefulArguments.push('/T')
      try { operations.execFileSync('taskkill.exe', gracefulArguments, { stdio: 'ignore', windowsHide: true }) } catch { }
      let stopped = await waitUntil(() => !operations.isProcessAlive(pid), config.stopTimeoutMs)
      if (!stopped) {
        const forceArguments = ['/F', '/PID', String(pid)]
        if (!config.preserveChildren) forceArguments.push('/T')
        try { operations.execFileSync('taskkill.exe', forceArguments, { stdio: 'ignore', windowsHide: true }) } catch { }
        stopped = await waitUntil(() => !operations.isProcessAlive(pid), config.stopTimeoutMs)
      }
      if (!stopped) throw new ProcessControllerError('STOP_TIMEOUT', `Не удалось остановить доказанный DSH PID ${pid}.`)
      return
    }
    try { process.kill(pid, 'SIGTERM') } catch { }
    const stopped = await waitUntil(() => !operations.isProcessAlive(pid), config.stopTimeoutMs)
    if (!stopped) throw new ProcessControllerError('STOP_TIMEOUT', `Не удалось остановить DSH PID ${pid}.`)
  }

  async function stop() {
    const found = await discover()
    if (found.status === 'PORT_OCCUPIED_BY_FOREIGN_PROCESS') {
      throw new ProcessControllerError('PORT_OCCUPIED_BY_FOREIGN_PROCESS', `Порт ${config.port} занят чужим процессом PID ${found.pid}; остановка отменена.`, { pid: found.pid })
    }
    if (found.status === 'NOT_RUNNING') {
      clearState(config)
      return { status: 'ALREADY_STOPPED' }
    }
    await terminateProcess(found.pid)
    const portClosed = await waitUntil(() => operations.listListeningPids(config.port).length === 0, config.stopTimeoutMs)
    if (!portClosed) throw new ProcessControllerError('PORT_STILL_OPEN', `DSH PID ${found.pid} остановлен, но порт ${config.port} ещё занят.`)
    clearState(config)
    log(config, `Stopped DSH PID ${found.pid}`)
    return { status: 'STOPPED', pid: found.pid }
  }

  async function restart() {
    const before = await discover()
    if (before.status === 'PORT_OCCUPIED_BY_FOREIGN_PROCESS') {
      throw new ProcessControllerError('PORT_OCCUPIED_BY_FOREIGN_PROCESS', `Порт ${config.port} занят чужим процессом PID ${before.pid}; перезапуск отменён.`)
    }
    const stopped = await stop()
    const started = await start()
    if (before.status === 'RUNNING' && stopped.pid === started.pid) {
      throw new ProcessControllerError('PID_NOT_CHANGED', `Перезапуск не сменил PID ${started.pid}.`)
    }
    return { status: before.status === 'RUNNING' ? 'RESTARTED' : 'STARTED', oldPid: stopped.pid, pid: started.pid }
  }

  return Object.freeze({ config, runtime: resolvedRuntime, discover, start, stop, restart, adopt })
}

function parseArgs(argv) {
  const [action = 'start', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    options[name] = rest[index + 1] && !rest[index + 1].startsWith('--') ? rest[++index] : true
  }
  return {
    action,
    config: {
      workingDirectory: options.cwd,
      launcherRoot: options['launcher-root'],
      profile: options.profile,
      port: options.port ? Number(options.port) : undefined,
      preserveChildren: options['preserve-children'] === undefined
        ? undefined
        : options['preserve-children'] === true || options['preserve-children'] === '1',
    },
  }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv)
  const controller = createProcessController({ config: parsed.config })
  if (parsed.action === 'start') return controller.start()
  if (parsed.action === 'stop') return controller.stop()
  if (parsed.action === 'restart') return controller.restart()
  if (parsed.action === 'discover') return controller.discover()
  throw new ProcessControllerError('INVALID_ACTION', `Неизвестная операция: ${parsed.action}`)
}

if (require.main === module) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }).catch((error) => {
    const payload = { status: 'FAILED', code: error.code || 'ERROR', error: error.message }
    process.stderr.write(`${JSON.stringify(payload)}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  DEFAULT_PORT,
  ProcessControllerError,
  createConfig,
  createProcessController,
  hasArgumentPair,
  isDshHarnessProcess,
  parseArgs,
  readState,
  writeState,
  clearState,
}
