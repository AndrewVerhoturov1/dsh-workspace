import {readFileSync, lstatSync, realpathSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'
import {loadDevspaceChannelForOwner} from './postman-devspace.js'

/** The caller supplies an owned journal row, never a model-authored exit receipt. */
export async function observeDevspaceWriter({leaderSessionId,bridgeJobId,task,op,otherWriters=[],controlFile}) {
  try {
    const binding=loadDevspaceChannelForOwner(op.devspace?.channel, {leaderSessionId,bridgeJobId,
      lunaSessionId:op.childSessionId,requestId:op.requestId})
    const writeRoot=op.residualWriteRoot ?? (op.devspace?.approvedAccess==='write' ? op.devspace.approvedRoot : task.worktree)
    if(binding.writerRuntimeVersion!==1 || binding.branch!==task.branch || binding.writeRoot!==writeRoot)
      return {ok:false,code:'WRITER_BINDING_CHANGED'}
    const descriptor=controlFile??join(homedir(),'.dsh','devspace','writer-control.json')
    if(lstatSync(descriptor).isSymbolicLink() || lstatSync(descriptor).size>4096 || realpathSync(descriptor)!==resolve(descriptor))
      return {ok:false,code:'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'}
    const control=JSON.parse(readFileSync(descriptor,'utf8'))
    if(control.version!==1 || !Number.isSafeInteger(control.port) || control.port<1 || control.port>65535 ||
      !/^[0-9a-f]{64}$/.test(control.secret??'')) return {ok:false,code:'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'}
    const response=await fetch('http://127.0.0.1:'+control.port+'/reconcile', {method:'POST',
      signal:AbortSignal.timeout(3000), headers:{'content-type':'application/json','authorization':'Bearer '+control.secret},
      body:JSON.stringify({...binding,writeRoot,otherWriters})})
    if(!response.ok) return {ok:false,code:'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'}
    const result=await response.json()
    if(!result.ok) return {ok:false,code:['WRITER_STILL_RUNNING','OTHER_WRITER_ACTIVE','WRITER_BINDING_CHANGED'].includes(result.code)
      ? result.code : 'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'}
    const proof=result.proof
    if(proof?.version!==1 || proof.source!=='devspace_native_tree' ||
      ['jobId','requestId','leaderSessionId','branch','writeRoot'].some(key=>proof[key]!==binding[key]) ||
      !/^[0-9a-f-]{36}$/.test(proof.generation??'') || !Number.isFinite(Date.parse(proof.settledAt)))
      return {ok:false,code:'WRITER_BINDING_CHANGED'}
    return {ok:true,proof}
  } catch { return {ok:false,code:'DEVSPACE_NATIVE_PROOF_UNAVAILABLE'} }
}
