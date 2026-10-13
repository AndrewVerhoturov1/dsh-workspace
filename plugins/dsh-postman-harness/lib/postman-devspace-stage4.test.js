import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDevspaceChannel } from './postman-devspace.js'
import { createPostmanBridgeJobs } from './postman-bridge-jobs.js'
import { createPostmanTaskPrepareTool } from './postman-bridge.js'

const REQUEST = 'REQ_20261013T031200Z_0001'
const BRIDGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PARENT = { id: 'leader', session: { header: { agentPreset: 'postman-leader', delegationDepth: 0 } } }

function fixture(t, { laneState = 'ready', foreignEvent = false, noBell = false,
  recoveryIntent = false, coldUnavailable = false, relayFails = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'stage4-cold-bell-'))
  const original = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = temp
  t.after(() => {
    if (original === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = original
    rmSync(temp, { recursive: true, force: true })
  })
  const privateRoot = join(temp, 'DSH', 'Postman', 'devspace')
  mkdirSync(privateRoot, { recursive: true })
  const binding = createDevspaceChannel({ root: privateRoot, bridgeJobId: BRIDGE,
    requestId: REQUEST, leaderSessionId: PARENT.id, lunaSessionId: 'luna-persisted',
    worktree: temp, sourceRoot: temp, mode: 'WRITE_TEST' })
  if (!noBell) {
    writeFileSync(join(binding.channel, 'event.json'), JSON.stringify({
      version: 1, ...Object.fromEntries(['jobId', 'requestId', 'leaderSessionId',
        'lunaSessionId', 'capability'].map(key => [key, binding[key]])),
      reportedOutcome: 'DONE', message: 'отчёт в свободной форме\n**done**', reportRef: null,
      ...(foreignEvent ? {leaderSessionId: 'another-leader'} : {}),
    }), 'utf8')
  }
  const taskContext = { leaderSessionId: PARENT.id, branch: 'task/postman-' + 'a'.repeat(32),
    worktree: temp, baseCommit: 'a'.repeat(40) }
  let row = { leaderSessionId: PARENT.id, bridgeOperations: {
    [BRIDGE]: { state: 'unknown', phase: 'request-known', transportKind: 'devspace',
      requestId: REQUEST, childSessionId: binding.lunaSessionId,
      devspace: { mode: 'WRITE_TEST', channel: binding.channel,
        ...(recoveryIntent ? {coldBellRecovery: 'intent'} : {}) },
    },
  }, devspaceLuna: {childId:binding.lunaSessionId,state:laneState,requestIds:[REQUEST],
     activeBridgeJobId:BRIDGE,conversationRef:null} }
  const calls = {followups:[],inspections:0,direct:0}
  const ctx = {
    agents: { get: id => id === PARENT.id ? PARENT : null },
    subagents: {
      async inspectOpenContinuableChild(parent,childId){
        assert.equal(parent,PARENT);assert.equal(childId,binding.lunaSessionId)
        calls.inspections++;return !coldUnavailable
      },
      async followup(parent,childId,parts,options){
        assert.equal(parent,PARENT);assert.equal(childId,binding.lunaSessionId)
        assert.equal(options.source.kind,'coordinator')
        calls.followups.push(parts[0].text)
        if (relayFails) throw Error('native followup delivery UNKNOWN')
        return 'durable-inbox-1'
      },
    },
  }
  const contexts = { get:id => id===PARENT.id ? taskContext:null,
    record:id => id===PARENT.id ? row:null,
    changeRecord:async (_id,fn)=>{row=fn(row);return row} }
  function make(){
    return createPostmanBridgeJobs(ctx,{run(){throw Error('COLD_MUST_NOT_LAUNCH')},dispose(){}},
      {register(){throw Error('COLD_MUST_NOT_GRANT')}},contexts,null,{
        inspectRequest(){calls.direct++;throw Error('NO_DIRECT_INSPECT')},
        dispose(){},
      })
  }
  return {binding,calls,make,row:()=>row,setRow:fn=>{row=fn(row)},contexts,ctx}
}

test('cold restart recovers owned bell through original Luna exactly once and no browser Send', async t => {
  const f=fixture(t)
  const jobs=f.make()
  const first=await jobs.status(PARENT,BRIDGE)
  assert.equal(first.status,'POSTMAN_BRIDGE_TERMINAL',first)
  assert.equal(first.result.source,'bell')
  assert.equal(first.result.reportedOutcome,'DONE')
  assert.equal(first.result.evidenceState,'REPORTED_NOT_VERIFIED')
  assert.equal(first.synchronization,'not-required')
  assert.equal(f.calls.inspections,1)
  assert.equal(f.calls.followups.length,1)
  assert.equal(f.calls.direct,0)
  assert.equal(f.row().bridgeOperations[BRIDGE].state,'received')
  assert.equal(f.row().devspaceLuna.activeBridgeJobId,null)
  const same=await jobs.status(PARENT,BRIDGE)
  assert.equal(same.result.source,'bell')
  assert.equal(f.calls.followups.length,1)
  await jobs.dispose()
  const restart=f.make()
  const cold=await restart.status(PARENT,BRIDGE)
  assert.equal(cold.status,'POSTMAN_BRIDGE_TERMINAL')
  assert.equal(f.calls.followups.length,1)
  assert.equal((await restart.status({id:'foreign'},BRIDGE)).status,'POSTMAN_BRIDGE_JOB_NOT_FOUND')
  await restart.dispose()
})

test('without bell or Luna reproof cold delivery remains unknown and no direct handoff', async t => {
  for(const options of [{noBell:true},{coldUnavailable:true},{foreignEvent:true},{laneState:'uncertain'},
     {recoveryIntent:true}]){
    const f=fixture(t,options), jobs=f.make()
    const status=await jobs.status(PARENT,BRIDGE)
    assert.equal(status.status,'POSTMAN_BRIDGE_OUTCOME_UNKNOWN',JSON.stringify({options,status}))
    assert.equal(f.calls.followups.length,0)
    assert.equal(f.calls.direct,0)
    assert.equal(f.row().bridgeOperations[BRIDGE].state,'unknown')
    await jobs.dispose()
  }
})


test('concurrent cold status reads recover one authenticated event through Luna once', async t => {
  const f = fixture(t)
  const jobs = f.make()
  const [a, b, c] = await Promise.all([
    jobs.status(PARENT, BRIDGE), jobs.status(PARENT, BRIDGE), jobs.status(PARENT, BRIDGE),
  ])
  for (const item of [a,b,c]) {
    assert.equal(item.status, 'POSTMAN_BRIDGE_TERMINAL')
    assert.equal(item.result?.source, 'bell')
    assert.equal(item.result?.requestId, REQUEST)
  }
  assert.equal(f.calls.followups.length,1)
  assert.equal(f.calls.inspections,1)
  assert.equal(f.calls.direct,0)
  await jobs.dispose()
})

test('after exact Leader prepare recovery sends READY once but never a second Web REQ', async t => {
  const f = fixture(t), jobs = f.make()
  let wakes = 0
  const previous=PARENT.followup
  PARENT.followup = msg => {wakes++;assert.match(JSON.stringify(msg),/POSTMAN_BRIDGE_READY/)}
  t.after(() => {if(previous===undefined) delete PARENT.followup;else PARENT.followup=previous})
  f.contexts.prepare = async () => ({status:'POSTMAN_TASK_CONTEXT_ALREADY_READY',
    worktree:f.binding.workspaceRef})
  const tool = createPostmanTaskPrepareTool(f.ctx, f.contexts, {jobs})
  const first = await tool.execute({}, {agent:PARENT})
  assert.equal(first.status, 'POSTMAN_TASK_CONTEXT_ALREADY_READY')
  assert.equal(first.devspaceReconciliation.recovered.length,1)
  assert.equal(first.devspaceReconciliation.recovered[0].notification,'DELIVERED')
  assert.equal(wakes,1)
  assert.equal(f.calls.followups.length,1)
  assert.equal(f.calls.direct,0)
  assert.equal(f.row().bridgeOperations[BRIDGE].devspace.coldReadyWake,'sent')
  assert.equal((await tool.execute({}, {agent:PARENT})).devspaceReconciliation.recovered.length,0)
  assert.equal(wakes,1)
  await jobs.dispose()
  const second = f.make()
  assert.equal((await second.recoverDevspacePending(PARENT)).recovered.length,0)
  assert.equal(wakes,1)
  await second.dispose()
})


test('uncertain Luna followup after intent does not resurrect or resend cold REQ', async t => {
  const f = fixture(t,{relayFails:true}), jobs=f.make()
  const first = await jobs.status(PARENT,BRIDGE)
  assert.equal(first.status,'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal(f.row().bridgeOperations[BRIDGE].devspace.coldBellRecovery,'intent')
  assert.equal(f.calls.followups.length,1)
  assert.equal((await jobs.status(PARENT,BRIDGE)).status,'POSTMAN_BRIDGE_OUTCOME_UNKNOWN')
  assert.equal(f.calls.followups.length,1)
  assert.equal(f.calls.direct,0)
  await jobs.dispose()
})

test('failed owner READY wake never duplicates it, while the durable bell remains readable', async t => {
  const f=fixture(t), jobs=f.make()
  const previous=PARENT.followup
  let attempted=0
  PARENT.followup=()=>{ attempted++;throw Error('Leader wake failed') }
  t.after(()=>{if(previous===undefined)delete PARENT.followup;else PARENT.followup=previous})
  const reconciled=await jobs.recoverDevspacePending(PARENT)
  assert.equal(reconciled.recovered.length,1)
  assert.equal(reconciled.recovered[0].notification,'UNKNOWN')
  assert.equal(f.row().bridgeOperations[BRIDGE].devspace.coldReadyWake,'unknown')
  assert.equal((await jobs.status(PARENT,BRIDGE)).result.source,'bell')
  await jobs.recoverDevspacePending(PARENT)
  assert.equal(attempted,1)
  assert.equal(f.calls.followups.length,1)
  await jobs.dispose()
})


function reportedText() {
  return { status:'POSTMAN_BRIDGE_TERMINAL',terminalStatus:'COMPLETED',
    transportKind:'devspace',requestId:REQUEST,
    result:{ok:true,code:'DEVSPACE_DIAGNOSTIC',requestId:REQUEST,
      source:'text_fallback',diagnostic:'UNKNOWN',reportedOutcome:'UNKNOWN',
      evidenceState:'REPORTED_NOT_VERIFIED',assistantText:'completed without a bell'} }
}

test('late bell upgrades a previously delivered text fallback in the same REQ exactly once', async t => {
  const f=fixture(t,{noBell:true})
  f.setRow(row=>({...row,bridgeOperations:{
    [BRIDGE]:{...row.bridgeOperations[BRIDGE],state:'received',
      synchronization:'not-required',terminal:reportedText()}
  }}))
  let job=f.make()
  const before=await job.status(PARENT,BRIDGE)
  assert.equal(before.result.source,'text_fallback')
  const event={version:1,...Object.fromEntries(['jobId','requestId','leaderSessionId',
    'lunaSessionId','capability'].map(k=>[k,f.binding[k]])),
    reportedOutcome:'DONE',message:'late bell',reportRef:null}
  writeFileSync(join(f.binding.channel,'event.json'),JSON.stringify(event))
  const after=await job.status(PARENT,BRIDGE)
  assert.equal(after.result.source,'bell')
  assert.equal(after.result.reportedOutcome,'DONE')
  assert.equal(f.calls.followups.length,1)
  assert.equal(f.row().bridgeOperations[BRIDGE].devspace.lateBellRecovery,'intent')
  await job.status(PARENT,BRIDGE)
  assert.equal(f.calls.followups.length,1)
  await job.dispose()
  job=f.make()
  assert.equal((await job.status(PARENT,BRIDGE)).result.source,'bell')
  assert.equal(f.calls.followups.length,1)
  await job.dispose()
})

test('uncertain late-bell Luna followup remains text fallback and never resends', async t => {
  const f=fixture(t,{noBell:false,relayFails:true})
  f.setRow(row=>({...row,bridgeOperations:{
    [BRIDGE]:{...row.bridgeOperations[BRIDGE],state:'received',
      synchronization:'not-required',terminal:reportedText()}
  }}))
  const job=f.make()
  assert.equal((await job.status(PARENT,BRIDGE)).result.source,'text_fallback')
  assert.equal(f.calls.followups.length,1)
  assert.equal(f.row().bridgeOperations[BRIDGE].devspace.lateBellRecovery,'intent')
  assert.equal((await job.status(PARENT,BRIDGE)).result.source,'text_fallback')
  assert.equal(f.calls.followups.length,1)
  assert.equal(f.calls.direct,0)
  await job.dispose()
})
