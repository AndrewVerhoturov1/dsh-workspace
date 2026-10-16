import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isTopLevelPostmanSupervisor } from './postman-bridge-core.js'

// One producer for the existing native job controller, not a process manager or
// owner transfer. The Worker's current shell policy and task scope remain intact.
const portFree = port => new Promise(resolve => {
  const server = createServer()
  server.once('error', () => resolve(false))
  server.listen({port, exclusive: true}, () => server.close(error => resolve(!error)))
})
export function createPostmanAppTool(ctx,worker,contexts) {
  const starts=new Map()
  ctx.on('postman/app-job-owner', nested=>{
    const grant=starts.get(nested.parent)
    if(!grant)return undefined
    const current=worker.appOwnerOf(nested.agent)
    if(nested.name!=='pwsh'||nested.agent!==grant.caller||current?.owner!==grant.owner||
       current.assignmentId!==grant.assignmentId||current.context!==grant.context||nested.signal.aborted)
      throw Error('POSTMAN_APP_OWNER_REVOKED')
    return grant.owner
  })
  ctx.on('postman/app-job-label',nested=>starts.get(nested.parent)?.label)
  return defineTool({name:'postman_app',
    description:'Start/check/stop a local test app on behalf of an exact Worker. Native owner is its live Leader. Explicit replacement start(jobId,appId,port) requires a Host-observed completed/killed native process and a currently free resource port. Lost record alone is UNKNOWN. URL delivery and browser acceptance are separate. No permission escalation.',
    parameters:{action:{type:'string',enum:['start','status','stop'],required:true},
      command:{type:'string'},description:{type:'string'},jobId:{type:'string'},appId:{type:'string'},
      port:{type:'number',description:'Exact app resource TCP port, integer 1..65535; required for an explicit replacement start.'}},
    output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    async execute(args,exec){
      const caller=exec.agent, proof=worker.appOwnerOf(caller)
      const leader=ctx.agents.get(caller?.id)===caller && isTopLevelPostmanSupervisor(caller) ? caller : null
      const owner=proof?.owner ?? leader, context=proof?.context ?? contexts.get(owner?.id)
      if(!owner || !context || contexts.get(owner.id)!==context || context.devspaceReadOnly || exec.signal.aborted)
        return {status:'POSTMAN_APP_CALLER_REJECTED'}
      const jobs=ctx.get('jobs')
      if(!jobs)return {status:'POSTMAN_APP_CAPABILITY_UNAVAILABLE'}
      if(args.action==='start'){
        // No model-selected cwd/policy/owner and no new shell authority.
        if(!proof || !ctx.tools.get('pwsh',caller) || ctx.bail('postman/app-owner-supported')!==true)
          return {status:'POSTMAN_APP_CAPABILITY_UNAVAILABLE'}
        if(typeof args.command!=='string'||!args.command.trim()||typeof args.description!=='string'||!args.description.trim())
          return {status:'POSTMAN_APP_ARGUMENTS_INVALID'}
        if(args.port!==undefined && (!Number.isInteger(args.port)||args.port<1||args.port>65535))
          return {status:'POSTMAN_APP_ARGUMENTS_INVALID'}
        const workdir=await realpath(context.worktree)
        if(worker.appOwnerOf(caller)?.assignmentId!==proof.assignmentId || contexts.get(owner.id)!==context || exec.signal.aborted)
          return {status:'POSTMAN_APP_CALLER_REJECTED'}
        const appId=randomUUID()
        if(args.jobId!==undefined || args.appId!==undefined){
          const old=contexts.record?.(owner.id)?.appJobs?.[args.appId]
          if(typeof args.jobId!=='string'||typeof args.appId!=='string'||!old||old.jobId!==args.jobId||
              old.worktree!==workdir || (old.port!==undefined && old.port!==args.port) || !Number.isInteger(args.port))
            return {status:'POSTMAN_APP_RESTART_REJECTED',restartAllowed:false}
          if(old.replacedBy)return {status:'POSTMAN_APP_RESTART_ALREADY_REQUESTED',restartAllowed:false,appId:old.replacedBy}
          let previous
          try {previous=jobs.get(args.jobId,owner)} catch(error){
            if(error?.message!=='unknown job '+args.jobId)throw error
          }
          if(previous){
            let savedLabel
            try {savedLabel=JSON.parse(previous.label)}catch{return {status:'POSTMAN_APP_CALLER_REJECTED'}}
            if(previous.ownerSession!==owner.id||previous.kind!=='pwsh'||savedLabel.appId!==args.appId||
                savedLabel.worktree!==workdir)return {status:'POSTMAN_APP_CALLER_REJECTED'}
            if(!['completed','killed'].includes(previous.status))
              return {status:'POSTMAN_APP_PROCESS_NOT_STOPPED',restartAllowed:false}
          }else if(!old.terminal)return {status:'POSTMAN_APP_OUTCOME_UNKNOWN',restartAllowed:false}
          if(!await portFree(args.port))return {status:'POSTMAN_APP_RESOURCE_BUSY',restartAllowed:false}
          await contexts.changeRecord(owner.id,row=>{
            if(contexts.get(owner.id)!==context || row.appJobs?.[args.appId]!==old || old.replacedBy)
              throw Error('POSTMAN_APP_OWNER_REVOKED')
            return {...row,appJobs:{...row.appJobs,[args.appId]:{...old,
              terminal:previous?.status ?? old.terminal,replacedBy:appId}}}
          })
        }else if(args.port!==undefined && !await portFree(args.port))
          return {status:'POSTMAN_APP_RESOURCE_BUSY',restartAllowed:false}
        const label=JSON.stringify({postmanApp:1,appId,workerSessionId:caller.id,
          assignmentId:proof.assignmentId,worktree:workdir,mode:'WRITE_ISOLATED',description:args.description})
        // Keep the complete native ToolRuntime guards, sandbox/environment,
        // output rendering and cancellation. The overlay only selects the
        // already-authorized initial native job owner and correlation label.
        starts.set(exec.token,{caller,owner,context,assignmentId:proof.assignmentId,label})
        let result
        try { result=await ctx.tools.execute({name:'pwsh',agent:caller,callId:exec.callId+':app',
          rootCallId:exec.rootCallId,parent:exec.token,signal:exec.signal,arguments:{
            command:args.command,description:args.description,workdir,run_in_background:true}}) }
        finally { starts.delete(exec.token) }
        if(result.isError)throw Error(result.error.message)
        if(result.value?.kind!=='background'||typeof result.value.jobId!=='string')
          return {status:'POSTMAN_APP_OUTCOME_UNKNOWN',restartAllowed:false}
        const jobId=result.value.jobId
        if(contexts.changeRecord)await contexts.changeRecord(owner.id,row=>{
          if(contexts.get(owner.id)!==context)throw Error('POSTMAN_APP_OWNER_REVOKED')
          return {...row,appJobs:{...row.appJobs,[appId]:{jobId,workerSessionId:caller.id,
            assignmentId:proof.assignmentId,worktree:workdir,...(args.port!==undefined?{port:args.port}:{})}}}
        })
        return {status:'POSTMAN_APP_STARTED',jobId,appId,ownerSessionId:owner.id,
          lifetime:'live-leader',coldRecovery:'OUTCOME_UNKNOWN',assignmentId:proof.assignmentId}
      }
      if(typeof args.jobId!=='string'||typeof args.appId!=='string')return {status:'POSTMAN_APP_ARGUMENTS_INVALID'}
      let snapshot
      try{snapshot=jobs.get(args.jobId,owner)}catch(error){
        // Native absence is thrown, unlike access denial. Cold loss must never
        // become an automatic restart or conceal another owner's denial.
        if(error?.message==='unknown job '+args.jobId)
          return {status:'POSTMAN_APP_OUTCOME_UNKNOWN',restartAllowed:false}
        throw error
      }
      let label
      try{label=JSON.parse(snapshot.label)}catch{return {status:'POSTMAN_APP_CALLER_REJECTED'}}
      if(snapshot.ownerSession!==owner.id||snapshot.kind!=='pwsh'||label.postmanApp!==1||label.appId!==args.appId||
         label.worktree!==await realpath(context.worktree)||proof&&label.workerSessionId!==caller.id)
        return {status:'POSTMAN_APP_CALLER_REJECTED'}
      if(args.action==='stop'){
        jobs.kill(args.jobId,owner,'exact owned test app stop')
        await jobs.wait(args.jobId,5000,owner,exec.signal)
      }
      const current=jobs.get(args.jobId,owner)
      if(['completed','killed'].includes(current?.status) && contexts.record?.(owner.id)?.appJobs?.[args.appId])
        await contexts.changeRecord(owner.id,row=>({...row,appJobs:{...row.appJobs,
          [args.appId]:{...row.appJobs[args.appId],terminal:current.status}}}))
      return {status:args.action==='stop'?'POSTMAN_APP_STOP_REQUESTED':'POSTMAN_APP_STATUS',
        jobId:args.jobId,appId:args.appId,ownerSessionId:owner.id,jobStatus:jobs.get(args.jobId,owner)?.status ?? 'unknown',
        output:jobs.read(args.jobId,owner)?.text ?? '',lifetime:'live-leader',coldRecovery:'OUTCOME_UNKNOWN'}
    }
  })
}
