import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { findVudaRuntime, listVudaTools } from '../vuda-runtime.mjs'

async function fixture(t, { dotenv = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vuda-discovery-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('dsh-vuda-discovery-'))
    await rm(root, { recursive: true, force: true })
  })
  const files = {
    '.agents/skills/pixel-perfect-ui-port/references/vuda-empty.config': '# empty\n',
    'cache/_npx/existing/node_modules/visual-ui-debug-agent-mcp/package.json': JSON.stringify({ name: 'visual-ui-debug-agent-mcp', version: '1.1.0' }),
    'cache/_npx/existing/node_modules/visual-ui-debug-agent-mcp/dist/index.js': '',
    'cache/_npx/existing/node_modules/@modelcontextprotocol/sdk/package.json': JSON.stringify({ name: '@modelcontextprotocol/sdk', exports: { './client': './client.js', './client/stdio.js': './stdio.js' } }),
    'cache/_npx/existing/node_modules/@modelcontextprotocol/sdk/client.js': '',
    'cache/_npx/existing/node_modules/@modelcontextprotocol/sdk/stdio.js': '',
  }
  if (dotenv) files['cache/_npx/existing/node_modules/dotenv/config.js'] = ''
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), content)
  }
  return { root, cache: join(root, 'cache') }
}

test('discovers an existing npm exec installation without PATH or a global package', async t => {
  const options = await fixture(t)
  const runtime = await findVudaRuntime(options)
  assert.equal(runtime.version, '1.1.0')
  assert.ok(runtime.serverEntry.startsWith(join(options.cache, '_npx')))
  assert.equal(runtime.env.VUDA_BROWSER_PROVIDER, 'local')
  assert.equal(runtime.env.DOTENV_CONFIG_PATH, join(options.root, '.agents/skills/pixel-perfect-ui-port/references/vuda-empty.config'))
  assert.ok(runtime.clientEntry.endsWith('client.js'))
  assert.ok(runtime.transportEntry.endsWith('stdio.js'))
})

test('reports an incomplete installed package instead of pretending it is usable', async t => {
  const options = await fixture(t, { dotenv: false })
  await assert.rejects(findVudaRuntime(options), error => {
    assert.match(error.message, /VUDA_RUNTIME_UNAVAILABLE/)
    assert.equal(error.diagnostics.length, 1)
    assert.equal(error.diagnostics[0].error, 'MODULE_NOT_FOUND')
    return true
  })
})

test('lists every MCP catalog page using the returned cursor', async () => {
  const cursors = []
  const result = await listVudaTools({ listTools: async params => {
    cursors.push(params.cursor)
    return params.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first' }], nextCursor: 'page-two' }
  } })
  assert.deepEqual(cursors, [undefined, 'page-two'])
  assert.deepEqual(result.tools.map(tool => tool.name), ['first', 'second'])
  assert.equal(result.pages, 2)
  assert.equal(result.count, 2)
})
