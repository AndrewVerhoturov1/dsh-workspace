'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  createProcessController,
  isDshHarnessProcess,
  parseArgs,
} = require('./dsh-process-controller.js')

const runtime = {
  nodePath: 'C:/Program Files/nodejs/node.exe',
  dshBin: 'C:/Users/andre/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js',
}

function commandLine({ profile = 'web', port = 4173, dshBin = runtime.dshBin } = {}) {
  return `"${runtime.nodePath}" --expose-internals ${dshBin} --profile ${profile} --port ${port} --no-open`
}

function createFixture({ state, listenerPids = [], records = {}, probe = true, spawnPid = 7000, spawnListenerPid = null } = {}) {
  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-process-controller-'))
  const config = { launcherRoot, startTimeoutMs: 100, stopTimeoutMs: 100 }
  if (state) fs.writeFileSync(path.join(launcherRoot, 'dsh-runtime.json'), `${JSON.stringify(state)}\n`, 'utf8')
  const processRecords = new Map(Object.entries(records).map(([pid, record]) => [Number(pid), record]))
  let nextPid = spawnPid
  const deps = {
    getProcessRecord: (pid) => processRecords.get(Number(pid)) || null,
    isProcessAlive: (pid) => processRecords.has(Number(pid)),
    listListeningPids: () => [...listenerPids],
    probeHttp: async () => probe,
    spawn: (_node, args) => {
      const pid = nextPid
      const listenerPid = spawnListenerPid || pid
      processRecords.set(listenerPid, { pid: listenerPid, commandLine: commandLine({ port: args[args.indexOf('--port') + 1] }) })
      listenerPids.splice(0, listenerPids.length, listenerPid)
      return { pid, unref() {} }
    },
    execFileSync: (_file, args) => {
      const pid = Number(args[args.indexOf('/PID') + 1])
      processRecords.delete(pid)
      listenerPids.splice(0, listenerPids.length)
    },
  }
  const controller = createProcessController({ config, runtime, deps })
  return {
    controller,
    launcherRoot,
    cleanup: () => fs.rmSync(launcherRoot, { recursive: true, force: true }),
    processRecords,
    listenerPids,
  }
}

test('should recognize only the canonical DSH profile and port', () => {
  const config = { profile: 'web', port: 4173 }
  assert.equal(isDshHarnessProcess({ commandLine: commandLine() }, runtime, config), true)
  assert.equal(isDshHarnessProcess({ commandLine: commandLine({ port: 3080 }) }, runtime, config), false)
  assert.equal(isDshHarnessProcess({ commandLine: commandLine({ profile: 'cli' }) }, runtime, config), false)
})

test('should adopt a listener when the state file is missing', async () => {
  const fixture = createFixture({
    listenerPids: [1201],
    records: { 1201: { pid: 1201, commandLine: commandLine() } },
  })
  try {
    const result = await fixture.controller.start()
    assert.equal(result.status, 'ALREADY_RUNNING')
    assert.equal(result.pid, 1201)
    assert.equal(result.adopted, true)
    const state = JSON.parse(fs.readFileSync(path.join(fixture.launcherRoot, 'dsh-runtime.json'), 'utf8'))
    assert.equal(state.pid, 1201)
    assert.equal(state.port, 4173)
  } finally { fixture.cleanup() }
})

test('should reject a foreign listener without stopping it', async () => {
  const fixture = createFixture({
    listenerPids: [1202],
    records: { 1202: { pid: 1202, commandLine: 'node unrelated-server.js --port 4173' } },
  })
  try {
    const found = await fixture.controller.discover()
    assert.equal(found.status, 'PORT_OCCUPIED_BY_FOREIGN_PROCESS')
    await assert.rejects(() => fixture.controller.stop(), { code: 'PORT_OCCUPIED_BY_FOREIGN_PROCESS' })
    assert.equal(fixture.processRecords.has(1202), true)
  } finally { fixture.cleanup() }
})

test('should treat a stale recorded PID as not running', async () => {
  const fixture = createFixture({ state: { pid: 1203, port: 4173, profile: 'web' } })
  try {
    const found = await fixture.controller.discover()
    assert.equal(found.status, 'NOT_RUNNING')
  } finally { fixture.cleanup() }
})

test('should stop a discovered DSH and close the port', async () => {
  const fixture = createFixture({
    listenerPids: [1204],
    records: { 1204: { pid: 1204, commandLine: commandLine() } },
  })
  try {
    const result = await fixture.controller.stop()
    assert.equal(result.status, 'STOPPED')
    assert.equal(result.pid, 1204)
    assert.equal(fixture.listenerPids.length, 0)
    assert.equal(fs.existsSync(path.join(fixture.launcherRoot, 'dsh-runtime.json')), false)
  } finally { fixture.cleanup() }
})

test('should start detached with the canonical 4173 command', async () => {
  const fixture = createFixture({ spawnPid: 1205 })
  try {
    const result = await fixture.controller.start()
    assert.equal(result.status, 'STARTED')
    assert.equal(result.pid, 1205)
    const state = JSON.parse(fs.readFileSync(path.join(fixture.launcherRoot, 'dsh-runtime.json'), 'utf8'))
    assert.equal(state.port, 4173)
    assert.equal(fixture.listenerPids[0], 1205)
  } finally { fixture.cleanup() }
})

test('should record the listener PID when detached DSH hands off to a child', async () => {
  const fixture = createFixture({ spawnPid: 1208, spawnListenerPid: 1209 })
  try {
    const result = await fixture.controller.start()
    assert.equal(result.status, 'STARTED')
    assert.equal(result.pid, 1209)
    const state = JSON.parse(fs.readFileSync(path.join(fixture.launcherRoot, 'dsh-runtime.json'), 'utf8'))
    assert.equal(state.pid, 1209)
    assert.equal(fixture.listenerPids[0], 1209)
  } finally { fixture.cleanup() }
})

test('should restart through the same stop and start controller', async () => {
  const fixture = createFixture({
    listenerPids: [1206],
    records: { 1206: { pid: 1206, commandLine: commandLine() } },
    spawnPid: 1207,
  })
  try {
    const result = await fixture.controller.restart()
    assert.equal(result.status, 'RESTARTED')
    assert.equal(result.oldPid, 1206)
    assert.equal(result.pid, 1207)
    assert.notEqual(result.oldPid, result.pid)
    assert.equal(fixture.listenerPids[0], 1207)
  } finally { fixture.cleanup() }
})

test('should parse controller options for the desktop and web callers', () => {
  const parsed = parseArgs(['restart', '--cwd', 'C:/Users/andre/.dsh', '--profile', 'web', '--port', '4173'])
  assert.equal(parsed.action, 'restart')
  assert.equal(parsed.config.port, 4173)
  assert.equal(parsed.config.profile, 'web')
  assert.equal(parsed.config.preserveChildren, undefined)

  const preserved = parseArgs(['restart', '--preserve-children'])
  assert.equal(preserved.config.preserveChildren, true)
})
