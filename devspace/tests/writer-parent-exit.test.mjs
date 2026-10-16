import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createDevspaceChannel} from '../../plugins/dsh-postman-harness/lib/postman-devspace.js';
import {createWriterRuntime,startWriterControl} from '../writer-runtime.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const health=async url=>{try{return (await fetch(url,{signal:AbortSignal.timeout(500)})).status===200;}catch{return false;}};
const until=async predicate=>{const end=Date.now()+15000;while(!await predicate()){if(Date.now()>end)throw Error('Native background condition timed out');await delay(50);}};

test('actual Node controller exit preserves a noisy native app and cold exact named stop without inventing writer proof',{timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'postman-native-parent-exit-'));
  const worktree=join(root,'worktree'),disjoint=join(root,'disjoint'),channelRoot=join(root,'channels');await mkdir(worktree);await mkdir(disjoint);await mkdir(channelRoot);
  const bridgeJobId=randomUUID(),branch='task/postman-'+randomUUID().replaceAll('-','');
  const binding=createDevspaceChannel({root:channelRoot,bridgeJobId,leaderSessionId:'leader',lunaSessionId:'luna',
    requestId:'REQ_20261017T123456Z_2345',worktree,branch,mode:'WRITE_ISOLATED',sourceRoot:root});
  const scope='native-parent-exit-scope',meta={_meta:{'openai/session':scope}},workspaces={getWorkspace:async id=>({root:id==='other'?disjoint:worktree})};
  const controllerFile=join(root,'writer-control.json'),portFile=join(worktree,'port.txt'),kept=join(worktree,'preserved.txt');
  await writeFile(kept,'user data must remain unchanged');
  const app=`const http=require('http'),fs=require('fs');const server=http.createServer((q,r)=>r.end('alive'));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},String(server.address().port)));setInterval(()=>{console.log('stdout after controller exit');console.error('stderr after controller exit')},20);`;
  const module=new URL('../writer-runtime.mjs',import.meta.url).href;
  const script=join(root,'controller.mjs');
  await writeFile(script,`import {createWriterRuntime,startWriterControl} from ${JSON.stringify(module)};
const runtime=createWriterRuntime({root:${JSON.stringify(channelRoot)}});
const control=await startWriterControl(runtime,{file:${JSON.stringify(controllerFile)}});
const meta=${JSON.stringify(meta)},workspaces={getWorkspace:async()=>({root:${JSON.stringify(worktree)}})};
await runtime.runTool('open_workspace',{path:${JSON.stringify('postman-writer:'+bridgeJobId)}},meta,workspaces,async()=>({ok:true}),true);
const input={workspace_id:'native',execution:'background',command:${JSON.stringify(app)},timeout:2};
const started=await runtime.runTool('bash',input,meta,workspaces,()=>runtime.background(input,{cwd:${JSON.stringify(worktree)},env:process.env},()=>({shell:process.execPath,args:['-e'],commandTransport:'argv'})));
process.stdout.write(JSON.stringify(started)+'\\n');
await control.close();
// No process.exit: referenced child pipes would make this controller hang.
`);
  const child=spawn(process.execPath,[script],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='',errors='';child.stdout.on('data',d=>{output+=d});child.stderr.on('data',d=>{errors+=d});
  const ended=new Promise(resolve=>child.once('close',resolve));
  let fresh,control,nativeId;
  t.after(async()=>{
    if(nativeId)try{fresh??=createWriterRuntime({root:channelRoot});await fresh.runTool('bash',{workspace_id:'native',execution:'stop',job_id:nativeId},meta,workspaces,
      ()=>fresh.background({execution:'stop',job_id:nativeId},{cwd:worktree}));}catch{}
    if(control)await control.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const exit=await Promise.race([ended,delay(8000).then(()=>{throw Error('Node controller retained referenced native pipes')})]);
  assert.equal(exit,0,errors);
  const started=JSON.parse(output.trim());assert.equal(started.isError,undefined,JSON.stringify(started));
  nativeId=started.structuredContent.native_job_id;assert.match(nativeId,/^[a-f0-9-]{36}$/);
  let url;
  await until(async()=>{try{url='http://127.0.0.1:'+Number(await readFile(portFile,'utf8'));return await health(url);}catch{return false;}});
  await delay(2200);assert.equal(await health(url),true,'timeout/Node EOF must not kill an app that keeps writing output');
  fresh=createWriterRuntime({root:channelRoot});control=await startWriterControl(fresh,{file:controllerFile});
  const coldClaim=await fresh.runTool('open_workspace',{path:'postman-writer:'+bridgeJobId},meta,workspaces,async()=>({bad:true}),true);
  assert.equal(coldClaim.isError,true);
  assert.equal(fresh.reconcile(binding).ok,false,'lost generation census is not recreated as active zero');
  let mutated=false;
  const foreign={_meta:{'openai/session':'independent-cold-scope'}};
  const blocked=await fresh.runTool('write',{workspace_id:'native'},foreign,workspaces,async()=>{mutated=true;});
  assert.equal(blocked.isError,true);assert.equal(mutated,false,'cold hold must prevent an overlapping unbound writer');
  const read=await fresh.runTool('read',{workspace_id:'native'},foreign,workspaces,async()=>({allowed:true}),true);
  assert.equal(read.allowed,true);
  const independent=await fresh.runTool('write',{workspace_id:'other'},foreign,workspaces,async()=>({allowed:true}));
  assert.equal(independent.allowed,true);
  const nextId=randomUUID(),nextMeta={_meta:{'openai/session':'new-bound-scope'}};
  createDevspaceChannel({root:channelRoot,bridgeJobId:nextId,leaderSessionId:'leader',lunaSessionId:'luna2',
    requestId:'REQ_20261017T123457Z_2346',worktree,branch,mode:'WRITE_ISOLATED',sourceRoot:root});
  await fresh.runTool('open_workspace',{path:'postman-writer:'+nextId},nextMeta,workspaces,async()=>({ok:true}),true);
  const boundBlocked=await fresh.runTool('write',{workspace_id:'native'},nextMeta,workspaces,async()=>{mutated=true;});
  assert.equal(boundBlocked.isError,true);assert.equal(mutated,false,'a new valid generation cannot overlap the retained old hold');
  const discovery=await fresh.runTool('bash',{workspace_id:'native',execution:'status'},meta,workspaces,
    ()=>fresh.background({execution:'status'},{cwd:worktree}));
  assert(discovery.structuredContent.jobs.some(job=>job.native_job_id===nativeId));
  const inspected=await fresh.runTool('bash',{workspace_id:'native',execution:'status',job_id:nativeId},meta,workspaces,
    ()=>fresh.background({execution:'status',job_id:nativeId},{cwd:worktree}));
  assert.equal(inspected.structuredContent.state,'BACKGROUND_RUNNING',JSON.stringify(inspected));
  const stopped=await fresh.runTool('bash',{workspace_id:'native',execution:'stop',job_id:nativeId},meta,workspaces,
    ()=>fresh.background({execution:'stop',job_id:nativeId},{cwd:worktree}));
  assert.equal(stopped.structuredContent.treeSettled,true,JSON.stringify(stopped));
  await until(async()=>!await health(url));
  assert.equal(fresh.reconcile(binding).ok,false,'addressed stop does not reconstruct the lost global writer census');
  assert.equal(await readFile(kept,'utf8'),'user data must remain unchanged');
});

test('ordinary upstream background retains only its overlapping unknown root across controller restart; bound argv receives stdin EOF',{timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'postman-unbound-census-'));
  const worktree=join(root,'old'),disjoint=join(root,'new'),channelRoot=join(root,'channels');
  await mkdir(worktree);await mkdir(disjoint);await mkdir(channelRoot);
  const file=join(root,'writer-control.json'),portFile=join(worktree,'port.txt');
  const app=join(worktree,'app.cjs'),launcher=join(worktree,'launch.cjs');
  await writeFile(app,`const http=require('http'),fs=require('fs');const server=http.createServer((q,r)=>{r.end('alive');if(q.url==='/stop')server.close()});server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(portFile)},String(server.address().port)));`);
  await writeFile(launcher,`require('child_process').spawn(process.execPath,[${JSON.stringify(app)}],{detached:true,stdio:'ignore',windowsHide:true}).unref();`);
  const install=process.env.DEVSPACE_INSTALL_ROOT??'C:/Users/Andrew/.dsh/devspace';
  const {createBashTool}=await import(pathToFileURL(join(install,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
  const previousPath=process.env.PATH;process.env.PATH='C:/Program Files/Git/bin;'+previousPath;
  let control,url;
  t.after(async()=>{
    process.env.PATH=previousPath;
    if(url)try{await fetch(url+'/stop',{signal:AbortSignal.timeout(1000)});}catch{}
    if(control)await control.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  const old=createWriterRuntime({root:channelRoot});control=await startWriterControl(old,{file});
  const workspaces={getWorkspace:async()=>({root:worktree})},meta={_meta:{'openai/session':'ordinary-external'}};
  const command=`"${process.execPath.replaceAll('\\','/')}" "${launcher.replaceAll('\\','/')}"`;
  const result=await old.runTool('bash',{workspace_id:'old',command,timeout:4},meta,workspaces,()=>{
    assert.equal(old.bashOperations(()=>{}),undefined,'ordinary Bash must receive real upstream default operations');
    return createBashTool(worktree).execute(randomUUID(),{command,timeout:4});
  });
  assert.equal(result.isError,undefined);
  await until(async()=>{try{url='http://127.0.0.1:'+Number(await readFile(portFile,'utf8'));return await health(url);}catch{return false;}});
  await control.close();control=null;
  const saved=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(saved.untrackedRoots,[worktree]);assert.equal(saved.port,undefined);
  const fresh=createWriterRuntime({root:channelRoot});control=await startWriterControl(fresh,{file});
  const makeBinding=target=>createDevspaceChannel({root:channelRoot,bridgeJobId:randomUUID(),leaderSessionId:'leader',lunaSessionId:randomUUID(),
    requestId:'REQ_20261017T123458Z_2347',worktree:target,branch:'task/postman-'+randomUUID().replaceAll('-',''),mode:'WRITE_ISOLATED',sourceRoot:root});
  const bind=async(owned,scope)=>fresh.runTool('open_workspace',{path:'postman-writer:'+owned.jobId},{_meta:{'openai/session':scope}},
    {getWorkspace:async()=>({root:owned.writeRoot})},async()=>({ok:true}),true);
  const overlapping=makeBinding(worktree);assert.equal((await bind(overlapping,'overlap')).ok,true);
  await writeFile(join(overlapping.channel,'revoked.json'),JSON.stringify(overlapping));
  assert.equal(fresh.reconcile(overlapping).code,'OTHER_WRITER_ACTIVE','root-exit/restart cannot prove ordinary descendants stopped');
  const independent=makeBinding(disjoint);assert.equal((await bind(independent,'disjoint')).ok,true);
  const independentMeta={_meta:{'openai/session':'disjoint'}},independentWorkspaces={getWorkspace:async()=>({root:disjoint})};
  let output='';
  await fresh.runTool('bash',{workspace_id:'new'},independentMeta,independentWorkspaces,()=>fresh.bashOperations(
    ()=>({shell:process.execPath,args:['-e'],commandTransport:'argv'})).exec("process.stdin.on('end',()=>console.log('STDIN_EOF'));process.stdin.resume()",disjoint,
    {env:process.env,timeout:8,onData:data=>output+=data}));
  assert.match(output,/STDIN_EOF/,'the shell must receive EOF instead of inheriting the helper stop-control pipe');
  await writeFile(join(independent.channel,'revoked.json'),JSON.stringify(independent));
  assert.equal(fresh.reconcile(independent).ok,true,'an unknown ordinary background must not block an independent root');
});
