import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createWriterRuntime} from '../writer-runtime.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'minimal-writer-')),id=randomUUID(),channel=join(root,id),project=join(root,'project'),outside=join(root,'outside');
  for(const path of [channel,project,outside])mkdirSync(path);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const binding={version:1,writerRuntimeVersion:1,jobId:id,requestId:'REQ_20261020T120000Z_0001',leaderSessionId:'leader',lunaSessionId:'luna',
    channel,capability:randomBytes(32).toString('hex'),writeRoot:project,workspaceRef:project,branch:'',workspaceOnly:true};
  writeFileSync(join(channel,'binding.json'),JSON.stringify(binding));
  const runtime=()=>createWriterRuntime({root});
  const invoke=(writer,name,input,operation=async()=>({ok:true}),scope='owned-chat')=>writer.runTool(name,input,
    {_meta:{'openai/session':scope}},{getWorkspace:async()=>({root:outside})},operation,false);
  return {root,channel,project,outside,id,binding,runtime,invoke};
}

test('Host binding identifies the job without imposing a second filesystem scope',async t=>{
  const f=fixture(t),writer=f.runtime(),input={path:'postman-writer:'+f.id};
  await f.invoke(writer,'open_workspace',input);
  assert.equal(input.path,f.project);
  assert.deepEqual(await f.invoke(writer,'write',{workspace_id:'another-authorized-workspace',path:'report.md'}),{ok:true});
  assert.deepEqual(await f.invoke(writer,'bash',{workspace_id:'another-authorized-workspace',command:'read only'}),{ok:true});
  const upstream={isError:true,content:[{type:'text',text:'native permissions denied'}]};
  assert.equal(await f.invoke(writer,'edit',{workspace_id:'native-policy'},async()=>upstream),upstream);
});

test('a restarted runtime accepts explicit work despite lost old process census',async t=>{
  const f=fixture(t),first=f.runtime();
  await f.invoke(first,'open_workspace',{path:'postman-writer:'+f.id});
  const restarted=f.runtime();
  assert.deepEqual(await f.invoke(restarted,'open_workspace',{path:'postman-writer:'+f.id}),{ok:true});
  assert.deepEqual(await f.invoke(restarted,'write',{workspace_id:'same-user-permissions'}),{ok:true});
  const foreign=await f.invoke(restarted,'open_workspace',{path:'postman-writer:'+f.id},undefined,'another-chat');
  assert.equal(foreign.isError,true,'another chat cannot claim this job capability');
});

test('revocation follows its exact persisted scope even after runtime restart',async t=>{
  const f=fixture(t),first=f.runtime();
  await f.invoke(first,'open_workspace',{path:'postman-writer:'+f.id});
  writeFileSync(join(f.channel,'revoked.json'),JSON.stringify({version:1,
    ...Object.fromEntries(['jobId','requestId','leaderSessionId','lunaSessionId','capability'].map(key=>[key,f.binding[key]]))}));
  let effects=0;
  const result=await f.invoke(f.runtime(),'write',{workspace_id:'literal-workspace'},async()=>{effects++;return {ok:true}});
  assert.equal(result.isError,true);assert.match(JSON.stringify(result),/WRITER_EXECUTION_REVOKED/);assert.equal(effects,0);
});
