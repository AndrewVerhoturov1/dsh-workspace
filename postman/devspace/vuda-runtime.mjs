import { access, readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const npmCache = process.env.npm_config_cache || (process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'npm-cache')
  : join(homedir(), '.npm'))

// npm exec installations are not necessarily present in PATH or npm's global tree.
export async function findVudaRuntime({ root = projectRoot, cache = npmCache } = {}) {
  const candidates = [join(root, 'node_modules/visual-ui-debug-agent-mcp'),
    join(root, 'profiles/web/node_modules/visual-ui-debug-agent-mcp')]
  const cacheRoot = join(cache, '_npx')
  let entries
  try { entries = await readdir(cacheRoot, { withFileTypes: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error; entries = [] }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) candidates.push(join(cacheRoot, entry.name, 'node_modules/visual-ui-debug-agent-mcp'))
  }
  const diagnostics = []
  for (const directory of candidates) {
    let metadata
    try { metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') diagnostics.push({ directory, error: error.code || error.message }); continue }
    if (metadata.name !== 'visual-ui-debug-agent-mcp' || metadata.version !== '1.1.0') {
      diagnostics.push({ directory, error: 'Expected visual-ui-debug-agent-mcp@1.1.0' }); continue
    }
    try {
      const require = createRequire(join(directory, 'package.json'))
      const serverEntry = join(directory, 'dist/index.js')
      const dotenvConfig = join(root, '.agents/skills/pixel-perfect-ui-port/references/vuda-empty.config')
      await access(serverEntry)
      await access(dotenvConfig)
      require.resolve('dotenv/config')
      const clientEntry = require.resolve('@modelcontextprotocol/sdk/client')
      const transportEntry = require.resolve('@modelcontextprotocol/sdk/client/stdio.js')
      return { version: metadata.version, command: process.execPath, serverEntry, clientEntry,
        transportEntry, cwd: directory, env: { VUDA_BROWSER_PROVIDER: 'local', DOTENV_CONFIG_PATH: dotenvConfig } }
    } catch (error) { diagnostics.push({ directory, error: error.code || error.message }) }
  }
  const error = new Error('VUDA_RUNTIME_UNAVAILABLE: installed VUDA 1.1.0 and its SDK/dotenv were not found; nothing was installed')
  error.diagnostics = diagnostics
  throw error
}

export async function withVudaClient(operation, options) {
  const runtime = await findVudaRuntime(options)
  const { Client } = await import(pathToFileURL(runtime.clientEntry).href)
  const { StdioClientTransport } = await import(pathToFileURL(runtime.transportEntry).href)
  // Do not forward provider credentials, browser profiles or external browser settings.
  const env = { ...runtime.env }
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile',
    'localappdata', 'appdata', 'comspec', 'pathext', 'home', 'lang'])
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value
  const transport = new StdioClientTransport({ command: runtime.command, args: [runtime.serverEntry],
    cwd: runtime.cwd, env, stderr: 'pipe' })
  let startupError = ''
  transport.stderr?.on('data', chunk => { startupError = (startupError + chunk.toString()).slice(-2000) })
  const client = new Client({ name: 'dsh-postman-vuda', version: '1.0.0' })
  try {
    try { await client.connect(transport) }
    catch (error) { throw new Error('VUDA_CONNECT_FAILED: ' + error.message + '\n' + startupError) }
    return await operation(client, runtime)
  } finally { await client.close() }
}

export async function listVudaTools(client) {
  const tools = []
  let cursor, pages = 0
  do {
    const page = await client.listTools(cursor ? { cursor } : {})
    tools.push(...page.tools)
    cursor = page.nextCursor
    pages++
  } while (cursor)
  return { pages, count: tools.length, tools }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const option = process.argv[2] || '--describe'
    if (!['--describe', '--list-tools'].includes(option)) throw new Error('Usage: node vuda-runtime.mjs [--describe|--list-tools]')
    const result = option === '--describe' ? await findVudaRuntime()
      : await withVudaClient(async (client, runtime) => ({ version: runtime.version, ...await listVudaTools(client) }))
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, diagnostics: error.diagnostics }))
    process.exitCode = 1
  }
}
