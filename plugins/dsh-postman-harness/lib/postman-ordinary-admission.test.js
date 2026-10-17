import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,mkdtemp,rm,access} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createPostmanBridgeJobs} from './postman-bridge-jobs.js'
import {checkDevspaceOrdinaryWriterAdmission} from './postman-writer-proof.js'

test('real ordinary MCP activity refuses Bridge before durable queue or REQ; finite native clearance permits a normal retry',{
  skip:process.platform!=='win32',timeout:30000,
},async t=>{
  const {createBackgroundFixture,quote}=await import('../../../devspace/tests/background-fixture.mjs')
  const f=await createBackgroundFixture(),control=await f.runtimeModule.startWriterControl(f.writers,{file:join(f.root,'writer-control.json')})
  t.after(async()=>{await control.close();await f.close()})
  const leader={id:'leader',session:{header:{agentPreset:'postman-leader',delegationDepth:0}},followup(){}}
  const task={leaderSessionId:leader.id,worktree:f.project,branch:f.binding.branch,repository:'andrewverhoturov1/dsh-workspace'}
  let row={...task,stage:'ready',bridgeOperations:{}}
  const contexts={get:()=>task,record:()=>row,records:()=>[[leader.id,row]],
    async changeRecord(_id,change){row=change(row);return row},
    checkOrdinaryWriterAdmission:(_id,root)=>checkDevspaceOrdinaryWriterAdmission(root,{controlFile:control.file})}
  const gates=[],coordinator={run(signal,_launch,ready){gates.push(ready);return new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(Error('owned test queue disposed')),{once:true})})},refresh(){},dispose(){}}
  let sends=0
  const jobs=createPostmanBridgeJobs({agents:{get:()=>leader}},coordinator,null,contexts,null,{async start(){sends++;throw Error('a test may not send')},dispose(){}})
  t.after(()=>jobs.dispose())
  const opened=await f.call('open_workspace',{path:f.project},'ordinary-active')
  assert.notEqual(opened.isError,true)
  const finish=join(f.project,'finish-ordinary'),started=join(f.project,'ordinary-started')
  const program='const fs=require("fs");fs.writeFileSync("ordinary-started","started");const timer=setInterval(()=>{if(fs.existsSync("finish-ordinary"))clearInterval(timer)},25)'
  const command=quote(process.execPath.replaceAll('\\','/'))+' -e '+quote(program)
  let ordinaryTerminal
  const ordinary=f.call('bash',{workspace_id:opened.structuredContent.workspace_id,command,timeout:15},'ordinary-active')
    .then(result=>{ordinaryTerminal=result;return result})
  try {
  let active=false
  const deadline=Date.now()+10000
  while(!active&&Date.now()<deadline) {
    try{await access(started);active=true}catch{}
    if(ordinaryTerminal&&!active)break
    if(!active)await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.equal(active,true,'the real upstream command creates a native ordinary lease: '+JSON.stringify({terminal:ordinaryTerminal,
    census:JSON.parse(await readFile(control.file,'utf8')).untrackedRoots}))
  const refused=await jobs.accept(leader,'@PostmanDevspace write approved task','devspace',undefined,undefined,'WRITE_ISOLATED')
  assert.equal(refused.status,'POSTMAN_TASK_CONTEXT_BUSY',JSON.stringify(refused))
  assert.equal(refused.diagnostic.code,'OTHER_WRITER_ACTIVE')
  assert.deepEqual(row.bridgeOperations,{})
  assert.equal(gates.length,0);assert.equal(sends,0)
  const reading=await jobs.accept(leader,'@PostmanDevspace read while ordinary runs','devspace',undefined,undefined,'READ_ONLY')
  assert.equal(reading.status,'POSTMAN_BRIDGE_ACCEPTED');assert.equal(gates.at(-1)(),true)
  const independent=join(f.root,'independent');await mkdir(independent)
  const separate=await jobs.accept(leader,'@PostmanDevspace independent approved write','devspace',undefined,undefined,
    'WRITE_APPROVED_TARGET',undefined,{root:independent,access:'write'})
  assert.equal(separate.status,'POSTMAN_BRIDGE_ACCEPTED');assert.equal(gates.at(-1)(),true)
  } finally {await writeFile(finish,'finish the owned finite command')}
  const terminal=await ordinary
  assert.notEqual(terminal.isError,true,JSON.stringify(terminal))
  const ready=await checkDevspaceOrdinaryWriterAdmission(f.project,{controlFile:control.file})
  assert.equal(ready.ok,true,JSON.stringify(ready))
  const accepted=await jobs.accept(leader,'@PostmanDevspace retry approved task','devspace',undefined,undefined,'WRITE_ISOLATED')
  assert.equal(accepted.status,'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(gates.at(-1)(),true)
  assert.equal(sends,0,'the inert launch fixture verifies admission without a ChatGPT send')
})

test('offline ordinary uncertainty refuses only overlapping admission; unreadable census is explicit and never queues a shared writer',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'postman-ordinary-cold-')),file=join(directory,'writer-control.json')
  const root=join(directory,'old'),independent=join(directory,'independent');await mkdir(root);await mkdir(independent)
  const leader={id:'leader',session:{header:{agentPreset:'postman-leader',delegationDepth:0}},followup(){}}
  const task={worktree:root,branch:'task/postman-'+'a'.repeat(32),repository:'andrewverhoturov1/dsh-workspace'}
  let currentTask=task,currentLeader=leader
  let row={...task,leaderSessionId:leader.id,stage:'ready',bridgeOperations:{}}
  const contexts={get:()=>currentTask,record:()=>row,records:()=>[[leader.id,row]],
    async changeRecord(_id,change){row=change(row);return row},
    checkOrdinaryWriterAdmission:(_id,target)=>checkDevspaceOrdinaryWriterAdmission(target,{controlFile:file})}
  const gates=[],coordinator={run(signal,_launch,ready){gates.push(ready);return new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(Error('owned test queue disposed')),{once:true})})},refresh(){},dispose(){}}
  const jobs=createPostmanBridgeJobs({agents:{get:()=>currentLeader}},coordinator,null,contexts,null,{dispose(){}})
  t.after(async()=>{await jobs.dispose();assert.equal(dirname(resolve(directory)),resolve(tmpdir()));await rm(directory,{recursive:true,force:true})})
  await writeFile(file,JSON.stringify({version:1,untrackedRoots:[root]}))
  const invoke=(target=root)=>jobs.accept(leader,'@PostmanDevspace approved write','devspace',undefined,undefined,
    'WRITE_APPROVED_TARGET',undefined,{root:target,access:'write'})
  const unknown=await invoke()
  assert.equal(unknown.status,'POSTMAN_TASK_CONTEXT_BUSY')
  assert.equal(unknown.diagnostic.code,'DEVSPACE_ORDINARY_WRITER_EXIT_UNPROVEN')
  assert.deepEqual(row.bridgeOperations,{});assert.equal(gates.length,0)
  assert.equal((await invoke(independent)).status,'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal((await jobs.accept(leader,'@PostmanDevspace inspect original root','devspace',undefined,undefined,'READ_ONLY')).status,'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(gates.length,2)
  await writeFile(file,'{invalid private census')
  const before=JSON.stringify(row.bridgeOperations),unavailable=await invoke()
  assert.equal(unavailable.status,'POSTMAN_TASK_CONTEXT_BUSY')
  assert.equal(unavailable.diagnostic.code,'DEVSPACE_ORDINARY_WRITER_EXIT_UNPROVEN')
  assert.equal(JSON.stringify(row.bridgeOperations),before);assert.equal(gates.length,2)
  for(const changed of ['task','leader']) {
    contexts.checkOrdinaryWriterAdmission=async()=>{
      if(changed==='task')currentTask={...currentTask,branch:'task/postman-'+'b'.repeat(32)}
      else currentLeader={...leader}
      return {ok:true,status:'READY'}
    }
    const stale=await invoke()
    assert.equal(stale.status,'POSTMAN_TASK_CONTEXT_BUSY')
    assert.equal(stale.diagnostic.code,'POSTMAN_TASK_CONTEXT_CHANGED')
    assert.equal(JSON.stringify(row.bridgeOperations),before);assert.equal(gates.length,2)
  }
})
