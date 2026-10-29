import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {restoreArchived} from '../src/index.js'

const installed='C:/Users/Andrew/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
function classFrom(source,start,end,environment,exportName) {
  const begin=source.indexOf(start),finish=source.indexOf(end,begin)
  assert(begin>=0&&finish>begin,'Installed rc.2 source no longer matches '+exportName)
  const sandbox={...environment}
  vm.runInNewContext(source.slice(begin,finish)+
    '\nglobalThis.__extracted='+exportName+';\n',sandbox,{filename:'installed-rc2-'+exportName+'.js'})
  return sandbox.__extracted
}
test('installed rc.2 WorkspaceRegistry -> Host domain callback -> WorkspaceManager archive snapshot',async()=>{
  const [workspacesSource,hostSource,runtimeSource]=await Promise.all([
    readFile(installed+'dsh-workspace/lib/index.js','utf8'),
    readFile(installed+'dsh-host-apiproxy/lib/index.js','utf8'),
    readFile(installed+'dsh-client-runtime/lib/client.js','utf8')
  ])
  class Service {
    constructor(ctx){this.ctx=ctx}
  }
  Service.init=Symbol('init')
  const Registry=classFrom(workspacesSource,
    'var WorkspaceRegistry = class extends Service {','const sameSessionIds',
    {Service},'WorkspaceRegistry')
  class Notifier {
    constructor(onDirty){this.onDirty=onDirty;this.listeners=new Set()}
    markDirty(){this.onDirty();for(const fn of this.listeners)fn()}
    ensureFresh(){}
    subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  }
  const Manager=classFrom(runtimeSource,
    'var WorkspaceManager = class {','function upsertWorkspace(',
    {Notifier},'WorkspaceManager')
  const manager=new Manager({})
  const startArchive=['session-12345','session-67890']
  manager.installArchived(startArchive)
  const registry=new Registry({})
  registry.state={
    initialized:true,workspaceIds:[],archivedSessionIds:[...startArchive],
    pendingMutation:undefined
  }
  // The actual registry's serialize+setState implementations run unchanged.
  // Only persistent storage's global.set (no disk) and its recovery probe
  // (no persisted mutation in this synthetic state) are replaced.
  registry.recoverPendingMutation=async()=>{}
  const frames=[],changed=[]
  const queue={push(message){
    frames.push(message)
    manager.handleHostEnvelope({payload:message})
  }}
  let domainListener
  const hostCtx={
    workspaceRegistry:registry,
    on(name,handler){
      assert.equal(name,'domain/changed')
      domainListener=handler
      return ()=>{domainListener=undefined}
    }
  }
  const eventStart='ctx.on("domain/changed", (change) => {'
  const eventEnd='...API_REMOTE_FORWARDED_EVENTS'
  const s=hostSource.indexOf(eventStart)
  const e=hostSource.indexOf(eventEnd,s)
  assert(s>=0&&e>s,'Installed Host domain callback changed')
  vm.runInNewContext('const registrations=['+hostSource.slice(s,e)+'];',{
    ctx:hostCtx,queue,frame:value=>value,
    committedWorkspaceIds:new Set(),committedWorkspaceOrder:[],
    archivedSessionIds:[...startArchive],
    workspaceDomainState:{parse:value=>value}
  },{filename:'installed-rc2-host-domain-callback.js'})
  assert.equal(typeof domainListener,'function')
  registry.global={async set(state){
    changed.push(state)
    domainListener({domain:'workspace',table:'',operation:'put',value:state})
  }}
  const snapshots=[]
  const off=manager.subscribe(()=>snapshots.push([...manager.getSnapshot().archivedSessionIds]))
  const result=await restoreArchived(registry,'session-12345')
  off()
  assert.deepEqual(Array.from(result),['session-67890'])
  assert.equal(changed.length,1,'One durable workspace domain change')
  assert.equal(frames.length,1,'One real rc.2 Host archived-sessions frame')
  assert.equal(frames[0].type,'host/archived-sessions-changed')
  assert.deepEqual(Array.from(frames[0].archivedSessionIds),['session-67890'])
  assert.deepEqual(Array.from(manager.getSnapshot().archivedSessionIds),['session-67890'])
  assert.deepEqual(snapshots,[['session-67890']])
  assert.deepEqual(registry.state.workspaceIds,[])
})
