import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanTaskContexts } from './postman-task-context.js'
import { createMemoryTaskRegistry } from './postman-task-registry.js'

const leader = (id,cwd=process.cwd()) => ({id,session:{header:{cwd}}})
test('ordinary owner record requires no Git and preserves old closed metadata',async()=>{
  const registry=createMemoryTaskRegistry()
  await registry.create('A',{leaderSessionId:'A',stage:'closed',worktree:'old-missing-tree',workers:{},bridgeOperations:{old:{executionRevoked:true}}})
  const contexts=createPostmanTaskContexts({registry,gitCommand(){throw Error('Git must not run')}})
  const a=leader('A'),owner=await contexts.ensure(a)
  assert.equal(owner.worktree,process.cwd())
  assert.equal(contexts.get('A'),owner)
  assert.equal(registry.get('A').stage,'closed')
  assert.equal(registry.get('A').bridgeOperations.old.executionRevoked,true)
  for(const removed of ['prepare','prepareReadOnly','resume','restore','close','sync','verifyWorktree']) assert.equal(contexts[removed],undefined)
})
test('concurrent first calls share one owner and independent leaders have separate records',async()=>{
  const contexts=createPostmanTaskContexts(),a=leader('A'),b=leader('B')
  const [one,two]=await Promise.all([contexts.ensure(a),contexts.ensure(a)])
  assert.equal(one,two)
  assert.notEqual(await contexts.ensure(b),one)
  assert.equal(contexts.records().length,2)
})
test('child binding records exact ownership and refuses changed or revoked operations',async()=>{
  const contexts=createPostmanTaskContexts(); await contexts.ensure(leader('A'))
  await contexts.changeRecord('A',row=>({...row,bridgeOperations:{job:{transportKind:'devspace',state:'pending',childSessionId:'child',devspace:{mode:'WRITE_TEST'}}}}))
  assert.equal(contexts.bindChild('A','child','job'),true)
  assert.equal(contexts.bindChild('B','child','other'),false)
  await contexts.recordBridgeRequest('child','REQ_20261020T000000Z_0001','channel')
  assert.equal(contexts.devspaceBinding('child').leaderSessionId,'A')
  await contexts.changeRecord('A',row=>({...row,bridgeOperations:{job:{...row.bridgeOperations.job,executionRevoked:true}}}))
  assert.equal(contexts.devspaceBinding('child'),null)
  await assert.rejects(contexts.recordBridgeRequest('child','different','channel'),/OWNER_CHANGED/)
})
