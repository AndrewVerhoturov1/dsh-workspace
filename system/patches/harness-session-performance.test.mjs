import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test, { before, after } from 'node:test'
import { applyHarnessSessionPerformance } from './apply-harness-session-performance.mjs'

const anchor = process.env.DSH_INSTALL_SDK ?? process.env.DSH_CAPABILITY_SDK ?? createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const sdk = createRequire(anchor)
const root = mkdtempSync(join(tmpdir(), 'dsh-session-performance-test-'))
const fixtureAnchor = join(root, 'package.json')
writeFileSync(fixtureAnchor, '{}')
const modulePath = name => join(root, 'node_modules/@deepseek-ai', name, 'lib/index.js')
let paginate, listArtifacts, summarize, detachedProjections, inspectSession

before(() => {
  for (const name of ['dsh-host-apiproxy', 'dsh-session-persistence-jsonl', 'dsh-api-remotes']) {
    const path = modulePath(name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(join(dirname(dirname(path)), 'package.json'), JSON.stringify({ main: 'lib/index.js' }))
    writeFileSync(path, readFileSync(sdk.resolve('@deepseek-ai/' + name)))
  }
  applyHarnessSessionPerformance(fixtureAnchor)
  const host = readFileSync(modulePath('dsh-host-apiproxy'), 'utf8')
  const begin = host.indexOf('function paginate(')
  const end = host.indexOf('\n/** Wrap an ok result', begin)
  paginate = new Function('MESSAGE_TYPES', 'isAppendSurfaceEvent', 'Buffer', host.slice(begin, end) + ';return paginate')(
    new Set(['user/message', 'assistant/message', 'tool/result']), e => e.surfaceOp?.kind !== 'replace', Buffer)
  const summaryStart = host.indexOf('function summarize(')
  const summaryEnd = host.indexOf('\n/**', summaryStart)
  summarize = new Function('sessionListMetadata', 'sessionListUpdatedAt', 'sessionListFields', host.slice(summaryStart, summaryEnd) + ';return summarize')(
    () => { throw new Error('unnecessary full log fold') }, (header, metadata) => Math.max(header.createdAt, metadata.lastPromptAt ?? 0), () => ({}))
  const projectionStart = host.indexOf('function detachedProjectionsFor(')
  const projectionEnd = host.indexOf('\n/**', projectionStart)
  detachedProjections = new Function(host.slice(projectionStart, projectionEnd) + ';return detachedProjectionsFor')()
  const jsonl = readFileSync(modulePath('dsh-session-persistence-jsonl'), 'utf8')
  const start = jsonl.indexOf('\tasync listArtifacts(signal) {')
  const finish = jsonl.indexOf('\n\t/** Atomically write', start)
  const method = jsonl.slice(start, finish).replace('async listArtifacts(', 'async function listArtifacts(')
  listArtifacts = new Function('join', 'logSuffix', 'parseHeaderMeta', 'return (' + method + ')')(
    join, compression => compression === 'zstd' ? '.jsonl.zstd' : '.jsonl', JSON.parse)
  const remotes = readFileSync(modulePath('dsh-api-remotes'), 'utf8')
  const remoteStart = remotes.indexOf('async function inspectApiRemoteSession(')
  const remoteEnd = remotes.indexOf('\n}', remoteStart) + 2
  inspectSession = new Function('ApiRemoteSessionNotFound', remotes.slice(remoteStart, remoteEnd) + ';return inspectApiRemoteSession')(
    class ApiRemoteSessionNotFound extends Error {})
})
after(() => {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.ok(basename(root).startsWith('dsh-session-performance-test-'))
  rmSync(root, { recursive: true, force: true })
})

function messages(count, chunks = 0, text = 'x') {
  const events = []
  for (let n = 0; n < count; n++) {
    const start = events.length
    for (let i = 0; i < chunks; i++) events.push({ seq: events.length, type: 'assistant/chunk', data: { text } })
    events.push({ seq: events.length, type: 'assistant/message', sourceEventSeqs: chunks ? [start] : [], data: { text } })
  }
  return events
}

test('history pages bound streamed events without gaps, lost events, or split source groups', () => {
  const events = messages(60, 220)
  const pages = []
  let beforeSeq
  for (;;) {
    const page = paginate(events, beforeSeq, 50)
    assert.ok(page.events.length > 0 && page.events.length <= 2048)
    for (const e of page.events) for (const seq of e.sourceEventSeqs ?? []) assert.ok(seq >= page.events[0].seq)
    pages.unshift(page.events)
    if (!page.hasMore) break
    beforeSeq = page.events[0].seq
  }
  assert.deepEqual(pages.flat(), events)
})

test('history byte budget preserves one indivisible large message and the unfinished tail', () => {
  const events = messages(8, 3, 'я'.repeat(20000))
  events.push({ seq: events.length, type: 'assistant/chunk', data: { text: 'unfinished' } })
  const page = paginate(events, undefined, 50)
  assert.ok(Buffer.byteLength(JSON.stringify(page.events)) < 512 * 1024)
  assert.deepEqual(page.events.at(-1), events.at(-1))
  const large = messages(1, 2200)
  assert.deepEqual(paginate(large, undefined, 50).events, large)
})

test('small histories and replacement source groups preserve their original page semantics', () => {
  const events = [{ seq: 0, type: 'session/start' }, ...messages(2).map(e => ({ ...e, seq: e.seq + 1 }))]
  assert.deepEqual(paginate(events, undefined, 50), { events, hasMore: false })
  const replacement = { seq: 3, type: 'assistant/message', sourceEventSeqs: [1], surfaceOp: { kind: 'replace' } }
  events.push(replacement)
  assert.deepEqual(paginate(events, undefined, 1), { events: events.slice(2), hasMore: true })
})

test('attached session summaries reuse the current metadata projection without folding the whole log', () => {
  const row = summarize({ id: 'live', header: { createdAt: 1 }, events: [] }, true, { blank: false, lastPromptAt: 5 })
  assert.deepEqual(row, { sessionId: 'live', updatedAt: 5, running: true, blank: false })
})

test('cold history restores only the tail of an identity-matching checkpoint at the same log cut', () => {
  const header = { id: 'cold', createdAt: 10, cwd: 'workspace' }
  const events = Array.from({ length: 10000 }, (_, seq) => ({ seq }))
  const rows = { checkpoint: true }
  let replayed
  const registry = { restoreFloor: () => 9990, restore(cached, tail, floor) {
    assert.equal(cached, rows); assert.equal(floor, 9990)
    replayed = tail
    return { snapshot: { asOfSeq: tail.at(-1).seq } }
  } }
  const cache = { recordFor(id, identity) {
    assert.equal(id, header.id)
    assert.deepEqual(identity, { createdAt: 10, cwd: 'workspace' })
    return { rows }
  } }
  const ctx = { get: name => name === 'sessionProjections' ? registry : cache }
  assert.deepEqual(detachedProjections(ctx, events, header), { asOfSeq: 9999 })
  assert.equal(replayed.length, 10)
  registry.restoreFloor = () => 10001
  registry.restore = (cached, tail, floor) => {
    assert.deepEqual(cached, {}); assert.equal(tail, events); assert.equal(floor, 0)
    return { snapshot: 'authoritative full log' }
  }
  assert.equal(detachedProjections(ctx, events, header), 'authoritative full log')
})

test('opening one stored session skips global listing while retaining not-found and corruption failures', async () => {
  const result = { meta: { id: 'one', cwd: 'workspace' }, events: [{ seq: 0 }] }
  const backend = { inspect: async () => result, list: async () => { throw new Error('unnecessary global listing') } }
  const ctx = { get: () => backend }
  assert.deepEqual(await inspectSession(ctx, 'one'), result)
  const corrupt = new Error('corrupt stored log')
  backend.inspect = async () => { throw corrupt }
  backend.list = async () => [result.meta]
  await assert.rejects(inspectSession(ctx, 'one'), error => error === corrupt)
  backend.list = async () => []
  await assert.rejects(inspectSession(ctx, 'missing'), /session "missing" not found/)
})

function store({ count = 40, fail = false, duplicate = false, signal } = {}) {
  let active = 0, peak = 0, finished = 0
  const backend = {
    compression: 'none', ensureRootEncoding: async () => {},
    listProjectDirs: async () => ['project'],
    listSessionDirs: async () => Array.from({ length: count }, (_, i) => String(i)),
    oppositeCompression: () => 'zstd', encodingMismatch: () => new Error('wrong encoding'),
    exists: async path => !path.endsWith('.zstd'),
    async readFirstLine(path) {
      active++; peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 2))
      active--; finished++
      if (fail && dirname(path) === '0') throw new Error('read failed')
      return JSON.stringify({ id: duplicate ? 'same-id' : dirname(path) })
    },
    assertStoredIdentity: async () => {},
  }
  return { run: () => listArtifacts.call(backend, signal), stats: () => ({ active, peak, finished }) }
}

test('listing overlaps filesystem waits while retaining every row and deterministic order', async () => {
  const fixture = store()
  const rows = await fixture.run()
  assert.deepEqual(rows.map(r => r.header.id), Array.from({ length: 40 }, (_, i) => String(i)))
  assert.ok(fixture.stats().peak > 1 && fixture.stats().peak <= 16)
})

test('failed batches settle before rejecting, duplicate ids and cancellation remain errors', async () => {
  const failed = store({ fail: true })
  await assert.rejects(failed.run(), /read failed/)
  assert.equal(failed.stats().active, 0)
  assert.equal(failed.stats().finished, 16)
  await assert.rejects(store({ duplicate: true }).run(), /duplicate JSONL session id/)
  await assert.rejects(store({ signal: AbortSignal.abort(new Error('cancelled')) }).run(), /cancelled/)
})

test('installation is idempotent and an unknown second module leaves the first unchanged', () => {
  const paths = applyHarnessSessionPerformance(fixtureAnchor)
  assert.equal(paths.length, 3)
  const first = readFileSync(paths[0], 'utf8')
  const second = readFileSync(paths[1], 'utf8')
  writeFileSync(paths[1], second + '\n// unknown local change\n')
  assert.throws(() => applyHarnessSessionPerformance(fixtureAnchor), /preimage mismatch/)
  assert.equal(readFileSync(paths[0], 'utf8'), first)
  writeFileSync(paths[1], second)
})
