import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-workspace-policy'
export const inject = ['systemPrompt', 'tools', 'fs', 'skills']
const CONTRACT = 'docs/workflow/TASK_CONTRACT.md'
const POLICY = 'REPO_POLICY.md'
// Only current, concrete subprojects. This is not a configurable rule registry.
const PROJECTS = [
  ['postman', ['postman', 'plugins/dsh-postman-harness', '.agents/skills/postman-leader', '.agents/skills/delegate-via-postman', '.agents/skills/delegate-via-postman-ask', '.agents/skills/delegate-via-postman-image']],
  ['ptc', ['plugins/dsh-ptc']],
  ['agents-nods-by-andrew', ['plugins/dsh-nodes-agent-by-andrew']],
]
const sectionName = path => 'dsh:workspace-policy:' + path
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) }
const message = path => ({id:randomUUID(),role:'user',content:[{type:'text',text:'Host loaded required workspace instructions before this operation. Continue only after the next instruction context; no action was performed.'}],source:{kind:'plugin',plugin:name,path}})

async function read(ctx, path, signal, optional = false) {
  const target = await ctx.fs.resolve(path, {signal})
  if (optional && await ctx.fs.stat(target, signal) === undefined) return undefined
  const content = await ctx.fs.readText(target, signal)
  signal?.throwIfAborted()
  return content
}
async function repository(ctx, cwd, signal) {
  for (let dir = resolve(cwd);; dir = dirname(dir)) {
    if (await ctx.fs.stat(await ctx.fs.resolve(join(dir,'.git'),{signal}),signal) !== undefined) return dir
    if (dirname(dir) === dir) return resolve(cwd)
  }
}
function leader(agent) {
  const header = agent.session.header
  const preset = agent.ctx.get('agentPresets')?.composedPreset(agent.ctx) ?? header.agentPreset
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0 && ['postman-leader','postman-leader-ptc'].includes(preset)
}
function locations(args, cwd) {
  return ['file_path','path','workdir'].flatMap(field => typeof args?.[field] === 'string' ? [resolve(cwd,args[field])] : [])
}
function projectPaths(root, paths) {
  return PROJECTS.filter(([id,prefixes]) => paths.some(path => within(root,path) && [...prefixes,'docs/subprojects/'+id].some(prefix => within(join(root,prefix),path))))
    .map(([id]) => join(root,'docs/subprojects',id,'SUBPROJECT.md'))
}
// Events, not a process-local loaded flag: hints and tool locations survive cold
// resume and compaction. A fork must re-evaluate them against its own cwd/root.
function touched(agent) {
  const cwd = agent.session.header.cwd
  return [...agent.session.events.flatMap(event => {
    if (event.type === 'tool/call') { try { return locations(JSON.parse(event.data.arguments),cwd) } catch { return [] } }
    if (event.type === 'agent/inbox/spliced') return event.data.inserted.filter(m=>m.source?.plugin===name && m.source.path).map(m=>m.source.path)
    return event.type === 'user/message' && event.data.source?.plugin === name && event.data.source.path ? [event.data.source.path] : []
  }),...agent.inbox.nextStep.filter(m=>m.source?.plugin===name).map(m=>m.source.path)]
}
function visibleSections(agent) {
  return agent.session.deriveMessages().findLast(m=>m.source?.plugin==='@deepseek-ai/dsh-system-prompt')?.source.sections ?? []
}
async function documents(ctx, agent, signal, extra = []) {
  const root = await repository(ctx,agent.session.header.cwd,signal)
  // Do not import dsh-workspace policy into unrelated repositories. These
  // existing repository documents identify where this plugin applies.
  const contract = await read(ctx,join(root,CONTRACT),signal,true)
  const policy = await read(ctx,join(root,POLICY),signal,true)
  if (contract === undefined && policy === undefined && !(await read(ctx,join(root,'AGENTS.md'),signal,true))?.includes('dsh-workspace')) return []
  const has = tool => ctx.tools.get(tool,agent) !== undefined
  const paths = []
  if (leader(agent) || ['write','edit','pwsh','bash','ptc_execute','implementation_artifact_apply','postman_worker','postman_sol_worker'].some(has)) paths.push(join(root,CONTRACT))
  // Arbitrary shell is not safely classifiable as Git/non-Git. Capability is
  // the deterministic condition; repo policy precedes the first shell call.
  if (leader(agent) || ['pwsh','bash','ptc_execute','postman_task_prepare','implementation_artifact_apply'].some(has)) paths.push(join(root,POLICY))
  paths.push(...projectPaths(root,[...touched(agent),...extra,agent.session.header.cwd]))
  return Promise.all([...new Set(paths)].map(async path => ({name:sectionName(path),text:'Workspace instructions from '+path+' (apply only to the named repository/subproject):\n\n'+await read(ctx,path,signal)})))
}
export function apply(ctx) {
  ctx.on('system-prompt/assemble',async (_assembly, context, next) => {
    const assembly = await next(), agent = context.agent
    if (!agent) return assembly
    const sections = await documents(ctx,agent,context.signal)
    if (leader(agent)) {
      const skill = await ctx.skills.get('postman-leader',{cwd:agent.session.header.cwd,scope:agent,signal:context.signal})
      if (!skill) throw Error('WORKSPACE_POLICY_REQUIRED: postman-leader skill unavailable')
      sections.push({name:sectionName('skill:postman-leader'),text:'Automatically loaded for this exact top-level Postman Leader only.\n<skill_content name="postman-leader">\nBase directory: '+(skill.resourceBase?.path ?? skill.provider)+'\n\n'+skill.content+'\n</skill_content>'})
    }
    // Dynamic context is reassembled by Host on every request; the native
    // runtime-context projection deduplicates it and restores it after compact.
    return {...assembly,contexts:[...assembly.contexts,...sections]}
  })
  const denied = new WeakMap()
  ctx.on('tools/pre-execute',async (exec,next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !exec.agent) return decision
    if (!locations(exec.arguments,exec.agent.session.header.cwd).length && !['write','edit','pwsh','bash','implementation_artifact_apply','postman_task_prepare','postman_task_restore','postman_worker','postman_sol_worker','postman_worker_interrupt','postman_bridge'].includes(exec.name)) return decision
    let required
    try { required = await documents(ctx,exec.agent,exec.signal,locations(exec.arguments,exec.agent.session.header.cwd)) }
    catch (error) { const reason = 'WORKSPACE_POLICY_REQUIRED: '+error.message; denied.set(exec.token,reason); return {kind:'deny',reason} }
    const visible = visibleSections(exec.agent)
    const missing = required.filter(row=>!visible.some(v=>v.name===row.name && v.text===row.text))
    if (!missing.length) return decision
    for (const path of locations(exec.arguments,exec.agent.session.header.cwd))
      if (!exec.agent.inbox.nextStep.some(m=>m.source?.plugin===name && m.source.path===path)) exec.agent.inbox.prepend('next-step',message(path))
    const reason = 'WORKSPACE_POLICY_REQUIRED: instruction context must reach the model before this operation; no action performed'
    denied.set(exec.token,reason)
    return {kind:'deny',reason}
  })
  // A later pre-execute listener cannot force-allow this denial.
  ctx.tools.guard(exec=>denied.get(exec.token))
}
