import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clearResultPresentation, createResultPresentationTool, presentResult } from './result-presentation.js'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-presentation-'))
  const worktree = path.join(root, 'worktree')
  const handoff = path.join(root, 'handoff')
  fs.mkdirSync(worktree); fs.mkdirSync(handoff); fs.mkdirSync(path.join(worktree, 'docs'))
  fs.writeFileSync(path.join(worktree, 'docs', 'index.html'), '<button>ok</button>', 'utf8')
  const published = path.join(handoff, 'published.json')
  fs.writeFileSync(published, `${JSON.stringify({ ok: true, code: 'PUBLISHED', requestId: 'REQ_TEST', prNumber: 99, commitSha: 'a'.repeat(40), worktree, worktreeRetained: true, worktreeRemoved: false })}\n`, 'utf8')
  return { root, worktree: fs.realpathSync(worktree), published }
}

test('presentation binds to retained worktree and calling session', async () => {
  const fx = fixture(); const calls = []
  try {
    const ctx = { get(name) { assert.equal(name, 'betterSidebarPresentation'); return { async present(value) { calls.push(value); return { id: 'p1', delivered: true } }, async clear() { return { id: 'c1', delivered: true } } } } }
    const result = await presentResult(ctx, fx.published, { kind: 'html', entry_path: 'docs/index.html', title: 'Result' }, 'session-user')
    assert.equal(result.status, 'RESULT_PRESENTED'); assert.equal(result.targetSessionId, 'session-user'); assert.equal(calls.length, 1)
    assert.equal(calls[0].workspaceRoot, fx.worktree); assert.equal(calls[0].sessionId, 'session-user'); assert.equal(calls[0].kind, 'html')
    assert.equal(calls[0].target, fs.realpathSync(path.join(fx.worktree, 'docs', 'index.html')))
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }) }
})

test('entry path cannot escape retained worktree', async () => {
  const fx = fixture()
  try {
    const ctx = { get() { return { present: async () => ({}), clear: async () => ({}) } } }
    await assert.rejects(presentResult(ctx, fx.published, { kind: 'html', entry_path: '../escape.html' }, 's'), /escapes retained worktree/)
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }) }
})

test('clear is best effort and records deterministic receipt', async () => {
  const fx = fixture()
  try {
    const ctx = { get() { return { async present() { return { id: 'p', delivered: false } }, async clear() { return { id: 'c', delivered: true } } } } }
    await presentResult(ctx, fx.published, { kind: 'html', entry_path: 'docs/index.html' }, 's')
    const result = await clearResultPresentation(ctx, fx.published)
    assert.equal(result.status, 'RESULT_PRESENTATION_CLEARED'); assert.equal(result.cleared, true)
  } finally { fs.rmSync(fx.root, { recursive: true, force: true }) }
})

test('tool requires a calling Harness agent', async () => {
  const tool = createResultPresentationTool({ get() { return { present: async () => ({}), clear: async () => ({}) } } })
  assert.equal(tool.name, 'postman_result_present')
  await assert.rejects(tool.execute({ published_json: 'x', kind: 'html', entry_path: 'x' }, {}), /requires a calling Harness agent/)
})
