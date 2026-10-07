import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdir, cp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as bridge from '../postman-bridge.js'
import { sharedPostmanTaskRegistry } from '../postman-task-registry.js'
import { initializePostmanTaskContexts } from '../postman-task-context.js'

// All native components resolve inside one pinned, locally installed production SDK.
// No APPDATA/DSH_ROOT, prefilled Stage 1 registry, or fake ordinary tool definitions.
const require = createRequire(import.meta.url)
const sdkRequire = createRequire(process.env.DSH_CAPABILITY_SDK ?? require.resolve('@deepseek-ai/dsh/package.json'))
export const native = name => import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/' + name)).href)
export const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
export async function capabilityRuntime(dir, { preset = 'postman-leader-ptc', resume = false, lateFs = false, plan = () => null } = {}) {
  const { Context } = await native('cordis')
  const { Loader, Group } = await native('cordis-plugin-loader')
  const { AgentRegistry, installModelSelection } = await native('dsh-agent')
  const { SessionStore } = await native('dsh-session')
  const { SessionProjectionRegistry } = await native('dsh-session-projection')
  const { JsonlSessionPersistence } = await native('dsh-session-persistence-jsonl')
  const { SystemPrompt } = await native('dsh-system-prompt')
  const { ToolRuntime } = await native('dsh-tools')
  const { LlmRuntime, LlmAdapter } = await native('dsh-llm')
  const { AgentLoop } = await native('dsh-agent-loop')
  const { SubagentRuntime } = await native('dsh-subagent')
  const { JsonStorageBackend } = await native('dsh-storage-json')
  const { DomainFacility } = await native('dsh-storage-domain')
  // Production Host auto-loads workspace/Leader instructions, not a fixture persona.
  await mkdir(join(dir,'.git'),{recursive:true})
  for(const path of ['AGENTS.md','REPO_POLICY.md','docs/workflow/TASK_CONTRACT.md','docs/subprojects/postman/SUBPROJECT.md','docs/subprojects/ptc/SUBPROJECT.md','.agents/skills/postman-leader']){await mkdir(join(dir,path,'..'),{recursive:true});await cp(join(repositoryRoot,path),join(dir,path),{recursive:true})}
  const ctx = new Context(), requests = [], results = [], counts = new Map(), disposals = new Map()
  ctx.on('agent/disposed', ({agent}) => disposals.get(agent.id)?.resolve(agent))
  new Loader(ctx, { baseUrl: pathToFileURL(join(repositoryRoot, 'package.json')).href })
  ctx.loader.builtins.group = Group
  // Resolve unmodified canonical preset rows against the same SDK as the Host.
  let delayedFs
  ctx.loader.internal = { import: async name => {
    const m = await native(name.replace('@deepseek-ai/', ''))
    if (lateFs && name === '@deepseek-ai/dsh-tool-fs') return { ...m, apply: (scope, config) => { delayedFs = () => m.apply(scope, config) } }
    return m
  } }
  new AgentRegistry(ctx); new SessionStore(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx, { mode: 'native' }); new LlmRuntime(ctx)
  new JsonlSessionPersistence(ctx, { root: join(dir, 'sessions'), compression:'none' }); new SubagentRuntime(ctx)
  new AgentLoop(ctx, { agents: [] })
  const backend = new JsonStorageBackend(join(dir, 'tasks'))
  ctx.provide('storageDomain', new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {} }, { backend: 'json', routes: {} }))
  const mount = async (name, config = {}) => { const m = await native(name); const f = ctx.plugin(m.default ?? m, config); await f.await(); return f }
  for (const name of ['dsh-jobs-local','dsh-user-questions','dsh-commands','dsh-goal','dsh-token-meter','dsh-skill','dsh-subprocess-local','dsh-pwsh-local','dsh-shell-env','dsh-web','dsh-spill-local']) await mount(name)
  await mount('dsh-fs-local', { cwd: dir, diffBasisMaxBytes: 1048576 })
  await mount('dsh-attachment-local', { root: join(dir, 'attachments') })
  await mount('dsh-subagent-spawn-in-process', { providerName: 'spawn' })
  await mount('dsh-tool-subagent-report', { reportDelivery: 'quiet' })
  await mount('dsh-fs-observation-policy')
  const { AgentPresets } = await native('dsh-agent-presets')
  new AgentPresets(ctx, { default: preset, roots: [
    { path: resolve(repositoryRoot, '.agent-presets'), trust: 'system' },
    { path: resolve(sdkRequire.resolve('@deepseek-ai/dsh/package.json'), '../config/agent-presets'), trust: 'system' },
  ], includeUserRoot: false })
  const registry = await sharedPostmanTaskRegistry(ctx.storageDomain)
  // Existing injection seam: no network/Git mutations, only task identity facts.
  const worktree = join(dir, 'worktree'); await mkdir(worktree, { recursive: true })
  const sha = 'a'.repeat(40)
  const gitCommand = async (cwd, ...args) => {
    const command = args.join(' ')
    if (command.includes('--show-toplevel')) return cwd
    if (command === 'remote get-url origin') return 'https://github.com/AndrewVerhoturov1/dsh-workspace.git'
    if (command === 'worktree list --porcelain') return 'worktree ' + dir + '\n\n' + (registry.get('leader')?.stage === 'ready' ? 'worktree ' + worktree + '\nbranch refs/heads/' + registry.get('leader').branch + '\n' : '')
    if (command === 'branch --show-current') return registry.get('leader')?.branch ?? ''
    if (args[0] === 'ls-remote') return args.at(-1) === registry.get('leader')?.branch ? sha + '\trefs/heads/' + args.at(-1) : ''
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return join(dir, 'absent-' + args[2])
    if (args[0] === 'rev-parse' || args[0] === 'merge-base') return sha
    return ''
  }
  const contexts = initializePostmanTaskContexts(registry, { gitCommand, makeDirectory: async () => worktree, temporaryDirectory: () => dir })
  const workspacePolicy=await import(pathToFileURL(join(repositoryRoot,'plugins/dsh-task-discipline/workspace-policy.js')).href)
  await ctx.plugin(workspacePolicy).await()
  const plugin = ctx.plugin(bridge, { localDevelopment: false }); await plugin.await()
  ctx.on('tools/result', (exec, result) => results.push({ agent: exec.agent, name: exec.name, result, parent: exec.parent }))
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text','image'], reasoning: { efforts: ['low','xhigh','max'].map(id => ({ id, name: id })) } } }
    async *stream(request) {
      const agent = ctx.agents.currentInitiator(), n = (counts.get(agent.id) ?? 0) + 1; counts.set(agent.id, n)
      requests.push({ agent, request, n })
      const action = await plan(agent, request, n, ctx)
      const block = action?.name ? { type: 'tool-call', id: randomUUID(), name: action.name, arguments: JSON.stringify(action.args ?? {}) } : { type: 'text', text: action?.text ?? 'bounded catalog capture' }
      yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['codex'], new Adapter())
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) }
  const handle = resume ? await ctx.agents.resume({ resumeSessionId: 'leader', agentOptions: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }, setup }) :
    await ctx.agents.create({ sessionId: 'leader', agentOptions: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }, meta: { cwd: dir, agentPreset: preset }, setup })
  const leader = handle.agent
  // The Web selector owns root model routing; preserve its explicit strong effort.
  installModelSelection(leader.ctx,{current:{provider:'codex',model:'gpt-6.1-sol',reasoningEffort:'xhigh'}})
  const turn = async (agent, text = 'Exact bounded catalog smoke') => {
    const end = Promise.withResolvers()
    const stop = ctx.on('session/event', (session,event) => { if (session.id === agent.id && event.type === 'turn/end') end.resolve() })
    try { agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user', form: 'direct' }, content: [{ type: 'text', text }] }); await end.promise; await agent.whenIdle(); await ctx.sessionPersistence.append(agent.id, []) }
    finally { stop() }
    return requests.filter(x => x.agent === agent).at(-1).request
  }
  const execute = (agent, name, args = {}) => ctx.tools.execute({ agent, name, arguments: args, callId: randomUUID(), signal: new AbortController().signal })
  const switchPreset = async id => { await ctx.agentPresets.recompose(leader.ctx, id); leader.session.append('agent-preset/selected', { agentPreset: id }); await ctx.emit('agent-preset/selected', leader.id, id) }
  const prepare = () => contexts.prepare(leader)
  const childDone = async id => {
    const child = ctx.agents.get(id)
    await disposals.get(id)?.promise
    if (child) await child.whenIdle()
    // startContinuable result is the actual native turn settlement boundary.
    const h = childHandles.get(id); if (h) await h.result
    await ctx.sessionPersistence.append(id, [])
    return requests.filter(x => x.agent.id === id).at(-1)?.agent
  }
  const childHandles = new Map(), start = ctx.subagents.startContinuable.bind(ctx.subagents)
  const followup=ctx.subagents.followup.bind(ctx.subagents)
  ctx.subagents.followup=async (...args)=>{disposals.set(args[1],Promise.withResolvers());return followup(...args)}
  ctx.subagents.startContinuable = async spec => { disposals.set(spec.childId,Promise.withResolvers()); const h = await start(spec); childHandles.set(spec.childId, h); return h }
  let disposal
  return { ctx, leader, requests, results, registry, contexts, turn, execute, switchPreset, prepare, childDone, worktree, registerLateFs: async () => { delayedFs(); await ctx.fiber.await() },
    dispose() { return disposal ??= (async () => { await ctx.subagents.drainContinuableChildren(leader); await plugin.dispose(); await plugin.await(); await ctx.fiber.dispose(); await ctx.fiber.await(); await backend.close() })() } }
}
