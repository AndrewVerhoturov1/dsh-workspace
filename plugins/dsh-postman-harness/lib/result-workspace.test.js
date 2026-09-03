import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createResultWorkspaceTools,
  readPublishedReceipt,
  registerResultWorkspace,
  resultWorkspaceTitle,
  unregisterResultWorkspace,
} from './result-workspace.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-result-workspace-'))
  const worktree = path.join(root, 'REQ_20260904T000000Z_0001')
  const handoff = path.join(root, 'handoff')
  fs.mkdirSync(worktree)
  fs.mkdirSync(handoff)
  const published = path.join(handoff, 'published.json')
  fs.writeFileSync(published, `${JSON.stringify({
    ok: true,
    code: 'PUBLISHED',
    requestId: 'REQ_20260904T000000Z_0001',
    prNumber: 91,
    commitSha: 'a'.repeat(40),
    worktree,
    worktreeRemoved: false,
    worktreeRetained: true,
  })}\n`, 'utf8')
  return { root, worktree: fs.realpathSync(worktree), published }
}

test('readPublishedReceipt binds to retained existing worktree', () => {
  const fx = fixture()
  try {
    const value = readPublishedReceipt(fx.published)
    assert.equal(value.worktree, fx.worktree)
    assert.equal(value.value.prNumber, 91)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('registerResultWorkspace uses host workspaceRegistry.create(path, title) and writes sidecar', async () => {
  const fx = fixture()
  try {
    const calls = []
    const ctx = {
      workspaceRegistry: {
        async create(worktree, title) {
          calls.push([worktree, title])
          return { id: 'workspace-postman-91', path: worktree, title }
        },
      },
    }
    const result = await registerResultWorkspace(ctx, fx.published)
    const expectedTitle = `Postman PR #91 — ${path.basename(fx.worktree)}`
    assert.deepEqual(calls, [[fx.worktree, expectedTitle]])
    assert.equal(result.status, 'RESULT_WORKSPACE_REGISTERED')
    assert.equal(result.workspaceId, 'workspace-postman-91')
    assert.equal(result.title, expectedTitle)
    const sidecar = JSON.parse(fs.readFileSync(result.workspaceJson, 'utf8'))
    assert.equal(sidecar.workspaceId, 'workspace-postman-91')
    assert.equal(sidecar.worktree, fx.worktree)
    assert.equal(sidecar.workspaceRemoved, false)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('unregisterResultWorkspace deletes registration only and marks sidecar', async () => {
  const fx = fixture()
  try {
    const deleted = []
    const workspace = { id: 'workspace-postman-91' }
    const ctx = {
      workspaceRegistry: {
        async create() { return workspace },
        get(id) { return id === workspace.id ? workspace : undefined },
        async delete(id) { deleted.push(id) },
      },
    }
    const registered = await registerResultWorkspace(ctx, fx.published)
    const result = await unregisterResultWorkspace(ctx, fx.published)
    assert.deepEqual(deleted, [registered.workspaceId])
    assert.equal(result.status, 'RESULT_WORKSPACE_UNREGISTERED')
    assert.equal(result.workspaceRemoved, true)
    assert.ok(fs.existsSync(fx.worktree), 'unregister must not delete the worktree')
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('tool surface is host-only register/unregister without client or preview tools', () => {
  const tools = createResultWorkspaceTools({ workspaceRegistry: {} })
  assert.deepEqual(tools.map((tool) => tool.name), [
    'postman_result_workspace_register',
    'postman_result_workspace_unregister',
  ])
})

test('title falls back to request id when PR number is unavailable', () => {
  assert.equal(
    resultWorkspaceTitle({ requestId: 'REQ_X' }, 'C:/temp/REQ_X'),
    'Postman REQ_X — REQ_X',
  )
})
