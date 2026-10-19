import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';

const runtimeUrl=process.env.DSH_TEST_RUNTIME_ROOT
  ? pathToFileURL(join(process.env.DSH_TEST_RUNTIME_ROOT,'devspace/writer-runtime.mjs'))
  : new URL('../writer-runtime.mjs',import.meta.url);
const {createWriterRuntime}=await import(runtimeUrl);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t,{bound=false}={}) {
  const directory=await mkdtemp(join(tmpdir(),'devspace-tool-errors-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const root=join(directory,'channels'),worktree=join(directory,'worktree');
  await mkdir(root);await mkdir(worktree);
  const runtime=createWriterRuntime({root});
  const meta={_meta:{'openai/session':'owned-scope'}};
  const workspaces={getWorkspace:async()=>({root:worktree})};
  let binding;
  if(bound) {
    const jobId=randomUUID(),channel=join(root,jobId);await mkdir(channel);
    binding={version:1,writerRuntimeVersion:1,jobId,channel,writeRoot:worktree,
      requestId:'REQ_20261017T123456Z_4567',leaderSessionId:'leader',lunaSessionId:'luna',
      branch:'task/postman-'+randomUUID().replaceAll('-',''),capability:randomBytes(32).toString('hex')};
    await writeFile(join(channel,'binding.json'),JSON.stringify(binding));
    const opened=await runtime.runTool('open_workspace',{path:'postman-writer:'+jobId},meta,workspaces,async()=>({ok:true}),true);
    assert.equal(opened.ok,true,JSON.stringify(opened));
  }
  const invoke=(operation,{name='write',readOnly=false,callMeta=meta,spaces=workspaces,input={workspace_id:'owned'}}={})=>
    runtime.runTool(name,input,callMeta,spaces,operation,readOnly);
  const revoke=async()=>writeFile(join(binding.channel,'revoked.json'),JSON.stringify(binding));
  return {directory,worktree,runtime,meta,workspaces,binding,invoke,revoke};
}

for(const bound of [false,true]) {
  const label=bound?'bound':'ordinary';
  test(label+' upstream rejection preserves the original Error object and structured result',{
    skip:bound&&process.platform!=='win32',
  },async t=>{
    const f=await fixture(t,{bound});
    const sentinel=Object.assign(new Error('UPSTREAM_SENTINEL'),{code:'ENOENT'});
    await assert.rejects(f.invoke(async()=>{throw sentinel}),error=>error===sentinel);
    await assert.rejects(f.invoke(()=>{throw sentinel}),error=>error===sentinel);
    const result={isError:true,content:[{type:'text',text:'UPSTREAM_STRUCTURED_ERROR'}],structuredContent:{code:'ENOENT'}};
    assert.equal(await f.invoke(async()=>result),result);
    if(bound){
      await assert.rejects(f.invoke(async()=>{throw sentinel},{name:'bash',input:{workspace_id:'owned',execution:'status'}}),error=>error===sentinel);
      await f.revoke();assert.equal(f.runtime.reconcile(f.binding).ok,true,'throw must not leak the active counter');
    }
  });

  test(label+' workspace provider errors and read-only handler errors keep upstream semantics',{
    skip:bound&&process.platform!=='win32',
  },async t=>{
    const f=await fixture(t,{bound});
    const missing=Object.assign(new Error('UPSTREAM_WORKSPACE_SENTINEL'),{code:'ENOENT'});
    let invoked=false;
    await assert.rejects(f.invoke(async()=>{invoked=true},{spaces:{getWorkspace:async()=>{throw missing}}}),error=>error===missing);
    assert.equal(invoked,false);
    const readError=new Error('UPSTREAM_READ_SENTINEL');
    await assert.rejects(f.invoke(async()=>{throw readError},{name:'read',readOnly:true}),error=>error===readError);
  });
}

test('Host preserves binding validation while independent authorized scopes may share a root',{
  skip:process.platform!=='win32',
},async t=>{
  const f=await fixture(t,{bound:true});let invoked=0;
  const operation=async()=>{invoked++;return {bad:true}};
  const foreign=await f.invoke(operation,{callMeta:{_meta:{'openai/session':'foreign'}}});
  assert.equal(foreign.bad,true,'an independent upstream-authorized scope is not denied by root overlap');
  const escaped=await f.invoke(operation,{spaces:{getWorkspace:async()=>({root:f.directory})}});
  assert.equal(escaped.isError,true);assert.match(JSON.stringify(escaped),/WRITER_BINDING_CHANGED/);
  const malformed=await f.invoke(operation,{name:'open_workspace',readOnly:true,input:{path:'postman-writer:invalid'}});
  assert.equal(malformed.isError,true);assert.match(JSON.stringify(malformed),/WRITER_BINDING_CHANGED/);
  await f.revoke();
  const revoked=await f.invoke(operation);
  assert.equal(revoked.isError,true);assert.match(JSON.stringify(revoked),/WRITER_EXECUTION_REVOKED/);
  await writeFile(join(f.binding.channel,'binding.json'),'PRIVATE_HOST_SECRET: malformed JSON');
  const malformedBinding=await f.invoke(operation,{name:'open_workspace',readOnly:true,input:{path:'postman-writer:'+f.binding.jobId}});
  assert.equal(malformedBinding.isError,true);assert.match(JSON.stringify(malformedBinding),/WRITER_BINDING_CHANGED/);
  assert.equal(JSON.stringify(malformedBinding).includes('PRIVATE_HOST_SECRET'),false);
  assert.equal(invoked,1,'only the independent authorized operation reaches the handler');
});

test('bound upstream abort retains concurrent activity and releases each active counter once',{
  skip:process.platform!=='win32',
},async t=>{
  const f=await fixture(t,{bound:true}),controller=new AbortController();
  let finish;const remaining=new Promise(resolve=>{finish=resolve});
  const held=f.invoke(()=>remaining);
  const sentinel=Object.assign(new Error('UPSTREAM_ABORT_SENTINEL'),{name:'AbortError'});
  const aborted=f.invoke(()=>new Promise((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(sentinel),{once:true})));
  const observed=assert.rejects(aborted,error=>error===sentinel);
  await tick();controller.abort();await observed;await f.revoke();
  assert.equal(f.runtime.reconcile(f.binding).code,'WRITER_STILL_RUNNING');
  finish({ok:true});assert.equal((await held).ok,true);
  assert.equal(f.runtime.reconcile(f.binding).ok,true);
});
