/** Browser interaction fixture using the *installed* rc.2 React and ReactDOM.
 * All data is synthetic and all actions are logged; no DSH Host calls.
 */
import {dshStaticModules} from '/assets/index.js'

const seeds=dshStaticModules()
const React=seeds.react
const {createRoot}=seeds['react-dom/client']
const registrations=window.__ModuleLoader__.pendingQueue
const bootstrapIndex=registrations.findIndex(row=>row.id==='@deepseek-ai/dsh-client-modules')
if(bootstrapIndex<0)throw Error('rc.2 module system did not register')
const [bootstrap]=registrations.splice(bootstrapIndex,1)
const modules=bootstrap.factory(()=>{throw Error('Unexpected module require')})
const system=modules.createClientModuleSystem(window.__ModuleLoader__,{id:bootstrap.id,exports:modules},{
  boot:{rev:'synthetic',entries:[{id:'dsh-mobile',url:'/mobile-client.js',rev:'synthetic',inject:['slots','sessions','workspaces','connection']}]},
  staticModules:seeds,
  loadBundle:async()=>{throw Error('Bundle already registered')}
})
const mod=await system.import('dsh-mobile')

const calls=window.__fixtureCalls
const record=(action,...args)=>{calls.push({action,args});return calls.length}
function makeStore(value) {
  const listeners=new Set()
  return {
    getSnapshot(){return value},
    subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},
    set(next){value=next;listeners.forEach(listener=>listener())}
  }
}
const rootId='session-test-root',archivedId='session-test-archive',childId='session-test-child',
  grandId='session-test-grand'
const project={workspaceId:'workspace-test',path:'C:\\work\\project',title:'Synthetic project',
  sessionIds:[rootId,archivedId]}
const sessions=makeStore({
  ids:[rootId,archivedId],
  current:undefined,
  byId:{
    [rootId]:{id:rootId,displayTitle:'Project chat',cwd:project.path,updatedAt:1790000000000,
      origin:undefined,agentPreset:'standard',running:false,blank:false},
    [archivedId]:{id:archivedId,displayTitle:'Archived chat',cwd:project.path,updatedAt:1789000000000,
      agentPreset:'standard',running:true,blank:false},
    [childId]:{id:childId,parentId:rootId,origin:'subagent',displayTitle:'One-shot Task',cwd:project.path,running:false,blank:false},
    [grandId]:{id:grandId,parentId:childId,origin:'subagent',displayTitle:'Grandchild',cwd:project.path,running:false,blank:false}
  },
  subagentsByParent:{
    [rootId]:{entries:[{kind:'child',id:childId,mode:'one-shot',activity:'inactive',hasChildren:true,label:'One-shot Task'}],parentAvailable:true},
    [childId]:{entries:[{kind:'child',id:grandId,mode:'continuable',activity:'running',hasChildren:false,label:'Grandchild'}],parentAvailable:true}
  }
})
const workspaces=makeStore({items:[project],archivedSessionIds:[archivedId]})
const hostDescription=makeStore({isLoopback:true})
const llmGroups=[
  {id:'fixture',name:'Fixture provider',models:[
    {id:'alpha',name:'Alpha',reasoning:{efforts:[{id:'low',name:'Низкий'},{id:'high',name:'Высокий'}]}},
    {id:'beta',name:'Beta',reasoning:{efforts:[{id:'low',name:'Низкий'},{id:'high',name:'Высокий'}]}}
  ]}
]
const selections=new Map([[rootId,{provider:'fixture',model:'alpha',reasoningEffort:'low'}]])
const normalState={
  nodes:[
    {kind:'user',seq:1,content:[{type:'text',text:'Первое сообщение'}]},
    {kind:'assistant',seq:2,blocks:[{kind:'text',text:'Ответ из **реальной** React-разметки. http://localhost:7777 недоступен с телефона.'}]}
  ],
  pending:[],queue:[],partial:null,running:false,openState:'open',hasMore:true,loadingOlder:false,
  removed:false,subagent:null
}
const stateById=new Map()
const pressureById=new Map()
function getSession(id) {
  if(!stateById.has(id)){
    stateById.set(id,makeStore(id===rootId?normalState:{
      ...normalState,nodes:[],pending:[],queue:[],running:false,
      hasMore:false,subagent:id===childId?{address:{parentSessionId:rootId,childSessionId:childId,mode:'one-shot'},parentAvailable:true}:
        id===grandId?{address:{parentSessionId:childId,childSessionId:grandId,mode:'continuable'},parentAvailable:true}:null
    }))
    pressureById.set(id,makeStore(id===rootId?{projectedTokens:310,contextWindow:1000}:undefined))
  }
  const state=stateById.get(id)
  return {
    getSnapshot:state.getSnapshot,subscribe:state.subscribe,
    projections:{faceOf:key=>key==='contextPressure'?pressureById.get(id):makeStore(undefined)},
    async prompt(content,mode) {
      record('prompt',id,content,mode)
      const old=state.getSnapshot()
      state.set({...old,nodes:[...old.nodes,{kind:'user',seq:Date.now(),content}],
        running:true,partial:{turn:2,step:1,blocks:[{kind:'text',text:'Потоковое продолжение…'}]}})
      return {ok:true,value:{messageId:'message-accepted'}}
    },
    async cancel(){
      record('cancel',id)
      const old=state.getSnapshot()
      state.set({...old,running:false,partial:null,nodes:[...old.nodes,
        {kind:'assistant',seq:Date.now(),interrupted:true,blocks:[{kind:'text',text:'Остановлено'}]}]})
      return {ok:true,value:{accepted:true}}
    },
    async command(line){
      record('command',id,line)
      return {ok:true,value:{matched:true}}
    },
    async loadOlder(){
      record('loadOlder',id)
      const old=state.getSnapshot()
      state.set({...old,hasMore:false,nodes:[{kind:'user',seq:0,content:[{type:'text',text:'Раннее сообщение'}]},...old.nodes]})
    }
  }
}
const bindings=new Map()
function binding(id) {
  if(!id)return null
  if(!bindings.has(id))bindings.set(id,{session:getSession(id)})
  return bindings.get(id)
}
function updateSessions(fn){sessions.set(fn(sessions.getSnapshot()))}
function openChat(id,address){
  record('open',id,address||null)
  updateSessions(old=>({...old,current:id}))
}
const api={
  agentPresets:{
    async list(){record('presets.list');return {result:{ok:true,value:{presets:[
      {id:'standard',name:'Разработчик',broken:false},{id:'research',name:'Исследователь',broken:false}
    ]}}}}
  },
  llm:{async models(){record('llm.models');return {result:{ok:true,value:{groups:llmGroups,failures:[]}}}}},
  sessions:{
    async create(request) {
      record('create',request)
      const id='session-new-'+Date.now()
      const base=request.cwd||project.path
      updateSessions(old=>({...old,ids:[id,...old.ids],byId:{...old.byId,[id]:{
        id,displayTitle:'Новый разговор',cwd:base,blank:false,updatedAt:Date.now(),
        running:false,agentPreset:request.agentPreset||'standard'
      }}}))
      return {result:{ok:true,value:{sessionId:id,agentPreset:request.agentPreset}}}
    },
    async rename({sessionId,title}) {
      record('rename',sessionId,title)
      updateSessions(old=>({...old,byId:{...old.byId,[sessionId]:{
        ...old.byId[sessionId],displayTitle:title
      }}}))
      return {result:{ok:true,value:{title,seq:2}}}
    },
    async selectModel({sessionId,provider,model,reasoningEffort}){
      record('selectModel',sessionId,provider,model,reasoningEffort||null)
      const selected={provider,model,...(reasoningEffort?{reasoningEffort}:{})}
      selections.set(sessionId,selected)
      return {result:{ok:true,value:{selected}}}
    },
    async models({sessionId}){
      record('session.models',sessionId)
      return {result:{ok:true,value:{
        current:selections.get(sessionId)||{provider:'fixture',model:'alpha',reasoningEffort:'low'},
        routable:true,groups:llmGroups,failures:[]
      }}}
    }
  },
  subagents:{
    async prompt(address){
      record('child.prompt',address)
      return {result:{ok:true,value:{messageId:'child-accepted'}}}
    },
    async interrupt(address){
      record('child.interrupt',address)
      return {result:{ok:true,value:{accepted:true}}}
    }
  }
}
const ctx={
  effect() {},
  slots:{
    inject(name,callback){if(name!=='shell.overlay')throw Error('Unsafe slot '+name);callback()},
    register(info,component){
      record('slot.register',info.name)
      createRoot(document.getElementById('mount')).render(React.createElement(component))
      return()=>{}
    }
  },
  sessions:{
    list:sessions,binding,open:id=>openChat(id),
    openSubagent:address=>openChat(address.childSessionId,address),
    subagentAddress:id=>{
      if(id===childId)return {parentSessionId:rootId,childSessionId:childId,mode:'one-shot'}
      if(id===grandId)return {parentSessionId:childId,childSessionId:grandId,mode:'continuable'}
      return undefined
    },
    setSubagentCatalogOpen(id,open){record('catalog.open',id,open)},
    refreshSubagents:async id=>record('catalog.refresh',id),
    search:async(query)=>{record('search',query);return {ok:true,value:{items:[]}}}
  },
  workspaces:{
    list:workspaces,
    async archiveSession(sessionId){
      record('archiveSession',sessionId)
      const old=workspaces.getSnapshot()
      workspaces.set({...old,archivedSessionIds:[...old.archivedSessionIds,sessionId]})
    }
  },
  connection:{hostDescription,api}
}
const realFetch=window.fetch.bind(window)
window.fetch=async(input,init={})=>{
  const url=String(input)
  if(url.startsWith('/mobile/api/list')){
    const {searchParams}=new URL(url,location.origin)
    const workspaceId=searchParams.get('workspaceId'),path=searchParams.get('path')
    record('project.list',workspaceId,path)
    return Response.json({ok:true,value:{
      workspaceId,root:project.path,path,loading:false,
      entries:path?[]:[{name:'docs',directory:true},{name:'report.md',directory:false},{name:'page.html',directory:false}]
    }})
  }
  if(url.startsWith('/mobile/api/unarchive')){
    const {sessionId}=JSON.parse(init.body)
    record('unarchive',sessionId)
    const old=workspaces.getSnapshot()
    const archivedSessionIds=old.archivedSessionIds.filter(x=>x!==sessionId)
    workspaces.set({...old,archivedSessionIds})
    return Response.json({ok:true,value:{archivedSessionIds}})
  }
  if(url.startsWith('/mobile/project/workspace-test/report.md')){
    record('file.read','report.md')
    return new Response('# Проверенный файл\nСодержимое проекта', {headers:{'content-type':'text/markdown; charset=utf-8'}})
  }
  if(url.startsWith('/api/dsh-restart')){
    record('restart.request',init.method)
    return new Response('{"status":"RESTART_SCHEDULED"}',{status:202,headers:{'content-type':'application/json'}})
  }
  return realFetch(input,init)
}
mod.apply(ctx)
window.__fixture={
  calls,sessions,workspaces,hostDescription,states:stateById,pressure:pressureById,
  forceQuestion(){
    const state=getSession(rootId),current=state.getSnapshot()
    const wait={
      key:'synthetic-question:rpc-77',kind:'question',sessionId:rootId,
      payload:{questions:[{id:'q-one',header:'Формат',question:'Как показать?',options:[{label:'Markdown'},{label:'HTML'}]}]},
      respond:async payload=>{record('question.respond',payload);stateById.get(rootId).set({...stateById.get(rootId).getSnapshot(),pending:[]});return {accepted:true}}
    }
    stateById.get(rootId).set({...current,pending:[wait]})
  },
  triggerReconnect(){
    record('reconnect.disconnected')
    hostDescription.set(undefined)
    queueMicrotask(()=>hostDescription.set({isLoopback:true}))
  },
  triggerStreaming(){
    const state=stateById.get(rootId),snapshot=state.getSnapshot()
    state.set({...snapshot,running:true,partial:{turn:3,step:1,blocks:[{kind:'text',text:'Синтетический поток…'}]}})
  },
  settleStreaming(){
    const state=stateById.get(rootId),snapshot=state.getSnapshot()
    state.set({...snapshot,running:false,partial:null})
  }
}
window.__fixturesReady=true
console.log('DSH_MOBILE_REACT_HARNESS_READY')
