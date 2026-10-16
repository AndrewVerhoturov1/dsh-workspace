import assert from 'node:assert/strict';
import { createServer as httpServer, request } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const install=process.env.DEVSPACE_INSTALL_ROOT ?? 'C:/Users/Andrew/.dsh/devspace';
const dist=join(install,'node_modules/@waishnav/devspace/dist');
const {createServer}=await import(pathToFileURL(join(dist,'server.js')));
const {loadConfig}=await import(pathToFileURL(join(dist,'config.js')));
const {SingleUserOAuthProvider}=await import(pathToFileURL(join(dist,'oauth-provider.js')));
const root=mkdtempSync(join(tmpdir(),'devspace-disconnect-'));
let app;
const server=httpServer((q,r)=>app(q,r));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const config=loadConfig();
Object.assign(config,{host:'127.0.0.1',port:server.address().port,publicBaseUrl:base,stateDir:join(root,'state'),allowedRoots:[root],skillsEnabled:false,uiEnabled:false,artifactsEnabled:false});
config.oauth={...config.oauth,ownerToken:randomBytes(32).toString('hex'),allowedResourceUrls:[],allowedRedirectHosts:['127.0.0.1']};
config.logging={...config.logging,level:'silent'};config.subagents={...config.subagents,enabled:false};
const native=createServer(config);app=native.app;
const issuer=new SingleUserOAuthProvider(config.oauth,new URL(base+'/mcp'),config.stateDir);
const client=issuer.clientsStore.registerClient({redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none'});
const token=issuer.issueTokens(client.client_id,['devspace'],new URL(base+'/mcp')).access_token;
issuer.close();
process.env.PATH='C:/Program Files/Git/bin;C:/Program Files/nodejs;'+process.env.PATH;
let id=0;
const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:'Bearer '+token,'MCP-Protocol-Version':'2025-03-26'};
async function rpc(method,params){
  const response=await fetch(base+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
  const text=await response.text();assert.equal(response.status,200);
  try{return JSON.parse(text)}catch{return text.split('\n').filter(v=>v.startsWith('data: ')).map(v=>JSON.parse(v.slice(6))).find(v=>v.result)}
}
try{
  await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'disconnect-proof',version:'1'}});
  const workspace=(await rpc('tools/call',{name:'open_workspace',arguments:{path:root,mode:'checkout'}})).result.structuredContent.workspace_id;
  const body=JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name:'bash',arguments:{workspace_id:workspace,command:'node -e "require(\'node:fs\').appendFileSync(\'once.txt\',\'x\');setTimeout(()=>console.log(1),2500)"',timeout:10}}});
  const outgoing=request(base+'/mcp',{method:'POST',headers},res=>res.resume());
  outgoing.on('error',()=>{});outgoing.end(body);
  const until=Date.now()+10000;while(!existsSync(join(root,'once.txt'))&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
  assert(existsSync(join(root,'once.txt')),'command actually started before disconnect');outgoing.destroy();
  await new Promise(r=>setTimeout(r,3500));
  assert.equal(readFileSync(join(root,'once.txt'),'utf8'),'x');
  assert((await rpc('tools/list',{})).result.tools.length>0);
  const report={passed:2,checks:['disconnect after mutation does not automatically replay command','server and OAuth remain usable after disconnected command'],root,productionNetworkChanged:false};
  writeFileSync(join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await new Promise(resolve=>server.close(resolve));await native.close()}
