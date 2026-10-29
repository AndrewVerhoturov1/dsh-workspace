import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {apply} from '../src/index.js'

const dshRoot='C:/Users/Andrew/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh'
test('installed rc.2 metadata matches the supported browser bundle format',async()=>{
  const app=JSON.parse(await readFile(dshRoot+'/package.json','utf8'))
  const modules=JSON.parse(await readFile(dshRoot+'/node_modules/@deepseek-ai/dsh-client-modules/package.json','utf8'))
  assert.equal(app.version,'0.1.1-rc.2')
  assert.equal(modules.version,'0.1.1-rc.2')
  const built=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
  assert.match(built,/window\.__ModuleLoader__\.load\(\{id:"dsh-mobile"/)
  assert.match(built,/require\('react'\)/)
  assert(!built.includes('__MOBILE_CSS_PLACEHOLDER__'))
})
test('integration with actual installed rc.2 WebServer match/render implementation (in-process)',async()=>{
  // Load only the installed router's JS implementation; replace Cordis and
  // schemastery *constructor imports* with inert test doubles. No socket binds.
  const js=await readFile(dshRoot+'/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js','utf8')
  const code=js.replace(/^import .*;$/gm,'').replace(
    /export \{ WebServer, WebServer as default, renderIndexInjections \};?/,
    'globalThis.installed={WebServer,renderIndexInjections};'
  )
  const anySchema=new Proxy(()=>anySchema,{get:()=>anySchema})
  const Service=class{constructor(ctx){this.ctx=ctx}}
  Service.init=Symbol('service.init')
  const sandbox={Service,z:anySchema,createServer:()=>{throw Error('Do not start a Host in this test')},
    URL,console,TextEncoder}
  vm.runInNewContext(code,sandbox,{filename:'installed-dsh-host-webserver-rc2.js'})
  const {WebServer,renderIndexInjections}=sandbox.installed
  const webServer=new WebServer({},{host:'127.0.0.1',port:3080})
  const ctx={webRuntime:{trustedHosts:[]},webServer,
    workspaceRegistry:{list:()=>[],archivedSessionIds:[]},
    effect(){}}
  apply(ctx)
  const exact=webServer.match('/mobile')
  assert.equal(exact.kind,'exact')
  assert.equal(webServer.match('/mobile/api/list').kind,'exact')
  assert.equal(webServer.match('/mobile/api/unarchive').kind,'exact')
  assert.equal(webServer.match('/mobile/project/workspace/path.html').kind,'prefix')
  assert.equal(webServer.match('/not-a-mobile-route'),undefined)
  const req={method:'GET',url:'/mobile',headers:{host:'127.0.0.1:3080'}}
  const res={code:0,headers:{},writeHead(code,headers){this.code=code;this.headers=headers},end(){}}
  await exact.handler(req,res)
  assert.equal(res.code,302)
  assert.equal(res.headers.location,'/?mobile=1')
  const html=renderIndexInjections('<html><head></head><body><div id="root"></div></body></html>',[
    {kind:'global',name:'__DSH_BOOT__',value:{entries:[{id:'dsh-mobile',url:'/plugins/dsh-mobile/client.js',rev:'dev'}]}},
    {kind:'script-src',placement:'head',src:'/plugins/dsh-mobile/client.js'}
  ])
  assert(html.includes('__DSH_BOOT__'))
  assert(html.includes('/plugins/dsh-mobile/client.js'))
  assert(html.indexOf('__DSH_BOOT__')<html.indexOf('<body>'))
})


test('installed rc.2 generic agentFor rejects live and cold subagent ownership',async()=>{
  const policySource=await readFile(
    dshRoot+'/node_modules/@deepseek-ai/dsh-api-remotes/lib/types/agent-lookup.js','utf8')
  const runtimeSource=await readFile(
    dshRoot+'/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js','utf8')
  const sandbox={TypertLookupFailure:class TypertLookupFailure extends Error{}}
  vm.runInNewContext(policySource.replace(/^import .*;$/gm,'').replace(/^export /gm,'')+
    '\nglobalThis.policy={createApiRemoteAgentResolver,hasApiRemoteSubagentOwner,apiRemoteSubagentOwnershipError};',
    sandbox,{filename:'installed-rc2-agent-lookup.js'})
  const typert={lookups:{configure(){}},contexts:{configureHost(){}}}
  const live={session:{header:{origin:'subagent'}}}
  const makeContext=agent=>({
    agents:{get:()=>agent,isOwnedBy:()=>true},
    sessions:{get:()=>({header:{origin:'subagent'}})},
    inject(_names,configure){configure({typert})}
  })
  for(const agent of [live,undefined]){
    const ctx=makeContext(agent)
    const agentFor=sandbox.policy.createApiRemoteAgentResolver(ctx,{})
    const result=await agentFor('session-child-1')
    assert.equal(result.error?.code,'agent-busy')
    assert.match(result.error?.message,/subagent routing/)
  }
  assert.match(runtimeSource,/this\.remote\.commands\.execute\(this\.sessionId, line, \[\]\)/)
  assert.match(policySource,/typeCtx\.typert\.lookups\.configure\('agent', resolveAgent\)/)
})

test('installed rc.2 ClientModuleSystem imports the built mobile plugin via its real boot graph',async()=>{
  const loaderScript=await readFile(
    dshRoot+'/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js','utf8')
  const mobileScript=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
  const facade={
    mode:'queue',pendingQueue:[],
    load(registration){this.pendingQueue.push(registration)}
  }
  const sandbox={
    window:{__ModuleLoader__:facade},
    document:{querySelectorAll:()=>[]},
    console,URL
  }
  vm.runInNewContext(loaderScript,sandbox,{filename:'installed-rc2-client-modules.js'})
  const bootstrap=facade.pendingQueue.splice(0)[0]
  assert.equal(bootstrap.id,'@deepseek-ai/dsh-client-modules')
  const modules=bootstrap.factory(spec=>{throw Error('Unexpected bootstrap dependency '+spec)})
  const system=modules.createClientModuleSystem(facade,{
    id:bootstrap.id,exports:modules
  },{
    boot:{rev:'synthetic-rc2',entries:[{
      id:'dsh-mobile',url:'/plugins/dsh-mobile/client.js?rev=test',rev:'test',
      inject:['@deepseek-ai/dsh-client-runtime','@deepseek-ai/dsh-client-connection','@deepseek-ai/dsh-client-ui-layout']
    }]},
    staticModules:{react:{createElement:()=>({})}},
    loadBundle:async url=>{
      assert(url.startsWith('/plugins/dsh-mobile/client.js?rev='))
      vm.runInNewContext(mobileScript,sandbox,{filename:'built-mobile-client.js'})
    }
  })
  const plugin=await system.import('dsh-mobile')
  assert.equal(typeof plugin.apply,'function')
  assert.deepEqual(Array.from(plugin.inject),['slots','sessions','workspaces','connection'])
  assert.equal(system.manifest.plugins[0].id,'dsh-mobile')
  assert.equal(system.manifest.plugins[0].immediately,false)
})

