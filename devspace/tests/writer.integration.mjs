// Real patched MCP handlers, OAuth, Bash, and Windows Job Objects; isolated files/port.
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,cpSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const install=process.env.DEVSPACE_INSTALL_ROOT??'C:/Users/Andrew/.dsh/devspace';
const root=mkdtempSync(join(tmpdir(),'devspace-native-writer-mcp-'));
const pkg=join(root,'node_modules/@waishnav/devspace'); mkdirSync(pkg,{recursive:true});
const upstream=join(install,'node_modules/@waishnav/devspace');
cpSync(join(upstream,'dist'),join(pkg,'dist'),{recursive:true}); copyFileSync(join(upstream,'package.json'),join(pkg,'package.json'));
copyFileSync(join(upstream,'dist/pi-tools.js.dsh-original'),join(pkg,'dist/pi-tools.js'));
symlinkSync(join(install,'node_modules'),join(pkg,'node_modules'),'junction');
for(const name of ['writer-runtime.mjs','writer-process.ps1']) copyFileSync(fileURLToPath(new URL('../'+name,import.meta.url)),join(root,name));
const patcher=fileURLToPath(new URL('../prepare-runtime.mjs',import.meta.url));
assert.equal(spawnSync(process.execPath,[patcher,root],{encoding:'utf8'}).status,0);
const runtimeModule=await import(pathToFileURL(join(root,'writer-runtime.mjs')));
const {createServer}=await import(pathToFileURL(join(pkg,'dist/server.js')));
const {loadConfig}=await import(pathToFileURL(join(pkg,'dist/config.js')));
const channelRoot=join(root,'channels'),project=join(root,'project'); mkdirSync(project); mkdirSync(channelRoot);
const id=randomUUID(), channel=join(channelRoot,id); mkdirSync(channel);
const binding={version:1,writerRuntimeVersion:1,jobId:id,requestId:'REQ_20261017T123456Z_1234',leaderSessionId:'leader',lunaSessionId:'luna',
  channel,capability:randomBytes(32).toString('hex'),writeRoot:project,workspaceRef:project,branch:'task/postman-'+'a'.repeat(32)};
writeFileSync(join(channel,'binding.json'),JSON.stringify(binding));
const writers=runtimeModule.dshWriters.configure({root:channelRoot});
const owner=randomBytes(32).toString('hex');
const server=httpServer((q,r)=>native.app(q,r)); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port, config=loadConfig();
Object.assign(config,{port:server.address().port,host:'127.0.0.1',publicBaseUrl:base,stateDir:join(root,'state'),allowedRoots:[root],
  skillsEnabled:false,uiEnabled:false,artifactsEnabled:false});
config.oauth={...config.oauth,ownerToken:owner,allowedRedirectHosts:['127.0.0.1'],allowedResourceUrls:[]};
config.logging={...config.logging,level:'silent'};config.subagents={...config.subagents,enabled:false};
const native=createServer(config);
let count=0;
let call,workspace_id;
const check=(value,name)=>{assert(value,name);count++;console.log('PASS '+name)};
try {
  const registration=await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'isolated-writer-proof',
    redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(registration.status,201); const client=await registration.json(), verifier=randomBytes(32).toString('base64url');
  const form=async(path,args)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(args),redirect:'manual'});
  const fields={response_type:'code',client_id:client.client_id,redirect_uri:'http://127.0.0.1/callback',code_challenge:createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method:'S256',resource:base+'/mcp',scope:'devspace',state:'isolated-writer'};
  const consent=await form('/authorize',{...fields,owner_token:owner}); assert.equal(consent.status,302);
  const code=new URL(consent.headers.get('location')).searchParams.get('code');
  const granted=await form('/token',{grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:fields.redirect_uri,resource:base+'/mcp'});
  assert.equal(granted.status,200);const token=(await granted.json()).access_token;
  call=async(name,args,scope='owned-chat')=>{
    const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,'MCP-Protocol-Version':'2025-03-26'},
      body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args,_meta:{'openai/session':scope}}})});
    const text=await response.text();assert.equal(response.status,200,text);
    let result;try{result=JSON.parse(text)}catch{result=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(value=>value.result||value.error)}
    assert(!result.error,JSON.stringify(result));return result.result;
  };
  const opened=await call('open_workspace',{path:'postman-writer:'+id});
  check(!opened.isError && opened.structuredContent.root===project,'Host alias binds actual MCP metadata to the exact native root');
  workspace_id=opened.structuredContent.workspace_id;
  const write=await call('write',{workspace_id,path:'kept.txt',content:'preserved'});
  check(!write.isError&&readFileSync(join(project,'kept.txt'),'utf8')==='preserved','instrumented native MCP write settles');
  process.env.PATH='C:/Program Files/Git/bin;C:/Program Files/nodejs;'+process.env.PATH;
  const bash=await call('bash',{workspace_id,command:'node -e "console.log(424242)"',timeout:15});
  check(!bash.isError && JSON.stringify(bash).includes('424242'),'patched real Bash operations retain output and native Job Object settlement');
  writeFileSync(join(channel,'revoked.json'),JSON.stringify(binding));
  const after=await call('write',{workspace_id,path:'kept.txt',content:'corruption'});
  check(after.isError&&readFileSync(join(project,'kept.txt'),'utf8')==='preserved','revoked actual MCP handler cannot mutate preserved files');
  const shifted=await call('write',{workspace_id,path:'kept.txt',content:'corruption'},'shifted-chat');
  check(shifted.isError,'shifted metadata cannot bypass a retained root');
  const proof=writers.reconcile(binding);
  check(proof.ok&&proof.proof.source==='devspace_native_tree','actual production handler observations produce a settlement proof');
  const independent=await call('write',{workspace_id,path:'new.txt',content:'independent'},'new-chat');
  check(!independent.isError&&readFileSync(join(project,'new.txt'),'utf8')==='independent','released root accepts a new independent native MCP write');
  console.log('PASS '+count+' isolated native writer integration checks; production unchanged');
} finally {
  if(call&&workspace_id){
    const jobs=await call('bash',{workspace_id,execution:'status'});
    for(const job of jobs.structuredContent?.jobs??[])if(!job.treeSettled)await call('bash',{workspace_id,execution:'stop',job_id:job.native_job_id});
  }
  await new Promise(resolve=>server.close(resolve)); await native.close();
  rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
