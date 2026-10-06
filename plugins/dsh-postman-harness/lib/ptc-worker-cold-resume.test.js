import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {stage1Runtime} from './fixtures/postman-stage1-runtime.js'
import {postmanRoleInstruction} from './postman-worker.js'

// No shared Agent/Session/manager/registry object crosses the process boundary.
// Native Jsonl Sessions and the production JSON domain are the only durable state.
const phase=async(dir,type,resume)=>{
  await mkdir(join(dir,'sessions'),{recursive:true})
  const f=await stage1Runtime(dir,{resume,plan:(a,_r,n,w)=>type==='secretary'&&!resume&&n===1?
    {name:'postman_secretary_ledger',args:{content:'durable exact facts; PASS inputs fixture',revision:0}}:
    {name:'report',args:{output:'Exact bounded '+type+' facts; verified fixture'}}})
  try {
    const tool=type==='sol'?f.worker.solTaskTool:type==='secretary'?f.worker.secretaryTool:f.worker.taskTool
    const oldId=Object.keys(f.registry.get('leader').workers)[0]
    if(resume){assert.ok(oldId);assert.equal(f.ctx.agents.get(oldId),undefined);assert.equal(f.ctx.sessions.get(oldId),undefined)}
    const accepted=await f.run(tool,{task:'bounded '+(resume?'followup':'initial'),...(resume?{workerSessionId:oldId}:{})})
    assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(accepted))
    const child=await f.settled(accepted.workerSessionId);await f.wake(f.leader)
    const req=f.requests[0].request
    assert.ok(req.system.includes(postmanRoleInstruction(type)))
    assert.equal(req.reasoningEffort,type==='sol'?'xhigh':'low')
    assert.ok(!req.tools.some(x=>['ptc_execute','subagent','workflow','ralph','postman_bridge'].includes(x.name)))
    if(resume){assert.ok(child.session.events.filter(e=>e.type==='turn/end').length>=2);assert.ok(req.messages.some(m=>JSON.stringify(m).includes('bounded initial')))}
    const ledger=f.registry.get('leader').secretaryLedger
    if(type==='secretary'){assert.equal(ledger.revision,1);assert.ok(req.system.includes(ledger.content)||!resume)}
    const summary={pid:process.pid,id:child.id,role:type,requests:f.requests.length,reasoning:req.reasoningEffort,ledger}
    if(resume){
      const fresh=await f.run(f.worker.freshTool,{workerSessionId:child.id,task:'Fresh bounded assignment'})
      assert.equal(fresh.status,'POSTMAN_WORKER_TASK_ACCEPTED',JSON.stringify(fresh));assert.notEqual(fresh.workerSessionId,child.id)
      await f.settled(fresh.workerSessionId)
      const r=f.requests.find(x=>x.agent.id===fresh.workerSessionId).request
      assert.ok(!r.messages.some(m=>JSON.stringify(m).includes('bounded initial')))
      assert.ok(f.registry.get('leader').retiredWorkers.some(x=>x.id===child.id))
      assert.ok((await f.ctx.sessionPersistence.inspect(child.id)).events.length>0)
      if(type==='secretary')assert.equal(f.registry.get('leader').secretaryLedger.content,ledger.content)
      summary.freshId=fresh.workerSessionId
    }
    await writeFile(join(dir,resume?'resumed.json':'fresh.json'),JSON.stringify(summary))
  } finally {await f.dispose();await f.registry.close()}
}
if(process.env.DSH_STAGE1_COLD_PHASE){
  await phase(process.env.DSH_STAGE1_COLD_DIR,process.env.DSH_STAGE1_COLD_ROLE,process.env.DSH_STAGE1_COLD_PHASE==='resumed')
}else{
  for(const role of ['luna','secretary','sol'])test('native cold '+role+' across independent Node processes, same session then fresh',{timeout:45000},async t=>{
    const dir=await mkdtemp(join(tmpdir(),'postman-role-cold-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
    for(const name of ['fresh','resumed'])await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{stdio:'inherit',env:{...process.env,DSH_STAGE1_COLD_PHASE:name,DSH_STAGE1_COLD_DIR:dir,DSH_STAGE1_COLD_ROLE:role}})
      child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(name+' exit '+code)))
    })
    const first=JSON.parse(await readFile(join(dir,'fresh.json'),'utf8')),second=JSON.parse(await readFile(join(dir,'resumed.json'),'utf8'))
    assert.notEqual(first.pid,second.pid);assert.equal(first.id,second.id);assert.notEqual(second.freshId,second.id)
  })
}
