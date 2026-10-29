/** Host half: only routes whose authority is an existing DSH Workspace.
 * No Host restart, sessions, credentials, new identity, or whole-disk picker.
 */
import { lstat, realpath, readdir, stat, readFile } from 'node:fs/promises'
import { join, relative, sep, extname } from 'node:path'

export const name='dsh-mobile'
export const inject=['webServer','webRuntime','workspaceRegistry']
const MAX_BYTES=2*1024*1024
const MAX_ENTRIES=400
const TYPES=Object.freeze({
  '.md':'text/markdown; charset=utf-8','.markdown':'text/markdown; charset=utf-8',
  '.txt':'text/plain; charset=utf-8','.json':'text/plain; charset=utf-8',
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon',
  '.svg':'image/svg+xml','.pdf':'application/pdf'
})
function reject(message,status=400){return Object.assign(new Error(message),{status})}
function reply(res,status,payload){
  res.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'
  })
  res.end(JSON.stringify(payload))
}
function failed(res,error){
  const status=Number.isInteger(error?.status)?error.status:500
  reply(res,status,{ok:false,error:status>=500?'Ошибка операции':String(error.message)})
}

export function trustedRequest(req,trustedHosts=[]){
  const host=req.headers?.host
  if(typeof host!=='string')return false
  let authority
  try{authority=new URL('http://'+host)}catch{return false}
  const hostname=authority.hostname.toLowerCase()
  const local=hostname==='localhost'||hostname==='[::1]'||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  const allowed=(trustedHosts||[]).some(entry=>{
    if(typeof entry!=='string')return false
    try {
      const url=new URL('http://'+entry)
      // Follow the installed rc.2 host fence: port-less authorities
      // accept the same hostname on any port; otherwise exact host+port.
      return url.port?url.host===authority.host:url.hostname===authority.hostname
    }catch{return false}
  })
  if(!local&&!allowed)return false
  if(req.headers['sec-fetch-site']==='cross-site')return false
  if(req.headers.origin!==undefined){
    try{if(new URL(req.headers.origin).host!==authority.host)return false}
    catch{return false}
  }
  return true
}
const SENSITIVE=/^(?:node_modules|attachments|secrets?|credentials?|backups?|diagnostics?|runtime|\.git|\.dsh|\.ssh|\.config|\.agents|\.agent-presets|\.npm|\.pnpm|\.vscode|\.idea)$/i
const SECRET_FILE=/^(?:settings\.ya?ml|\.env(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx|kdbx|sqlite|db|log|bak))$/i
/** URL virtual paths are always forward-slash-delimited, never Host paths. */
export function segments(path){
  if(typeof path!=='string'||path.length>2048)throw reject('Неверный путь')
  if(path==='')return []
  const result=path.split('/')
  for(const name of result){
    if(!name||name==='.'||name==='..'||name.startsWith('.')||
      /[\\:\x00-\x1f]/.test(name))throw reject('Недопустимый путь',403)
    if(SENSITIVE.test(name)||SECRET_FILE.test(name))throw reject('Служебный файл недоступен',403)
  }
  return result
}
function isInside(root,target){
  const rel=relative(root,target)
  return rel===''||(rel!=='..'&&!rel.startsWith('..'+sep)&&!rel.startsWith(sep))
}
/** Resolve using registry id, lstat every traversed component and canonicalize.
 * A client-supplied root is NEVER accepted. */
export async function projectPath(registry,workspaceId,path=''){
  if(typeof workspaceId!=='string'||!workspaceId)throw reject('Не выбран проект')
  const w=registry.list().find(row=>String(row.id)===workspaceId)
  if(!w)throw reject('Незарегистрированный проект',403)
  const root=await realpath(w.path)
  let target=root
  for(const name of segments(path)){
    target=join(target,name)
    if((await lstat(target)).isSymbolicLink())throw reject('Ссылки на каталоги запрещены',403)
  }
  const canonical=await realpath(target)
  if(!isInside(root,canonical))throw reject('Путь выходит из проекта',403)
  return {root,target:canonical,workspace:w}
}
export async function listProject(registry,workspaceId,path=''){
  const {target,workspace}=await projectPath(registry,workspaceId,path)
  if(!(await stat(target)).isDirectory())throw reject('Это не папка')
  const rows=[]
  for(const entry of await readdir(target,{withFileTypes:true})){
    try{segments(entry.name)}catch{continue}
    if(!entry.isDirectory()&&!entry.isFile())continue
    if(entry.isFile()&&!TYPES[extname(entry.name).toLowerCase()])continue
    rows.push({name:entry.name,directory:entry.isDirectory()})
  }
  rows.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name))
  return {
    workspaceId:String(workspace.id),root:workspace.path,path,
    entries:rows.slice(0,MAX_ENTRIES),truncated:rows.length>MAX_ENTRIES
  }
}
export async function openProjectFile(registry,workspaceId,path,res){
  const {target}=await projectPath(registry,workspaceId,path)
  const type=TYPES[extname(target).toLowerCase()]
  if(!type)throw reject('Формат файла недоступен',415)
  const metadata=await stat(target)
  if(!metadata.isFile()||metadata.size>MAX_BYTES)throw reject('Файл слишком большой или не найден',413)
  // CSP sandbox excludes allow-same-origin: even a direct URL to an HTML
  // file does not inherit DSH's authority or API privileges.
  const html=/\.html?$/i.test(target)
  const svg=/\.svg$/i.test(target)
  const policy=html
    ? "sandbox allow-scripts; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"
    : svg?"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'":"default-src 'none'; img-src data:"
  const body=await readFile(target)
  res.writeHead(200,{
    'content-type':type,
    'content-security-policy':policy,
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer',
    'cache-control':'no-store'
  })
  res.end(body)
}
async function jsonBody(req){
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))throw reject('Ожидался JSON',415)
  let text='',size=0
  for await(const chunk of req){
    size+=chunk.length
    if(size>8192)throw reject('Слишком большой запрос',413)
    text+=chunk.toString('utf8')
  }
  try{return JSON.parse(text)}catch{throw reject('Неверный JSON')}
}
/** The installed rc.2 WorkspaceRegistry has archiveSession but no reverse
 * public method. Use exactly its durable serialized domain mutation path:
 * enqueueOperation + requireState + setState; never touch settings on disk.
 * setState emits the existing domain/changed event for all regular clients. */
export async function restoreArchived(registry,sessionId){
  if(typeof sessionId!=='string'||!/^[a-z0-9_-]{8,128}$/i.test(sessionId))
    throw reject('Неверный идентификатор')
  if(!['enqueueOperation','requireState','setState'].every(n=>typeof registry[n]==='function'))
    throw reject('Установленная DSH не поддерживает восстановление архива',503)
  return registry.enqueueOperation(async()=>{
    const state=registry.requireState()
    if(!state.archivedSessionIds.includes(sessionId))throw reject('Сессия не найдена в архиве',404)
    const archivedSessionIds=state.archivedSessionIds.filter(id=>id!==sessionId)
    await registry.setState({...state,archivedSessionIds})
    return archivedSessionIds
  })
}
export function apply(ctx){
  const gate=req=>trustedRequest(req,ctx.webRuntime.trustedHosts)
  const routes=[
    ctx.webServer.register({kind:'exact',path:'/mobile',handler:(req,res)=>{
      if(!gate(req))return reply(res,403,{ok:false,error:'Запрос отклонён'})
      if(req.method!=='GET')return reply(res,405,{ok:false,error:'Метод не поддерживается'})
      res.writeHead(302,{'location':'/?mobile=1','cache-control':'no-store'})
      res.end()
    }}),
    ctx.webServer.register({kind:'exact',path:'/mobile/api/list',handler:async(req,res)=>{
      if(!gate(req))return reply(res,403,{ok:false,error:'Запрос отклонён'})
      if(req.method!=='GET')return reply(res,405,{ok:false,error:'Метод не поддерживается'})
      try {
        const url=new URL(req.url||'/','http://host')
        const data=await listProject(ctx.workspaceRegistry,url.searchParams.get('workspaceId'),url.searchParams.get('path')||'')
        return reply(res,200,{ok:true,value:data})
      }catch(e){return failed(res,e)}
    }}),
    ctx.webServer.register({kind:'prefix',path:'/mobile/project',handler:async(req,res)=>{
      if(!gate(req))return reply(res,403,{ok:false,error:'Запрос отклонён'})
      if(req.method!=='GET')return reply(res,405,{ok:false,error:'Метод не поддерживается'})
      try {
        const url=new URL(req.url||'/','http://host')
        const base='/mobile/project/'
        if(!url.pathname.startsWith(base))return reply(res,404,{ok:false,error:'Не найдено'})
        const raw=url.pathname.slice(base.length)
        const parts=raw.split('/')
        if(parts.length<2)throw reject('Неверный файл')
        const decoded=parts.map(x=>{try{return decodeURIComponent(x)}catch{throw reject('Неверный адрес')}})
        if(decoded.some(x=>x.includes('/')||x.includes('\\')))throw reject('Неверный путь',403)
        return await openProjectFile(ctx.workspaceRegistry,decoded[0],decoded.slice(1).join('/'),res)
      }catch(e){return failed(res,e)}
    }}),
    ctx.webServer.register({kind:'exact',path:'/mobile/api/unarchive',handler:async(req,res)=>{
      if(!gate(req))return reply(res,403,{ok:false,error:'Запрос отклонён'})
      if(req.method!=='POST')return reply(res,405,{ok:false,error:'Метод не поддерживается'})
      try {
        const body=await jsonBody(req)
        return reply(res,200,{ok:true,value:{
          archivedSessionIds:await restoreArchived(ctx.workspaceRegistry,body?.sessionId)
        }})
      }catch(e){return failed(res,e)}
    }})
  ]
  ctx.effect(()=>()=>{for(const dispose of routes.reverse())dispose()},'dsh-mobile: routes')
}
