import {readFileSync, lstatSync, realpathSync, unlinkSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, resolve, isAbsolute} from 'node:path'
import {loadDevspaceChannelForOwner} from './postman-devspace.js'

const controlPath=controlFile=>controlFile??join(homedir(),'.dsh','devspace','writer-control.json')
const normalized=root=>resolve(root).replaceAll('\\','/').toLowerCase()
const overlaps=(a,b)=>{a=normalized(a);b=normalized(b);return a===b||a.startsWith(b+'/')||b.startsWith(a+'/')}
function ordinaryCensus(controlFile) {
  const file=controlPath(controlFile)
  let info
  try {info=lstatSync(file)} catch(error) {if(error.code==='ENOENT')return {untrackedRoots:[]};throw error}
  if(info.isSymbolicLink() || info.size>1048576 || realpathSync(file)!==resolve(file))throw Error('DEVSPACE_ORDINARY_CENSUS_UNAVAILABLE')
  const census=JSON.parse(readFileSync(file,'utf8'))
  if(census.version!==1 || census.untrackedRoots!==undefined && (!Array.isArray(census.untrackedRoots) ||
    census.untrackedRoots.some(root=>typeof root!=='string'||!root||!isAbsolute(root))))throw Error('DEVSPACE_ORDINARY_CENSUS_UNAVAILABLE')
  return {...census,untrackedRoots:census.untrackedRoots??[]}
}

/** Advisory admission only; absence of a known lease is never native exit proof. */
export function devspaceOrdinaryWriterConflict(writeRoot,{controlFile}={}) {
  try {return ordinaryCensus(controlFile).untrackedRoots.some(root=>overlaps(writeRoot,root))}
  catch {return true}
}
export async function checkDevspaceOrdinaryWriterAdmission(writeRoot,{controlFile}={}) {
  const unavailable=()=>({ok:false,status:'EXIT_UNPROVEN'})
  try {
    const census=ordinaryCensus(controlFile)
    if(!census.untrackedRoots.some(root=>overlaps(writeRoot,root)))return {ok:true,status:'READY'}
    if(!Number.isSafeInteger(census.port)||census.port<1||census.port>65535||!/^[0-9a-f]{64}$/.test(census.secret??''))return unavailable()
    const response=await fetch('http://127.0.0.1:'+census.port+'/ordinary-admission',{method:'POST',signal:AbortSignal.timeout(3000),
      headers:{'content-type':'application/json','authorization':'Bearer '+census.secret},body:JSON.stringify({writeRoot})})
    if(!response.ok)return unavailable()
    const result=await response.json()
    if(result.writeRoot!==writeRoot || !['READY','OTHER_WRITER_ACTIVE','EXIT_UNPROVEN'].includes(result.status))return unavailable()
    if(result.status==='READY')return result.ok===true ? {ok:true,status:'READY'} : unavailable()
    return result.ok===false ? {ok:false,status:result.status} : unavailable()
  } catch {return unavailable()}
}

/** A native background/pending lease survives a delivered web result. Reading
 * it can only retain the original granted root, never prove native settlement. */
export function readDevspaceWriterHold({leaderSessionId,bridgeJobId,task,op}) {
  if(op.writerSettlement || !op.devspace?.channel) return null
  const savedRoot=op.residualWriteRoot ?? (op.devspace.approvedAccess==='write' ? op.devspace.approvedRoot :
    op.devspace.mode==='WRITE_ISOLATED' ? task.worktree :
      op.devspace.mode==='WRITE_TEST' ? join(op.devspace.channel,'workspace') : null)
  const uncertain=()=>savedRoot ? {root:savedRoot,verified:false} : null
  let held=false
  try {
    const file=join(op.devspace.channel,'writer-hold.json')
    let info
    try {info=lstatSync(file)} catch(error) {return error.code==='ENOENT' ? null : uncertain()}
    held=true
    const binding=loadDevspaceChannelForOwner(op.devspace.channel,{leaderSessionId,bridgeJobId,
      lunaSessionId:op.childSessionId,requestId:op.requestId})
    if(binding.branch!==task.branch || binding.mode!==op.devspace.mode || !binding.writeRoot || binding.writeRoot!==savedRoot) return uncertain()
    if(info.isSymbolicLink() || info.size>65536 || realpathSync(file)!==resolve(file)) return uncertain()
    const lease=JSON.parse(readFileSync(file,'utf8'))
    if(lease.version!==1 || !/^[0-9a-f-]{36}$/.test(lease.generation??'') ||
      ['jobId','requestId','leaderSessionId','lunaSessionId','branch','writeRoot','capability'].some(key=>lease[key]!==binding[key]))
      return uncertain()
    const claimFile=join(binding.channel,'writer-claim.json'),claimInfo=lstatSync(claimFile)
    if(claimInfo.isSymbolicLink() || claimInfo.size>65536 || realpathSync(claimFile)!==resolve(claimFile)) return uncertain()
    const claim=JSON.parse(readFileSync(claimFile,'utf8'))
    if(claim.version!==1 || claim.generation!==lease.generation || typeof claim.scope!=='string' || !claim.scope ||
      ['jobId','requestId','leaderSessionId','branch','writeRoot'].some(key=>claim[key]!==binding[key])) return uncertain()
    return {root:binding.writeRoot,verified:true}
  } catch { return held ? uncertain() : null }
}
export const devspaceWriterHoldRoot=options=>readDevspaceWriterHold(options)?.root??null

/** Called only after the exact native proof has been durably recorded. */
export function clearDevspaceWriterHold({leaderSessionId,bridgeJobId,task,op,proof}) {
  try {
    const binding=loadDevspaceChannelForOwner(op.devspace?.channel,{leaderSessionId,bridgeJobId,
      lunaSessionId:op.childSessionId,requestId:op.requestId})
    if(proof?.version!==1 || proof.source!=='devspace_native_tree' || !/^[0-9a-f-]{36}$/.test(proof.generation??'') ||
      !Number.isFinite(Date.parse(proof.settledAt)) || binding.branch!==task.branch ||
      ['jobId','requestId','leaderSessionId','branch','writeRoot'].some(key=>proof[key]!==binding[key])) return false
    const claimFile=join(binding.channel,'writer-claim.json'),claimInfo=lstatSync(claimFile)
    if(claimInfo.isSymbolicLink() || claimInfo.size>65536 || realpathSync(claimFile)!==resolve(claimFile)) return false
    const claim=JSON.parse(readFileSync(claimFile,'utf8'))
    if(claim.version!==1 || claim.generation!==proof.generation ||
      ['jobId','requestId','leaderSessionId','branch','writeRoot'].some(key=>claim[key]!==binding[key])) return false
    const file=join(binding.channel,'writer-hold.json')
    try {lstatSync(file)} catch(error) {return error.code==='ENOENT'}
    const held=readDevspaceWriterHold({leaderSessionId,bridgeJobId,task,op:{...op,writerSettlement:undefined}})
    if(!held?.verified || held.root!==proof.writeRoot) return false
    const lease=JSON.parse(readFileSync(file,'utf8'))
    if(lease.generation!==proof.generation ||
      ['jobId','requestId','leaderSessionId','lunaSessionId','branch','writeRoot','capability'].some(key=>lease[key]!==binding[key])) return false
    unlinkSync(file)
    return true
  } catch {return false}
}

/** The caller supplies an owned journal row, never a model-authored exit receipt. */
export async function observeDevspaceWriter({leaderSessionId,bridgeJobId,task,op,otherWriters=[],controlFile}) {
  try {
    const binding=loadDevspaceChannelForOwner(op.devspace?.channel, {leaderSessionId,bridgeJobId,
      lunaSessionId:op.childSessionId,requestId:op.requestId})
    const writeRoot=op.residualWriteRoot ?? (op.devspace?.approvedAccess==='write' ? op.devspace.approvedRoot :
      op.devspace?.mode==='WRITE_TEST' ? binding.writeRoot : task.worktree)
    if(binding.writerRuntimeVersion!==1 || binding.branch!==task.branch || binding.writeRoot!==writeRoot)
      return {ok:false,code:'WRITER_BINDING_CHANGED'}
    const descriptor=controlFile??join(homedir(),'.dsh','devspace','writer-control.json')
    if(lstatSync(descriptor).isSymbolicLink() || lstatSync(descriptor).size>1048576 || realpathSync(descriptor)!==resolve(descriptor))
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
