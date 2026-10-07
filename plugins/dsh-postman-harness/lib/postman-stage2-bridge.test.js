import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilityRuntime, native } from './fixtures/postman-capability-runtime.js'
import { createDirectCurrentTurnToolConfigs } from './direct-current-turn.js'
import { postmanInputGrants } from './postman-input-files.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const call = async (f, name, args = {}) => {
  const r = await f.execute(f.leader, 'ptc_execute', { program: 'return await tools.' + name + '(' + JSON.stringify(args) + ')', boundary: 'semantic_decision', description: 'Verify registered exact Bridge lifecycle' })
  assert.equal(r.isError, false, JSON.stringify(r)); assert.equal(r.value.status, 'ok', JSON.stringify(r.value)); return r.value.value
}

test('production Bridge A READY re-waits on active B with no dispatch/poll/FYI round; terminal Host path wakes exactly once', { timeout: 60000 }, async t => {
  const dir=await mkdtemp(join(tmpdir(),'stage2-existing-bridge-'))
  const gates=[Promise.withResolvers(),Promise.withResolvers()],entered=[Promise.withResolvers(),Promise.withResolvers()]
  const endings=[Promise.withResolvers(),Promise.withResolvers(),Promise.withResolvers()],children=[],accepted=[],ready=[]
  let f
  t.after(async()=>{gates.forEach(g=>g.resolve());await f?.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5})})
  const ptc=program=>({name:'ptc_execute',args:{program,description:'Handle terminal then wait for exact remaining Bridge event',boundary:'external_event'}})
  f=await capabilityRuntime(dir,{preset:'postman-leader',plan:async(a,r,n)=>{
    if(a.id==='leader'){
      assert.ok(!r.tools.some(t=>t.name==='postman_yield'));assert.doesNotMatch(r.system,/postman_yield|POSTMAN_YIELDED/)
      if(n===1)return ptc('const a=await tools.postman_bridge({message:"@PostmanAsk A"});const b=await tools.postman_bridge({message:"@PostmanAsk B"});return {a,b}')
      if(n===2)return ptc('await tools.read({file_path:'+JSON.stringify(join(f.worktree,'known.txt'))+'});return {handled:"A"}')
      assert.equal(n,3,'only dispatch + A READY + B READY model requests');return {text:'Both Host terminal events handled'}
    }
    if(!children.includes(a.id))children.push(a.id)
    const i=children.indexOf(a.id)
    try {
      assert.deepEqual(r.tools.map(t=>t.name).sort(),['skill','postman_send_current_turn','postman_current_turn_status','postman_ask_validate_reply'].sort())
      assert.doesNotMatch(r.system,/notify_parent/);assert.match(r.system,/Host delivers terminal POSTMAN_BRIDGE_READY/)
    } catch(error) { entered[i].reject(error);throw error }
    entered[i].resolve(a);await gates[i].promise
    return {text:'UNTRUSTED Bridge prose '+i}
  }})
  const {defineTool}=await native('dsh-tools')
  const direct=createDirectCurrentTurnToolConfigs(f.ctx,{taskContexts:f.contexts})
  for(const tool of direct.tools)f.ctx.tools.register(defineTool(tool))
  t.after(()=>direct.dispose())
  const get=f.ctx.tools.get.bind(f.ctx.tools)
  // Stub only the trusted Direct receipt, not Host job state/event/child surface.
  f.ctx.tools.get=(name,agent)=>name==='postman_current_turn_status'&&children.includes(agent?.id)?{execute:async()=>{
    const requestId='REQ_'+children.indexOf(agent.id)
    return {status:'FAILED',requestId,result:{ok:false,code:'POSTMAN_TRANSPORT_FAILED',requestId,
      publicationStarted:false,transportMessage:'controlled terminal transport failure',details:{}}}
  }}:get(name,agent)
  const followup=f.leader.followup.bind(f.leader)
  f.leader.followup=message=>{if(message.content?.[0]?.text?.startsWith('POSTMAN_BRIDGE_READY'))ready.push(message);return followup(message)}
  f.ctx.on('tools/result',(exec,result)=>{if(exec.parent&&exec.name==='postman_bridge')accepted.push(result.value)})
  f.ctx.on('session/event',(s,e)=>{if(s.id==='leader'&&e.type==='turn/end')endings[e.data.turn-1]?.resolve()})
  await f.prepare();await writeFile(join(f.worktree,'known.txt'),'known deterministic processing')
  await f.turn(f.leader,'Approved bounded two Bridge job regression')
  assert.equal(accepted.length,2);await Promise.all(entered.map(g=>g.promise))
  assert.equal(f.requests.filter(r=>r.agent.id==='leader').length,1,'Bridge progress never wakes Leader')
  gates[0].resolve();await endings[1].promise;await f.leader.whenIdle()
  assert.equal(ready.length,1);assert.equal(f.ctx.agents.get(children[1]).status,'running')
  const outer=f.results.filter(r=>r.agent.id==='leader'&&r.name==='ptc_execute')
  assert.equal(outer.length,2);assert.ok(outer.every(r=>r.result.concludesTurn===true))
  assert.deepEqual(outer[1].result.value.effects.calls.map(c=>c.name),['read'],'no status/list polling or new dispatch')
  gates[1].resolve();await endings[2].promise;await f.leader.whenIdle()
  assert.equal(f.requests.filter(r=>r.agent.id==='leader').length,3,'no yield-only model round')
  assert.equal(ready.length,2);assert.equal(new Set(ready.map(m=>m.id)).size,2)
  assert.deepEqual(f.leader.session.events.filter(e=>e.type==='turn/start').map(e=>e.data.turn),[1,2,3])
  for(const a of accepted)assert.equal(ready.filter(m=>m.content[0].text.includes(a.bridgeJobId)).length,1)
  assert.equal(f.leader.inbox.hasPending,false)
})

test('production inherited PTC Bridge stop retains input pin through actual cleanup and persists cancellation in JsonStorage', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'stage2-bridge-'))
  const f = await capabilityRuntime(dir, { plan: () => null })
  const end = Promise.withResolvers(), cleanup = Promise.withResolvers(), disposing = Promise.withResolvers()
  let child, signal, disposed = 0
  t.after(async () => { end.resolve({ stopReason: 'aborted' }); cleanup.resolve(); await f.dispose(); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  await f.turn(f.leader, 'Load required instruction context before bounded local verification')
  const modelRounds = f.requests.length
  await f.prepare()
  const empty = await call(f, 'postman_team_status')
  assert.equal(empty.bridge.used, 0); assert.deepEqual(empty.bridge.operations, [])
  const root = join(dir, 'private-input'); await mkdir(root)
  const bytes = 'selected-private-bytes', sha256 = createHash('sha256').update(bytes).digest('hex')
  const descriptor = { name: 'reference.txt', repository: 'AndrewVerhoturov1/dsh-workspace', commit: 'a'.repeat(40), path: 'tmp/reference.txt', sha256, byte_length: Buffer.byteLength(bytes), raw_url: 'https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/' + 'a'.repeat(40) + '/tmp/reference.txt' }
  await writeFile(join(root, '001.bin'), bytes)
  const context = f.contexts.get(f.leader.id)
  postmanInputGrants.record(f.leader, context, { snapshotRoot: root, descriptors: [descriptor], materializations: [{ snapshot_path: join(root, '001.bin'), sha256, byte_length: descriptor.byte_length }] })
  // Only the existing spawn seam is controlled; production tool definitions,
  // inherited preset, QuickJS dispatch, jobs, registry and pins are untouched.
  f.ctx.subagents.start = async (_provider, request) => {
    signal = request.signal
    const handle = await f.ctx.agents.create({ sessionId: 'bridge-controlled-' + randomUUID(), agentOptions: { provider: 'codex', model: 'gpt-6-luna' }, meta: { cwd: dir, origin: 'subagent', delegationDepth: 1 } })
    child = handle.agent
    signal.addEventListener('abort', () => end.resolve({ stopReason: 'aborted' }), { once: true })
    return { id: child.id, localAgent: child, result: end.promise, async dispose() { disposed++; disposing.resolve(); await cleanup.promise; await handle.dispose() } }
  }
  const direct = await f.execute(f.leader, 'postman_bridge', { message: '@PostmanAsk forbidden direct' })
  assert.equal(direct.isError, true); assert.match(direct.error.message, /POSTMAN_PTC_DIRECT_CALL_REJECTED/)
  const accepted = await call(f, 'postman_bridge', { message: '@PostmanAsk --input-files-json ' + JSON.stringify([descriptor]) + '\nRead selected file' })
  assert.equal(accepted.status, 'POSTMAN_BRIDGE_ACCEPTED', JSON.stringify(accepted))
  await tick()
  assert.ok(postmanInputGrants.child(child, context, [descriptor]))
  postmanInputGrants.release(f.leader)
  assert.equal(existsSync(root), true, 'opaque Bridge pin owns bytes after Leader grant release')
  const stopped = await call(f, 'postman_bridge_stop', { bridge_job_id: accepted.bridgeJobId })
  assert.equal(stopped.status, 'POSTMAN_BRIDGE_STOP_REQUESTED', JSON.stringify(stopped)); assert.equal(stopped.intentPersisted, true)
  assert.equal(signal.aborted, true)
  await disposing.promise
  assert.equal(disposed, 1); assert.equal(existsSync(root), true)
  assert.ok(postmanInputGrants.child(child, context, [descriptor]), 'pin remains while child cleanup pending')
  assert.equal(f.registry.get('leader').bridgeOperations[accepted.bridgeJobId].cancellationRequested, true)
  const files = async path => { const rows = await readdir(path, { withFileTypes: true }); return (await Promise.all(rows.map(r => r.isDirectory() ? files(join(path, r.name)) : join(path, r.name)))).flat() }
  const disk = (await Promise.all((await files(join(dir, 'tasks'))).map(p => readFile(p, 'utf8')))).join('\n')
  assert.match(disk, /"cancellationRequested"\s*:\s*true/, 'actual JsonStorage bytes retain cancellation intent')
  const maintenance = Promise.withResolvers(), maintenanceEntered = Promise.withResolvers()
  const paused = f.leader.runMaintenance(async () => { maintenanceEntered.resolve(); await maintenance.promise })
  await maintenanceEntered.promise
  cleanup.resolve(); await tick(); await tick()
  assert.equal(existsSync(root), false); assert.equal(postmanInputGrants.child(child, context, [descriptor]), null)
  assert.equal(disposed, 1)
  const status = await call(f, 'postman_bridge_status', { bridge_job_id: accepted.bridgeJobId })
  assert.equal(status.status, 'POSTMAN_BRIDGE_OUTCOME_UNKNOWN', JSON.stringify(status))
  assert.equal(f.requests.length, modelRounds, 'no mechanical or remote model round after initial instruction catalog')
  const closing = f.dispose(); maintenance.resolve(); await paused; await closing
  assert.equal(disposed, 1); assert.equal(existsSync(root), false)
})
