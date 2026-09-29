import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { apply as applyFs } from '@deepseek-ai/dsh-tool-fs'
import { applyGlobTool, applyGrepTool, RAW_OUTPUT_MAX_BYTES, GREP_MAX_MATCHES, GREP_MAX_LINE_BYTES, SEARCH_META_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES, SEARCH_TIMEOUT_MS } from '@deepseek-ai/dsh-tool-fs-search'
import { applyWebFetchTool, applyWebSearchTool } from '@deepseek-ai/dsh-tool-web'
import { createMemoryTaskRegistry } from './postman-task-registry.js'
import { createPostmanWorkerTools } from './postman-worker.js'
import { createPostmanBridgeBoundaryManager, isTopLevelPostmanPtcLeader, POSTMAN_LEADER_TOOL_ALLOWLIST } from './postman-bridge-core.js'
import { createPtcAdapter, WORKER_RESEARCH_PROFILE } from './ptc-adapter.js'

const output = { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function fixture(dir, { web = true, worktree = dir } = {}) {
  const ctx = new Context()
  ctx.systemPrompt = { tools() {}, section() { return () => {} } }
  new ToolRuntime(ctx)
  ctx.fs = new LocalFileSystem(ctx, { cwd: dir, diffBasisMaxBytes: 1048576 })
  ctx.subprocess = new LocalSubprocessRuntime(ctx)
  applyFs(ctx, { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 10485760 })
  const caps = { maxMatches: GREP_MAX_MATCHES, maxLineBytes: GREP_MAX_LINE_BYTES, maxMetaBytes: SEARCH_META_MAX_BYTES,
    rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES, graceMs: SEARCH_GRACE_MS, stderrMaxBytes: SEARCH_STDERR_MAX_BYTES, timeoutMs: SEARCH_TIMEOUT_MS }
  applyGlobTool(ctx, { ...caps, maxResults: 100, sampleThreshold: 1000 })
  applyGrepTool(ctx, caps)
  if (web) {
    ctx.web = {
      async fetch({ url }) { return { url, statusCode: 200, body: { kind: 'text', content: 'fixture page' }, truncated: false } },
      async search({ query }) { return { sources: [{ url: 'https://example.test/', title: query }], truncated: false } },
    }
    applyWebFetchTool(ctx, 30000, 200000)
    applyWebSearchTool(ctx, 10, 4, 30000, true)
  }
  // Ordinary Worker tools remain wide, but these inert names must never enter a PTC program.
  for (const name of ['write', 'edit', 'pwsh', 'bash', 'jobs', 'report', 'notify_parent', 'postman_bridge', 'postman_worker', 'implementation_artifact_apply', 'read_image', 'get_goal'])
    if (!ctx.tools.get(name)) ctx.tools.register(defineTool({ name, description: name, parameters: {}, output, execute() { return { name } } }))
  for (const name of POSTMAN_LEADER_TOOL_ALLOWLIST)
    if (!ctx.tools.get(name)) ctx.tools.register(defineTool({ name, description: name, parameters: {}, output, execute() { return { name } } }))
  const agents = new Map(), presets = new WeakMap(), children = new Set(), created = new Map(), traces = [], calls = { starts: [], follows: [], drains: [], early: [] }
  ctx.agents = { get: id => agents.get(id), list: () => [...agents.values()] }
  const service = ctx.get.bind(ctx)
  ctx.get = name => name === 'approval' ? { request: async () => 'allowed-once' } : service(name)
  ctx.agentPresets = { composedPreset: agentCtx => agentCtx?.agent?.session?.header?.agentPreset ?? presets.get(agentCtx) }
  ctx.on('tools/pre-execute', async (exec, next) => { traces.push({ name: exec.name, agent: exec.agent, parent: exec.parent, root: exec.rootCallId, token: exec.token }); return next() })
  const registry = createMemoryTaskRegistry(), taskContexts = new Map()
  const contexts = {
    get: id => taskContexts.get(id) ?? null, record: registry.get, changeRecord: registry.change,
    isRestoring: () => false, hasActiveOperation: () => false,
  }
  ctx.subagents = {
    async listChildren() { return [...children].map(id => ({ id, kind: 'child', mode: 'continuable', activity: 'inactive' })) },
    async startContinuable(spec) {
      calls.starts.push(spec)
      const child = await agent(spec.childId, 'plain', { origin: 'subagent', delegationDepth: 1, parentSession: spec.request.parent.id })
      created.set(spec.childId, child)
      calls.early.push(ctx.tools.schemas(child.a).some(s => s.name === 'ptc_execute'))
      children.add(spec.childId)
      return { childId: spec.childId, messageId: 'start-' + calls.starts.length }
    },
    async followup(_parent, id) { calls.follows.push(id); return 'follow-' + calls.follows.length },
    async drainContinuableChildren(_parent, ids) { calls.drains.push(ids); agents.delete(ids[0]); children.delete(ids[0]) },
  }
  let adapter, boundaries
  function refresh(id) {
    const current = agents.get(id)
    if (!current || !adapter || !boundaries) return
    adapter.remove(current)
    boundaries.refreshSession(id)
    adapter.refresh(current)
  }
  let worker = createPostmanWorkerTools(ctx, undefined, contexts, { onBindingChange: refresh })
  function restartWorker() {
    worker.dispose()
    worker = createPostmanWorkerTools(ctx, undefined, contexts, { onBindingChange: refresh })
  }
  const owns = a => worker.ownsLiveWorker(a) && isTopLevelPostmanPtcLeader(agents.get(a.session.header.parentSession))
  adapter = createPtcAdapter(ctx, { workerContextOf: a => owns(a) ? worker.ptcContextOf(a) : null,
    resolveAssignment: (a, leaderProfile) => isTopLevelPostmanPtcLeader(a)
    ? { profile: leaderProfile, role: 'leader' } : owns(a) ? { profile: WORKER_RESEARCH_PROFILE, role: 'worker' } : null })
  ctx.tools.register(adapter.tool)
  boundaries = createPostmanBridgeBoundaryManager(id => agents.get(id), owns)
  async function agent(id, preset = 'plain', header = {}) {
    const sections = [], events = []
    const a = { id, status: 'running', session: { header: { agentPreset: preset, delegationDepth: 0, cwd: dir, ...header }, events: [],
      append(type, data) { events.push({ type, data }) } } }
    a.ctx = createScope(ctx, a).ctx
    presets.set(a.ctx, preset)
    a.ctx.systemPrompt.section = section => { sections.push(section); return () => { const index = sections.indexOf(section); if (index >= 0) sections.splice(index, 1) } }
    agents.set(id, a); boundaries.install(a); await worker.confirmActivation(a); adapter.refresh(a)
    return { a, sections, events }
  }
  let n = 0
  function execute(a, program, controller = new AbortController()) {
    return ctx.tools.execute({ callId: 'root-' + ++n, name: 'ptc_execute', arguments: { program, description: 'Worker research' }, agent: a, signal: controller.signal })
  }
  async function leader(id = 'leader', preset = 'postman-leader-ptc', taskWorktree = worktree) {
    const result = await agent(id, preset)
    const context = Object.freeze({ branch: 'task/postman-' + id, worktree: taskWorktree })
    await registry.create(id, { stage: 'ready', workers: {}, runner: { state: 'none' } })
    taskContexts.set(id, context)
    return result
  }
  async function start(parent, label = 'Worker') {
    const result = await worker.taskTool.execute({ task: 'research', createNew: true, label }, { agent: parent.a, signal: new AbortController().signal })
    assert.equal(result.status, 'POSTMAN_WORKER_TASK_ACCEPTED', JSON.stringify(result))
    return created.get(result.workerSessionId)
  }
  async function cleanup() { worker.dispose(); boundaries.disposeAll(); await adapter.dispose(); await ctx.fiber.dispose() }
  return { ctx, agent, leader, start, execute, get worker() { return worker }, restartWorker, adapter, boundaries, agents, presets, taskContexts, registry, traces, calls, cleanup, refresh }
}

const inTemporaryDir = async (prefix, fn) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const visible = (f, a) => f.ctx.tools.schemas(a).map(s => s.name)
const value = result => { assert.equal(result.isError, false, result.error?.message); assert.equal(result.value.status, 'ok', JSON.stringify(result.value)); return result.value.value }

test('confirmed Worker gets research namespace, real read/glob/grep and controlled web through Harness', () => inTemporaryDir('ptc-worker-', async dir => {
  await writeFile(join(dir, 'one.txt'), 'МАРКЕР один\n', 'utf8')
  await writeFile(join(dir, 'two.txt'), 'МАРКЕР два\n', 'utf8')
  const f = await fixture(dir)
  try {
    const parent = await f.leader(), child = await f.start(parent)
    assert.deepEqual(f.calls.early, [false])
    assert.equal(WORKER_RESEARCH_PROFILE.id, 'postman-worker-research')
    assert.equal(WORKER_RESEARCH_PROFILE.revision, 1)
    assert.deepEqual(WORKER_RESEARCH_PROFILE.tools, ['read', 'glob', 'grep', 'web_fetch', 'web_search'])
    assert.equal(visible(f, child.a).includes('ptc_execute'), true)
    assert.ok(visible(f, child.a).includes('write'))
    assert.match(child.sections[0].text({ scope: child.a }), /read, glob, grep.*web_fetch\/web_search/)
    const names = value(await f.execute(child.a, 'return Object.keys(tools).sort()'))
    assert.deepEqual(names, ['glob', 'grep', 'read', 'web_fetch', 'web_search'])
    for (const denied of ['write', 'edit', 'pwsh', 'bash', 'jobs', 'report', 'notify_parent', 'postman_worker', 'ptc_execute', 'run_code', 'read_image', 'get_goal'])
      assert.ok(!names.includes(denied), denied)
    const result = value(await f.execute(child.a, "const found = await tools.glob({pattern:'*.txt'}); const files = found.paths.sort(); const lines = []; for (const path of files) { const r = await tools.read({file_path:path}); lines.push(r.lines[0].text) } const match = await tools.grep({pattern:'МАРКЕР',path:found.root}); const web = await tools.web_fetch({url:'http://127.0.0.1/controlled'}); const search = await tools.web_search({queries:['fixture']}); return {lines,matches:match.matches.length,page:web.body.content,title:search.sources[0].title}"))
    assert.deepEqual(result.lines, ['МАРКЕР один', 'МАРКЕР два'])
    assert.equal(result.matches, 2)
    assert.equal(result.page, 'fixture page')
    assert.equal(result.title, 'fixture')
    const nested = f.traces.filter(t => ['read', 'glob', 'grep', 'web_fetch', 'web_search'].includes(t.name))
    assert.deepEqual(nested.map(t => t.name), ['glob', 'read', 'read', 'grep', 'web_fetch', 'web_search'])
    const outer = f.traces.findLast(t => t.name === 'ptc_execute' && t.agent === child.a)
    assert.ok(nested.every(t => t.agent === child.a && t.parent === outer.token && t.root === outer.root))
  } finally { await f.cleanup() }
}))

test('Worker PTC relative read resolves against its Host-bound task worktree, not session cwd', () => inTemporaryDir('ptc-base-', async root => {
  const session = join(root, 'session'), worktree = join(root, 'task')
  await mkdir(session); await mkdir(worktree)
  await writeFile(join(session, 'proof.txt'), 'INSTALLATION_MARKER\n', 'utf8')
  await writeFile(join(worktree, 'proof.txt'), 'WORKTREE_MARKER\n', 'utf8')
  const f = await fixture(session, { worktree })
  try {
    const leader = await f.leader(), child = await f.start(leader)
    const result = value(await f.execute(child.a, "return (await tools.read({file_path:'proof.txt'})).lines[0].text"))
    assert.equal(result, 'WORKTREE_MARKER')
    const search = value(await f.execute(child.a, "const g = await tools.glob({pattern:'*.txt'}); const r = await tools.grep({pattern:'MARKER'}); return {paths:g.paths,matches:r.matches.map(x=>x.line)}"))
    assert.equal(search.paths.length, 1)
    assert.deepEqual(search.matches, ['WORKTREE_MARKER'])
    assert.equal(value(await f.execute(child.a, 'return (await tools.read({file_path:' + JSON.stringify(join(worktree, 'proof.txt')) + '})).lines[0].text')), 'WORKTREE_MARKER')
    assert.equal(f.traces.filter(t => ['read', 'glob', 'grep'].includes(t.name)).every(t => t.agent === child.a), true)
  } finally { await f.cleanup() }
}))

test('Worker PTC rejects absolute, traversal and junction escapes before Harness dispatch', () => inTemporaryDir('ptc-escapes-', async root => {
  const session = join(root, 'session'), task = join(root, 'task'), outside = join(root, 'outside')
  await mkdir(session); await mkdir(task); await mkdir(outside); await mkdir(join(task, 'safe'))
  await writeFile(join(outside, 'secret.txt'), 'OUTSIDE_SECRET\n', 'utf8')
  await writeFile(join(root, 'outside.txt'), 'OUTSIDE_PARENT\n', 'utf8')
  await symlink(outside, join(task, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir')
  const f = await fixture(session, { worktree: task })
  try {
    const leader = await f.leader(), child = await f.start(leader)
    for (const [name, args] of [
      ['read', { file_path: join(outside, 'secret.txt') }],
      ['read', { file_path: '../outside.txt' }],
      ['read', { file_path: '../../outside.txt' }],
      ['read', { file_path: 'safe/../../outside.txt' }],
      ['read', { file_path: 'escape-link/secret.txt' }],
      ['glob', { pattern: '*.txt', path: outside }],
      ['glob', { pattern: '*.txt', path: 'escape-link' }],
      ['grep', { pattern: 'OUTSIDE', path: '../outside.txt' }],
      ['grep', { pattern: 'OUTSIDE', path: 'escape-link' }],
    ]) {
      const before = f.traces.length
      const result = await f.execute(child.a, 'return await tools.' + name + '(' + JSON.stringify(args) + ')')
      assert.equal(result.value.status, 'runtime-error', JSON.stringify(result.value))
      assert.match(JSON.stringify(result.value), /PTC_FILESYSTEM_BOUNDARY_REJECTED/)
      assert.equal(f.traces.length, before + 1, name + ' dispatched forbidden target') // only outer ptc_execute
      assert.deepEqual(result.value.effects?.calls?.map(x => x.state), ['failed']) // guest attempt; no Host dispatch
    }
    // A glob pattern is a filter, never a search-root authority.
    for (const pattern of [join(outside, 'secret.txt').replaceAll('\\', '/'), '../outside/secret.txt']) {
      const found = value(await f.execute(child.a, 'return await tools.glob(' + JSON.stringify({ pattern }) + ')'))
      assert.deepEqual(found.paths, [])
    }
    // Ripgrep's default recursion must not follow a Windows junction or POSIX directory symlink.
    for (const [name, args] of [['glob', { pattern: '*.txt' }], ['grep', { pattern: 'OUTSIDE_SECRET' }]]) {
      const found = value(await f.execute(child.a, 'return await tools.' + name + '(' + JSON.stringify(args) + ')'))
      assert.doesNotMatch(JSON.stringify(found), /OUTSIDE_SECRET|secret\.txt/)
    }
  } finally { await f.cleanup() }
}))

test('two Leaders bind distinct Worker PTC filesystem authority', () => inTemporaryDir('ptc-two-roots-', async base => {
  const session = join(base, 'session'), taskA = join(base, 'task-A'), taskB = join(base, 'task-B')
  await Promise.all([mkdir(session), mkdir(taskA), mkdir(taskB)])
  await writeFile(join(session, 'proof.txt'), 'INSTALLATION_MARKER\n', 'utf8')
  await writeFile(join(taskA, 'proof.txt'), 'A\n', 'utf8')
  await writeFile(join(taskB, 'proof.txt'), 'B\n', 'utf8')
  const f = await fixture(session)
  try {
    const leaderA = await f.leader('leader-A', 'postman-leader-ptc', taskA)
    const leaderB = await f.leader('leader-B', 'postman-leader-ptc', taskB)
    const a = await f.start(leaderA), b = await f.start(leaderB)
    const readProof = x => f.execute(x.a, "return (await tools.read({file_path:'proof.txt'})).lines[0].text")
    assert.equal(value(await readProof(a)), 'A')
    assert.equal(value(await readProof(b)), 'B')
    assert.equal(value(await readProof(a)), 'A')
  } finally { await f.cleanup() }
}))

test('three Workers retain common task root after selective stop', () => inTemporaryDir('ptc-three-root-', async base => {
  const session = join(base, 'session'), task = join(base, 'task')
  await mkdir(session); await mkdir(task)
  await writeFile(join(session, 'proof.txt'), 'INSTALLATION_MARKER\n', 'utf8')
  await writeFile(join(task, 'proof.txt'), 'SHARED_WORKTREE\n', 'utf8')
  const f = await fixture(session, { worktree: task })
  try {
    const leader = await f.leader(), [a, b, c] = await Promise.all(['A', 'B', 'C'].map(label => f.start(leader, label)))
    const readProof = x => f.execute(x.a, "return (await tools.read({file_path:'proof.txt'})).lines[0].text")
    for (const child of [a, b, c]) assert.equal(value(await readProof(child)), 'SHARED_WORKTREE')
    assert.equal((await f.worker.stopTool.execute({ mode:'cancel', workerSessionId:a.a.id },
      { agent: leader.a, callId:'stop-A-root', signal: new AbortController().signal })).status, 'POSTMAN_WORKER_CANCELLED')
    for (const child of [b, c]) assert.equal(value(await readProof(child)), 'SHARED_WORKTREE')
  } finally { await f.cleanup() }
}))

test('replaced task context revokes active PTC before next filesystem dispatch', () => inTemporaryDir('ptc-replace-root-', async base => {
  const task = join(base, 'task'), replacement = join(base, 'replacement')
  await mkdir(task); await mkdir(replacement)
  await writeFile(join(task, 'proof.txt'), 'OLD_WORKTREE\n', 'utf8')
  await writeFile(join(replacement, 'proof.txt'), 'NEW_WORKTREE\n', 'utf8')
  const f = await fixture(base, { worktree: task })
  try {
    const leader = await f.leader(), child = await f.start(leader), entered = deferred(), held = deferred()
    f.ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'read' && exec.agent === child.a && exec.parent) { entered.resolve(); await held.promise }
      return next()
    })
    const running = f.execute(child.a, "await tools.read({file_path:'proof.txt'}); return await tools.grep({pattern:'NEW_WORKTREE'})")
    await entered.promise
    f.taskContexts.set(leader.a.id, Object.freeze({ branch:'replacement', worktree:replacement }))
    held.resolve()
    const result = await running
    assert.notEqual(result.value.status, 'ok')
    assert.equal(f.traces.some(t => t.name === 'grep' && t.agent === child.a), false)
    const after = await f.execute(child.a, "return await tools.read({file_path:'proof.txt'})")
    assert.equal(after.value.status, 'PTC_CALLER_REJECTED')
  } finally { await f.cleanup() }
}))

test('wrong callers, forged preset, stale Worker and other Leader stay rejected', () => inTemporaryDir('ptc-reject-', async dir => {
  const f = await fixture(dir)
  try {
    const pilot = await f.leader('pilot'), prod = await f.leader('production', 'postman-leader')
    const real = await f.start(pilot), production = await f.start(prod)
    assert.equal(isTopLevelPostmanPtcLeader(pilot.a), true)
    assert.equal(visible(f, pilot.a).includes('ptc_execute'), true)
    const bridge = await f.agent('bridge', 'postman-leader-ptc', { origin: 'subagent', delegationDepth: 1, parentSession: pilot.a.id })
    const unrelated = await f.agent('unrelated', 'postman-leader-ptc', { origin: 'subagent', delegationDepth: 1, parentSession: pilot.a.id })
    const grandchild = await f.agent('grandchild', 'postman-leader-ptc', { origin: 'subagent', delegationDepth: 2, parentSession: real.a.id })
    const foreign = await f.agent('foreign', 'postman-leader-ptc', { origin: 'subagent', delegationDepth: 1, parentSession: prod.a.id })
    for (const { a, sections } of [production, bridge, unrelated, grandchild, foreign]) {
      assert.equal(visible(f, a).includes('ptc_execute'), false)
      assert.equal(sections.length, 0)
      assert.equal((await f.execute(a, 'return 1')).isError, true)
      a.ctx.tools.register(f.adapter.tool)
      assert.equal((await f.execute(a, 'return 1')).value.status, 'PTC_CALLER_REJECTED')
    }
    assert.deepEqual(value(await f.execute(real.a, 'return Object.keys(tools).sort()')), ['glob', 'grep', 'read', 'web_fetch', 'web_search'])
    const stale = real.a
    f.agents.delete(stale.id); f.adapter.remove(stale); f.boundaries.disposeAgent(stale)
    assert.equal((await f.execute(stale, 'return 2')).value.status, 'PTC_CALLER_REJECTED')
    assert.equal(f.worker.ownsLiveWorker(stale), false)
    assert.deepEqual(value(await f.execute(pilot.a, 'return Object.keys(tools).sort()')), ['get_goal', 'grep', 'read', 'web_fetch'])
    assert.equal(visible(f, prod.a).includes('ptc_execute'), false)
  } finally { await f.cleanup() }
}))

test('three Workers share runtime limits but not identity, cancellation or access', () => inTemporaryDir('ptc-three-', async dir => {
  const f = await fixture(dir)
  try {
    const leader = await f.leader(), [a, b, c] = await Promise.all(['A', 'B', 'C'].map(label => f.start(leader, label)))
    assert.equal(new Set([a.a, b.a, c.a]).size, 3)
    assert.equal((await f.worker.listTool.execute({}, { agent: leader.a })).workers.length, 3)
    assert.ok([a, b, c].every(x => visible(f, x.a).includes('ptc_execute')))
    const entered = deferred(), held = deferred()
    let first = 0
    f.ctx.on('tools/execute', async (exec, next) => { if (exec.name === 'read' && exec.parent && [a.a, b.a].includes(exec.agent)) { if (++first === 2) entered.resolve(); await held.promise } return next() })
    const pendingA = f.execute(a.a, "return await tools.read({file_path:'none'})")
    const pendingB = f.execute(b.a, "return await tools.read({file_path:'none'})")
    await entered.promise
    const limit = await f.execute(c.a, 'return 3')
    assert.equal(limit.value.status, 'limit-exceeded')
    f.adapter.remove(a.a)
    held.resolve()
    assert.notEqual((await pendingA).value.status, 'ok')
    assert.equal((await pendingB).value.status, 'runtime-error')
    assert.equal(value(await f.execute(b.a, "return 'B'")), 'B')
    assert.equal(value(await f.execute(c.a, "return 'C'")), 'C')
    assert.equal(visible(f, a.a).includes('ptc_execute'), true)
    assert.equal((await f.execute(a.a, 'return 8')).value.status, 'PTC_CALLER_REJECTED')
    f.refresh(a.a.id)
    assert.equal(value(await f.execute(a.a, "return 'A'")), 'A')
  } finally { await f.cleanup() }
}))

test('two experimental Leader sessions keep PTC assignments and revocations isolated', () => inTemporaryDir('ptc-sessions-', async dir => {
  const f = await fixture(dir)
  try {
    const one = await f.leader('one'), two = await f.leader('two')
    const a = await f.start(one, 'A'), b = await f.start(two, 'B')
    assert.equal(value(await f.execute(a.a, "return 'one'")), 'one')
    assert.equal(value(await f.execute(b.a, "return 'two'")), 'two')
    f.worker.suspendLeader(one.a)
    f.refresh(a.a.id)
    assert.equal(visible(f, a.a).includes('ptc_execute'), false)
    assert.equal(value(await f.execute(b.a, "return 'still two'")), 'still two')
    assert.equal(f.worker.ownsNotification(b.a, two.a.id), true)
    assert.equal(f.worker.ownsNotification(b.a, one.a.id), false)
  } finally { await f.cleanup() }
}))

test('approved stop cancels only A while B and C retain independent runs', () => inTemporaryDir('ptc-stop-', async dir => {
  const f = await fixture(dir)
  try {
    const leader = await f.leader(), a = await f.start(leader, 'A'), b = await f.start(leader, 'B'), c = await f.start(leader, 'C')
    const stopped = await f.worker.stopTool.execute({ mode: 'cancel', workerSessionId: a.a.id }, { agent: leader.a, callId: 'stop-A', signal: new AbortController().signal })
    assert.equal(stopped.status, 'POSTMAN_WORKER_CANCELLED', JSON.stringify(stopped))
    assert.deepEqual(f.calls.drains, [[a.a.id]])
    assert.equal(f.worker.ownsLiveWorker(a.a), false)
    const denied = await f.execute(a.a, 'return 1')
    assert.equal(denied.isError || denied.value?.status === 'PTC_CALLER_REJECTED', true)
    assert.equal(value(await f.execute(b.a, 'return 2')), 2)
    assert.equal(value(await f.execute(c.a, 'return 3')), 3)
    assert.deepEqual((await f.worker.listTool.execute({}, { agent: leader.a })).workers.map(x => x.workerSessionId).sort(), [b.a.id, c.a.id].sort())
  } finally { await f.cleanup() }
}))

test('stopping A mid-program cancels its next call without cancelling B', () => inTemporaryDir('ptc-stop-active-', async dir => {
  await writeFile(join(dir, 'proof.txt'), 'МАРКЕР\n', 'utf8')
  const f = await fixture(dir)
  try {
    const leader = await f.leader(), a = await f.start(leader, 'A'), b = await f.start(leader, 'B')
    const entered = deferred(), held = deferred()
    f.ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'read' && exec.agent === a.a && exec.parent) { entered.resolve(); await held.promise }
      return next()
    })
    const running = f.execute(a.a, "await tools.read({file_path:'proof.txt'}); return await tools.grep({pattern:'МАРКЕР',path:'proof.txt'})")
    await entered.promise
    const stopped = await f.worker.stopTool.execute({ mode: 'cancel', workerSessionId: a.a.id }, { agent: leader.a, callId: 'stop-active-A', signal: new AbortController().signal })
    assert.equal(stopped.status, 'POSTMAN_WORKER_CANCELLED')
    held.resolve()
    const result = await running
    assert.notEqual(result.value.status, 'ok')
    assert.equal(f.traces.some(t => t.name === 'grep' && t.agent === a.a), false)
    assert.equal(value(await f.execute(b.a, 'return 22')), 22)
  } finally { await f.cleanup() }
}))

test('permission revoke cancels a running program; later restoration starts a new run', () => inTemporaryDir('ptc-revoke-', async dir => {
  await writeFile(join(dir, 'proof.txt'), 'МАРКЕР\n', 'utf8')
  const f = await fixture(dir)
  try {
    const leader = await f.leader(), child = await f.start(leader), entered = deferred(), held = deferred()
    f.ctx.on('tools/execute', async (exec, next) => { if (exec.name === 'read' && exec.agent === child.a && exec.parent) { entered.resolve(); await held.promise } return next() })
    const running = f.execute(child.a, "await tools.read({file_path:'proof.txt'}); return await tools.grep({pattern:'МАРКЕР',path:'proof.txt'})")
    await entered.promise
    const deny = child.a.ctx.tools.restrict({ deny: ['grep'] })
    f.adapter.permissionsChanged()
    held.resolve()
    assert.notEqual((await running).value.status, 'ok')
    deny()
    assert.equal(value(await f.execute(child.a, "return 'new run'")), 'new run')
    assert.equal(f.traces.some(t => t.name === 'grep' && t.agent === child.a), false)
  } finally { await f.cleanup() }
}))

test('uncertain binding, parent preset, context replacement and disposal revoke selectively', () => inTemporaryDir('ptc-lifecycle-', async dir => {
  const f = await fixture(dir)
  try {
    const leader = await f.leader(), a = await f.start(leader, 'A'), b = await f.start(leader, 'B')
    await f.registry.change(leader.a.id, row => ({ ...row, workers: { ...row.workers, [a.a.id]: { ...row.workers[a.a.id], state: 'uncertain' } } }))
    f.refresh(a.a.id)
    assert.equal(visible(f, a.a).includes('ptc_execute'), false)
    assert.equal(value(await f.execute(b.a, 'return 2')), 2)
    await f.registry.change(leader.a.id, row => ({ ...row, workers: { ...row.workers, [a.a.id]: { ...row.workers[a.a.id], state: 'ready' } } }))
    f.refresh(a.a.id)
    assert.equal(value(await f.execute(a.a, 'return 3')), 3)
    await f.registry.change(leader.a.id, row => ({ ...row, workers: { ...row.workers, [a.a.id]: { ...row.workers[a.a.id], state: 'stopping' } } }))
    f.refresh(a.a.id)
    assert.equal(visible(f, a.a).includes('ptc_execute'), false)
    assert.equal(value(await f.execute(b.a, 'return 4')), 4)
    leader.a.session.header.agentPreset = 'postman-leader'
    f.refresh(b.a.id)
    assert.equal(visible(f, b.a).includes('ptc_execute'), false)
    leader.a.session.header.agentPreset = 'postman-leader-ptc'
    f.taskContexts.set(leader.a.id, Object.freeze({ branch: 'replacement', worktree: dir }))
    f.refresh(b.a.id)
    assert.equal(visible(f, b.a).includes('ptc_execute'), false)
    f.worker.suspendLeader(leader.a)
    assert.equal(f.worker.ownsLiveWorker(b.a), false)
  } finally { await f.cleanup() }
}))

test('durable child resumes only after exact reconciliation; stale activation never regains authority', () => inTemporaryDir('ptc-resume-', async dir => {
  const task = join(dir, 'task')
  await mkdir(task)
  await writeFile(join(dir, 'proof.txt'), 'INSTALLATION_MARKER\n', 'utf8')
  await writeFile(join(task, 'proof.txt'), 'RESUMED_WORKTREE\n', 'utf8')
  const f = await fixture(dir, { worktree: task })
  try {
    const leader = await f.leader(), initial = await f.start(leader)
    assert.equal(value(await f.execute(initial.a, 'return 1')), 1)
    f.worker.releaseActivation(initial.a)
    f.agents.delete(initial.a.id); f.adapter.remove(initial.a); f.boundaries.disposeAgent(initial.a)
    assert.equal((await f.execute(initial.a, 'return 2')).value.status, 'PTC_CALLER_REJECTED')
    const resumed = await f.agent(initial.a.id, 'plain', { origin: 'subagent', delegationDepth: 1, parentSession: leader.a.id })
    assert.equal(visible(f, resumed.a).includes('ptc_execute'), true) // created after verified ready binding
    assert.equal(f.calls.starts.length, 1)
    const follow = await f.worker.taskTool.execute({ task: 'continue', workerSessionId: initial.a.id }, { agent: leader.a, signal: new AbortController().signal })
    assert.equal(follow.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
    assert.equal(follow.created, false)
    assert.equal(f.calls.starts.length, 1)
    assert.deepEqual(f.calls.follows, [initial.a.id])
    assert.equal(f.worker.ownsLiveWorker(resumed.a), true)
    assert.equal(value(await f.execute(resumed.a, "return (await tools.read({file_path:'proof.txt'})).lines[0].text")), 'RESUMED_WORKTREE')
    assert.equal(value(await f.execute(resumed.a, 'return 3')), 3)
    assert.equal((await f.execute(initial.a, 'return 4')).value.status, 'PTC_CALLER_REJECTED')
  } finally { await f.cleanup() }
}))

test('replaced Leader Agent cannot lend authority to an old child binding', () => inTemporaryDir('ptc-parent-', async dir => {
  const f = await fixture(dir)
  try {
    const leader = await f.leader(), child = await f.start(leader)
    assert.equal(value(await f.execute(child.a, 'return 1')), 1)
    f.worker.suspendLeader(leader.a)
    f.agents.delete(leader.a.id); f.adapter.remove(leader.a); f.boundaries.disposeAgent(leader.a)
    const replacement = await f.agent(leader.a.id, 'postman-leader-ptc')
    f.refresh(child.a.id)
    assert.equal(visible(f, child.a).includes('ptc_execute'), false)
    assert.equal(f.worker.ownsLiveWorker(child.a), false)
    assert.equal(visible(f, replacement.a).includes('ptc_execute'), true)
    const follow = await f.worker.taskTool.execute({ task: 'continue', workerSessionId: child.a.id }, { agent: replacement.a, signal: new AbortController().signal })
    assert.equal(follow.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
    assert.equal(follow.created, false)
    assert.equal(value(await f.execute(child.a, 'return 2')), 2)
  } finally { await f.cleanup() }
}))

test('cold manager restart rechecks durable child and keeps stale Agent denied', () => inTemporaryDir('ptc-cold-', async dir => {
  const f = await fixture(dir)
  try {
    const leader = await f.leader(), first = await f.start(leader)
    f.worker.releaseActivation(first.a)
    f.agents.delete(first.a.id); f.adapter.remove(first.a); f.boundaries.disposeAgent(first.a)
    f.restartWorker()
    const replacement = await f.agent(first.a.id, 'plain', { origin: 'subagent', delegationDepth: 1, parentSession: leader.a.id })
    assert.equal(visible(f, replacement.a).includes('ptc_execute'), false)
    const follow = await f.worker.taskTool.execute({ task: 'continue', workerSessionId: first.a.id }, { agent: leader.a, signal: new AbortController().signal })
    assert.equal(follow.status, 'POSTMAN_WORKER_TASK_ACCEPTED')
    assert.equal(follow.created, false)
    assert.equal(f.calls.starts.length, 1)
    assert.equal(visible(f, replacement.a).includes('ptc_execute'), true)
    assert.equal(value(await f.execute(replacement.a, 'return 9')), 9)
    assert.equal((await f.execute(first.a, 'return 1')).value.status, 'PTC_CALLER_REJECTED')
  } finally { await f.cleanup() }
}))

test('web names are omitted when registry-invisible; unrelated registration cannot grow profile', () => inTemporaryDir('ptc-no-web-', async dir => {
  const f = await fixture(dir, { web: false })
  try {
    const leader = await f.leader(), child = await f.start(leader)
    child.a.ctx.tools.restrict({ deny: ['web_fetch'] })
    assert.deepEqual(value(await f.execute(child.a, 'return Object.keys(tools).sort()')), ['glob', 'grep', 'read'])
    f.ctx.tools.register(defineTool({ name: 'future_tool', description: 'future', parameters: {}, output, execute() { return {} } }))
    assert.deepEqual(value(await f.execute(child.a, 'return Object.keys(tools).sort()')), ['glob', 'grep', 'read'])
  } finally { await f.cleanup() }
}))


