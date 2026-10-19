// Native Windows detached HTTP children, reached only through real MCP/OAuth.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createBackgroundFixture,quote} from './background-fixture.mjs';

const mode=process.argv[2]??'green',fixtures=[];
const create=async options=>{const fixture=await createBackgroundFixture(options);fixtures.push(fixture);return fixture};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let checks=0;
const check=(condition,name)=>{assert(condition,name);checks++;console.log('PASS '+name)};
const text=result=>JSON.stringify(result);
const node=source=>'node -e '+quote(source);
async function eventually(predicate,name) {
  for(let i=0;i<100;i++){if(await predicate())return;await pause(100)}
  assert.fail(name);
}
try {
  if(mode==='unbound'||mode==='green') {
    const observations=[],applications=[];
    for(const patched of [false,true]) {
      const f=await create({patched});
      const opened=await f.call('open_workspace',{path:f.project},'ordinary');assert(!opened.isError,JSON.stringify(opened));
      const app=f.application(),start=Date.now();
      applications.push(app);
      const result=await f.call('bash',{workspace_id:opened.structuredContent.workspace_id,command:app.command,timeout:4},'ordinary');
      const elapsed=Date.now()-start,alive=await app.wait();
      observations.push({patched,elapsed,alive,isError:!!result.isError,text:JSON.stringify(result)});
    }
    console.log(JSON.stringify({mode:'unbound',observations},null,2));
    assert(!observations[0].isError&&observations[0].alive,'upstream detached HTTP child survives parent return');
    assert(!observations[1].isError&&observations[1].alive,'ordinary patched Bash must preserve upstream detached HTTP lifecycle');
    check(true,'real upstream and patched ordinary detached HTTP lifecycle');
    if(mode==='green') {
      const f=fixtures.at(-1),scope='ordinary';
      const opened=await f.call('open_workspace',{path:f.project},scope),workspace_id=opened.structuredContent.workspace_id;
      const bash=args=>f.call('bash',{workspace_id,...args},scope);
      const written=await f.call('write',{workspace_id,path:'ordinary.txt',content:'before'},scope);
      const edited=await f.call('edit',{workspace_id,path:'ordinary.txt',edits:[{old_text:'before',new_text:'after'}]},scope);
      const read=await f.call('read',{workspace_id,path:'ordinary.txt'},scope);
      check(!written.isError&&!edited.isError&&!read.isError&&text(read).includes('after'),'ordinary MCP open/write/edit/read preserve their behavior');
      mkdirSync(join(f.project,'nested'));
      const io=await bash({command:'printf input_payload | DSH_BACKGROUND_ENV=env_payload '+node("process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{console.log(process.cwd());console.log(process.env.DSH_BACKGROUND_ENV);console.log(input);console.error('stderr_payload')})"),working_directory:'nested',timeout:5});
      check(!io.isError&&text(io).includes('nested')&&text(io).includes('env_payload')&&text(io).includes('input_payload')&&text(io).includes('stderr_payload'),'ordinary executor preserves cwd/env/stdin/stdout/stderr');
      const exit=await bash({command:node("console.log('exit_payload');process.exit(7)"),timeout:5});
      check(exit.isError&&text(exit).includes('7')&&text(exit).includes('exit_payload'),'ordinary executor preserves nonzero exit and output');
      const timed=await bash({command:node('setTimeout(()=>{},10000)'),timeout:1});
      check(timed.isError&&text(timed).toLowerCase().includes('timed out'),'ordinary foreground timeout remains effective');
      const listed=await f.tools(),schema=listed.tools.find(tool=>tool.name==='bash').inputSchema;
      check(schema.properties.timeout.maximum===300,'real MCP schema preserves 300-second command limit');
      const gate=join(f.project,'gate.json');
      const active=Array.from({length:8},(_,i)=>bash({command:node("const fs=require('node:fs');fs.writeFileSync('active-"+i+"','started');const timer=setInterval(()=>{if(fs.existsSync('gate.json')){clearInterval(timer);console.log('slot_finished')}},50);setTimeout(()=>{clearInterval(timer)},10000).unref()"),timeout:15}));
      await eventually(()=>Array.from({length:8},(_,i)=>existsSync(join(f.project,'active-'+i))).every(Boolean),'eight native ordinary commands start');
      const ninth=await bash({command:node("require('node:fs').writeFileSync('ninth-executed','bad')"),timeout:5});
      check(ninth.isError&&text(ninth).includes('Eight Bash')&&!existsSync(join(f.project,'ninth-executed')),'real MCP ninth Bash rejected before executing');
      writeFileSync(gate,'open');const completed=await Promise.all(active);
      const next=await bash({command:node("console.log('capacity_restored')"),timeout:5});
      check(completed.every(result=>!result.isError)&&!next.isError&&text(next).includes('capacity_restored'),'eight native commands settle and capacity returns');
      check((await Promise.all(applications.map(app=>app.health()))).every(Boolean),'ordinary detached HTTP applications survive unrelated commands and timeout');
    }
  }
  if(mode==='bound'||mode==='green') {
    const f=await create({patched:true});
    const opened=await f.call('open_workspace',{path:'postman-writer:'+f.binding.jobId});assert(!opened.isError,JSON.stringify(opened));
    const app=f.application(),start=Date.now();
    const result=await f.call('bash',{workspace_id:opened.structuredContent.workspace_id,command:app.command,timeout:4,execution:'background'});
    const elapsed=Date.now()-start,alive=await app.wait();
    console.log(JSON.stringify({mode:'bound',elapsed,alive,result},null,2));
    assert(!result.isError&&alive&&result.structuredContent?.native_job_id,'explicit bound background must return a tracked live native job');
    assert(elapsed<4000,'explicit background confirmation returns before command timeout');
    check(true,'real bound explicit background starts and survives foreground return');
    if(mode==='green') {
      const workspace_id=opened.structuredContent.workspace_id,native_job_id=result.structuredContent.native_job_id;
      const bash=args=>f.call('bash',{workspace_id,...args});
      const schema=(await f.tools()).tools.find(tool=>tool.name==='bash').inputSchema;
      check(schema.properties.execution.enum.includes('background')&&schema.properties.execution.enum.includes('status')&&schema.properties.execution.enum.includes('stop')&&!schema.required.includes('command'),'real MCP advertises explicit start/status/stop with optional command');
      mkdirSync(join(f.project,'nested'));
      const io=await bash({command:'printf bound_input | DSH_BACKGROUND_ENV=bound_env '+node("process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{console.log(process.cwd());console.log(process.env.DSH_BACKGROUND_ENV);console.log(input);console.error('bound_stderr')})"),working_directory:'nested',timeout:8});
      check(!io.isError&&text(io).includes('nested')&&text(io).includes('bound_env')&&text(io).includes('bound_input')&&text(io).includes('bound_stderr'),'bound native foreground preserves cwd/env/stdin/stdout/stderr');
      const exit=await bash({command:node("console.log('bound_exit');process.exit(9)"),timeout:8});
      check(exit.isError&&text(exit).includes('9')&&text(exit).includes('bound_exit'),'bound native finite foreground preserves nonzero exit and output');
      let status;
      await eventually(async()=>{status=await bash({execution:'status',job_id:native_job_id});return status.structuredContent?.foregroundFinished===true},'native foreground actually exits');
      check(status.structuredContent.exitCode===0&&!status.structuredContent.treeSettled&&await app.health(),'foreground exit is separate from live native tree');
      await pause(4500);
      check(await app.health(),'explicit native background survives beyond former four-second descendant timeout');
      const jobs=await bash({execution:'status'});
      check(!jobs.isError&&jobs.structuredContent.jobs.some(job=>job.native_job_id===native_job_id),'lost start response can discover exact owned native job');
      const foreign=await f.call('bash',{workspace_id,execution:'stop',job_id:native_job_id},'foreign-chat');
      const unknown=await bash({execution:'stop',job_id:randomUUID()});
      check(foreign.isError&&unknown.isError&&await app.health(),'foreign scope and unknown job cannot stop owned application');
      const independent=join(f.root,'independent');mkdirSync(independent);
      const other=await f.call('open_workspace',{path:independent},'independent-chat');
      const wrong=await bash({execution:'stop',workspace_id:other.structuredContent.workspace_id,job_id:native_job_id});
      check(wrong.isError&&await app.health(),'wrong workspace cannot stop exact owned native job');
      const write=await f.call('write',{workspace_id,path:'kept.txt',content:'preserved'});
      const conflict=await f.call('write',{workspace_id,path:'parallel.txt',content:'parallel'},'foreign-chat');
      const read=await f.call('read',{workspace_id,path:'kept.txt'},'reader');
      const separate=await f.call('write',{workspace_id:other.structuredContent.workspace_id,path:'independent.txt',content:'independent'},'independent-chat');
      check(!write.isError&&!conflict.isError&&!read.isError&&!separate.isError&&readFileSync(join(f.project,'kept.txt'),'utf8')==='preserved','live writer does not veto concurrent upstream-authorized writes or reads');
      writeFileSync(join(f.channel,'revoked.json'),JSON.stringify(f.binding));
      check(!f.writers.reconcile(f.binding).ok,'revoked live background cannot manufacture native release');
      const denied=await bash({command:node("require('node:fs').writeFileSync('forbidden','bad')"),execution:'background',timeout:3});
      const observed=await bash({execution:'status',job_id:native_job_id,command:node("require('node:fs').writeFileSync('status-command-executed','bad')")});
      check(denied.isError&&!existsSync(join(f.project,'forbidden'))&&!observed.isError&&!existsSync(join(f.project,'status-command-executed')),'revoke blocks new starts while addressed status remains observational');
      const stopped=await bash({execution:'stop',job_id:native_job_id});
      check(!stopped.isError,'same exact binding can request addressed native stop after revoke');
      await eventually(async()=>{status=await bash({execution:'status',job_id:native_job_id});return status.structuredContent?.treeSettled===true},'whole native background tree settles after addressed stop');
      check(!await app.health()&&f.writers.reconcile(f.binding).ok&&readFileSync(join(f.project,'kept.txt'),'utf8')==='preserved','actual tree settlement permits native proof and preserves prior files');
    }
  }
  if(mode==='green')console.log('PASS '+checks+' real OAuth/MCP background and compatibility checks; production unchanged');
} finally {for(const fixture of fixtures.reverse())await fixture.close()}
