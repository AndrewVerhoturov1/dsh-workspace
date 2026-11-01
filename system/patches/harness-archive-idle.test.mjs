import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test, { before, after } from 'node:test'
import { applyHarnessSessionPerformance } from './apply-harness-session-performance.mjs'
import { applyHarnessArchiveIdle } from './apply-harness-archive-idle.mjs'

const sdk = createRequire(process.env.DSH_INSTALL_SDK ?? createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const root = mkdtempSync(join(tmpdir(), 'dsh-archive-idle-test-'))
const anchor = join(root, 'package.json')
writeFileSync(anchor, '{}')
const pathFor = name => join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')
let jsonl, workspace, host
before(() => {
  for (const name of ['dsh-host-apiproxy', 'dsh-session-persistence-jsonl', 'dsh-api-remotes', 'dsh-workspace']) {
    const path = pathFor(name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(join(dirname(dirname(path)), 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
    writeFileSync(path, readFileSync(sdk.resolve('@deepseek-ai/' + name)))
  }
  applyHarnessSessionPerformance(anchor)
  applyHarnessArchiveIdle(anchor)
  // The normal installer sequence must also accept an already-patched SDK.
  applyHarnessSessionPerformance(anchor)
  applyHarnessArchiveIdle(anchor)
  jsonl = readFileSync(pathFor('dsh-session-persistence-jsonl'), 'utf8').replaceAll('\r\n', '\n')
  workspace = readFileSync(pathFor('dsh-workspace'), 'utf8').replaceAll('\r\n', '\n')
  host = readFileSync(pathFor('dsh-host-apiproxy'), 'utf8').replaceAll('\r\n', '\n')
})
after(() => {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.ok(basename(root).startsWith('dsh-archive-idle-test-'))
  rmSync(root, { recursive: true, force: true })
})
function method(source, start, end, parameters = {}) {
  const begin = source.indexOf(start)
  assert.ok(begin >= 0, start)
  const stop = source.indexOf(end, begin)
  assert.ok(stop > begin, end)
  return new Function(...Object.keys(parameters), 'return ({' + source.slice(begin, stop) + '})')(...Object.values(parameters))
}

test('archive directories are excluded before encoding checks, file opens and decompression', async () => {
  const id = 'archived / special'
  const encodeSegment = encodeURIComponent
  const dirs = [join('/sessions/project', encodeSegment(id)), join('/sessions/project', 'visible')]
  const operations = []
  const backend = {
    compression: 'zstd', oppositeCompression: () => 'none',
    listProjectDirs: async () => ['/sessions/project'], listSessionDirs: async () => dirs,
    async exists(path) { operations.push(path); assert.ok(!path.includes(encodeSegment(id))); return path.endsWith('.zstd') },
    async readFirstZstdLine(path) { operations.push(path); assert.ok(!path.includes(encodeSegment(id))); return '{"id":"visible"}' },
    async assertStoredIdentity() {},
  }
  const { checkRootEncoding } = method(jsonl, '\tasync checkRootEncoding(', '\n\tasync rejectLegacyFlatArtifact', { basename, join, encodeSegment, logSuffix: c => c === 'zstd' ? '.jsonl.zstd' : '.jsonl' })
  backend.ensureRootEncoding = ids => checkRootEncoding.call(backend, ids)
  const { listArtifacts } = method(jsonl, '\tasync listArtifacts(', '\n\t/** Atomically write', { basename, join, encodeSegment, logSuffix: c => c === 'zstd' ? '.jsonl.zstd' : '.jsonl', parseHeaderMeta: JSON.parse })
  const result = await listArtifacts.call(backend, new AbortController().signal, [id])
  assert.deepEqual(result.map(r => r.header.id), ['visible'])
  assert.ok(operations.length > 0)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(listArtifacts.call(backend, aborted.signal, [id]), { name: 'AbortError' })
})

test('default persistence listing forwards the native archive set and explicit reads remain available', async () => {
  const { list } = method(jsonl, '\tasync list(signal,', '\n\t/** List metadata plus')
  let excluded
  const backend = {
    ctx: { get: () => ({ archivedSessionIds: ['archived'] }) },
    async listArtifacts(signal, ids) { excluded = ids; return [{ header: { id: 'cold-visible' } }] },
  }
  assert.deepEqual(await list.call(backend), [{ id: 'cold-visible' }])
  assert.deepEqual(excluded, ['archived'])
  // Exclusion belongs to inventory; findLog/inspect are not disabled or rewritten.
  assert.ok(jsonl.includes('inspect(id, signal) {\n\t\treturn this.coordinator.inspect(id, signal);'))
})

test('workspace catalog reuses metadata and receives new sessions without reading storage', () => {
  const { sessionHeaders } = method(workspace, '\tsessionHeaders() {', '\n\t/**\n\t* Delete one workspace')
  const cold = { id: 'finished-visible', parentSession: 'root' }
  const live = { id: 'root' }
  const registry = { headers: new Map([[cold.id, cold]]), ctx: { get: () => ({ list: () => [{ id: live.id, header: live }] }) } }
  assert.deepEqual(sessionHeaders.call(registry), [cold, live])
  assert.ok(workspace.includes('this.ctx.on("session/created", session => this.headers.set(session.id, session.header))'))
  assert.equal((workspace.match(/list\(undefined, \{ excludedSessionIds: this.state.archivedSessionIds \}\)/g) ?? []).length, 2)
})

test('ordinary session listing excludes archived live/cold sessions without persistence enumeration', async () => {
  const begin = host.indexOf('\tasync function listVisibleSessionSummaries(signal) {')
  const end = host.indexOf('\n\t/**\n\t* Resolve the goal', begin)
  assert.ok(begin >= 0 && end > begin)
  const ctx = {
    workspaceRegistry: { archivedSessionIds: ['archived-live', 'archived-cold'], sessionHeaders: () => [{ id: 'archived-cold', cwd: '/cwd' }, { id: 'cold', cwd: '/cwd' }] },
    agents: { get: () => undefined },
    sessions: { list: () => [{ id: 'archived-live', header: {} }, { id: 'live', header: {} }], get: () => undefined },
    get: () => ({ list() { assert.fail('No storage enumeration') } }),
  }
  const list = new Function('ctx', 'summarize', 'listProjectionsFor', 'summarizeCold', 'COLD_SUMMARY_BATCH_SIZE', 'coldBlankProbeMaxBytes', host.slice(begin, end) + ';return listVisibleSessionSummaries')(
    ctx, s => ({ sessionId: s.id, updatedAt: 1 }), () => undefined,
    async (_ctx, _p, meta) => ({ sessionId: meta.id, updatedAt: 0 }), 16, 1024)
  assert.deepEqual((await list()).map(s => s.sessionId), ['live', 'cold'])
})
