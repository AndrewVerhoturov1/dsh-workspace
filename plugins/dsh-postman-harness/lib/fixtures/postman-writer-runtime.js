import {mkdtemp,mkdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createWriterRuntime,startWriterControl} from '../../../../devspace/writer-runtime.mjs'
import {createDevspaceChannel,revokeDevspaceChannel,devspaceRoot} from '../postman-devspace.js'

// Actual Windows Job Object controller and native commands; no fabricated exit callback.
export async function writerRuntimeFixture(t,{leaderSessionId='leader',bridgeJobId=randomUUID(),branch='task/postman-'+randomUUID().replaceAll('-',''),requestId='REQ_20261017T123456Z_1234'}={}) {
  const directory=await mkdtemp(join(tmpdir(),'postman-writer-release-'))
  const previous=process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA=directory
  const worktree=join(directory,'worktree'); await mkdir(worktree)
  const binding=createDevspaceChannel({bridgeJobId,leaderSessionId,lunaSessionId:'luna-'+bridgeJobId,
    requestId,worktree,branch,mode:'WRITE_ISOLATED',sourceRoot:directory})
  const runtime=createWriterRuntime({root:devspaceRoot()})
  const control=await startWriterControl(runtime,{file:join(directory,'writer-control.json')})
  const scope='native-scope-'+bridgeJobId
  const meta={_meta:{'openai/session':scope}}
  const workspaces={getWorkspace:async()=>({root:worktree})}
  const claim=await runtime.runTool('open_workspace',{path:'postman-writer:'+bridgeJobId},meta,workspaces,async()=>({ok:true}),true)
  if(claim.isError) throw Error(JSON.stringify(claim))
  const operations=command=>runtime.runTool('bash',{workspace_id:'native'},meta,workspaces,async()=>{
    const native=runtime.bashOperations(()=>({shell:process.execPath,args:['-e'],commandTransport:'argv'}))
    let output=''
    const result=await native.exec(command,worktree,{onData:data=>{output+=data},timeout:20,env:process.env})
    return {...result,output}
  })
  t.after(async()=>{await control.close(); if(previous===undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA=previous;
    await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
  return {directory,worktree,branch,binding,runtime,control,meta,scope,workspaces,operations,
    revoke:()=>revokeDevspaceChannel(binding)}
}
