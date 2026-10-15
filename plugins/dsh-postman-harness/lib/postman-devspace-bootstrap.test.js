import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'

// Two independent Host-owned DevSpace lanes. No browser Send, model provider,
// private channel, or invented terminal: the stub holds real Bridge lifecycle
// promises until its separately allocated synthetic REQ is released.
test('two bootstrap Luna report+settled pairs stay durable without waking; both Bridge READY wake', async t => {
  const taskContext = Object.freeze({ branch: 'task/fixture', worktree: 'C:/synthetic/task',
    repositoryPath: 'C:/synthetic/repo' })
  const parent = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } },
    phase: {kind:'idle'}, inbox: {nextStep:[], nextTurn:[]}, wakes:[],
    inject(message) { this.inbox.nextStep.push(message) },
    followup(message) { this.wakes.push(message); this.inbox.nextTurn.push(message) },
    steer(message) { this.wakes.push(message); this.inbox.nextStep.push(message) } }
  const children = new Map([['leader',parent]])
  const sessions=new Map()
  const ctx = { agents: { get: id => children.get(id) },sessions:{get:id=>sessions.get(id)} }
  let row = { leaderSessionId:'leader', bridgeOperations:{} }
  const contexts = { get: id => id === 'leader' ? taskContext : null,
    record: id => id === 'leader' ? row : null,
    changeRecord: async (id, update) => {
      assert.equal(id,'leader')
      row = update(row)
      return row
    } }
  const started = [], pending = new Map(), requestIds = new Map()
  let jobs
  ctx.subagents = {
    async startContinuable(spec) {
      const child = { id:spec.childId,
        session:{header:{id:spec.childId,origin:'subagent',parentSession:'leader',delegationDepth:1,seedLength:0},
          events:[{type:'turn/start',data:{turn:1}},{type:'user/message',
            data:{source:{kind:'subagent',form:'task'},id:'initial'}}]},
        inbox:{hasPending:false} }
      children.set(child.id, child);sessions.set(child.id,child.session)
      started.push(child)
      const reportText = 'POSTMAN_LUNA_BOOTSTRAP_ACK'
      const args = JSON.stringify({output:reportText})
      const callId = 'bootstrap-'+started.length
      child.session.events.push({type:'tool/call',data:{turn:1,callId,name:'report',arguments:args}})
      const report = {id:'native-report-'+started.length,
        source:{kind:'subagent-report',senderSessionId:child.id},
        content:[{type:'text',text:reportText}]}
      const reportContent=[{type:'text',text:reportText}]
      assert.equal(jobs.canDeferLunaBootstrapReport(parent,child,reportContent),true,
        'exact new bootstrap report is not a trusted Bridge result')
      parent.inject(report)
      child.session.events.push({type:'tool/result',data:{turn:1}})
      child.session.events.push({type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
      const terminal = {stopReason:'completed',output:[{type:'tool-call',id:callId,name:'report',arguments:args}]}
      assert.equal(jobs.canDeferLunaBootstrapSettlement(parent,child,terminal),true)
      parent.inject({id:'native-settled-'+started.length,
        source:{kind:'subagent-settled',senderSessionId:child.id},
        content:[{type:'text',text:'Native completion fact'}]})
      assert.equal(jobs.canDeferLunaBootstrapReport({...parent},child,reportContent),false,
        'foreign object cannot borrow owner id')
      assert.equal(jobs.canDeferLunaBootstrapReport(parent,{...child},reportContent),false,
        'foreign child object cannot borrow Luna id')
      for (const text of ['NEEDS_PARENT_GUIDANCE: binding mismatch', 'authority revoked',
        'A meaningful result in otherwise ordinary prose', 'Bootstrap liaison ready'])
        assert.equal(jobs.canDeferLunaBootstrapReport(parent,child,[{type:'text',text}]),false)
      assert.equal(jobs.canDeferLunaBootstrapSettlement(parent,child,
        {stopReason:'completed',output:[{type:'tool-call',id:callId,name:'report',
          arguments:JSON.stringify({output:'authority revoked'})}]}),false)
      assert.equal(jobs.canDeferLunaBootstrapSettlement(parent,child,
        {stopReason:'error',output:terminal.output}),false)
      assert.equal(jobs.canDeferLunaBootstrapSettlement(parent,child,
        {stopReason:'completed',output:[{type:'text',text:'unreported failure'}]}),false)
      return {childId:child.id,messageId:'admitted-'+started.length}
    },
    async inspectOpenContinuableChild(_parent,childId) {return children.has(childId)},
    async followup() {return 'host-relay-received'},
  }
  const coordinator = { run(_signal,start) {return Promise.resolve().then(start)}, fork(){return this}, dispose(){} }
  const direct = { async start(options) {
      const requestId = 'REQ_20261014T130800Z_'+String(pending.size+1).padStart(4,'0')
      await options.onRequestAllocated(requestId, 'C:/synthetic/channel/'+requestId)
      const deferred=Promise.withResolvers()
      pending.set(options.devspaceBinding.bridgeJobId,deferred)
      requestIds.set(options.devspaceBinding.bridgeJobId,requestId)
      return {requestId}
    },
    async wait(_childId,_unused,signal) {
      const id = [...pending.keys()].find(jobId => row.bridgeOperations[jobId]?.childSessionId === _childId)
      assert.ok(id)
      return pending.get(id).promise
    }, dispose(){} }
  jobs=createPostmanBridgeJobs(ctx,coordinator,null,contexts,null,direct)
  t.after(async()=>{ for(const [id,deferred] of pending) deferred.resolve({
    status:'COMPLETED',requestId:requestIds.get(id),result:{ok:true,requestId:requestIds.get(id),
      source:'bell',code:'DEVSPACE_SIGNAL_RECEIVED',reportedOutcome:'DONE',evidenceState:'REPORTED_NOT_VERIFIED'}})
    await jobs.dispose() })
  const requests = await Promise.all([
    jobs.accept(parent,'@PostmanDevspace first synthetic task','devspace',undefined,undefined,'WRITE_TEST'),
    jobs.accept(parent,'@PostmanDevspace second synthetic task','devspace',undefined,undefined,'WRITE_TEST'),
  ])
  assert.ok(requests.every(item=>item.status==='POSTMAN_BRIDGE_ACCEPTED'))
  for(let i=0;i<80&&pending.size!==2;i++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(pending.size,2)
  assert.equal(started.length,2)
  assert.equal(parent.wakes.length,0,'two report+settled pairs never wake Leader before Bridge READY')
  assert.deepEqual(parent.inbox.nextStep.map(item=>item.source.kind),
    ['subagent-report','subagent-settled','subagent-report','subagent-settled'])
  assert.equal(jobs.hasActiveWork(parent),true)
  assert.ok(requests.every(item=>jobs.canDeferLunaBootstrapSettlement(parent,
    children.get(row.devspaceLanes[item.laneId].childId),
    {stopReason:'completed',output:[{type:'tool-call',
      id:'bootstrap-'+(started.indexOf(children.get(row.devspaceLanes[item.laneId].childId))+1),
      name:'report',arguments:JSON.stringify({output:'POSTMAN_LUNA_BOOTSTRAP_ACK'})}]})))
  // Resolve independent terminals in the same tick. No synthetic Send/resend,
  // no merged Bridge IDs, and no loss of earlier native lifecycle facts.
  for(const request of requests) pending.get(request.bridgeJobId).resolve({
    status:'COMPLETED',requestId:requestIds.get(request.bridgeJobId),
    result:{ok:true,requestId:requestIds.get(request.bridgeJobId),source:'bell',
      code:'DEVSPACE_SIGNAL_RECEIVED',reportedOutcome:'DONE',evidenceState:'REPORTED_NOT_VERIFIED'},
  })
  for(let i=0;i<80 && parent.wakes.length!==2;i++)
    await new Promise(resolve=>setImmediate(resolve))
  for(const request of requests) {
    assert.equal(parent.wakes.filter(m=>m.source?.bridgeJobId===request.bridgeJobId).length,1,
      'one READY per exact Bridge job')
    assert.equal((await jobs.status(parent,request.bridgeJobId)).status,'POSTMAN_BRIDGE_TERMINAL')
  }
  assert.equal(parent.wakes.length,2)
  assert.deepEqual(new Set(parent.wakes.map(m=>m.source.bridgeJobId)),
    new Set(requests.map(x=>x.bridgeJobId)))
  assert.equal(parent.inbox.nextStep.length,4,'all four original native lifecycle facts retained')
  assert.equal(jobs.hasActiveWork(parent),false)
})
