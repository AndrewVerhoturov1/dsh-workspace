import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isTopLevelPostmanSupervisor } from './postman-bridge-core.js'

export function createPostmanAppTool(ctx, worker, contexts) {
  const starts = new Map()
  ctx.on('postman/app-job-owner', nested => {
    const start = starts.get(nested.parent)
    if (!start) return
    const current = worker.appOwnerOf(nested.agent)
    if (nested.name !== 'pwsh' || nested.agent !== start.caller || current?.owner !== start.owner ||
        current.assignmentId !== start.assignmentId || nested.signal.aborted) throw Error('POSTMAN_APP_OWNER_REVOKED')
    return start.owner
  })
  ctx.on('postman/app-job-label', nested => starts.get(nested.parent)?.label)
  return defineTool({ name: 'postman_app',
    description: 'Start, inspect or stop an explicitly selected owned test app. Prior process state is information for Leader; this never restarts or stops an app automatically.',
    parameters: { action: { type: 'string', enum: ['start', 'status', 'stop'], required: true },
      command: { type: 'string' }, description: { type: 'string' }, jobId: { type: 'string' }, appId: { type: 'string' },
      port: { type: 'number', description: 'Optional informational TCP port.' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a,v) => [{type:'text',text:JSON.stringify(v)}] },
    async execute(args, exec) {
      const caller = exec.agent, assignment = worker.appOwnerOf(caller)
      const leader = ctx.agents.get(caller?.id) === caller && isTopLevelPostmanSupervisor(caller) ? caller : null
      const owner = assignment?.owner ?? leader
      if (!owner || exec.signal.aborted) return { status: 'POSTMAN_APP_CALLER_REJECTED' }
      const jobs = ctx.get('jobs')
      if (!jobs) return { status: 'POSTMAN_APP_CAPABILITY_UNAVAILABLE' }
      if (args.action === 'start') {
        if (!assignment || !ctx.tools.get('pwsh',caller) || ctx.bail('postman/app-owner-supported') !== true)
          return { status: 'POSTMAN_APP_CAPABILITY_UNAVAILABLE' }
        const appId = randomUUID(), workdir = assignment.context.worktree
        const previous = args.appId ? contexts.record(owner.id)?.appJobs?.[args.appId] : null
        if (previous && (previous.jobId !== args.jobId))
          return { status: 'POSTMAN_APP_CALLER_REJECTED' }
        const label = JSON.stringify({postmanApp:1,appId,workerSessionId:caller.id,assignmentId:assignment.assignmentId,worktree:workdir})
        starts.set(exec.token,{caller,owner,assignmentId:assignment.assignmentId,label})
        let result
        try { result = await ctx.tools.execute({name:'pwsh',agent:caller,callId:exec.callId+':app',rootCallId:exec.rootCallId,
          parent:exec.token,signal:exec.signal,arguments:{command:args.command,description:args.description ?? 'Run test app',workdir,run_in_background:true}}) }
        finally { starts.delete(exec.token) }
        if (result.isError) return { status: 'POSTMAN_APP_TOOL_ERROR', error: result.error }
        if (result.value?.kind !== 'background' || typeof result.value.jobId !== 'string')
          return { status: 'POSTMAN_APP_OUTCOME_UNKNOWN', result: result.value }
        const jobId = result.value.jobId
        await contexts.changeRecord(owner.id,row => ({...row,appJobs:{...row.appJobs,[appId]:{
          jobId,workerSessionId:caller.id,assignmentId:assignment.assignmentId,worktree:workdir,
          ...(args.port !== undefined ? {port:args.port} : {})}}}))
        return { status: 'POSTMAN_APP_STARTED',jobId,appId,ownerSessionId:owner.id,
          ...(previous ? {previousApp:{appId:args.appId,jobId:previous.jobId,terminal:previous.terminal ?? null}} : {}) }
      }
      const recorded = contexts.record(owner.id)?.appJobs?.[args.appId]
      if (recorded && (recorded.jobId !== args.jobId || assignment && recorded.workerSessionId !== caller.id))
        return { status: 'POSTMAN_APP_CALLER_REJECTED' }
      let snapshot
      try { snapshot = jobs.get(args.jobId,owner) }
      catch (error) {
        if (error?.message === 'unknown job '+args.jobId) return {status:'POSTMAN_APP_OUTCOME_UNKNOWN',jobId:args.jobId,appId:args.appId}
        throw error
      }
      let label
      try { label = JSON.parse(snapshot.label) } catch { return { status: 'POSTMAN_APP_CALLER_REJECTED' } }
      if (snapshot.ownerSession !== owner.id || snapshot.kind !== 'pwsh' || label.postmanApp !== 1 || label.appId !== args.appId ||
          assignment && label.workerSessionId !== caller.id) return { status: 'POSTMAN_APP_CALLER_REJECTED' }
      if (args.action === 'stop') { jobs.kill(args.jobId,owner,'explicit owned test app stop'); await jobs.wait(args.jobId,5000,owner,exec.signal) }
      return {status:args.action === 'stop' ? 'POSTMAN_APP_STOP_REQUESTED' : 'POSTMAN_APP_STATUS',jobId:args.jobId,appId:args.appId,
        ownerSessionId:owner.id,jobStatus:jobs.get(args.jobId,owner)?.status ?? 'unknown',output:jobs.read(args.jobId,owner)?.text ?? ''}
    }
  })
}
