// Isolated OAuth database, project and loopback port. No production credentials are sent.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';


const install=process.env.DEVSPACE_INSTALL_ROOT ?? 'C:/Users/Andrew/.dsh/devspace';
const dist=join(install,'node_modules/@waishnav/devspace/dist');
const {createServer}=await import(pathToFileURL(join(dist,'server.js')));
const {loadConfig}=await import(pathToFileURL(join(dist,'config.js')));
const {createRequire}=await import('node:module');
const Database=createRequire(pathToFileURL(join(dist,'pi-tools.js')))('better-sqlite3');
const root=mkdtempSync(join(tmpdir(),'devspace-native-proof-'));
const project=join(root,'project');mkdirSync(project);
const owner=randomBytes(32).toString('hex');
const checks=[];
const check=(value,name)=>{assert(value,name);checks.push(name);console.log('PASS '+name)};
let native, app, server, base, tokens, client, workspace, longCall;
const start=async(port=0)=>{
  server=httpServer((q,r)=>app(q,r));
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
  const config=loadConfig();
  Object.assign(config,{port:server.address().port,host:'127.0.0.1',publicBaseUrl:base,stateDir:join(root,'state'),allowedRoots:[root],skillsEnabled:false,uiEnabled:false,artifactsEnabled:false});
  config.oauth={...config.oauth,ownerToken:owner,allowedRedirectHosts:['127.0.0.1'],allowedResourceUrls:[]};
  config.logging={...config.logging,level:'silent'};
  config.subagents={...config.subagents,enabled:false};
  native=createServer(config);app=native.app;
};
const stop=async()=>{await new Promise(resolve=>server.close(resolve));await native.close()};
const form=async(path,fields)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),redirect:'manual'});
const rpc=async(method,params={},token=tokens.access_token)=>{
  const response=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+token,'MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:randomBytes(4).toString('hex'),method,params})});
  const text=await response.text();
  if(response.status!==200)return {status:response.status};
  let result;try{result=JSON.parse(text)}catch{result=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(v=>v.result||v.error)}
  assert(result && !result.error,'MCP result');return {status:response.status,...result};
};
const call=async(name,args,scope)=>rpc('tools/call',{name,arguments:args,...(scope?{_meta:{'openai/session':scope}}:{})});
try{
  await start();
  const registered=await fetch(base+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'isolated-reliability-proof',redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(registered.status,201);client=await registered.json();
  const verifier=randomBytes(32).toString('base64url');
  const fields={response_type:'code',client_id:client.client_id,redirect_uri:'http://127.0.0.1/callback',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource:base+'/mcp',scope:'devspace',state:'isolated-test'};
  const rejected=await form('/authorize',{...fields,owner_token:'invalid'});check(rejected.status===401,'OAuth rejects wrong owner password');
  const consent=await form('/authorize',{...fields,owner_token:owner});assert.equal(consent.status,302);
  const code=new URL(consent.headers.get('location')).searchParams.get('code');
  const granted=await form('/token',{grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:fields.redirect_uri,resource:base+'/mcp'});
  assert.equal(granted.status,200);tokens=await granted.json();
  check((await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'isolated-proof',version:'1'}})).status===200,'OAuth PKCE and MCP initialize');
  const same=await Promise.all([call('open_workspace',{path:project,mode:'checkout'},'same-chat'),call('open_workspace',{path:project,mode:'checkout'},'same-chat')]);
  workspace=same[0].result.structuredContent.workspace_id;
  check(workspace===same[1].result.structuredContent.workspace_id,'parallel opens in same chat reuse workspace');
  const other=await call('open_workspace',{path:project,mode:'checkout'},'other-chat');
  check(workspace!==other.result.structuredContent.workspace_id,'independent chats receive separate workspace bindings');
  const writes=await Promise.all([call('write',{workspace_id:workspace,path:'first.txt',content:'first'}),call('write',{workspace_id:other.result.structuredContent.workspace_id,path:'second.txt',content:'second'})]);
  check(writes.every(v=>!v.result.isError)&&readFileSync(join(project,'first.txt'),'utf8')==='first'&&readFileSync(join(project,'second.txt'),'utf8')==='second','parallel independent changes persist correctly');
  process.env.PATH='C:/Program Files/Git/bin;C:/Program Files/nodejs;'+process.env.PATH;
  const started=Date.now();
  longCall=call('bash',{workspace_id:workspace,command:'node -e "setTimeout(()=>console.log(12345),121000)"',timeout:150});
  await new Promise(resolve=>setTimeout(resolve,1200));
  const quick=await call('read',{workspace_id:other.result.structuredContent.workspace_id,path:'second.txt'});
  check(!quick.result.isError&&Date.now()-started<15000,'long Bash call does not block independent read');
  const longResult=await longCall;longCall=null;
  check(!longResult.result.isError&&JSON.stringify(longResult.result.content).includes('12345')&&Date.now()-started>=121000,'121-second MCP command completes');
  const port=server.address().port;await stop();await start(port);
  check((await call('read',{workspace_id:workspace,path:'first.txt'})).status===200,'workspace and access token survive server restart');
  const db=new Database(join(root,'state','devspace.sqlite'));
  db.prepare('update oauth_access_tokens set expires_at = ?').run(Math.floor(Date.now()/1000)-5);db.close();
  check((await rpc('tools/list')).status===401,'expired access token is rejected');
  const refreshed=await form('/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:base+'/mcp'});
  assert.equal(refreshed.status,200);const previous=tokens;tokens=await refreshed.json();
  check((await rpc('tools/list')).status===200,'refresh token works after restart and access expiry');
  check((await form('/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:previous.refresh_token,resource:base+'/mcp'})).status===400,'consumed refresh token cannot be replayed');
  const report={passed:checks.length,checks,root,productionOAuthChanged:false,productionNetworkChanged:false};
  writeFileSync(join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(longCall)await longCall.catch(()=>{});if(server?.listening)await stop()}

