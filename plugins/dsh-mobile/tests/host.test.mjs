import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {
  segments,trustedRequest,projectPath,listProject,restoreArchived,
  openProjectFile,apply
} from '../src/index.js'
const testRoot=fileURLToPath(new URL('./',import.meta.url))
function request(host,overrides={}) {return {headers:{host,...overrides}}}
function registryAt(path){
  return {list:()=>[{id:'workspace-123',path,title:'Synthetic'}]}
}
function capture(){
  return {
    status:null,headers:{},body:undefined,
    writeHead(status,headers){this.status=status;this.headers=headers||{}},
    end(body){this.body=body}
  }
}
test('reject traversal, Windows drives, hidden and sensitive files',()=>{
  for(const bad of [
    '../x','docs/../x','docs//x','/x','C:/windows','docs\\x','.env',
    'settings.yaml','docs/.git/config','node_modules/file.md',
    'attachments/secret.md','private/key.pem','docs/secret.db','id_rsa'
  ])assert.throws(()=>segments(bad),bad)
  assert.deepEqual(segments('docs/report.md'),['docs','report.md'])
})
test('mirror installed rc.2 Host/Origin fence without claiming identity authentication',()=>{
  assert(trustedRequest(request('localhost:4173')))
  assert(trustedRequest(request('127.0.0.1:4173')))
  assert(trustedRequest(request('192.168.1.9:4173'),['192.168.1.9']))
  assert(!trustedRequest(request('evil.invalid:4173'),['192.168.1.9']))
  assert(!trustedRequest(request('localhost:4173',{'sec-fetch-site':'cross-site'})))
  assert(!trustedRequest(request('localhost:4173',{origin:'https://evil.invalid'})))
  assert(trustedRequest(request('localhost:4173',{origin:'http://localhost:4173'})))
})
test('folder picker visits only registered canonical project descendants',async t=>{
  const dir=await mkdtemp(join(testRoot,'synthetic-'))
  const project=join(dir,'registered')
  try{
    await mkdir(join(project,'docs'),{recursive:true})
    await writeFile(join(project,'docs','guide.md'),'# Guide')
    await writeFile(join(project,'.env'),'secret')
    await writeFile(join(project,'settings.yaml'),'secret')
    await writeFile(join(dir,'outside.md'),'outside')
    const roots=registryAt(project)
    const list=await listProject(roots,'workspace-123','')
    assert.deepEqual(list.entries.map(x=>x.name),['docs'])
    assert.equal((await projectPath(roots,'workspace-123','docs/guide.md')).target,resolve(project,'docs','guide.md'))
    await assert.rejects(projectPath(roots,'workspace-evil','docs/guide.md'),/Незарегистрированный/)
    await assert.rejects(projectPath(roots,'workspace-123','../outside.md'))
    await assert.rejects(projectPath(roots,'workspace-123','.env'))
    try{
      await symlink(join(dir,'outside.md'),join(project,'docs','escaped.md'))
      await assert.rejects(projectPath(roots,'workspace-123','docs/escaped.md'),/Ссылки/)
    }catch(error){
      if(error.code==='EPERM'||error.code==='EACCES')
        t.diagnostic('Windows did not permit creating synthetic symlink')
      else throw error
    }
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('HTML preview is origin-sandboxed on both iframe and direct response URL',async()=>{
  const dir=await mkdtemp(join(testRoot,'synthetic-'))
  try{
    const project=join(dir,'workspace')
    await mkdir(project)
    await writeFile(join(project,'page.html'),'<script>alert(1)</script>')
    const res=capture()
    await openProjectFile(registryAt(project),'workspace-123','page.html',res)
    assert.equal(res.status,200)
    assert.match(res.headers['content-security-policy'],/sandbox allow-scripts/)
    assert.doesNotMatch(res.headers['content-security-policy'],/allow-same-origin/)
    assert.match(res.headers['content-security-policy'],/connect-src 'none'/)
    assert.match(res.headers['content-type'],/text\/html/)
  }finally{await rm(dir,{recursive:true,force:true})}
})
test('archive restoration is serialized, durable and never cancels an agent',async()=>{
  let changed=0
  let mutationTail=Promise.resolve()
  const registry={
    state:{initialized:true,workspaceIds:['w'],archivedSessionIds:['session-12345','session-67890']},
    runningSession:true,
    get archivedSessionIds(){return this.state.archivedSessionIds},
    requireState(){return this.state},
    async setState(value){this.state=value;changed++},
    enqueueOperation(op){const pending=mutationTail.then(op);mutationTail=pending.catch(()=>{});return pending}
  }
  assert.deepEqual(await restoreArchived(registry,'session-12345'),['session-67890'])
  assert.deepEqual(registry.state.workspaceIds,['w'])
  assert.equal(registry.runningSession,true)
  assert.equal(changed,1)
  await assert.rejects(restoreArchived(registry,'session-12345'),/не найдена/)
  await assert.rejects(restoreArchived(registry,'../../escape'),/Неверный идентификатор/)
})
test('exact /mobile redirect and guarded project/unarchive actions',async()=>{
  const records=new Map()
  const registry={
    state:{archivedSessionIds:['session-12345'],workspaceIds:[]},
    list(){return []},requireState(){return this.state},
    get archivedSessionIds(){return this.state.archivedSessionIds},
    async setState(state){this.state=state},
    enqueueOperation:async fn=>fn()
  }
  const ctx={
    webRuntime:{trustedHosts:[]},workspaceRegistry:registry,
    webServer:{register(route){records.set(route.path,route);return()=>records.delete(route.path)}},
    effect() {}
  }
  apply(ctx)
  async function invoke(url,method='GET',headers={},body=''){
    const path=new URL(url,'http://localhost').pathname
    const route=records.get(path)||records.get('/mobile/project')
    assert(route,'Missing route '+path)
    const req={url,method,headers:{host:'localhost:4173',...headers},
      async *[Symbol.asyncIterator](){if(body)yield Buffer.from(body)}}
    const res=capture()
    await route.handler(req,res)
    return res
  }
  assert.equal((await invoke('/mobile')).headers.location,'/?mobile=1')
  assert.equal((await invoke('/mobile','POST')).status,405)
  assert.equal((await invoke('/mobile/api/list?workspaceId=unknown')).status,403)
  assert.equal((await invoke('/mobile/api/list?workspaceId=unknown','GET',{origin:'https://evil.invalid'})).status,403)
  assert.equal((await invoke('/mobile/api/unarchive','POST',{'content-type':'application/json'},'not json')).status,400)
  assert.equal((await invoke('/mobile/api/unarchive','POST',{'content-type':'application/json'},JSON.stringify({sessionId:'../secret'}))).status,400)
  const restored=await invoke('/mobile/api/unarchive','POST',{'content-type':'application/json'},JSON.stringify({sessionId:'session-12345'}))
  assert.equal(restored.status,200)
  assert.deepEqual(JSON.parse(restored.body).value.archivedSessionIds,[])
})
