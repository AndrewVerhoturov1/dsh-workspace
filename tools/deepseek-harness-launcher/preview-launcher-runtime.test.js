'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createProcessController } = require('./dsh-process-controller.js')

const runtime = {
  nodePath: 'C:/Program Files/nodejs/node.exe',
  dshBin: 'C:/Users/andre/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js',
}

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
