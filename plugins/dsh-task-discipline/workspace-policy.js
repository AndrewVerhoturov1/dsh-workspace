import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-workspace-policy'
export const inject = ['systemPrompt', 'tools', 'fs', 'skills']
const CONTRACT = 'docs/workflow/TASK_CONTRACT.md'
const POLICY = 'REPO_POLICY.md'
const HOST_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const LEADER_SKILL_BASE = resolve(HOST_ROOT, '.agents/skills/postman-leader')
// Only current, concrete subprojects. This is not a configurable rule registry.
const PROJECTS = [
  ['postman', ['postman', 'plugins/dsh-postman-harness', '.agents/skills/postman-leader', '.agents/skills/delegate-via-postman', '.agents/skills/delegate-via-postman-ask', '.agents/skills/delegate-via-postman-image']],
  ['ptc', ['plugins/dsh-ptc']],
  ['agents-nods-by-andrew', ['plugins/dsh-nodes-agent-by-andrew']],
]
const sectionName = path => 'dsh:workspace-policy:' + path
const within = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) }
const message = path => ({id:randomUUID(),role:'user',content:[{type:'text',text:'Workspace path requested: '+path+'. Applicable instructions are refreshed in the next normal model context; this is not a tool outcome.'}],source:{kind:'plugin',plugin:name,path}})

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
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0 && ['postman-leader','postman-leader-ptc','postman-leader-ptc-nodes'].includes(preset)
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
  const agents = await read(ctx,join(root,'AGENTS.md'),signal,true)
  const managed = policy?.includes('`dsh-workspace`') || agents?.includes('dsh-workspace')
  if (!managed && contract === undefined && policy === undefined) return []
  const has = tool => ctx.tools.get(tool,agent) !== undefined
  const paths = []
  // Generic repositories have optional rules: load each existing document,
  // while a managed DSH checkout still requires both when capabilities apply.
  if ((managed || contract !== undefined) && (leader(agent) || ['write','edit','pwsh','bash','ptc_execute','implementation_artifact_apply','postman_worker','postman_sol_worker'].some(has))) paths.push(join(root,CONTRACT))
  // Arbitrary shell is not safely classifiable as Git/non-Git. Capability is
  // the deterministic condition; repo policy precedes the first shell call.
  if ((managed || policy !== undefined) && (leader(agent) || ['pwsh','bash','ptc_execute','implementation_artifact_apply'].some(has))) paths.push(join(root,POLICY))
  // Expected managed supervisor capabilities are known before their first tool.
  // Role comes from the owning Host, never an inherited child preset/persona.
  if (managed && (leader(agent) || ctx.bail('postman/workspace-role', agent) === 'sol')) {
    paths.push(...['postman','ptc'].map(id => join(root,'docs/subprojects',id,'SUBPROJECT.md')))
  }
  if (managed) paths.push(...projectPaths(root,[...touched(agent),...extra,agent.session.header.cwd]))
  return Promise.all([...new Set(paths)].map(async path => {
    try { return {name:sectionName(path),text:'Workspace instructions from '+path+' (apply only to the named repository/subproject):\n\n'+await read(ctx,path,signal)} }
    catch (error) {
      signal?.throwIfAborted()
      return {name:sectionName(path),text:'WORKSPACE_INSTRUCTION_UNAVAILABLE: '+path+'\n'+error.message+'\nThe instructions were not delivered. Retry reading them when available; this diagnostic is not an authorization or a tool failure.'}
    }
  }))
}
export function apply(ctx) {
  ctx.on('system-prompt/assemble',async (_assembly, context, next) => {
    const assembly = await next(), agent = context.agent
    if (!agent) return assembly
    let sections
    try { sections = await documents(ctx,agent,context.signal) }
    catch (error) {
      context.signal?.throwIfAborted()
      sections = [{name:sectionName('diagnostic'),text:'WORKSPACE_INSTRUCTION_UNAVAILABLE: '+error.message+'\nInstruction discovery failed; the workspace documents were not delivered. The next context assembly will retry.'}]
    }
    if (leader(agent)) {
      try {
        const skill = await ctx.skills.get('postman-leader',{cwd:HOST_ROOT,scope:agent,signal:context.signal})
        if (!skill || skill.resourceBase?.kind !== 'directory' ||
            typeof skill.resourceBase.path !== 'string' || resolve(skill.resourceBase.path) !== LEADER_SKILL_BASE)
          throw Error('canonical postman-leader skill unavailable from Host installation')
        sections.push({name:sectionName('skill:postman-leader'),text:'Automatically loaded for this exact top-level Postman Leader only.\n<skill_content name="postman-leader">\nBase directory: '+(skill.resourceBase?.path ?? skill.provider)+'\n\n'+skill.content+'\n</skill_content>'})
      } catch (error) {
        context.signal?.throwIfAborted()
        sections.push({name:sectionName('skill:postman-leader'),text:'WORKSPACE_INSTRUCTION_UNAVAILABLE: '+error.message+'. Canonical role instructions were not delivered; no project-owned substitute was loaded.'})
      }
      if ((agent.ctx.get('agentPresets')?.composedPreset(agent.ctx) ?? agent.session.header.agentPreset) === 'postman-leader-ptc-nodes') {
        try {
          const skill = await ctx.skills.get('postman-leader-nodes',{cwd:HOST_ROOT,scope:agent,signal:context.signal})
          if (skill?.resourceBase?.kind !== 'directory' || resolve(skill.resourceBase.path) !== resolve(HOST_ROOT,'.agents/skills/postman-leader-nodes'))
            throw Error('canonical postman-leader-nodes skill unavailable from Host installation')
          sections.push({name:sectionName('skill:postman-leader-nodes'),text:'<skill_content name="postman-leader-nodes">\n'+skill.content+'\n</skill_content>'})
        } catch (error) {
          context.signal?.throwIfAborted()
          sections.push({name:sectionName('skill:postman-leader-nodes'),text:'WORKSPACE_INSTRUCTION_UNAVAILABLE: '+error.message})
        }
      }
    }
    // Dynamic context is reassembled by Host on every request; the native
    // runtime-context projection deduplicates it and restores it after compact.
    return {...assembly,contexts:[...assembly.contexts,...sections]}
  })
  ctx.on('tools/pre-execute',async (exec,next) => {
    const decision = await next()
    if (decision.kind !== 'allow' || !exec.agent) return decision
    const paths = locations(exec.arguments,exec.agent.session.header.cwd)
    if (!paths.length) return decision
    let required
    try { required = await documents(ctx,exec.agent,exec.signal,paths) }
    catch { exec.signal?.throwIfAborted(); return decision }
    const visible = visibleSections(exec.agent)
    // Existing first-touch hints deliver only genuinely new instruction context.
    // Known paths must not wake an event-waiting supervisor for bookkeeping.
    // Instruction freshness never denies an ordinary tool.
    if (required.some(row=>!visible.some(v=>v.name===row.name && v.text===row.text)))
      for (const path of paths)
        if (!exec.agent.inbox.nextStep.some(m=>m.source?.plugin===name && m.source.path===path))
          exec.agent.inbox.prepend('next-step',message(path))
    return decision
  })
}
