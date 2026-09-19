import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createResultWorkspaceTools,
  readDurableReceipt,
  readPublishedReceipt,
  registerResultWorkspace,
  resultWorkspaceTitle,
  unregisterResultWorkspace,
} from './result-workspace.js'

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function publishedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-result-workspace-'))
  const worktree = path.join(root, 'REQ_20260904T000000Z_0001')
  const handoff = path.join(root, 'handoff')
  fs.mkdirSync(worktree)
  fs.mkdirSync(handoff)
  const published = path.join(handoff, 'published.json')
  writeJson(published, {
    ok: true,
    code: 'PUBLISHED',
    requestId: 'REQ_20260904T000000Z_0001',
    prNumber: 91,
    commitSha: 'a'.repeat(40),
    worktree,
    worktreeRemoved: false,
    worktreeRetained: true,
  })
  return { root, worktree: fs.realpathSync(worktree), published }
}

function durableFixture(requestId = 'REQ_20260904T000000Z_0001', root = null, { includeManifest = true } = {}) {
  const ownedRoot = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'postman-durable-workspace-'))
  const resultRoot = path.join(ownedRoot, 'results')
  const resultDirectory = path.join(resultRoot, requestId)
  const handoffDirectory = path.join(ownedRoot, 'handoff')
  fs.mkdirSync(resultDirectory, { recursive: true })
  fs.mkdirSync(handoffDirectory, { recursive: true })
  const resultZip = path.join(resultDirectory, 'result.zip')
  if (includeManifest) writeJson(path.join(resultDirectory, 'manifest.json'), { name: 'manifest.json' })
  for (const name of ['validation.json', 'metadata.json']) {
    writeJson(path.join(resultDirectory, name), { name })
  }
  fs.writeFileSync(resultZip, 'result', 'utf8')
  const resultHandoffJson = path.join(handoffDirectory, requestId + '.json')
  writeJson(resultHandoffJson, {
    ok: true,
    code: 'RESULT_DURABLE',
    state: 'RESULT_DURABLE',
    requestId,
    resultRoot,
    resultZip,
  })
  return {
    root: ownedRoot,
    resultRoot: fs.realpathSync(resultRoot),
    resultDirectory: fs.realpathSync(resultDirectory),
    resultZip: fs.realpathSync(resultZip),
    resultHandoffJson: fs.realpathSync(resultHandoffJson),
  }
}

function registry(workspaceId = 'workspace-result') {
  const calls = []
  const workspaces = new Map()
  return {
    calls,
    workspaces,
    workspaceRegistry: {
      async create(resultDirectory, title) {
        calls.push(['create', resultDirectory, title])
        const workspace = { id: workspaceId, path: resultDirectory, title }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      get(id) { return workspaces.get(id) },
      async delete(id) {
        calls.push(['delete', id])
        workspaces.delete(id)
      },
    },
  }
}

test('readPublishedReceipt binds to retained existing worktree', () => {
  const fx = publishedFixture()
  try {
    const value = readPublishedReceipt(fx.published)
    assert.equal(value.worktree, fx.worktree)
    assert.equal(value.value.prNumber, 91)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('legacy published_json registration works as before', async () => {
  const fx = publishedFixture()
  try {
    const { calls, workspaceRegistry } = registry('workspace-postman-91')
    const result = await registerResultWorkspace({ workspaceRegistry }, fx.published)
    const expectedTitle = 'Postman PR #91 — ' + path.basename(fx.worktree)
    assert.deepEqual(calls, [['create', fx.worktree, expectedTitle]])
    assert.equal(result.status, 'RESULT_WORKSPACE_REGISTERED')
    assert.equal(result.workspaceId, 'workspace-postman-91')
    assert.equal(result.title, expectedTitle)
    assert.equal(result.workspaceJson, path.join(path.dirname(fx.published), 'result-workspace.json'))
    const sidecar = JSON.parse(fs.readFileSync(result.workspaceJson, 'utf8'))
    assert.equal(sidecar.worktree, fx.worktree)
    assert.equal(sidecar.workspaceRemoved, false)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('durable handoff registers the exact resultDirectory and stores sidecar inside it', async () => {
  const fx = durableFixture()
  try {
    const { calls, workspaceRegistry } = registry('workspace-durable-1')
    const result = await registerResultWorkspace({ workspaceRegistry }, { request_id: 'REQ_20260904T000000Z_0001', result_handoff_json: fx.resultHandoffJson })
    assert.deepEqual(calls, [['create', fx.resultDirectory, 'Postman REQ_20260904T000000Z_0001 — result']])
    assert.equal(result.ok, true)
    assert.equal(result.source, 'RESULT_DURABLE')
    assert.equal(result.resultDirectory, fx.resultDirectory)
    assert.equal(result.resultZip, fx.resultZip)
    assert.equal(result.resultHandoffJson, fx.resultHandoffJson)
    assert.equal(result.workspaceJson, path.join(fx.resultDirectory, 'result-workspace.json'))
    assert.equal(path.dirname(result.workspaceJson), fx.resultDirectory)
    assert.deepEqual(JSON.parse(fs.readFileSync(result.workspaceJson, 'utf8')), result)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('durable registration requires exact current request_id before Workspace creation', async () => {
  const fx = durableFixture()
  try {
    const state = registry('workspace-durable-guard')
    const ctx = { workspaceRegistry: state.workspaceRegistry }

    await assert.rejects(
      registerResultWorkspace(ctx, { result_handoff_json: fx.resultHandoffJson }),
      /request_id is required for RESULT_DURABLE/,
    )
    assert.deepEqual(state.calls, [])

    await assert.rejects(
      registerResultWorkspace(ctx, {
        request_id: 'REQ_20260904T000001Z_0002',
        result_handoff_json: fx.resultHandoffJson,
      }),
      /durable receipt requestId does not match request_id/,
    )
    assert.deepEqual(state.calls, [])
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('different durable REQs have independent sidecar files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-durable-two-'))
  try {
    const one = durableFixture('REQ_20260904T000000Z_0001', root)
    const two = durableFixture('REQ_20260904T000001Z_0002', root)
    const first = registry('workspace-one')
    const second = registry('workspace-two')
    const resultOne = await registerResultWorkspace(first, { request_id: 'REQ_20260904T000000Z_0001', result_handoff_json: one.resultHandoffJson })
    const resultTwo = await registerResultWorkspace(second, { request_id: 'REQ_20260904T000001Z_0002', result_handoff_json: two.resultHandoffJson })
    assert.notEqual(resultOne.workspaceJson, resultTwo.workspaceJson)
    assert.equal(JSON.parse(fs.readFileSync(resultOne.workspaceJson, 'utf8')).requestId, one.resultDirectory.split(path.sep).pop())
    assert.equal(JSON.parse(fs.readFileSync(resultTwo.workspaceJson, 'utf8')).requestId, two.resultDirectory.split(path.sep).pop())
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('durable result without manifest passes receipt read and Workspace registration', async () => {
  const fx = durableFixture('REQ_20260904T000000Z_0001', null, { includeManifest: false })
  try {
    const receipt = readDurableReceipt(fx.resultHandoffJson)
    assert.equal(receipt.resultDirectory, fx.resultDirectory)
    assert.equal(fs.existsSync(path.join(fx.resultDirectory, 'manifest.json')), false)

    const { workspaceRegistry } = registry('workspace-durable-no-manifest')
    const result = await registerResultWorkspace(
      { workspaceRegistry },
      { request_id: 'REQ_20260904T000000Z_0001', result_handoff_json: fx.resultHandoffJson },
    )
    assert.equal(result.ok, true)
    assert.equal(result.status, 'RESULT_WORKSPACE_REGISTERED')
    assert.equal(result.source, 'RESULT_DURABLE')
    assert.equal(result.resultDirectory, fx.resultDirectory)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('readDurableReceipt validates the exact durable layout without unpacking ZIP', () => {
  const fx = durableFixture()
  try {
    const receipt = readDurableReceipt(fx.resultHandoffJson)
    assert.equal(receipt.resultDirectory, fx.resultDirectory)
    assert.equal(receipt.resultZip, fx.resultZip)
    assert.equal(fs.readFileSync(fx.resultZip, 'utf8'), 'result')
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('rejects when both or neither input is supplied', async () => {
  const fx = publishedFixture()
  try {
    await assert.rejects(
      registerResultWorkspace({}, { published_json: fx.published, result_handoff_json: fx.published }),
      /exactly one of published_json or result_handoff_json/,
    )
    await assert.rejects(
      registerResultWorkspace({}, {}),
      /exactly one of published_json or result_handoff_json/,
    )
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('rejects durable receipt with wrong code or state', async () => {
  const fx = durableFixture()
  try {
    const value = JSON.parse(fs.readFileSync(fx.resultHandoffJson, 'utf8'))
    value.code = 'PUBLISHED'
    writeJson(fx.resultHandoffJson, value)
    await assert.rejects(registerResultWorkspace({}, { request_id: 'REQ_20260904T000000Z_0001', result_handoff_json: fx.resultHandoffJson }), /exact successful RESULT_DURABLE/)
    value.code = 'RESULT_DURABLE'
    value.state = 'PUBLISHED'
    writeJson(fx.resultHandoffJson, value)
    await assert.rejects(registerResultWorkspace({}, { request_id: 'REQ_20260904T000000Z_0001', result_handoff_json: fx.resultHandoffJson }), /exact successful RESULT_DURABLE/)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('rejects durable resultZip outside resultRoot/requestId', async () => {
  const fx = durableFixture()
  const outsideDirectory = path.join(fx.root, 'outside', 'REQ_20260904T000000Z_0001')
  fs.mkdirSync(outsideDirectory, { recursive: true })
  const outsideZip = path.join(outsideDirectory, 'result.zip')
  fs.writeFileSync(outsideZip, 'outside', 'utf8')
  const value = JSON.parse(fs.readFileSync(fx.resultHandoffJson, 'utf8'))
  value.resultZip = outsideZip
  writeJson(fx.resultHandoffJson, value)
  try {
    await assert.rejects(registerResultWorkspace({}, { request_id: 'REQ_20260904T000000Z_0001', result_handoff_json: fx.resultHandoffJson }), /outside resultRoot\/requestId/)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('durable unregister deletes only Workspace registration and preserves result files', async () => {
  const fx = durableFixture()
  try {
    const state = registry('workspace-durable-1')
    const ctx = { workspaceRegistry: state.workspaceRegistry }
    const registered = await registerResultWorkspace(ctx, { request_id: 'REQ_20260904T000000Z_0001', result_handoff_json: fx.resultHandoffJson })
    const result = await unregisterResultWorkspace(ctx, { request_id: 'REQ_20260904T000000Z_0001', result_handoff_json: fx.resultHandoffJson })
    assert.deepEqual(state.calls, [
      ['create', fx.resultDirectory, 'Postman REQ_20260904T000000Z_0001 — result'],
      ['delete', registered.workspaceId],
    ])
    assert.equal(result.source, 'RESULT_DURABLE')
    assert.equal(result.status, 'RESULT_WORKSPACE_UNREGISTERED')
    assert.equal(result.workspaceRemoved, true)
    assert.ok(fs.existsSync(fx.resultDirectory))
    assert.ok(fs.existsSync(fx.resultZip))
    assert.equal(JSON.parse(fs.readFileSync(result.workspaceJson, 'utf8')).status, 'RESULT_WORKSPACE_UNREGISTERED')
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('durable unregister rejects wrong request_id before Workspace deletion', async () => {
  const fx = durableFixture()
  try {
    const state = registry('workspace-durable-guard')
    const ctx = { workspaceRegistry: state.workspaceRegistry }
    await registerResultWorkspace(ctx, {
      request_id: 'REQ_20260904T000000Z_0001',
      result_handoff_json: fx.resultHandoffJson,
    })
    assert.equal(state.calls.length, 1)

    await assert.rejects(
      unregisterResultWorkspace(ctx, {
        request_id: 'REQ_20260904T000001Z_0002',
        result_handoff_json: fx.resultHandoffJson,
      }),
      /durable receipt requestId does not match request_id/,
    )
    assert.deepEqual(state.calls.map((call) => call[0]), ['create'])
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('unregisterResultWorkspace preserves legacy cleanup semantics', async () => {
  const fx = publishedFixture()
  try {
    const state = registry('workspace-postman-91')
    const ctx = { workspaceRegistry: state.workspaceRegistry }
    const registered = await registerResultWorkspace(ctx, fx.published)
    const result = await unregisterResultWorkspace(ctx, fx.published)
    assert.deepEqual(state.calls.map((call) => call[0]), ['create', 'delete'])
    assert.equal(result.status, 'RESULT_WORKSPACE_UNREGISTERED')
    assert.equal(result.workspaceRemoved, true)
    assert.ok(fs.existsSync(fx.worktree))
    assert.equal(registered.workspaceJson, result.workspaceJson)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('tool names remain unchanged and both receipt inputs are optional', () => {
  const tools = createResultWorkspaceTools({ workspaceRegistry: {} })
  assert.deepEqual(tools.map((tool) => tool.name), [
    'postman_result_workspace_register',
    'postman_result_workspace_unregister',
  ])
  for (const tool of tools) {
    assert.equal(tool.parameters.required, undefined)
    assert.equal(tool.parameters.properties.request_id.type, 'string')
    assert.equal(tool.parameters.properties.published_json.type, 'string')
    assert.equal(tool.parameters.properties.result_handoff_json.type, 'string')
  }
})

test('title falls back to request id when PR number is unavailable', () => {
  assert.equal(
    resultWorkspaceTitle({ requestId: 'REQ_X' }, 'C:/temp/REQ_X'),
    'Postman REQ_X — REQ_X',
  )
})
