// Real OAuth/MCP surface in a disposable package; never changes the installation.
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,cpSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
export async function createBackgroundFixture({patched=true}={}) {
  const install=process.env.DEVSPACE_INSTALL_ROOT??'C:/Users/Andrew/.dsh/devspace';
  const root=mkdtempSync(join(tmpdir(),'devspace-background-'));
  const pkg=join(root,'node_modules/@waishnav/devspace'),upstream=join(install,'node_modules/@waishnav/devspace');
  mkdirSync(pkg,{recursive:true});cpSync(join(upstream,'dist'),join(pkg,'dist'),{recursive:true});
  copyFileSync(join(upstream,'package.json'),join(pkg,'package.json'));
  for(const name of ['pi-tools.js','server.js']) {
    const original=join(upstream,'dist',name+'.dsh-original');
    if(existsSync(original))copyFileSync(original,join(pkg,'dist',name));
  }
  symlinkSync(join(install,'node_modules'),join(pkg,'node_modules'),'junction');
  let runtimeModule,writers;
  if(patched) {
    for(const name of ['writer-runtime.mjs','writer-process.ps1'])copyFileSync(fileURLToPath(new URL('../'+name,import.meta.url)),join(root,name));
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../prepare-runtime.mjs',import.meta.url)),root],{encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
    runtimeModule=await import(pathToFileURL(join(root,'writer-runtime.mjs')));
  }
  const channelRoot=join(root,'channels'),project=join(root,'project');mkdirSync(project);mkdirSync(channelRoot);
  const id=randomUUID(),channel=join(channelRoot,id);mkdirSync(channel);
  const binding={version:1,writerRuntimeVersion:1,jobId:id,requestId:'REQ_20261017T123456Z_1234',leaderSessionId:'leader',lunaSessionId:'luna',
    channel,capability:randomBytes(32).toString('hex'),writeRoot:project,workspaceRef:project,branch:'task/postman-'+'a'.repeat(32)};
  writeFileSync(join(channel,'binding.json'),JSON.stringify(binding));
  if(patched)writers=runtimeModule.dshWriters.configure({root:channelRoot});
  const {createServer}=await import(pathToFileURL(join(pkg,'dist/server.js')));
  const {loadConfig}=await import(pathToFileURL(join(pkg,'dist/config.js')));
  const owner=randomBytes(32).toString('hex');let native;
  const server=httpServer((q,r)=>native.app(q,r));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,config=loadConfig();
  Object.assign(config,{port:server.address().port,host:'127.0.0.1',publicBaseUrl:base,stateDir:join(root,'state'),allowedRoots:[root],skillsEnabled:false,uiEnabled:false,artifactsEnabled:false});
  config.oauth={...config.oauth,ownerToken:owner,allowedRedirectHosts:['127.0.0.1'],allowedResourceUrls:[]};
  config.logging={...config.logging,level:'silent'};config.subagents={...config.subagents,enabled:false};
  native=createServer(config);
  const registration=await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'isolated-background-proof',
    redirect_uris:['http://127.0.0.1/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']})});
  assert.equal(registration.status,201);const client=await registration.json(),verifier=randomBytes(32).toString('base64url');
  const form=(path,args)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(args),redirect:'manual'});
  const fields={response_type:'code',client_id:client.client_id,redirect_uri:'http://127.0.0.1/callback',code_challenge:createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method:'S256',resource:base+'/mcp',scope:'devspace',state:'isolated-background'};
  const consent=await form('/authorize',{...fields,owner_token:owner});assert.equal(consent.status,302);
  const code=new URL(consent.headers.get('location')).searchParams.get('code');
  const granted=await form('/token',{grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:fields.redirect_uri,resource:base+'/mcp'});
  assert.equal(granted.status,200);const token=(await granted.json()).access_token;
  const rpc=async(method,params)=>{
    const response=await fetch(base+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,'MCP-Protocol-Version':'2025-03-26'},
      body:JSON.stringify({jsonrpc:'2.0',id:randomUUID(),method,params})});
    const text=await response.text();assert.equal(response.status,200,text);
    let result;try{result=JSON.parse(text)}catch{result=text.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(value=>value.result||value.error)}
    assert(!result.error,JSON.stringify(result));return result.result;
  };
  let ownedWorkspace;
  const call=async(name,args,scope='owned-chat')=>{
    const result=await rpc('tools/call',{name,arguments:args,_meta:{'openai/session':scope}});
    if(name==='open_workspace'&&args.path==='postman-writer:'+id&&!result.isError)ownedWorkspace={id:result.structuredContent.workspace_id,scope};
    return result;
  };
  const tools=()=>rpc('tools/list',{});
  const children=[];
  writeFileSync(join(project,'server.cjs'),`const http=require('node:http'),fs=require('node:fs');const [ready,token]=process.argv.slice(2);const server=http.createServer((q,r)=>{if(q.url==='/health'){r.end(token)}else if(q.url==='/shutdown?token='+token){r.end('stopped');server.close(()=>process.exit(0))}else{r.writeHead(404);r.end()}});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(ready,JSON.stringify({pid:process.pid,port:server.address().port,token})));setTimeout(()=>server.close(()=>process.exit(0)),90000).unref();`);
  writeFileSync(join(project,'launch.cjs'),`const {spawn}=require('node:child_process');const path=require('node:path');const child=spawn(process.execPath,[path.join(__dirname,'server.cjs'),...process.argv.slice(2)],{cwd:process.cwd(),env:process.env,detached:true,stdio:'ignore',windowsHide:true});child.unref();console.log('PARENT_FINISHED');`);
  const application=()=>{
    const ready=join(project,'ready-'+randomUUID()+'.json'),secret=randomBytes(16).toString('hex');children.push({ready,secret});
    return {command:quote(process.execPath.replaceAll('\\','/'))+' '+quote(join(project,'launch.cjs').replaceAll('\\','/'))+' '+quote(ready.replaceAll('\\','/'))+' '+quote(secret),
      async health(){try{const data=JSON.parse(readFileSync(ready,'utf8'));const res=await fetch('http://127.0.0.1:'+data.port+'/health',{signal:AbortSignal.timeout(500)});return res.ok&&await res.text()===secret}catch{return false}},
      async wait(){for(let i=0;i<40;i++){if(await this.health())return true;await pause(100)}return false}};
  };
  const close=async()=>{
    if(ownedWorkspace){
      const jobs=await call('bash',{workspace_id:ownedWorkspace.id,execution:'status'},ownedWorkspace.scope);
      for(const job of jobs.structuredContent?.jobs??[])if(!job.treeSettled)await call('bash',{workspace_id:ownedWorkspace.id,execution:'stop',job_id:job.native_job_id},ownedWorkspace.scope);
    }
    for(const {ready,secret}of children){if(!existsSync(ready))continue;const data=JSON.parse(readFileSync(ready,'utf8'));
      try{await fetch('http://127.0.0.1:'+data.port+'/shutdown?token='+secret,{signal:AbortSignal.timeout(1000)})}catch{}
    }
    // A native helper may still be publishing the final census after HTTP exit.
    if(children.length)await pause(500);
    await new Promise(resolve=>server.close(resolve));await native.close();
    const actual=resolve(root);assert(actual.startsWith(resolve(tmpdir())+sep)&&actual.includes('devspace-background-'));
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  };
  process.env.PATH='C:/Program Files/Git/bin;C:/Program Files/nodejs;'+process.env.PATH;
  return {root,project,channel,binding,writers,runtimeModule,call,tools,application,close};
}
