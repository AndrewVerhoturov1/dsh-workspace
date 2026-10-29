import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'

function obs(value){return {getSnapshot:()=>value,subscribe:()=>()=>{}}}
function fakeHooks(){
  const state=[],refs=[]
  let cursor=0,refCursor=0
  const React={
    Fragment:'fragment',
    createElement:(type,props,...children)=>({type,props:props||{},children}),
    useState(initial){
      const i=cursor++
      if(!Object.prototype.hasOwnProperty.call(state,i))state[i]=typeof initial==='function'?initial():initial
      return [state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value}]
    },
    useEffect(){},
    useMemo:fn=>fn(),
    useCallback:fn=>fn,
    useRef(value){
      const i=refCursor++
      return refs[i]??(refs[i]={current:value})
    },
    useSyncExternalStore:(_subscribe,getSnapshot)=>getSnapshot()
  }
  return {React,reset(){cursor=0;refCursor=0},clear(){state.length=0;refs.length=0;cursor=0;refCursor=0}}
}
function collect(node,out=[]){
  if(node===null||node===undefined||typeof node==='boolean')return out
  if(Array.isArray(node)){for(const item of node)collect(item,out);return out}
  if(typeof node==='object'&&Object.hasOwn(node,'type')){
    if(typeof node.type==='function')return collect(node.type(node.props),out)
    out.push(node)
    collect(node.children,out)
  }else if(typeof node==='string'||typeof node==='number')out.push(node)
  return out
}
async function browser(search){
  const script=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
  const registrations=[]
  const {React,reset,clear}=fakeHooks()
  const document={
    querySelector:()=>null,
    createElement:tag=>({tag,setAttribute(){},remove(){}}),
    head:{appendChild(){}}
  }
  const environment={
    window:{__ModuleLoader__:{load:registration=>registrations.push(registration)}},
    document,location:{search},
    URLSearchParams,URL,Date,Intl,console,Set,Map,AbortController,
    setTimeout,clearTimeout,crypto:{getRandomValues(bytes){bytes.fill(42);return bytes}}
  }
  vm.runInNewContext(script,environment,{filename:'installed-rc2-client-bundle.js'})
  assert.equal(registrations.length,1)
  assert.equal(registrations[0].id,'dsh-mobile')
  const client=registrations[0].factory(id=>{
    assert.equal(id,'react')
    return React
  })
  return {client,reset,clear}
}
function syntheticCtx(){
  const list={
    ids:['session-12345','fork-12345'],
    current:'session-12345',
    byId:{
      'session-12345':{id:'session-12345',displayTitle:'Synthetic',cwd:'C:\\work\\project',updatedAt:1790000000000,running:false,blank:false},
      'fork-12345':{id:'fork-12345',parentId:'session-12345',displayTitle:'Forked session',cwd:'C:\\work\\project',updatedAt:1790000001000,running:false,blank:false},
      'child-12345':{id:'child-12345',origin:'subagent',parentId:'session-12345',displayTitle:'Task child',running:false,blank:false},
      'grand-12345':{id:'grand-12345',origin:'subagent',parentId:'child-12345',displayTitle:'Task grandchild',running:false,blank:false}
    },
    subagentsByParent:{
      'session-12345':{entries:[{kind:'child',id:'child-12345',hasChildren:true,mode:'one-shot',activity:'inactive'}]},
      'child-12345':{entries:[{kind:'child',id:'grand-12345',hasChildren:false,mode:'continuable',activity:'running'}]}
    }
  }
  const workspaces={items:[{workspaceId:'workspace-123',path:'C:\\work\\project',title:'Project'}],archivedSessionIds:[]}
  const progress={projectedTokens:230,contextWindow:1000}
  const session={
    getSnapshot:()=>({
      nodes:[
        {kind:'user',seq:1,content:[{type:'text',text:'Привет'}]},
        {kind:'assistant',seq:2,blocks:[{kind:'text',text:'**Ответ** агента'}]}
      ],chat:null,queue:[],pending:[],openState:'open',partial:null,removed:false,running:false
    }),
    subscribe:()=>()=>{},
    projections:{faceOf:()=>obs(progress)},
    prompt:async()=>({ok:true,value:{accepted:true}}),
    loadOlder:async()=>{},
    command:async()=>({ok:true,value:{matched:true}})
  }
  const activity=[]
  const ctx={
    effect(){},
    slots:{inject(name,callback){activity.push(['slot',name]);callback()},
      register(options,component){ctx.slot={options,component};return()=>{}}},
    sessions:{
      list:obs(list),binding:()=>({session}),open:id=>activity.push(['open',id]),
      openSubagent:address=>activity.push(['open-subagent',address]),
      subagentAddress:()=>undefined,
      setSubagentCatalogOpen(){},refreshSubagents:async()=>{},search:async()=>({ok:true,value:{items:[]}})
    },
    workspaces:{list:obs(workspaces),archiveSession:async()=>{}},
    connection:{hostDescription:obs(null),api:{
      agentPresets:{list:async()=>({result:{ok:true,value:{presets:[]}}})},
      llm:{models:async()=>({result:{ok:true,value:{groups:[]}}})},
      sessions:{models:async()=>({result:{ok:true,value:{groups:[],current:{model:'m',provider:'p'}}}})}
    }}
  }
  return {ctx,activity}
}
test('desktop mode registers zero UI slots',async()=>{
  const {client}=await browser('')
  let called=false
  client.apply({slots:{inject:()=>{called=true}}})
  assert.equal(called,false)
})
test('mobile mode composes over the installed shell.overlay and uses actual snapshot data',async()=>{
  const {client,reset}=await browser('?mobile=1')
  const {ctx,activity}=syntheticCtx()
  client.apply(ctx)
  assert.deepEqual(activity,[['slot','shell.overlay']])
  assert.equal(ctx.slot.options.id,'dsh-mobile')
  reset()
  let elements=collect(ctx.slot.component())
  assert(elements.some(x=>x.type==='h1'&&x.children.includes('Чаты')))
  assert(elements.some(x=>x.type==='strong'&&x.children.includes('Synthetic')))
  assert(elements.some(x=>x.type==='strong'&&x.children.includes('Forked session')))
  assert(elements.some(x=>x.props?.className==='m-chat-excerpt'&&x.children.some(v=>String(v).includes('Ответ'))))
  assert(!elements.includes('Нажмите, чтобы вернуть'))
  assert(!elements.includes('Открыть переписку'))
  const chat=elements.find(x=>x.type==='button'&&x.props.className==='m-chat-row')
  assert(chat,'real session item from sessions.list')
  chat.props.onClick()
  reset()
  elements=collect(ctx.slot.component())
  assert(activity.some(x=>x[0]==='open'&&x[1]==='session-12345'))
  assert(elements.some(x=>x.type==='div'&&x.props.className==='m-messages'))
  assert(elements.some(x=>x.type==='span'&&x.props.className==='m-usage'&&x.children.includes('23%')))
  assert(elements.includes('Привет'))
  assert(elements.some(x=>x.type==='strong'&&x.children.includes('Ответ')))
})
test('Task includes grandchildren and opens one-shot child through direct parent',async()=>{
  const {client,reset}=await browser('?mobile=1')
  const {ctx,activity}=syntheticCtx()
  client.apply(ctx)
  reset()
  let elements=collect(ctx.slot.component())
  const taskButton=elements.find(x=>x.type==='button'&&x.props['aria-label']==='Task')
  taskButton.props.onClick()
  reset()
  elements=collect(ctx.slot.component())
  assert(elements.includes('Task grandchild'))
  const child=elements.find(x=>x.type==='button'&&x.props.className==='m-tree-main'&&collect(x).includes('Task child'))
  assert(child)
  child.props.onClick()
  reset()
  elements=collect(ctx.slot.component())
  assert(activity.some(x=>x[0]==='open-subagent'&&x[1].childSessionId==='child-12345'&&x[1].parentSessionId==='session-12345'))
  assert(elements.some(x=>x.type==='div'&&x.props.className==='m-readonly'))
  assert(!elements.some(x=>x.type==='form'&&x.props.className==='m-composer'))
})
test('create retries with the same id after an uncertain result, then opens a listed session',async()=>{
  const {client,reset}=await browser('?mobile=1')
  const {ctx,activity}=syntheticCtx()
  const list=ctx.sessions.list.getSnapshot()
  const attempts=[]
  let failOnce=true
  ctx.sessions.create=async request=>{
    attempts.push(request)
    if(failOnce){failOnce=false;throw Error('uncertain transport result')}
    const id=request.sessionId
    list.byId[id]={id,displayTitle:'Created session',blank:true,updatedAt:1790000002000,running:false}
    list.ids.unshift(id)
    return id
  }
  ctx.connection.api.sessions.create=()=>{throw Error('raw API must not create')}
  client.apply(ctx)
  const draw=()=>{reset();return collect(ctx.slot.component())}
  let elements=draw()
  elements.find(x=>x.type==='button'&&x.props.title==='Создать чат').props.onClick()
  elements=draw()
  const select=(id,value)=>elements.find(x=>x.type==='select'&&x.props.id===id).props.onChange({target:{value}})
  select('mobile-workspace','workspace-123')
  select('mobile-preset','standard')
  elements=draw()
  const create=()=>elements.find(x=>x.type==='button'&&x.props.className==='m-btn m-primary m-full').props.onClick()
  create()
  for(let i=0;i<8;i++)await Promise.resolve()
  elements=draw()
  assert.equal(attempts.length,1)
  assert.equal(attempts[0].workspaceId,'workspace-123')
  assert(elements.includes('uncertain transport result'))
  assert.equal(elements.find(x=>x.type==='button'&&x.props.className==='m-btn m-primary m-full').props.disabled,false)
  // No new name/id is allocated: a retry is an idempotent request.
  elements.find(x=>x.type==='button'&&x.props.className==='m-btn m-primary m-full').props.onClick()
  for(let i=0;i<8;i++)await Promise.resolve()
  elements=draw()
  assert.equal(attempts.length,2)
  assert.equal(attempts[1].sessionId,attempts[0].sessionId)
  assert(activity.some(x=>x[0]==='open'&&x[1]===attempts[0].sessionId))
  assert(elements.some(x=>x.type==='div'&&x.props.className==='m-messages'))
})
test('pending question batch uses retained wait.respond envelope',async()=>{
  const {client,reset,clear}=await browser('?mobile=1')
  clear()
  let result,done=false
  const wait={
    sessionId:'session-12345',key:'q:stable-request-id',
    payload:{questions:[{id:'a',question:'Выбрать?',options:[{label:'Да'},{label:'Нет'}]}]},
    respond:async value=>{result=value;return {accepted:true}}
  }
  reset()
  let elements=collect(client.testing.QuestionForm({wait,onDone:()=>{done=true},onError:()=>{}}))
  const option=elements.find(x=>x.type==='input'&&x.props.type==='radio')
  assert(option)
  option.props.onChange()
  reset()
  elements=collect(client.testing.QuestionForm({wait,onDone:()=>{done=true},onError:()=>{}}))
  const send=elements.find(x=>x.type==='button'&&x.children.includes('Ответить'))
  await send.props.onClick()
  assert.equal(result.ok,true)
  assert.equal(result.value.sessionId,'session-12345')
  assert.deepEqual(JSON.parse(JSON.stringify(result.value.answer.answers)),[{id:'a',selected:['Да']}])
  assert(done)
})
test('preset labels retain every canonical id and display Russian or English text',async()=>{
  const {client}=await browser('?mobile=1')
  const label=client.testing.presetLabel
  assert.equal(label({id:'standard',name:'标准模式'},0),'Стандартный')
  assert.equal(label({id:'code',name:'PTC 模式'},1),'PTC')
  assert.equal(label({id:'minimal',name:'极简模式'},2),'Минимальный')
  assert.equal(label({id:'cordis',name:'创造模式'},3),'Творческий')
  assert.equal(label({id:'research',name:'Research'},4),'Research')
  assert.equal(label({id:'custom',name:'Мой агент'},5),'Мой агент')
  assert.equal(label({id:'my-special',name:'非中文模式'},6),'my-special')
  assert.equal(label({id:'不支持',name:'非中文模式'},7),'Пресет 8')
})
test('pure client helpers keep projection semantics and safe URL policy',async()=>{
  const {client}=await browser('?mobile=1')
  assert.equal(client.testing.pressurePercent({projectedTokens:120,pressureTokens:40,contextWindow:200}),'60%')
  assert.equal(client.testing.pressurePercent({pressureTokens:40,contextWindow:200}),'20%')
  assert.equal(client.testing.pressurePercent({contextWindow:200}),'—')
  assert.equal(client.testing.urlIfReachable('http://localhost:3000/'),null)
  assert.equal(client.testing.urlIfReachable('javascript:alert(1)'),null)
  assert.equal(client.testing.urlIfReachable('http://192.168.1.20:3000/'),'http://192.168.1.20:3000/')
  const rich=collect(client.testing.Markdown({text:'<script>alert(1)</script> [click](javascript:alert(1))'}))
  assert(!rich.some(x=>x?.props?.dangerouslySetInnerHTML))
  assert(rich.some(x=>x.type==='span'&&x.props.title==='Адрес недоступен на Android'))
})
