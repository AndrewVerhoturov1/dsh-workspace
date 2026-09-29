import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'

const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
test('ordinary nested dispatcher preserves caller, parent, policies, validation, cancellation and starts without lock', async () => {
  const ctx = new Context()
  ctx.systemPrompt = { tools() {} }
  new ToolRuntime(ctx)
  const agent = { id: 'one' }
  const events = []
  ctx.on('tools/pre-execute', async (exec, next) => { events.push(['pre', exec.name, exec.agent, exec.parent]); return next() })
  ctx.tools.register(defineTool({ name: 'inner', description: 'test', parameters: { text: { type: 'string', required: true } }, output,
    async execute(args, exec) { events.push(['body', exec.name, exec.agent, exec.parent, exec.signal]); await new Promise(resolve => exec.signal.addEventListener('abort', resolve, {once:true})); return { text: args.text } } }))
  ctx.tools.register(defineTool({ name: 'outer', description: 'test', parameters: {}, output,
    async execute(_args, exec) {
      events.push(['outer', exec.name, exec.agent, exec.token])
      const invalid = await ctx.tools.execute({ callId: 'bad', rootCallId: exec.rootCallId, name: 'inner', arguments: {}, agent: exec.agent, parent: exec.token, signal: exec.signal })
      assert.equal(invalid.isError, true)
      assert.match(invalid.error.message, /required|text/i)
      const nested = await ctx.tools.execute({ callId: 'child', rootCallId: exec.rootCallId, name: 'inner', arguments: {text:'ok'}, agent: exec.agent, parent:exec.token, signal: exec.signal })
      return { nestedError:nested.isError, code:nested.error?.info?.code ?? null }
    } }))
  const controller = new AbortController()
  const task = ctx.tools.execute({callId:'root',name:'outer',arguments:{},agent,signal:controller.signal})
  await new Promise(resolve => { const tick = () => events.some(e => e[0] === 'body') ? resolve() : setImmediate(tick); tick() })
  assert.equal(events.find(e=>e[0]==='body')[2], agent)
  assert.equal(events.find(e=>e[0]==='body')[3], events.find(e=>e[0]==='outer')[3])
  controller.abort()
  const result = await task
  assert.equal(result.isError, true)
  assert.ok(events.some(e=>e[0]==='pre' && e[1]==='inner'))
})
