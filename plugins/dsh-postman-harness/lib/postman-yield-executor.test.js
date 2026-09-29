import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlockAssembler, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { createPostmanYieldTool } from './postman-bridge.js'

// Execute the exact installed turn/step/scheduler, replacing only provider and
// tool-service boundaries. Never invoke a live model, Postman transport or child.
const file = join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
const source = readFileSync(file, 'utf8')
const segment = (first, last) => {
  const from = source.indexOf(first), to = source.indexOf(last, from)
  assert.ok(from >= 0 && to > from, 'installed runtime source changed')
  return source.slice(from, to)
}
const executeToolCalls = new Function('TOOL_RUNTIME_SCHEDULER', 'createToolResultMessage', 'assertNever',
  'TOOL_ABORTED_BEFORE_DISPATCH', segment('async function executeToolCalls(', '\n//#endregion') +
  '\nreturn executeToolCalls;')(TOOL_RUNTIME_SCHEDULER, createToolResultMessage,
  value => { throw new Error('unexpected scheduler outcome: ' + value) }, 'ABORTED')
const methods = new Function('LlmError', 'errorChain', 'BlockAssembler', 'createAssistantMessage',
  'renderPrompt', 'executeToolCalls', 'return ({' + segment('\tasync turn() {', '\n\tasync buildRequest(').replace('\n\tasync step(', ',\n\tasync step(') + '})')(
    class LlmError extends Error {}, String, BlockAssembler, createAssistantMessage, () => '', executeToolCalls)
const yieldTool = createPostmanYieldTool({ agents: { get: id => id === 'leader' ? live : null } })
let live

function harness() {
  const events = [], calls = [], queuedTurn = [{ id: 'initial', content: [{ type: 'text', text: 'work' }] }]
  const queuedStep = []
  const agent = { id: 'leader', turn: methods.turn, step: methods.step,
    session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 }, events,
      append(type, data) { const event = { type, data, seq: events.length + 1 }; events.push(event); return event },
      deriveMessages() { return events.filter(e => e.type === 'assistant/message').map(e => e.data.message) } },
    phase: { kind: 'running', turn: 0, step: 0, abort: new AbortController() },
    dispatch: { async serial() {} },
    inbox: { nextTurn: queuedTurn, nextStep: queuedStep,
      get hasPending() { return queuedTurn.length + queuedStep.length > 0 },
      splice(target, index, removed, inserted) {
        (target === 'next-turn' ? queuedTurn : queuedStep).splice(index, removed, ...inserted)
      } },
    async preStep(target) {
      const claimed = [...queuedStep.splice(0), ...target === 'next-turn' ? queuedTurn.splice(0) : []]
      return { kind: 'enter', messages: claimed, assembly: { tools: [] }, claimed }
    },
    async buildRequest() {
      calls.push('model')
      const index = calls.length
      return { request: { provider: 'fake', model: 'fake', signal: this.phase.abort.signal },
        preparedCall: { async *stream() {
          if (index === 1) {
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'yield-1',
              name: 'postman_yield', arguments: '{}' } }
          } else {
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'report received' } }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } } }
    },
    throwError(error) { throw error },
  }
  const scheduler = {
    async prepare(exec) { return { kind: 'dispatch', exec } },
    async dispatch(exec) {
      const value = await yieldTool.execute(exec.arguments, { ...exec, concludeTurn() { exec.concluded = true } })
      assert.equal(value.status, 'POSTMAN_YIELDED')
      return { kind: 'post-result', result: { value } }
    },
    async finalize(exec, result) { return { content: [{ type: 'text', text: result.value.status }],
      concludesTurn: exec.concluded } },
    finish(_exec, result) { return result },
  }
  agent.loopCtx = { agents: { requireInitiator: () => agent },
    agentLoop: { config: { maxParallelToolCalls: 1 } },
    tools: { executionMode: () => ({ kind: 'exclusive' }), [TOOL_RUNTIME_SCHEDULER]: scheduler } }
  live = agent
  return { agent, calls, events, queuedTurn, queuedStep }
}

test('installed stream step and scheduler execute yield, then resume only for report', async () => {
  const f = harness()
  assert.equal(await f.agent.turn(), false)
  assert.deepEqual(f.calls, ['model'])
  assert.deepEqual(f.events.filter(e => e.type === 'tool/call').map(e => e.data.name), ['postman_yield'])
  assert.equal(f.events.filter(e => e.type === 'tool/result').length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(f.events.some(e => e.type === 'assistant/message' && e.data.message.content.length === 0), false)
  f.queuedTurn.push({ id: 'native-report', content: [{ type: 'text', text: 'Worker completed' }] })
  assert.equal(await f.agent.turn(), false)
  assert.deepEqual(f.calls, ['model', 'model'])
  assert.ok(f.events.some(e => e.type === 'user/message' && e.data.id === 'native-report'))
  assert.ok(f.events.some(e => e.type === 'assistant/message' && e.data.message.content.some(b => b.text === 'report received')))
})
