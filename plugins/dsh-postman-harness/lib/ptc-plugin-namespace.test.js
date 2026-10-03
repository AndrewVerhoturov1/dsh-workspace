import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { apply as applyFs } from '@deepseek-ai/dsh-tool-fs'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as bridge from './postman-bridge.js'
import { POSTMAN_LEADER_TOOL_ALLOWLIST } from './postman-bridge-core.js'

// Actual namespace through Cordis plugin loader; no direct apply or ctx.fs assignment.
test('Cordis bridge namespace injects fs; PTC full-read gets native filesystem', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ptc-plugin-namespace-'))
  const ctx = new Context(), agents = new Map()
  ctx.systemPrompt = { tools() {}, section() { return () => {} } }
  new ToolRuntime(ctx)
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()] })
  ctx.provide('subagents', {})
  ctx.provide('attachments', {})
  const backend = new JsonStorageBackend(join(dir, 'storage'))
  ctx.provide('storageDomain', new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} }))
  t.after(async () => { await ctx.fiber.dispose(); await backend.close(); await rm(dir, { recursive: true, force: true }) })
  const output = { schema: { type: 'object', additionalProperties: true }, render: () => [] }
  for (const name of POSTMAN_LEADER_TOOL_ALLOWLIST) if (!name.startsWith('postman_') && name !== 'read')
    ctx.tools.register(defineTool({ name, description: name, parameters: {}, output, execute() { return {} } }))
  const fiber = ctx.plugin(bridge)
  await fiber.await()
  assert.equal(ctx.tools.get('ptc_execute'), undefined, 'fs dependency parks namespace until provider exists')
  new LocalFileSystem(ctx, { cwd: dir, diffBasisMaxBytes: 1048576 })
  applyFs(ctx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 10485760 })
  await fiber.await()
  assert.ok(ctx.tools.get('ptc_execute'), JSON.stringify({ state: fiber.state, missing: bridge.inject.filter(key => !ctx.get(key)) }))
  const text = 'полный текст\n' + 'Ю'.repeat(80000) + '\nконец\n'
  await writeFile(join(dir, 'proof.txt'), text, 'utf8')
  const agent = { id: 'namespace-leader', status: 'running', session: {
    header: { agentPreset: 'postman-leader-ptc', delegationDepth: 0, cwd: dir }, events: [], append() {} } }
  agent.ctx = createScope(ctx, agent).ctx
  agents.set(agent.id, agent)
  await ctx.emit('agent/created', { agent })
  const result = await ctx.tools.execute({ callId: 'namespace-full-read', name: 'ptc_execute', agent,
    signal: new AbortController().signal, arguments: { program: "return await ptc.readAllText({file_path:'proof.txt'})",
      description: 'Read full UTF-8 text through native capability', boundary: 'semantic_decision' } })
  assert.equal(result.isError, false, result.error?.message)
  assert.equal(result.value.status, 'ok', JSON.stringify(result.value))
  // Native read contract joins line text, omitting the terminal newline.
  assert.ok(result.value.value === text.slice(0, -1), 'full native line text must match without preview truncation')
})
