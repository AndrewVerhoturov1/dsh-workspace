import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPostmanYieldTool } from './postman-bridge.js'
const root = join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
const source = readFileSync(root, 'utf8')
const first = source.indexOf('\tasync turn() {')
const last = source.indexOf('\n\tasync step(', first)
assert.ok(first >= 0 && last > first)
const realTurn = new Function('LlmError', 'errorChain', 'return ({' + source.slice(first, last) + '}).turn')(
  class LlmError extends Error {}, String)
const tool = createPostmanYieldTool({ agents: { get: id => id === 'L' ? active : null } })
let active
function loop(initial, onStep) {
  const nextTurn = initial.map(id => ({ id }))
  const nextStep = []
  const events = [], calls = []
  const agent = { turn: realTurn }
  agent.id = 'L'
  agent.session = { header: { agentPreset: 'postman-leader', delegationDepth: 0 },
    append(type, data) { events.push({ type, data }) } }
  agent.phase = { kind: 'running', turn: 0, step: 0, abort: new AbortController() }
  agent.inbox = { nextTurn, nextStep, get hasPending() { return nextTurn.length + nextStep.length > 0 },
    splice(target, index, removed, inserted) { (target === 'next-turn' ? nextTurn : nextStep).splice(index, removed, ...inserted) },
    claim(target) { return [...nextStep.splice(0), ...target === 'next-turn' ? nextTurn.splice(0) : []] } }
  agent.dispatch = { async serial() {} }
  agent.preStep = async target => ({ kind: 'enter', messages: agent.inbox.claim(target), assembly: {} })
  agent.step = async () => {
    calls.push(agent.phase.turn)
    return onStep(agent, calls.length, tool)
  }
  agent.throwError = error => { throw error }
  active = agent
  return { agent, calls, events, nextTurn }
}
test('real installed turn ends after yield without empty final or extra model call', async () => {
  const f = loop(['user'], async (agent, count, yieldTool) => {
    const result = await yieldTool.execute({}, { agent, concludeTurn() { agent.concluded = true } })
    assert.equal(result.status, 'POSTMAN_YIELDED')
    return agent.concluded ? { kind: 'completed' } : null
  })
  assert.equal(await f.agent.turn(), false)
  assert.equal(f.calls.length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(f.events.some(e => e.type === 'assistant/message'), false)
})
test('real installed turn preserves report/user before, during and after yield', async () => {
  for (const moment of ['before','during','after']) {
    const f = loop(['user'], async (agent, count, yieldTool) => {
      if (count === 1) {
        if (moment === 'during') agent.inbox.nextStep.push({ id: 'report' })
        const result = await yieldTool.execute({}, { agent, concludeTurn() { agent.concluded = true } })
        assert.equal(result.status, 'POSTMAN_YIELDED')
        return agent.concluded ? { kind: 'completed' } : null
      }
      return { kind: 'completed' }
    })
    if (moment === 'before') f.agent.inbox.nextStep.push({ id: 'report' })
    assert.equal(await f.agent.turn(), false)
    if (moment === 'after') f.agent.inbox.nextTurn.push({ id: 'report' })
    if (f.agent.inbox.hasPending) assert.equal(await f.agent.turn(), false)
    assert.ok(f.events.filter(e => e.type === 'user/message').some(e => e.data.id === 'report'), moment)
  }
})
