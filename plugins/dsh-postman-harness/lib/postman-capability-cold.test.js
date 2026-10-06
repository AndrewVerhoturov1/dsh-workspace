import assert from 'node:assert/strict'
import {assertManagementRequest} from './fixtures/postman-stage3-contract.js'
import test from 'node:test'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'
import {POSTMAN_LEADER_TOOL_ALLOWLIST,POSTMAN_SOL_PTC_TOOL_NAMES} from './postman-bridge-core.js'
import {postmanRoleInstruction} from './postman-worker.js'
const names=r=>r.tools.map(t=>t.name).sort()
const ptc=program=>({program,description:'Review exact durable role facts',boundary:'semantic_decision'})
const report={name:'report',args:{output:'bounded native role verified'}}
const value=r=>{assert.equal(r.isError,false,JSON.stringify(r));return r.value}
const nested=r=>{const v=value(r);assert.equal(v.status,'ok',JSON.stringify(v));return v.value}
const leaderCall=(f,name,args)=>f.execute(f.leader,'ptc_execute',ptc('return await tools.'+name+'('+JSON.stringify(args)+')')).then(nested)

for (const preset of ['postman-leader', 'postman-leader-ptc']) test(preset + ': process-cold Leader, Secretary, Worker, legacy Sol and Sol-owned Worker restore actual catalog and instructions',{timeout:60000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'postman-cold-catalog-'));let f,gate=Promise.withResolvers(),entered=Promise.withResolvers()
 t.after(()=>gate.resolve())
 t.after(async()=>{await f?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
 const plan=async a=>{if(a.id!=='leader'&&a.options.model==='gpt-6.1-sol'){entered.resolve(a);await gate.promise}return a.id==='leader'?null:report}
 f=await capabilityRuntime(dir,{preset,plan});await f.prepare();await writeFile(join(f.worktree,'facts.txt'),'cold verified fact')
 const initial=await f.turn(f.leader),entries=[];assertManagementRequest('leader',initial);assert.match(JSON.stringify(initial),/POSTMAN_LEADER_SKILL_VERSION: 30/)
 const remember=(a,type,name,owner='leader')=>entries.push({id:a.id,type,name,owner,log:f.ctx.sessionPersistence.locate(a.session.header).path,expected:names(f.requests.find(x=>x.agent.id===a.id).request)})
 for(const type of ['secretary','luna','sol']){
  const name=type==='secretary'?'postman_secretary':type==='sol'?'postman_sol_worker':'postman_worker',args={task:'User authorizes explicit Sol Worker route for bounded fixture'}
  const r=await leaderCall(f,name,args)
  assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r))
  const a=type==='sol'?await entered.promise:await f.childDone(r.workerSessionId);remember(a,type,name)
  if(type==='sol'){
   const owned=value(await f.execute(a,'postman_worker',{task:'bounded owned cold facts'}));assert.equal(owned.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(owned))
   remember(await f.childDone(owned.workerSessionId),'luna','postman_worker',a.id);gate.resolve();await f.childDone(a.id)
  }
 }
 await f.dispose();f=null
 // Only the isolated durable fixture gets an old immutable PTC-denying descriptor.
 const sol=entries.find(e=>e.type==='sol'),lines=(await readFile(sol.log,'utf8')).trimEnd().split('\n').map(JSON.parse)
 const descriptor=lines.find(e=>e.type==='subagent/descriptor');assert.ok(descriptor);descriptor.data.toolFilter.deny.push('ptc_execute')
 await writeFile(sol.log,lines.map(JSON.stringify).join('\n')+'\n')
 gate=Promise.withResolvers();entered=Promise.withResolvers();f=await capabilityRuntime(dir,{preset,resume:true,plan})
 assert.ok(['TASK_CONTEXT_READY','POSTMAN_TASK_CONTEXT_ALREADY_READY'].includes((await f.prepare()).status))
 const resumed=await f.turn(f.leader);assertManagementRequest('leader',resumed);assert.deepEqual(names(resumed),names(initial));assert.match(JSON.stringify(resumed),/POSTMAN_LEADER_SKILL_VERSION: 30/);await f.switchPreset('postman-leader-ptc');assert.deepEqual(names(await f.turn(f.leader)),[...POSTMAN_LEADER_TOOL_ALLOWLIST,'ptc_execute'].sort())
 let liveSol
 for(const e of entries){
  const args={workerSessionId:e.id,task:'bounded cold durable facts'}
  const r=e.owner!=='leader'?value(await f.execute(liveSol,e.name,args)):await leaderCall(f,e.name,args)
  assert.equal(r.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(r));if(e.type==='sol')liveSol=await entered.promise;else await f.childDone(e.id)
  const request=f.requests.find(x=>x.agent.id===e.id).request
  assert.deepEqual(names(request),e.expected,JSON.stringify({role:e.type,owner:e.owner,expected:e.expected,actual:names(request)}))
  assertManagementRequest(e.type,request);assert.ok(request.system.includes(postmanRoleInstruction(e.type)));assert.equal(request.model,e.type==='sol'?'gpt-6.1-sol':'gpt-6-luna');assert.equal(request.reasoningEffort,e.type==='sol'?'xhigh':'low')
  if(e.type==='sol'){
   for(const name of POSTMAN_SOL_PTC_TOOL_NAMES.filter(n=>n!=='bash'))assert.ok(request.tools.some(t=>t.name===name),name)
   const read=nested(await f.execute(liveSol,'ptc_execute',ptc('return await tools.read({file_path:'+JSON.stringify(join(f.worktree,'facts.txt'))+'})')));assert.equal(read.lines[0].text,'cold verified fact')
  }
 }
 gate.resolve();await f.childDone(sol.id)
})
