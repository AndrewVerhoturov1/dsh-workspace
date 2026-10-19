import test from 'node:test'
import assert from 'node:assert/strict'
import {createPostmanBridgeJobs} from './postman-bridge-jobs.js'

for(const diagnostic of ['OTHER_WRITER_ACTIVE','EXIT_UNPROVEN','UNREADABLE_CENSUS'])
test('Leader may dispatch Bridge without an ordinary writer veto: '+diagnostic,async t=>{
  const leader={id:'leader',session:{header:{agentPreset:'postman-leader',delegationDepth:0}},followup(){}}
  const task={leaderSessionId:leader.id,worktree:'C:/task',branch:'task/leader',repository:'example/repo'}
  let row={...task,stage:'ready',bridgeOperations:{}}
  let checks=0
  const contexts={get:()=>task,record:()=>row,records:()=>[[leader.id,row]],
    hasActiveOperation:()=>true,
    async changeRecord(_id,change){row=change(row);return row},
    async checkOrdinaryWriterAdmission(){checks++;throw Error(diagnostic)}}
  const launches=[]
  const coordinator={run(signal,_launch,ready){launches.push({ready});return new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(Error('inert test disposed')),{once:true})})},dispose(){}}
  const jobs=createPostmanBridgeJobs({agents:{get:()=>leader}},coordinator,null,contexts,null,{dispose(){}})
  t.after(()=>jobs.dispose())
  for(const mode of ['WRITE_ISOLATED','READ_ONLY','WRITE_APPROVED_TARGET']) {
    const accepted=await jobs.accept(leader,'@PostmanDevspace Leader-authorized work','devspace',undefined,
      undefined,mode,undefined,mode==='WRITE_APPROVED_TARGET'?{root:task.worktree,access:'write'}:undefined)
    assert.equal(accepted.status,'POSTMAN_BRIDGE_ACCEPTED')
    assert.ok(row.bridgeOperations[accepted.bridgeJobId])
  }
  assert.equal(checks,0,'no ordinary writer census is consulted for dispatch')
  assert.equal(launches.length,3)
  assert.ok(launches.every(entry=>entry.ready===undefined),'no hidden root gate delays execution')
})
