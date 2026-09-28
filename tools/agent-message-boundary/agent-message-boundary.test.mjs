import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { patchSource } from './apply-overlay.mjs'

const root = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
const file = join(root, 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js')
const original = await readFile(file, 'utf8')
const source = patchSource(original)
const start = source.indexOf('	async turn() {')
const end = source.indexOf('\n\tasync step(', start)
assert.ok(start >= 0 && end > start, 'agent loop turn() was not found')
const turn = new Function('LlmError', 'errorChain', 'return ({' + source.slice(start, end) + '}).turn')(
  class LlmError extends Error {}, String)

function fixture(initial = [], hooks = {}) {
  const pending = [...initial.map(text => ({ text }))]
  const claimed = []
  const starts = []
  const completed = []
  const events = []
  const inbox = {
    nextTurn: pending,
    nextStep: [],
    get hasPending() { return pending.length > 0 || this.nextStep.length > 0 },
    splice(target, index, remove, messages) {
      (target === 'next-turn' ? pending : this.nextStep).splice(index, remove, ...messages)
    },
    claim(target) {
      const batch = this.nextStep.splice(0)
      if (target === 'next-turn') batch.push(...pending.splice(0))
      claimed.push(batch.map(item => item.text))
      return batch
    },
  }
  const agent = {
    phase: { kind: 'running', turn: 0, step: 0, abort: new AbortController() },
    inbox,
    session: { append(type, data) {
      events.push({ type, data })
      if (type === 'step/start') starts.push(data)
      if (type === 'user/message') completed.push(data.text)
    } },
    dispatch: { async serial() {} },
    async preStep(target) {
      const batch = inbox.claim(target)
      await hooks.afterClaim?.(pending, this.phase.turn)
      return { kind: 'enter', claimed: batch, messages: batch, assembly: null }
    },
    async step() {
      await hooks.inStep?.(pending, this.phase.turn)
      return { kind: 'completed' }
    },
    throwError(error) { throw error },
    turn,
  }
  return { agent, pending, starts, completed, claimed, events }
}

test('idle recipient takes all A/B/C as one FIFO batch', async () => {
  const f = fixture(['A', 'B', 'C'])
  assert.equal(await f.agent.turn(), false)
  assert.deepEqual(f.completed, ['A', 'B', 'C'])
  assert.equal(f.starts.length, 1)
})

test('late arrival in first preStep restarts without starting obsolete step', async () => {
  let once = false
  const f = fixture(['A', 'B'], { afterClaim(pending) {
    if (!once) { once = true; pending.push({ text: 'C' }) }
  } })
  assert.equal(await f.agent.turn(), true)
  assert.deepEqual(f.starts, [])
  assert.deepEqual(f.pending.map(m => m.text), ['A', 'B', 'C'])
  assert.equal(await f.agent.turn(), false)
  assert.deepEqual(f.completed, ['A', 'B', 'C'])
  assert.equal(f.starts.length, 1)
})

for (const direction of ['Child → Parent', 'Parent → Child']) {
  test(direction + ': current step completes; next round drains pending messages', async () => {
    let once = false
    const f = fixture(['A'], { inStep(pending) {
      if (!once) { once = true; pending.push({ text: 'B' }, { text: 'C' }) }
    } })
    assert.equal(await f.agent.turn(), true)
    assert.deepEqual(f.completed, ['A'])
    assert.equal(f.starts.length, 1)
    assert.equal(f.events.filter(e => e.type === 'step/end').length, 1)
    assert.deepEqual(f.pending.map(m => m.text), ['B', 'C'])
    assert.equal(await f.agent.turn(), false)
    assert.deepEqual(f.completed, ['A', 'B', 'C'])
    assert.deepEqual(f.claimed, [['A'], ['B', 'C']])
  })
}

test('batch freezes at claim; later message waits for a later round', async () => {
  let once = false
  const f = fixture(['A', 'B'], { inStep(pending) {
    if (!once) { once = true; pending.push({ text: 'C' }) }
  } })
  assert.equal(await f.agent.turn(), true)
  assert.deepEqual(f.completed, ['A', 'B'])
  assert.equal(await f.agent.turn(), false)
  assert.deepEqual(f.claimed, [['A', 'B'], ['C']])
})

test('overlay refuses unknown versions of the turn fragment', () => {
  assert.equal(patchSource(original), source)
  assert.equal(patchSource(source), source)
  assert.throws(() => patchSource('not an agent loop'), /fragment does not match/)
})
