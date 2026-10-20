import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createDevspaceChannel, devspaceTerminal, requestDevspaceControl, readDevspaceControls } from './postman-devspace.js'
import { parsePostmanUserTurn, CurrentUserTurnStore, createDirectCurrentTurnToolConfigs, DirectPostmanJobManager } from './direct-current-turn.js'
import { buildPostmanBridgeStartRequest } from './postman-bridge-core.js'
import { createPostmanBridgeTool, createPostmanTeamStatusTool } from './postman-bridge.js'
import { createPostmanDevspaceLanes } from './postman-devspace-lanes.js'
import { createPostmanDevspaceLuna } from './postman-devspace-luna.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { openPostmanTaskRegistry } from './postman-task-registry.js'


test('bound live Luna sends exact captured payload once; impostor object cannot reuse id', async () => {
  const agent={id:'luna',session:{header:{cwd:'C:/source',origin:'subagent',delegationDepth:1,parentSession:'leader'}}}
  const context={leaderSessionId:'leader',branch}
  const binding={bridgeJobId:jobId,leaderSessionId:'leader',lunaSessionId:'luna',worktree:'C:/task',mode:'READ_ONLY'}
  const store=new CurrentUserTurnStore({})
  const user={type:'user/message',seq:1,data:{source:{kind:'user'},content:[{type:'text',text:'@PostmanDevspace exact\nintent'}]}}
  store.capture(agent,user)
  let sent=0
  const f=createDirectCurrentTurnToolConfigs({on:()=>()=>{},agents:{get:id=>id==='luna'?agent:null}}, {store,
    taskContexts:{child:()=>context,get:()=>context,devspaceBinding:()=>binding,recordBridgeRequest(){}},
    jobs:{start(args){sent++;assert.equal(args.payload,'exact\nintent');assert.equal(args.devspaceBinding,binding);return {status:'STARTED'}}}})
  await assert.rejects(f.tools[0].execute({}, {agent:{...agent}}),/LEADER_BINDING_REQUIRED/)
  assert.equal((await f.tools[0].execute({}, {agent})).status,'STARTED')
  await assert.rejects(f.tools[0].execute({}, {agent}),/ALREADY_USED/)
  assert.equal(sent,1)
})
test('registry reopens new private mode and old v1 operation without migration', async t => {
  const root=mkdtempSync(join(tmpdir(),'devspace-registry-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const backend=new JsonStorageBackend(root)
  const domain=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){}},{backend:'json',routes:{}})
  const registry=await openPostmanTaskRegistry(domain)
  const row={leaderSessionId:'leader',repository:'andrewverhoturov1/dsh-workspace',repositoryPath:'C:/repo',originUrl:'https://github.com/andrewverhoturov1/dsh-workspace.git',
    baseCommit:'a'.repeat(40),branch,worktree:'C:/task',stage:'ready',diagnostic:null,runner:{state:'none',requestId:null},bridge:null,
    bridgeOperations:{old:{state:'pending'},[jobId]:{state:'pending',phase:'request-known',transportKind:'devspace',childSessionId:'luna',requestId:req,notification:'delivered',finishedAt:'2026-10-20T12:00:00Z',diagnostic:'saved local fact',hostDiagnostic:{status:'unknown'},devspace:{mode:'WRITE_TEST',channel:'C:/private/job'}}}}
  await registry.create('leader',row);await registry.close()
  const again=await openPostmanTaskRegistry(domain)
  assert.deepEqual(again.get('leader').bridgeOperations,row.bridgeOperations)
  const folder = { ...row, leaderSessionId: 'folder', workspaceOnly: true,
    repository: '', originUrl: '', baseCommit: '', branch: '', devspaceReadOnly: true, workers: {} }
  await again.create('folder', folder)
  await again.close()
  const restored = await openPostmanTaskRegistry(domain)
  assert.deepEqual(restored.get('folder'), folder)
  await restored.close(); await backend.close()
})

const req = 'REQ_20261012T120000Z_0001'
const jobId = '11111111-1111-4111-8111-111111111111'
const branch = 'task/postman-' + 'a'.repeat(32)
const parent = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }
function channel(t, mode = 'WRITE_TEST') {
  const root = mkdtempSync(join(tmpdir(), 'devspace-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, binding: createDevspaceChannel({ root, bridgeJobId: jobId, requestId: req, leaderSessionId: 'leader',
    lunaSessionId: 'luna', worktree: root, sourceRoot: root, mode }) }
}
function bell(binding, fields = {}) {
  const event = { version: 1, ...Object.fromEntries(['jobId','requestId','leaderSessionId','lunaSessionId','capability'].map(k => [k,binding[k]])),
    reportedOutcome: 'DONE', message: 'необычный\n **отчёт**', reportRef: null, ...fields }
  writeFileSync(join(binding.channel,'event.json'), JSON.stringify(event))
}
test('Stage 3 isolates writeRoot only to a Host-bound task worktree', t => {
  const {root} = channel(t,'WRITE_TEST')
  const unique='33333333-3333-4333-8333-333333333333'
  const binding=createDevspaceChannel({root,bridgeJobId:unique,requestId:req,
    leaderSessionId:'leader',lunaSessionId:'luna',worktree:root,sourceRoot:root,mode:'WRITE_ISOLATED'})
  assert.equal(binding.workspaceRef,root)
  assert.equal(binding.writeRoot,root)
  assert.throws(() => createDevspaceChannel({root,bridgeJobId:'55555555-5555-4555-8555-555555555555',
    requestId:req,priorRequestId:req,conversationUrl:'https://chatgpt.com/c/old',
    leaderSessionId:'leader',lunaSessionId:'luna',worktree:root,sourceRoot:root,mode:'READ_ONLY'}),
  /POSTMAN_DEVSPACE_BINDING_INVALID/)
  assert.throws(() => createDevspaceChannel({root,bridgeJobId:'66666666-6666-4666-8666-666666666666',
    requestId:req,priorRequestId:'bad',conversationUrl:'https://chatgpt.com/c/old',
    leaderSessionId:'leader',lunaSessionId:'luna',worktree:root,sourceRoot:root,mode:'READ_ONLY'}),
  /POSTMAN_DEVSPACE_BINDING_INVALID/)
  assert.equal(devspaceTerminal(binding,{source:'text_fallback',diagnostic:'PARTIAL'}).reportedOutcome,'PARTIAL')
  const readonly='44444444-4444-4444-8444-444444444444'
  const read=createDevspaceChannel({root,bridgeJobId:readonly,requestId:req,
    leaderSessionId:'leader',lunaSessionId:'luna',worktree:root,sourceRoot:root,mode:'READ_ONLY'})
  assert.equal(read.writeRoot,null)
  assert.equal(read.computerUse,'allow')
})

test('exact devspace marker is separate and old payload/modes stay exact', () => {
  assert.equal(parsePostmanUserTurn('  @PostmanDevspace русский\nтекст').transportKind,'devspace')
  assert.equal(parsePostmanUserTurn('@PostmanDevspace русский\nтекст').payload,'русский\nтекст')
  for (const raw of ['@PostmanDevspaceExtra task','@postmandevspace task','@PostmanDevspace: task']) assert.throws(() => parsePostmanUserTurn(raw))
  for(const [name,kind] of [['Postman','artifact'],['PostmanAsk','text'],['PostmanImage','image']]) {
    assert.equal(parsePostmanUserTurn('@'+name+' exact').transportKind,kind)
    assert.equal(parsePostmanUserTurn('@'+name+' exact').payload,'exact')
  }
})
test('standalone and non-bound coding child cannot send devspace; coordinator stays ignored', async () => {
  const store = new CurrentUserTurnStore({})
  const agent = { id:'ordinary',session:{header:{cwd:'/repo'}} }
  const user = { type:'user/message',seq:1,data:{source:{kind:'user'},content:[{type:'text',text:'@PostmanDevspace task'}]} }
  store.capture(agent,user)
  store.capture(agent,{...user,seq:2,data:{...user.data,source:{kind:'coordinator'}}})
  assert.equal(store.get(agent.id).seq,1)
  const tools = createDirectCurrentTurnToolConfigs({}, {store,taskContexts:{child:()=>null},jobs:{start(){assert.fail('no send')}}})
  await assert.rejects(tools.tools[0].execute({}, {agent}),/POSTMAN_DEVSPACE_LEADER_BINDING_REQUIRED/)
  assert.equal(store.get(agent.id).consumed,false)
})
test('bell retains missing/arbitrary report, rejects each foreign identity and redacts capability', t => {
  const {binding} = channel(t)
  bell(binding,{reportRef:join(binding.writeRoot,'missing.md')})
  const result=devspaceTerminal(binding,{source:'text_fallback',diagnostic:'CAPABILITY_UNAVAILABLE'})
  assert.equal(result.source,'bell');assert.equal(result.reportedOutcome,'DONE')
  assert.ok(result.warnings.includes('REPORT_UNAVAILABLE'));assert.equal(result.evidenceState,'REPORTED_NOT_VERIFIED')
  assert.equal(JSON.stringify(result).includes(binding.capability),false)
  for (const key of ['jobId','requestId','leaderSessionId','lunaSessionId','capability']) {
    bell(binding,{[key]:'foreign'})
    assert.throws(()=>devspaceTerminal(binding),/OWNER_MISMATCH/)
  }
  bell(binding,{reportRef:join(binding.channel,'binding.json')})
  assert.equal(devspaceTerminal(binding).reportRef,null)
})
test('manager uses private launcher not publisher and stdout cannot forge own bell', async t => {
  const {root}=channel(t,'READ_ONLY')
  // Use another job to avoid existing immutable channel.
  const id='22222222-2222-4222-8222-222222222222'
  let argv,child
  const manager=new DirectPostmanJobManager({exists:()=>true,spawn(_cmd,args){argv=args;child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>child.emit('spawn'));return child}})
  // Override private-root allocation only through test environment, never source.
  const old=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=root;t.after(()=>{if(old===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=old})
  await assert.rejects(manager.start({sessionId:'root',workspace:root,payload:'intent',branch,transportKind:'devspace'}),/LEADER_BINDING_REQUIRED/)
  const started=await manager.start({sessionId:'luna',workspace:root,payload:'intent',branch:'',transportKind:'devspace',devspaceBinding:{bridgeJobId:id,leaderSessionId:'leader',lunaSessionId:'luna',worktree:root,branch:'',workspaceOnly:true,mode:'READ_ONLY'}})
  assert.match(argv[argv.indexOf('-File')+1],/postman-devspace\.ps1$/)
  assert.equal(argv[argv.indexOf('-Branch')+1],'')
  const binding=JSON.parse(readFileSync(join(argv[argv.indexOf('-Channel')+1],'binding.json'),'utf8'))
  assert.equal(binding.workspaceOnly,true)
  assert.equal(binding.branch,'')
  assert.equal(binding.writerRuntimeVersion,1)
  assert.ok(argv.includes('-Channel'));assert.equal(argv.includes('-InputFilesBase64'),false)
  child.stdout.emit('data',JSON.stringify({source:'bell',requestId:started.requestId,reportedOutcome:'DONE'}));child.emit('close',0)
  assert.equal(manager.view('luna').result.code,'POSTMAN_DEVSPACE_ROUTING_FAILED')
})
test('owned conversation continues after failed REQ; prior history is only an optional hint', async () => {
  const prior = req, failed = 'REQ_20261012T120001Z_0002', next = 'REQ_20261012T120002Z_0003'
  const chat = 'https://chatgpt.com/c/prior-history', child = 'luna'
  const positive = () => ({state:'received',phase:'synchronized',transportKind:'devspace',requestId:prior,
    childSessionId:child,terminal:{status:'POSTMAN_BRIDGE_TERMINAL',terminalStatus:'COMPLETED',
      requestId:prior,transportKind:'devspace',result:{requestId:prior,conversationRef:chat,source:'bell',
        transportDiagnostics:{transportEventJournal:[{event:'STAGE_STARTED'}]}}}})
  for (const variant of ['normal','text','image','recovered-unknown','child','url','request','unobserved','not-sent','duplicate','missing']) {
    let op=positive()
    if(variant==='text')op.terminal.result.source='text_fallback'
    if(variant==='image')Object.assign(op.terminal.result,{source:'image_result',evidenceState:'BROWSER_VERIFIED_IMAGE'})
    if(variant==='recovered-unknown')op.terminal.result.transportDiagnostics.sendProof={sendState:'UNKNOWN'}
    if(variant==='child')op.childSessionId='foreign'
    if(variant==='url')op.terminal.result.conversationRef='https://chatgpt.com/c/foreign'
    if(variant==='request')op.terminal.requestId=failed
    if(variant==='unobserved')delete op.terminal.result.transportDiagnostics
    if(variant==='not-sent')op.terminal.result.transportDiagnostics.sendProof={sendState:'PROVEN_NOT_SENT'}
    let row={devspaceLuna:{childId:child,state:'ready',activeBridgeJobId:null,requestIds:[prior,failed],conversationRef:chat},
      bridgeOperations:{old:op,failed:{...positive(),requestId:failed,terminal:{...positive().terminal,requestId:failed,
        result:{requestId:failed,conversationRef:chat,source:'transport_diagnostic',
          transportDiagnostics:{submitProof:{sendState:'PROVEN_NOT_SENT'}}}}},
        current:{state:'pending',phase:'reserved',transportKind:'devspace'}}}
    if(variant==='duplicate')row.bridgeOperations.duplicate=positive()
    if(variant==='missing')delete row.bridgeOperations.old
    const context={branch,worktree:'C:/task'}, launched=[]
    const contexts={get:()=>context,record:()=>row,changeRecord:async(_,fn)=>{row=fn(row)}}
    const ctx={agents:{get:id=>id===parent.id?parent:null},subagents:{
      startContinuable:async()=>{throw Error('must reuse saved Luna')},
      inspectOpenContinuableChild:async()=>true,followup:async()=> 'ok'}}
    const direct={start:async args=>{launched.push(args);await args.onRequestAllocated(next,'C:/private');return {requestId:next}},
      wait:async()=>({status:'COMPLETED',requestId:next,result:{requestId:next,source:'text_fallback',conversationRef:chat}})}
    const luna=createPostmanDevspaceLuna(ctx,contexts,direct)
    const before=structuredClone(row)
    const result=await luna.run({bridgeJobId:'current',taskContext:context,controller:new AbortController(),devspaceMode:'READ_ONLY'},
      '@PostmanDevspace continuation',parent)
    assert.equal(result.status,'POSTMAN_BRIDGE_TERMINAL',variant)
    assert.equal(launched.length,1)
    assert.equal(launched[0].devspaceBinding.priorRequestId,failed)
    assert.equal(launched[0].devspaceBinding.conversationUrl,chat)
    assert.deepEqual(row.bridgeOperations.old,before.bridgeOperations.old)
    assert.deepEqual(row.bridgeOperations.failed,before.bridgeOperations.failed,
      'the old PROVEN_NOT_SENT terminal remains unchanged')
  }
})

test('Host-owned Devspace control intent keeps owner, preserves one exact ID and prevents foreign state', t => {
  const {binding}=channel(t)
  const intent=requestDevspaceControl(binding,{kind:'preempt',priority:'urgent',message:'Stop and change the plan'})
  assert.equal(intent.status,'POSTMAN_DEVSPACE_CONTROL_QUEUED')
  let row=readDevspaceControls(binding)
  assert.equal(row.length,1)
  assert.equal(row[0].state,'QUEUED')
  assert.equal(row[0].kind,'preempt')
  const path=join(binding.channel,'controls',intent.controlId+'.ack.json')
  writeFileSync(path,JSON.stringify({controlId:intent.controlId,requestId:req,
    state:'STOP_UI_PROVEN',stopState:'STOP_UI_PROVEN',sendState:null}))
  row=readDevspaceControls(binding)
  assert.equal(row[0].stopState,'STOP_UI_PROVEN')
  assert.equal(row[0].state,'STOP_UI_PROVEN')
  writeFileSync(path,JSON.stringify({controlId:intent.controlId,requestId:'REQ_20261013T000000Z_9999',
    state:'SENT_CONFIRMED'}))
  assert.throws(()=>readDevspaceControls(binding),/ACK_INVALID/)
  assert.throws(()=>requestDevspaceControl(binding,{kind:'steer',message:''}),/CONTROL_INVALID/)
})

test('control status accepts durable composer wait and superseded acknowledgements without claiming Send', t => {
  const { binding } = channel(t)
  const intent = requestDevspaceControl(binding, { kind: 'preempt', message: 'continue when ready' })
  const path = join(binding.channel, 'controls', intent.controlId + '.ack.json')
  for (const state of ['WAITING_COMPOSER', 'SUPERSEDED']) {
    writeFileSync(path, JSON.stringify({ controlId: intent.controlId, requestId: binding.requestId,
      state, stopState: 'CLICK_UNKNOWN', sendState: 'PROVEN_NOT_SENT' }))
    const status = readDevspaceControls(binding)[0]
    assert.equal(status.state, state)
    assert.equal(status.stopState, 'CLICK_UNKNOWN')
    assert.equal(status.sendState, 'PROVEN_NOT_SENT')
  }
})

test('Host team status is lossless JSON while three Luna lanes are only reserved', async () => {
  // Admission persists reserved lanes before the native childId exists. The
  // actual PTC ToolRuntime rejects undefined even though JSON.stringify omits it.
  const row = { stage: 'ready', devspaceLanes: {
    alpha: { state: 'reserved', activeBridgeJobId: 'job-A',
      requestIds: [], conversationRef: null },
    beta: { state: 'ready', childId: 'luna-B', activeBridgeJobId: 'job-B',
      requestIds: ['REQ_20261013T000000Z_0002'], conversationRef: null },
    gamma: { state: 'reserved', activeBridgeJobId: 'job-C',
      requestIds: [], conversationRef: null },
  } }
  const ctx = { agents: { get: id => id === parent.id ? parent : null } }
  const contexts = { record: () => row, get: () => ({ branch: 'main' }),
    isRestoring: () => false, hasActiveOperation: () => false }
  const lanes = createPostmanDevspaceLanes(ctx, contexts, {})
  const jobs = { devspaceLunaSnapshot: owner => lanes.snapshot(owner),
    teamSnapshot: () => ({ status: 'POSTMAN_BRIDGE_TEAM_SNAPSHOT',
      used: 3, limit: 3, operations: [], truncated: false }) }
  const worker = { teamSnapshot: () => ({ status: 'POSTMAN_TEAM_STATUS',
    secretary: { present: false, sessionId: null, state: 'absent',
      budget: null, ledgerRevision: 0 },
    workers: { used: 0, limit: 2, rows: [] },
    sol: { present: false, sessionId: null, state: 'absent',
      ownedWorkers: { used: 0, limit: 2, states: {},
        budget: { used: 0, soft: 0, hard: 0, exhausted: 0, unknown: 0 } } } }) }
  const output = await createPostmanTeamStatusTool(ctx, contexts, worker, jobs)
    .execute({}, { agent: parent })
  assert.equal(output.status, 'POSTMAN_TEAM_STATUS')
  assert.equal(output.devspaceLuna.lanes.length, 3)
  assert.equal(output.devspaceLuna.lanes[0].lunaSessionId, null)
  assert.equal(output.devspaceLuna.lanes[1].lunaSessionId, 'luna-B')
  assert.equal(output.devspaceLuna.lanes[2].lunaSessionId, null)
  assert.deepEqual(output, JSON.parse(JSON.stringify(output)),
    'No undefined field can cross the Host PTC lossless JSON boundary')
})

test('three concurrent READ_ONLY lanes isolate Luna, REQ, chat and an UNKNOWN in another line', async () => {
  let row = { bridgeOperations: {} }
  const context = { branch, repositoryPath: 'C:/source', worktree: 'C:/source', devspaceReadOnly:true }
  const reqs = ['REQ_20261013T000000Z_0001', 'REQ_20261013T000001Z_0002',
    'REQ_20261013T000002Z_0003', 'REQ_20261013T000003Z_0004']
  let allocated=0, starts=0
  const waiting=new Map(), launched=[], notices=[]
  const leader={ ...parent, followup(message){notices.push(message)} }
  const ctx={
    agents:{get:id=>id===leader.id?leader:null},
    subagents:{
      startContinuable:async a=>{starts++;return {childId:a.childId}},
      inspectOpenContinuableChild:async ()=>true,
      followup:async ()=> 'delivered',
      closeContinuableChild:async (_,__,check)=>check(),
    },
  }
  const direct={
    async start(args){
      const id=reqs[allocated++]
      await args.onRequestAllocated(id,'C:/private/'+id)
      launched.push({...args,requestId:id})
      return {requestId:id}
    },
    wait(childId){return new Promise(resolve=>waiting.set(childId,resolve))},
    dispose(){},
  }
  const sourceContexts = {
    get:()=>context, record:()=>row,
    changeRecord:async (_id,fn)=>{row=fn(row)},
  }
  // Real PostmanTaskContexts is a Proxy with no enumerable own keys;
  // spreading it silently dropped get()/verifyWorktree() and prevented all
  // three Luna from starting after successful Bridge admission.
  const contexts = new Proxy({}, {get: (_target, key) => sourceContexts[key]})
  assert.deepEqual(Object.keys(contexts), [])
  const coordinator={run:(_signal,fn)=>Promise.resolve().then(fn),dispose(){}}
  const jobs=createPostmanBridgeJobs(ctx,coordinator,null,contexts,null,direct)
  const accepted=await Promise.all([1,2,3].map(i=>
    jobs.accept(leader, '@PostmanDevspace read-only job '+i, 'devspace',
      undefined,undefined,'READ_ONLY')))
  assert.ok(accepted.every(v=>v.status==='POSTMAN_BRIDGE_ACCEPTED'))
  assert.equal(new Set(accepted.map(v=>v.laneId)).size,3)
  const fourth=await jobs.accept(leader,'@PostmanDevspace rejected','devspace',
    undefined,undefined,'READ_ONLY')
  assert.equal(fourth.status,'POSTMAN_DEVSPACE_CAPACITY_REACHED')
  for(let i=0;i<40 && waiting.size<3;i++)await new Promise(r=>setImmediate(r))
  assert.equal(starts,3)
  assert.equal(allocated,3)
  assert.equal(waiting.size,3)
  assert.equal(new Set(launched.map(v=>v.sessionId)).size,3)
  assert.equal(Object.keys(row.devspaceLanes).length,3)
  assert.ok(accepted.every(v=>row.devspaceLanes[v.laneId].activeBridgeJobId===v.bridgeJobId))
  const out=(i)=>({status:'COMPLETED',requestId:reqs[i],result:{
    ok:true,requestId:reqs[i],source:'bell',reportedOutcome:'DONE',
    evidenceState:'REPORTED_NOT_VERIFIED',
    transportDiagnostics:{transportEventJournal:[{event:'STAGE_STARTED'}]},
    conversationRef:'https://chatgpt.com/c/devspace-lane-'+i}})
  waiting.get(launched[0].sessionId)(out(0))
  waiting.get(launched[1].sessionId)(out(1))
  for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r))
  assert.equal((await jobs.status(leader,accepted[0].bridgeJobId)).status,'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await jobs.status(leader,accepted[1].bridgeJobId)).status,'POSTMAN_BRIDGE_TERMINAL')
  // The third line remains in-flight while a previously completed line resumes.
  const continued=await jobs.accept(leader,'@PostmanDevspace same chat again','devspace',
    undefined,undefined,'READ_ONLY',accepted[0].laneId)
  assert.equal(continued.status,'POSTMAN_BRIDGE_ACCEPTED')
  for(let i=0;i<40 && launched.length<4;i++)await new Promise(r=>setImmediate(r))
  assert.equal(launched.length,4)
  assert.equal(starts,3)
  assert.equal(launched[3].sessionId,launched[0].sessionId)
  assert.equal(launched[3].devspaceBinding.conversationUrl,
    'https://chatgpt.com/c/devspace-lane-0')
  assert.equal((await jobs.status(leader,accepted[2].bridgeJobId)).status,
    'POSTMAN_BRIDGE_RUNNING')
  // A caller from a different owner cannot inspect this lane's terminal.
  assert.equal((await jobs.status({id:'other'},accepted[0].bridgeJobId)).status,
    'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  waiting.get(launched[2].sessionId)(out(2))
  waiting.get(launched[3].sessionId)(out(3))
  for(let i=0;i<40;i++)await new Promise(r=>setImmediate(r))
  assert.equal((await jobs.status(leader,continued.bridgeJobId)).status,'POSTMAN_BRIDGE_TERMINAL')
  assert.equal((await jobs.devspaceLunaClose(leader)).status,'POSTMAN_DEVSPACE_LUNA_CLOSED')
  assert.ok(Object.values(row.devspaceLanes).every(x=>x.state==='closed'))
  await jobs.dispose()
})

test('Host checks private image proof and never promotes an arbitrary stdout path', t => {
  const {binding} = channel(t,'READ_ONLY')
  const source = join(binding.channel,'POSTMAN_IMAGE_'+req+'.png')
  const content=Buffer.from('89504e470d0a1a0a'+'0000000d4948445200000049000000430802000000','hex')
  writeFileSync(source,content)
  const proof={source:'image_result',requestId:req,
    imageFormat:'png',imageMimeType:'image/png',imageWidth:73,imageHeight:67,
    resultImage:source,imageByteLength:content.length,
    imageSha256:createHash('sha256').update(content).digest('hex'),
    assistantText:'image and text remain independent from a bell',
    conversationRef:'https://chatgpt.com/c/owned-test-chat'}
  const result=devspaceTerminal(binding,proof)
  assert.equal(result.code,'DEVSPACE_IMAGE_RESULT_DURABLE')
  assert.equal(result.source,'image_result')
  assert.equal(result.evidenceState,'BROWSER_VERIFIED_IMAGE')
  assert.equal(result.resultImage,source)
  assert.equal(result.imageSha256,proof.imageSha256)
  assert.equal(result.reportedOutcome,'UNKNOWN') // No fake DONE without bell.
  assert.throws(()=>devspaceTerminal(binding,{...proof,resultImage:'C:/foreign.png'}),/IMAGE_PROOF_INVALID/)
  assert.throws(()=>devspaceTerminal(binding,{...proof,imageSha256:'0'.repeat(64)}),/IMAGE_PROOF_INVALID/)
  assert.throws(()=>devspaceTerminal(binding,{...proof,source:'arbitrary',resultImage:undefined}),/EVENT_MISSING/)
  writeFileSync(join(binding.channel,'event.json'),JSON.stringify({version:1,
    ...Object.fromEntries(['jobId','requestId','leaderSessionId','lunaSessionId','capability'].map(k=>[k,binding[k]])),
    reportedOutcome:'DONE',message:'assistant claim only',reportRef:null}))
  const bell=devspaceTerminal(binding,proof)
  assert.equal(bell.source,'bell');assert.equal(bell.reportedOutcome,'DONE')
  assert.equal(bell.resultImage,source);assert.equal(bell.imageSha256,proof.imageSha256)
  assert.equal(bell.assistantText,proof.assistantText)
  assert.equal(bell.evidenceState,'BROWSER_VERIFIED_IMAGE','image proof is not engineering PASS')
  assert.equal(devspaceTerminal(binding,bell).imageSha256,proof.imageSha256,'restart/late status retains validated bytes')
  assert.throws(()=>devspaceTerminal(binding,{...proof,imageSha256:'0'.repeat(64)}),/IMAGE_PROOF_INVALID/)
})
