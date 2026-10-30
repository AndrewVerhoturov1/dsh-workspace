import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Each upstream VUDA server has process-global browser/page/resource state.
// Keep its unmodified implementation in one child per ChatGPT session.
export function createVudaSessionRouter(connect, audit = () => {}, { idleMs = 30 * 60 * 1000 } = {}) {
  const sessions = new Map()
  const retiring = new Set()
  let stopping = false
  let closing
  const hash = scope => createHash('sha256').update(scope).digest('hex')
  function retire(scope, entry, reason) {
    if (sessions.get(scope) !== entry) return
    sessions.delete(scope)
    clearTimeout(entry.timer)
    // Detach ownership before closing: a returning chat gets a new private child.
    const disposal = entry.tail.then(async () => {
      const client = await entry.client
      await client.close()
      audit({ event: 'session_closed', scope: hash(scope), reason })
    })
    retiring.add(disposal)
    disposal.then(() => retiring.delete(disposal), () => {
      retiring.delete(disposal)
      audit({ event: 'session_close_failed', scope: hash(scope), reason })
    })
  }
  function session(meta) {
    const scope = meta?.['openai/session']
    if (typeof scope !== 'string' || !scope.trim()) throw new Error('VUDA_CHAT_SESSION_REQUIRED')
    if (stopping) throw new Error('VUDA_TUNNEL_CLOSED')
    if (!sessions.has(scope)) {
      const entry = { tail: Promise.resolve(), pending: 0 }
      entry.client = Promise.resolve().then(connect).then(client => {
        const onclose = client.onclose
        client.onclose = () => {
          retire(scope, entry, 'disconnected')
          onclose?.()
        }
        return client
      })
      sessions.set(scope, entry)
    }
    return { entry: sessions.get(scope), scope: hash(scope), key: scope }
  }
  return {
    async run(method, params, rpcRequestId) {
      const { entry, scope, key } = session(params._meta)
      clearTimeout(entry.timer)
      entry.pending++
      const requestId = randomUUID()
      const fields = { requestId, rpcRequestId, scope, method,
        ...(method === 'tools/call' ? { tool: params.name } : {}) }
      audit({ ...fields, event: 'received' })
      const result = entry.tail.then(async () => {
        const client = await entry.client
        if (method === 'tools/call') return client.callTool(params)
        if (method === 'resources/read') return client.readResource(params)
        return client.listResources(params)
      })
      entry.tail = result.catch(() => {})
      try {
        const value = await result
        audit({ ...fields, event: 'completed', isError: value.isError === true })
        return value
      } catch (error) {
        // Errors may contain page content/arguments. Persist only the outcome.
        audit({ ...fields, event: 'failed' })
        throw error
      } finally {
        entry.pending--
        // A queued action is activity too; never expire a running/queued request.
        if (!stopping && !entry.pending && sessions.get(key) === entry) {
          entry.timer = setTimeout(() => retire(key, entry, 'idle'), idleMs)
          entry.timer.unref()
        }
      }
    },
    close() {
      stopping = true
      for (const [scope, entry] of sessions) retire(scope, entry, 'shutdown')
      return closing ??= Promise.allSettled([...retiring])
    }
  }
}

export async function startVudaTunnel(options = {}) {
  const root = resolve(options.root ?? fileURLToPath(new URL('../../', import.meta.url)))
  const { findVudaRuntime, listVudaTools } = await import(pathToFileURL(join(root, 'postman/devspace/vuda-runtime.mjs')).href)
  const runtime = await findVudaRuntime({ ...options, root })
  const require = createRequire(runtime.serverEntry)
  const sdk = async name => import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/' + name)).href)
  const [{ Client }, { StdioClientTransport }, { Server }, { StdioServerTransport }, types] = await Promise.all([
    sdk('client'), sdk('client/stdio.js'), sdk('server/index.js'), sdk('server/stdio.js'), sdk('types.js')
  ])
  // Never pass the tunnel's API key or browser credentials to a child VUDA.
  const env = { ...runtime.env }
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile',
    'localappdata', 'appdata', 'comspec', 'pathext', 'home', 'lang'])
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase())) env[key] = value
    else delete process.env[key]
  }
  const connect = async () => {
    const transport = new StdioClientTransport({ command: runtime.command, args: runtime.launcherArgs,
      cwd: runtime.cwd, env, stderr: 'pipe' })
    transport.stderr?.resume() // Do not copy unfiltered child diagnostics into tunnel logs.
    const client = new Client({ name: 'dsh-vuda-chat', version: '1.0.0' })
    try { await client.connect(transport); return client }
    catch (error) { await client.close(); throw error }
  }
  const auditFile = options.auditFile ?? join(process.env.LOCALAPPDATA, 'DSH/integrations/vuda-tunnel/requests.jsonl')
  mkdirSync(dirname(auditFile), { recursive: true })
  const router = createVudaSessionRouter(connect, event => {
    appendFileSync(auditFile, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 })
  })
  // Discovery needs no page or chat identity. Close this catalogue-only child.
  const catalogClient = await connect()
  let catalog
  try { catalog = await listVudaTools(catalogClient) }
  finally { await catalogClient.close() }
  const server = new Server({ name: 'vuda', version: runtime.version }, {
    capabilities: { tools: {}, resources: {} }
  })
  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: catalog.tools }))
  for (const [schema, method] of [
    [types.CallToolRequestSchema, 'tools/call'],
    [types.ReadResourceRequestSchema, 'resources/read'],
    [types.ListResourcesRequestSchema, 'resources/list']
  ]) {
    server.setRequestHandler(schema, async (request, extra) => {
      try { return await router.run(method, request.params ?? {}, extra.requestId) }
      catch (error) {
        if (error.message === 'VUDA_CHAT_SESSION_REQUIRED') {
          throw new types.McpError(types.ErrorCode.InvalidParams, error.message)
        }
        throw error
      }
    })
  }
  let closing
  const close = () => closing ??= router.close().finally(() => server.close())
  const shutdown = () => { void close().finally(() => process.exit(0)) }
  process.stdin.once('end', shutdown)
  process.stdin.once('close', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await server.connect(new StdioServerTransport())
  return { server, close }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startVudaTunnel({ root: process.argv[2] })
}
