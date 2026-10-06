import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import {apply as filesystemTools} from '@deepseek-ai/dsh-tool-fs'
import {apply as observationPolicy} from '@deepseek-ai/dsh-fs-observation-policy'
import {stage1Runtime} from './fixtures/postman-stage1-runtime.js'

test('FAST direct read/edit keeps stock observation semantics and task cwd',{timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'postman-direct-mutation-')),file=join(dir,'facts.txt')
  await writeFile(file,'old fact')
  const f=await stage1Runtime(dir,{setupTools:ctx=>{new LocalFileSystem(ctx,{cwd:dir,diffBasisMaxBytes:1048576});filesystemTools(ctx,{readLimit:2000,readMaxLineLength:2000,readMaxBytes:51200,readStreamMinSize:10485760});observationPolicy(ctx)},plan:(_a,_r,n)=>{
    if(n===1||n===3)return {name:'edit',args:{file_path:'facts.txt',old_string:'old fact',new_string:'new fact'}}
    if(n===2||n===4)return {name:'read',args:{file_path:'facts.txt'}}
    return {name:'report',args:{output:'read/edit/reread native evidence; done'}}
  }})
  t.after(async()=>{await f.dispose();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  const accepted=await f.run(f.worker.taskTool,{task:'edit only observed facts and reread'});assert.equal(accepted.status,'POSTMAN_WORKER_TASK_ACCEPTED')
  const child=await f.settled(accepted.workerSessionId)
  assert.equal(await readFile(file,'utf8'),'new fact')
  const results=child.session.events.filter(e=>e.type==='tool/result')
  assert.equal(results[0].data.message.content[0].isError,true)
  assert.equal(results[2].data.message.content[0].isError,false)
  for(const {request} of f.requests)assert.ok(!request.tools.some(x=>x.name==='ptc_execute'))
})
