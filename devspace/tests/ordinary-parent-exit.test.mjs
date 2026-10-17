// A6: real upstream launch and actual controller process exit, never a fake census.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBackgroundFixture} from './background-fixture.mjs';

test('A6 actual ordinary controller exit retains unknown Postman admission while ordinary permissions remain unchanged',{timeout:60000},async t=>{
  const f=await createBackgroundFixture(),app=f.application({writes:true});
  const controlFile=join(f.root,'ordinary-cold-control.json'),script=join(f.root,'ordinary-controller.mjs');
  const module=pathToFileURL(join(f.root,'writer-runtime.mjs')).href;
  const install=process.env.DEVSPACE_INSTALL_ROOT??'C:/Users/Andrew/.dsh/devspace';
  const agent=pathToFileURL(join(install,'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
  writeFileSync(script,`import assert from 'node:assert/strict';
import {createWriterRuntime,startWriterControl} from ${JSON.stringify(module)};
import {createBashTool} from ${JSON.stringify(agent)};
const runtime=createWriterRuntime({root:${JSON.stringify(join(f.root,'channels'))}});
const control=await startWriterControl(runtime,{file:${JSON.stringify(controlFile)}});
const command=${JSON.stringify(app.command)};
await runtime.runTool('bash',{workspace_id:'ordinary',command},{_meta:{'openai/session':'ordinary-parent'}},
 {getWorkspace:async()=>({root:${JSON.stringify(f.project)}})},()=>{
   assert.equal(runtime.bashOperations(()=>{}),undefined);
   return createBashTool(${JSON.stringify(f.project)}).execute('ordinary-parent',{command,timeout:4});
 });
await control.close();console.log('ORDINARY_CONTROLLER_COMPLETED');
`);
  const child=spawn(process.execPath,[script],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='',control;
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const ended=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{if(child.exitCode===null)child.kill();if(control)await control.close();await f.close()});
  let deadline;
  const exit=await Promise.race([ended,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('ordinary controller retains process handles')),12000)})]).finally(()=>clearTimeout(deadline));
  assert.equal(exit,0,stderr);assert.match(stdout,/ORDINARY_CONTROLLER_COMPLETED/);
  assert(await app.wait(),'unmodified upstream detached child survives controller exit');
  assert(existsSync(app.heartbeat),'real detached descendant continues writing');
  const fresh=f.runtimeModule.createWriterRuntime({root:join(f.root,'channels')});
  control=await f.runtimeModule.startWriterControl(fresh,{file:controlFile});
  const privateAdmission=await fresh.ordinaryAdmission(f.project);
  assert.equal(privateAdmission.ok,false,'lost census does not prove a root ready for new Postman ownership');
  assert.equal(privateAdmission.status,'EXIT_UNPROVEN');
  let overlappingExecuted=false;
  const meta={_meta:{'openai/session':'cold-independent'}},workspaces={getWorkspace:async id=>({root:id==='overlap'?f.project:join(f.root,'independent')})};
  const boundMeta={_meta:{'openai/session':'cold-new-postman'}};
  await fresh.runTool('open_workspace',{path:'postman-writer:'+f.binding.jobId},boundMeta,workspaces,async()=>({allowed:true}),true);
  const refused=await fresh.runTool('write',{workspace_id:'overlap'},boundMeta,workspaces,async()=>{overlappingExecuted=true;return {allowed:true}});
  assert(refused.isError&&!overlappingExecuted,'lost controller cannot admit a new Postman writer over a possible live ordinary tree');
  const read=await fresh.runTool('read',{workspace_id:'overlap'},meta,workspaces,async()=>({allowed:true}),true);
  const disjoint=await fresh.runTool('write',{workspace_id:'disjoint'},meta,workspaces,async()=>({allowed:true}));
  assert(read.allowed&&disjoint.allowed,'cold unknown is limited to overlapping mutations');
  assert.equal(fresh.reconcile(f.binding).ok,false,'no model report or lost census manufactures Postman native proof');
  await app.stop();
});
