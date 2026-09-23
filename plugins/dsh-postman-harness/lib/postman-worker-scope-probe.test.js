import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPostmanWorkerScopeProbeTool } from './postman-bridge.js'

function fixture(cwd, { leak = false, write = true, stopReason = 'completed' } = {}) {
  const parent = {
    id: 'leader-session',
    session: { header: { agentPreset: 'postman-leader', cwd } },
  }
  const child = {
    id: 'child-session',
    session: { header: {
      agentPreset: 'postman-leader',
      parentSession: parent.id,
      origin: 'subagent',
      delegationDepth: 1,
    } },
  }
  let started = 0
  let disposed = 0
  const ctx = {
    tools: {
      schemas: agent => agent === parent
        ? [{ name: 'postman_worker_scope_probe' }, ...(leak ? [{ name: 'write' }] : [])]
        : [{ name: 'write' }],
      get: (name, agent) => {
        if (agent === parent) return name === 'postman_worker_scope_probe' || (leak && name === 'write') ? {} : undefined
        return agent === child && name === 'write' ? {} : undefined
      },
    },
    subagents: {
      async start(provider, request) {
        started++
        assert.equal(provider, 'spawn')
        assert.equal(request.parent, parent)
        assert.deepEqual(request.toolFilter, { allow: ['write'] })
        assert.deepEqual(request.agentOptions, { provider: 'codex', model: 'gpt-5.6-luna' })
        assert.equal(request.maxDepth, 1)
        const [, markerName, markerText] = request.persona.match(/file_path="([^"]+)" and content="([^"]+)"/) ?? []
        assert.ok(markerName && markerText)
        const result = (async () => {
          if (write) await writeFile(join(cwd, markerName), markerText, 'utf8')
          return { stopReason }
        })()
        return { id: child.id, localAgent: child, result, async dispose() { disposed++ } }
      },
    },
    logger: { warn() {} },
  }
  return { parent, ctx, counts: () => ({ started, disposed }) }
}

test('scope probe verifies actual bytes, lineage and cleanup', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-scope-probe-'))
  try {
    const { parent, ctx, counts } = fixture(cwd)
    const result = await createPostmanWorkerScopeProbeTool(ctx).execute({}, { agent: parent, signal: new AbortController().signal })
    assert.equal(result.status, 'POSTMAN_WORKER_SCOPE_PROBE_PASS')
    assert.equal(result.verdict, 'SPAWN_SUFFICIENT_FOR_SCOPE_HYPOTHESIS')
    assert.equal(result.parent.writeVisible, false)
    assert.equal(result.child.writeVisible, true)
    assert.equal(result.child.postmanBridgeVisible, false)
    assert.equal(result.child.scopeProbeVisible, false)
    assert.equal(result.child.parentSession, parent.id)
    assert.equal(result.child.origin, 'subagent')
    assert.equal(result.child.delegationDepth, 1)
    assert.equal(result.marker.exactMatch, true)
    assert.deepEqual(result.cleanup, { childDisposed: true, markerRemoved: true, errors: [] })
    assert.deepEqual(counts(), { started: 1, disposed: 1 })
    assert.deepEqual(await readdir(cwd), [])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('scope probe stops before spawn if Leader sees write', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-scope-probe-'))
  try {
    const { parent, ctx, counts } = fixture(cwd, { leak: true })
    const result = await createPostmanWorkerScopeProbeTool(ctx).execute({}, { agent: parent })
    assert.equal(result.status, 'POSTMAN_WORKER_SCOPE_PROBE_PARENT_BOUNDARY_FAILED')
    assert.equal(result.parentWriteVisible, true)
    assert.deepEqual(counts(), { started: 0, disposed: 0 })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('scope probe does not trust child prose without marker', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-scope-probe-'))
  try {
    const { parent, ctx, counts } = fixture(cwd, { write: false })
    const result = await createPostmanWorkerScopeProbeTool(ctx).execute({}, { agent: parent, signal: new AbortController().signal })
    assert.equal(result.status, 'POSTMAN_WORKER_SCOPE_PROBE_FAILED')
    assert.equal(result.marker.exactMatch, false)
    assert.equal(result.cleanup.markerRemoved, true)
    assert.deepEqual(counts(), { started: 1, disposed: 1 })
    assert.deepEqual(await readdir(cwd), [])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
