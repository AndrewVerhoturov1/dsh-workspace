'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { execFileSync } = require('node:child_process')

const { createProcessController } = require('./dsh-process-controller.js')

const runtime = {
  nodePath: 'C:/Program Files/nodejs/node.exe',
  dshBin: 'C:/Users/andre/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js',
}

test('Windows launcher passes the enabled system proxy to Node and keeps loopback direct', { skip: process.platform !== 'win32' }, () => {
  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-proxy-launcher-'))
  const controllerPath = path.join(launcherRoot, 'inspect-env.js')
  const quote = value => `'${String(value).replaceAll("'", "''")}'`
  fs.writeFileSync(controllerPath, `console.log(JSON.stringify({
    https: process.env.HTTPS_PROXY || null,
    http: process.env.HTTP_PROXY || null,
    enabled: process.env.NODE_USE_ENV_PROXY || null,
    bypass: process.env.NO_PROXY || null,
  }))`)
  const baseEnv = { ...process.env, DSH_LAUNCHER_ROOT: launcherRoot, DSH_WORKING_DIRECTORY: launcherRoot, DSH_REQUIRE_PROFILE_INSTALL: '0' }
  for (const key of Object.keys(baseEnv)) {
    if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)) delete baseEnv[key]
  }
  const cases = [
    { system: '127.0.0.1:18080', enabled: 1, https: 'http://127.0.0.1:18080' },
    { system: 'http=127.0.0.1:18080;https=127.0.0.1:18081', enabled: 1, https: 'http://127.0.0.1:18081' },
    { system: '127.0.0.1:18080', enabled: 0, https: null },
    { system: 'http=127.0.0.1:18080', enabled: 1, https: null },
    { system: '127.0.0.1:18080', enabled: 1, env: { HTTPS_PROXY: 'http://explicit.invalid:18082', NO_PROXY: 'internal.invalid' }, https: 'http://explicit.invalid:18082' },
    { system: '127.0.0.1:18080', enabled: 1, env: { HTTP_PROXY: 'http://explicit.invalid:18082', NODE_USE_ENV_PROXY: '0' }, https: null },
    { system: '127.0.0.1:18080', enabled: 1, action: 'discover', https: null },
  ]
  try {
    for (const entry of cases) {
      const script = `
        $ErrorActionPreference = 'Stop'
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $script:proxySettings = @{ ProxyEnable = ${entry.enabled}; ProxyServer = ${quote(entry.system)} }
        function Get-ItemPropertyValue {
          [CmdletBinding()] param([string]$LiteralPath, [string]$Name)
          return $script:proxySettings[$Name]
        }
        . ${quote(path.join(__dirname, 'DSH-Common.ps1'))}
        $script:ControllerPath = ${quote(controllerPath)}
        function Resolve-ControllerRuntime { [pscustomobject]@{ NodePath = ${quote(process.execPath)} } }
        Invoke-DshController -Action ${quote(entry.action || 'start')}
      `
      const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8', windowsHide: true, env: { ...baseEnv, ...entry.env },
      })
      const child = JSON.parse(output.trim())
      assert.equal(child.https, entry.https)
      assert.equal(child.http, entry.env?.HTTP_PROXY || null)
      const hasProxy = Boolean(entry.https || entry.env?.HTTP_PROXY)
      assert.equal(child.enabled, hasProxy ? entry.env?.NODE_USE_ENV_PROXY || '1' : null)
      if (hasProxy) {
        for (const host of ['localhost', '127.0.0.1', '::1']) assert.ok(child.bypass.split(',').includes(host))
        if (entry.env?.NO_PROXY) assert.ok(child.bypass.split(',').includes(entry.env.NO_PROXY))
      } else assert.equal(child.bypass, null)
    }
  } finally {
    fs.rmSync(launcherRoot, { recursive: true, force: true })
  }
})

test('preview controller starts with isolated cwd, port, state root and inherited runtime identity', async () => {
  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-launcher-'))
  const workingDirectory = 'C:\\Users\\andre\\.dsh-preview'
  const records = new Map()
  const listenerPids = []
  let spawnArgs = null
  let spawnOptions = null

  const config = {
    workingDirectory,
    profile: 'web',
    port: 4174,
    launcherRoot,
    startTimeoutMs: 100,
    stopTimeoutMs: 100,
  }
  const deps = {
    getProcessRecord: (pid) => records.get(Number(pid)) || null,
    isProcessAlive: (pid) => records.has(Number(pid)),
    listListeningPids: () => [...listenerPids],
    probeHttp: async () => true,
    spawn: (_node, args, options) => {
      spawnArgs = [...args]
      spawnOptions = options
      const pid = 7401
      records.set(pid, {
        pid,
        commandLine: `"${runtime.nodePath}" --expose-internals ${runtime.dshBin} --profile web --port 4174 --no-open`,
      })
      listenerPids.push(pid)
      return { pid, unref() {} }
    },
    execFileSync: () => {},
  }

  try {
    const controller = createProcessController({ config, runtime, deps })
    const result = await controller.start()
    assert.equal(result.status, 'STARTED')
    assert.equal(result.pid, 7401)
    assert.equal(spawnOptions.cwd, path.resolve(workingDirectory))
    assert.equal(spawnOptions.env.DSH_WORKING_DIRECTORY, path.resolve(workingDirectory))
    assert.equal(spawnOptions.env.DSH_PROFILE, 'web')
    assert.equal(spawnOptions.env.DSH_PORT, '4174')
    assert.equal(spawnOptions.env.DSH_LAUNCHER_ROOT, path.resolve(launcherRoot))
    assert.equal(spawnOptions.env.DSH_PROCESS_CONTROLLER, path.resolve(__dirname, 'dsh-process-controller.js'))
    assert.equal(spawnOptions.env.DSH_RESTART_HELPER, path.resolve(__dirname, 'Web-Restart.vbs'))
    assert.equal(spawnArgs[spawnArgs.indexOf('--port') + 1], '4174')
    assert.equal(spawnArgs[spawnArgs.indexOf('--profile') + 1], 'web')

    const state = JSON.parse(fs.readFileSync(path.join(launcherRoot, 'dsh-runtime.json'), 'utf8'))
    assert.equal(state.port, 4174)
    assert.equal(state.profile, 'web')
    assert.equal(state.workingDirectory, path.resolve(workingDirectory))
  } finally {
    fs.rmSync(launcherRoot, { recursive: true, force: true })
  }
})
