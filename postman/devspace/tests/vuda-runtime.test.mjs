import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { findVudaRuntime, listVudaTools } from '../vuda-runtime.mjs'
import { configureVudaChromium } from '../start-vuda.mjs'

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
  assert.deepEqual(runtime.launcherArgs.slice(1), [runtime.cwd, options.root])
  assert.ok(runtime.launcherArgs[0].endsWith('start-vuda.mjs'))
})

test('GPU launch preserves caller options and the existing Chrome fallback', async () => {
  const calls = []
  const chromium = { launch(options) { assert.equal(this, chromium); calls.push(options) } }
  configureVudaChromium(chromium)
  await chromium.launch({ headless: true, timeout: 123, args: ['--example'] })
  await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-gpu'] })
  assert.deepEqual(calls, [
    { headless: true, timeout: 123, channel: 'chromium', args: ['--example', '--enable-gpu'] },
    { headless: true, channel: 'chrome', args: ['--enable-gpu'] }
  ])
})

test('shutdown waits for an opening browser and closes every owned browser', async () => {
  let opened
  let closed = 0
  const browser = { async close() { closed++ } }
  const chromium = { launch: () => new Promise(resolve => { opened = resolve }) }
  const close = configureVudaChromium(chromium)
  const launching = chromium.launch({})
  await Promise.resolve()
  const closing = close()
  opened(browser)
  await launching
  await closing
  await close()
  assert.equal(closed, 1)
})

test('shared entry changes the Playwright instance imported by VUDA and strips credentials', async t => {
  const options = await fixture(t)
  const runtime = await findVudaRuntime(options)
  const packageRoot = runtime.cwd
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'visual-ui-debug-agent-mcp', version: '1.1.0', type: 'module'
  }))
  const playwrightRoot = join(packageRoot, '../playwright')
  await mkdir(playwrightRoot)
  await writeFile(join(playwrightRoot, 'package.json'), JSON.stringify({ name: 'playwright', main: 'index.cjs' }))
  await writeFile(join(playwrightRoot, 'index.cjs'), `exports.chromium = {
    launch(options) { console.log(JSON.stringify({ options,
      secretPresent: 'DSH_TEST_SECRET' in process.env,
      provider: process.env.VUDA_BROWSER_PROVIDER,
      dotenv: process.env.DOTENV_CONFIG_PATH,
      cwd: process.cwd() })) }
  }`)
  await writeFile(runtime.serverEntry, `import { chromium } from 'playwright';
    await chromium.launch({ headless: true });`)
  const launcher = fileURLToPath(new URL('../start-vuda.mjs', import.meta.url))
  const output = execFileSync(process.execPath, [launcher, packageRoot, options.root], {
    encoding: 'utf8', env: { ...process.env, DSH_TEST_SECRET: 'test-only', VUDA_BROWSER_PROVIDER: 'cdp' }
  })
  const actual = JSON.parse(output)
  assert.deepEqual(actual.options, { headless: true, channel: 'chromium', args: ['--enable-gpu'] })
  assert.equal(actual.secretPresent, false)
  assert.equal(actual.provider, 'local')
  assert.equal(actual.dotenv, runtime.env.DOTENV_CONFIG_PATH)
  assert.equal(resolve(actual.cwd), resolve(packageRoot))
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

test('closing MCP stdin closes the browser before the server exits', { timeout: 5000 }, async t => {
  const options = await fixture(t)
  const runtime = await findVudaRuntime(options)
  await writeFile(join(runtime.cwd, 'package.json'), JSON.stringify({ name: 'visual-ui-debug-agent-mcp', version: '1.1.0', type: 'module' }))
  const playwrightRoot = join(runtime.cwd, '../playwright')
  await mkdir(playwrightRoot)
  await writeFile(join(playwrightRoot, 'package.json'), JSON.stringify({ name: 'playwright', main: 'index.cjs' }))
  await writeFile(join(playwrightRoot, 'index.cjs'), `exports.chromium = { async launch() {
    return { async close() { console.log('browser-closed') } }
  } }`)
  await writeFile(runtime.serverEntry, `import { chromium } from 'playwright';
    await chromium.launch({}); console.log('browser-open'); process.stdin.resume();`)
  const launcher = fileURLToPath(new URL('../start-vuda.mjs', import.meta.url))
  const child = spawn(process.execPath, [launcher, runtime.cwd, options.root], { windowsHide: true })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''
  child.stdout.on('data', chunk => {
    output += chunk
    if (output.includes('browser-open')) child.stdin.end()
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0)
  assert.match(output, /browser-open[\s\S]*browser-closed/)
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
