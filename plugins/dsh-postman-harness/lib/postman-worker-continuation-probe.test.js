import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runPostmanWorkerContinuationProbe } from './postman-worker-continuation-probe.js'

function fixture(cwd, { forget = false, leak = false, cleanupFailure = false } = {}) {
  const parent = { id: 'leader', session: { header: { cwd, agentPreset: 'postman-leader' } } }
  let child
  let listener
  let started = 0
  let followed = 0
  let drained = 0
  let firstText
  const append = (type, data) => {
    const event = { type, data }
    child.session.events.push(event)
    listener?.(child.session, event)
  }
  const ctx = {
    agents: { get: id => child?.id === id && !child.disposed ? child : undefined },
    tools: {
      schemas: agent => agent === parent
        ? [{ name: 'postman_worker_scope_probe' }, ...(leak ? [{ name: 'write' }] : [])]
        : [{ name: 'write' }],
      get: (name, agent) => agent === parent
        ? name === 'postman_worker_scope_probe' || (leak && name === 'write') ? {} : undefined
        : agent === child && name === 'write' ? {} : undefined,
    },
    on: (name, callback) => {
      assert.equal(name, 'session/event')
      listener = callback
      return () => { listener = undefined }
    },
    subagents: {
      async startContinuable(spec) {
        started++
        assert.equal(spec.provider, 'spawn')
        assert.deepEqual(spec.request.agentOptions, { provider: 'codex', model: 'gpt-5.6-luna' })
        assert.deepEqual(spec.request.toolFilter, { allow: ['write'] })
        assert.equal(spec.request.maxDepth, 1)
        assert.equal(spec.request.parent, parent)
        assert.doesNotMatch(spec.request.persona, /CONTINUATION_SECRET:/)
        firstText = spec.request.prompt[0].text
        const secret = firstText.match(/CONTINUATION_SECRET:[a-f0-9-]+/)[0]
        child = { id: spec.childId, disposed: false, session: {
          id: spec.childId, events: [], header: { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
        } }
        queueMicrotask(() => {
          append('turn/start', { turn: 1 })
          append('user/message', { id: 'message-one', content: [{ type: 'text', text: firstText }] })
          append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        })
        return { childId: spec.childId, messageId: 'message-one' }
      },
      async followup(agent, id, content, options) {
        followed++
        assert.equal(agent, parent)
        assert.equal(id, child.id)
        assert.equal(options.source.senderSessionId, parent.id)
        assert.equal(options.source.kind, 'coordinator')
        assert.doesNotMatch(content[0].text, /CONTINUATION_SECRET:/)
        const secret = firstText.match(/CONTINUATION_SECRET:[a-f0-9-]+/)[0]
        queueMicrotask(async () => {
          append('turn/start', { turn: 2 })
          append('user/message', { id: 'message-two', content })
          const filename = content[0].text.match(/file_path="([^"]+)"/)[1]
          append('tool/call', { turn: 2, name: 'write', callId: 'call-one' })
          await writeFile(join(cwd, filename), 'CONTINUATION_OK:' + (forget ? 'WRONG' : secret))
          append('tool/result', { turn: 2, message: { source: { callId: 'call-one' }, content: [{ isError: false }] } })
          append('turn/end', { turn: 2, reason: { kind: 'completed' } })
        })
        return 'message-two'
      },
      async drainContinuableChildren(agent, ids) {
        drained++
        assert.equal(agent, parent)
        assert.deepEqual(ids, [child.id])
        if (cleanupFailure) throw new Error('mock drain failed')
        child.disposed = true
      },
    },
  }
  return { ctx, parent, counts: () => ({ started, followed, drained }) }
}

for (const [title, options, status] of [
  ['exact remembered secret', {}, 'POSTMAN_WORKER_CONTINUATION_PROBE_PASS'],
  ['wrong secret', { forget: true }, 'POSTMAN_WORKER_CONTINUATION_PROBE_FAILED'],
  ['cleanup failure', { cleanupFailure: true }, 'POSTMAN_WORKER_CONTINUATION_PROBE_CLEANUP_FAILED'],
]) {
  test('continuation probe: ' + title, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-continuation-probe-'))
    try {
      const { ctx, parent, counts } = fixture(cwd, options)
      const result = await runPostmanWorkerContinuationProbe(ctx, { agent: parent, signal: new AbortController().signal })
      assert.equal(result.status, status, JSON.stringify(result))
      assert.deepEqual(counts(), { started: 1, followed: 1, drained: 1 })
      assert.equal(result.turns.firstCompleted, true)
      assert.equal(result.turns.secondCompleted, true)
      assert.equal(result.turns.sameChildSession, true)
      assert.equal(result.turns.secretRepeatedInSecondTurn, false)
      assert.deepEqual(result.child.tools, ['write'])
      assert.equal(result.memory.exactMatch, !options.forget)
      assert.deepEqual(await readdir(cwd), [])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
}

test('continuation probe blocks parent write leakage before start', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-continuation-probe-'))
  try {
    const { ctx, parent, counts } = fixture(cwd, { leak: true })
    const result = await runPostmanWorkerContinuationProbe(ctx, { agent: parent })
    assert.equal(result.status, 'POSTMAN_WORKER_CONTINUATION_PROBE_PARENT_BOUNDARY_FAILED')
    assert.deepEqual(counts(), { started: 0, followed: 0, drained: 0 })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
