import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createDevspaceChannel, devspaceTerminal, requestDevspaceControl, readDevspaceControls } from './postman-devspace.js'
import { parsePostmanUserTurn, CurrentUserTurnStore, createDirectCurrentTurnToolConfigs, DirectPostmanJobManager } from './direct-current-turn.js'
import { buildPostmanBridgeStartRequest } from './postman-bridge-core.js'
import { createPostmanBridgeTool } from './postman-bridge.js'
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
    bridgeOperations:{old:{state:'pending'},[jobId]:{state:'pending',phase:'request-known',transportKind:'devspace',childSessionId:'luna',requestId:req,devspace:{mode:'WRITE_TEST',channel:'C:/private/job'}}}}
  await registry.create('leader',row);await registry.close()
  const again=await openPostmanTaskRegistry(domain)
  assert.deepEqual(again.get('leader').bridgeOperations,row.bridgeOperations)
  await again.close();await backend.close()
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
test('only live top-level Leader authorizes bridge and stage-one mode excludes continuation/Git', async () => {
  let accepted = 0
  const contexts = {get:()=>({})}
  const tool = createPostmanBridgeTool({agents:{get:id=>id===parent.id?parent:null}}, {accept(...args){accepted++;assert.equal(args[2],'devspace');assert.equal(args[5],'WRITE_TEST');return {status:'POSTMAN_BRIDGE_ACCEPTED'}}}, contexts)
  assert.equal((await tool.execute({message:'@PostmanDevspace task'}, {agent:{id:'foreign'}})).status,'POSTMAN_BRIDGE_CALLER_REJECTED')
  assert.equal((await tool.execute({message:'@PostmanDevspace --chat '+req+' task'}, {agent:parent})).status,'POSTMAN_BRIDGE_MESSAGE_REJECTED')
  assert.equal((await tool.execute({message:'@PostmanAsk task',devspace_mode:'WRITE_TEST'}, {agent:parent})).status,'POSTMAN_BRIDGE_MESSAGE_REJECTED')
  assert.equal((await tool.execute({message:'@PostmanDevspace task',devspace_mode:'WRITE_TEST'}, {agent:parent})).status,'POSTMAN_BRIDGE_ACCEPTED')
  assert.equal(accepted,1)
  const start = buildPostmanBridgeStartRequest({parent,message:'@PostmanDevspace task',transportKind:'devspace',signal:new AbortController().signal})
  assert.equal(start.label,'Postman Devspace Bridge')
  assert.match(start.persona,/1\. For exact @PostmanDevspace/)
  assert.equal(start.maxDepth,1)
  assert.deepEqual(start.toolFilter.allow,['skill','postman_send_current_turn','postman_current_turn_status','postman_ask_validate_reply'])
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
test('cold pending/unknown bell cannot bypass Luna; received trusted terminal remains readable', async t => {
  const {binding}=channel(t)
  bell(binding)
  const eventPath=join(binding.channel,'event.json')
  const saved=readFileSync(eventPath,'utf8')
  for (const state of ['pending','unknown']) {
    const operation={state,phase:'request-known',transportKind:'devspace',requestId:req,childSessionId:'luna',
      devspace:{mode:'WRITE_TEST',channel:binding.channel}}
    const row={bridgeOperations:{[jobId]:operation}}
    const unexpected=()=>assert.fail('cold status must not resume Luna, read Direct, mutate journal, sync or grant')
    const jobs=createPostmanBridgeJobs({subagents:{start:unexpected}}, {run:unexpected,dispose(){}}, {register:unexpected},
      {record:()=>row,changeRecord:unexpected,sync:unexpected}, null, {inspectRequest:unexpected})
    const status=await jobs.status(parent,jobId,true)
    assert.equal(status.status,'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
    assert.equal(status.diagnostic,'POSTMAN_DEVSPACE_LUNA_TERMINAL_UNAVAILABLE')
    assert.equal(status.result,undefined)
    assert.equal(status.terminalStatus,undefined)
    assert.equal(operation.terminal,undefined)
    assert.equal(operation.state,state)
    assert.equal(jobs.list(parent).used,1)
    assert.equal(readFileSync(eventPath,'utf8'),saved)
    assert.doesNotMatch(JSON.stringify(status),/DONE|DELIVERED|RESULT_REPORTED|capability|REPORT_UNVERIFIED/)
    // Only a terminal previously delivered through Luna/journal can be read cold.
    const result=devspaceTerminal(binding)
    row.bridgeOperations[jobId]={...operation,state:'received',synchronization:'not-required',
      terminal:{status:'POSTMAN_BRIDGE_TERMINAL',terminalStatus:'COMPLETED',transportKind:'devspace',requestId:req,result}}
    const received=await jobs.status(parent,jobId)
    assert.equal(received.status,'POSTMAN_BRIDGE_TERMINAL')
    assert.deepEqual(received.result,result)
    assert.equal(readFileSync(eventPath,'utf8'),saved)
    await jobs.dispose()
  }
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
  const started=await manager.start({sessionId:'luna',workspace:root,payload:'intent',branch,transportKind:'devspace',devspaceBinding:{bridgeJobId:id,leaderSessionId:'leader',lunaSessionId:'luna',worktree:root,mode:'READ_ONLY'}})
  assert.match(argv[argv.indexOf('-File')+1],/postman-devspace\.ps1$/)
  assert.ok(argv.includes('-Channel'));assert.equal(argv.includes('-InputFilesBase64'),false)
  child.stdout.emit('data',JSON.stringify({source:'bell',requestId:started.requestId,reportedOutcome:'DONE'}));child.emit('close',0)
  assert.equal(manager.view('luna').result.code,'POSTMAN_DEVSPACE_ROUTING_FAILED')
})
test('continuable Luna keeps exact identity across two REQs and same ChatGPT chat', async () => {
  let row = { bridgeOperations: {} }, wake, starts = 0, coldChecks = 0, closes = 0
  const context = { branch, repositoryPath: 'C:/source', worktree: 'C:/isolated' }
  const requestIds = [req, 'REQ_20261012T120001Z_0002']
  const conversationRef = 'https://chatgpt.com/c/stage2-owned'
  const launched = [], relays = [], reports = []
  const ctx = {
    agents: { get: id => id === 'leader' ? parent : null },
    subagents: {
      startContinuable: async args => { starts++; assert.deepEqual(args.request.toolFilter.allow, []); assert.equal(args.provider, 'spawn'); assert.equal(args.request.parent, parent); return { childId: args.childId, messageId: 'initial' } },
      inspectOpenContinuableChild: async () => { coldChecks++; return true },
      followup: async (_parent, childId, parts, options) => { relays.push({childId, message:parts[0].text, kind:options.source.kind}); return 'accepted' },
      closeContinuableChild: async (_parent, id, check) => { closes++; return await check() },
    },
  }
  let currentId
  const direct = {
    start: async args => {
      const requestId = requestIds[launched.length]
      assert.ok(requestId)
      assert.equal(args.transportKind, 'devspace')
      assert.equal(args.payload, launched.length ? 'second assignment' : 'first assignment')
      if (launched.length) assert.equal(args.devspaceBinding.conversationUrl, conversationRef)
      else assert.equal(args.devspaceBinding.conversationUrl, undefined)
      await args.onRequestAllocated(requestId, 'C:/private/'+requestId)
      launched.push(args);currentId = requestId
      return {requestId}
    },
    wait: async () => {
      const result = {ok:true,requestId:currentId,code:'DEVSPACE_SIGNAL_RECEIVED',
        source:'bell',reportedOutcome:'DONE',conversationRef,evidenceState:'REPORTED_NOT_VERIFIED'}
      reports.push(result)
      return {status:'COMPLETED',requestId:currentId,result}
    },
    dispose(){},
  }
  parent.followup = value => {wake = value}
  const contexts = {
    get: () => context, record: () => row,
    changeRecord: async (_id, fn) => {row = fn(row)},
    sync(){ assert.fail('no Git sync') },
  }
  const jobs = createPostmanBridgeJobs(ctx, createPostmanBridgeLaunchCoordinator(),
    {register(){ assert.fail('no grants') }}, contexts, null, direct)
  async function assigned(message) {
    const accepted = await jobs.accept(parent, '@PostmanDevspace '+message, 'devspace',undefined,undefined,'WRITE_TEST')
    assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED', accepted)
    let status
    for(let i=0;i<20;i++){
      await new Promise(resolve=>setImmediate(resolve))
      status = await jobs.status(parent, accepted.bridgeJobId)
      if(status.status==='POSTMAN_BRIDGE_TERMINAL')break
    }
    assert.equal(status.status, 'POSTMAN_BRIDGE_TERMINAL', status)
    assert.equal(status.result.source, 'bell')
    assert.equal(status.synchronization, 'not-required')
    assert.equal(row.bridgeOperations[accepted.bridgeJobId].childSessionId, row.devspaceLuna.childId)
    return accepted
  }
  const first = await assigned('first assignment')
  const second = await assigned('second assignment')
  assert.equal(starts, 1)
  assert.equal(coldChecks, 1)
  assert.equal(launched.length, 2)
  assert.equal(launched[0].devspaceBinding.lunaSessionId,launched[1].devspaceBinding.lunaSessionId)
  assert.equal(row.devspaceLuna.conversationRef, conversationRef)
  assert.deepEqual(row.devspaceLuna.requestIds,requestIds)
  assert.ok(relays.some(x=>x.kind==='coordinator' && x.message.includes('Host terminal')))
  assert.ok(relays.some(x=>x.kind==='coordinator' && x.message.includes('second assignment')))
  assert.match(JSON.stringify(wake),/POSTMAN_BRIDGE_READY/)
  assert.equal((await jobs.status({id:'foreign'},second.bridgeJobId)).status,'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  assert.equal((await jobs.devspaceLunaClose(parent)).status,'POSTMAN_DEVSPACE_LUNA_CLOSED')
  assert.equal(closes,1)
  assert.equal(row.devspaceLuna.state,'closed')
  assert.equal(jobs.devspaceLunaSnapshot(parent).state,'closed')
  await jobs.dispose()
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
