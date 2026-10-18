import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'

const phase=program=>({program,description:'Exact Secretary retirement after branchless promotion',boundary:'external_event'})
const value=result=>{assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.value.status,'ok',JSON.stringify(result));return result.value.value}
for(const afterClose of [false,true])test('native branchless Secretary retirement '+(afterClose?'after abandon':'during abandon'),{timeout:30000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-secretary-retire-'))
  const counts=new Map();let f,registered=false
  f=await capabilityRuntime(dir,{taskContextOptions:{makeDirectory:async()=>join(dir,'worktree'),temporaryDirectory:()=>dir,
    gitCommand:async(cwd,...args)=>{
      const command=args.join(' '),row=f?.registry.get('leader'),sha='a'.repeat(40)
      if(command.includes('--show-toplevel'))return cwd
      if(command==='remote get-url origin')return 'https://github.com/AndrewVerhoturov1/dsh-workspace.git'
      if(command==='worktree list --porcelain')return 'worktree '+dir+'\n\n'+(registered?'worktree '+join(dir,'worktree')+'\nbranch refs/heads/'+row.branch+'\n':'')
      if(args[0]==='worktree'&&args[1]==='add'){registered=true;return ''}
      if(command==='branch --show-current')return row.branch
      if(args[0]==='ls-remote')return args.at(-1)===row.branch?sha+'\trefs/heads/'+row.branch:''
      if(args[0]==='rev-parse'||args[0]==='merge-base')return sha
      return ''
    }},plan:agent=>{
    if(agent.id==='leader')return null
    const n=(counts.get(agent.id)??0)+1;counts.set(agent.id,n)
    return n===1?{name:'postman_secretary_ledger',args:{revision:0,content:'Preserved exact research facts'}}:
      {name:'report',args:{output:'Research finished; no shell or writes'}}
  }})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true})})
  await f.turn(f.leader)
  const accepted=value(await f.execute(f.leader,'ptc_execute',phase('return await tools.postman_secretary({task:"Collect bounded facts",createNew:true})')))
  assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(accepted))
  await f.childDone(accepted.workerSessionId)
  for(let i=0;i<4;i++){await f.ctx.sessions.flush(f.leader.session);await new Promise(resolve=>setImmediate(resolve));await f.leader.whenIdle()}
  assert.equal(f.registry.readLedger('leader').revision,1)
  assert.equal(f.registry.get('leader').workers[accepted.workerSessionId].lifecycle.admissions[0].worktree,dir,
    'the real Host records the original scope before promotion')
  const promoted=await f.prepare();assert.equal(promoted.status,'TASK_CONTEXT_READY',JSON.stringify(promoted))
  const before=f.requests.length
  if(afterClose)await f.contexts.close(f.leader,{abandon:true,beforeClose:async()=>false})
  const result=value(await f.execute(f.leader,'ptc_execute',phase(afterClose?
    'return await tools.postman_worker_stop('+JSON.stringify({workerSessionId:accepted.workerSessionId,mode:'close'})+')':
    'return await tools.postman_task_close({abandon:true})')))
  console.log(JSON.stringify({scenario:afterClose?'closed-retirement':'promotion-abandon',result,modelRequestsBefore:before,modelRequestsAfter:f.requests.length}))
  assert.equal(afterClose?result.status:result.workerRetirementProven,afterClose?'POSTMAN_WORKER_STOPPED':true)
  assert.equal(Object.keys(f.registry.get('leader').workers).length,0)
  assert.equal(await f.ctx.subagents.inspectClosedContinuableChild(f.leader,accepted.workerSessionId),true)
  assert.equal(f.registry.readLedger('leader').content,'Preserved exact research facts')
  assert.equal(f.requests.length,before,'retirement does not wake a model')
})
