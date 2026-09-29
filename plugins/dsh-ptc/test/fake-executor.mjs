import { FrameReader, message, writer } from '../src/protocol.js'
const lim={maxMessageBytes:1048576,maxTotalBridgeBytes:16777216,maxValueDepth:32,maxValueNodes:10000,maxToolCalls:256}
let once=false
const read=new FrameReader(lim,async data=>{
  if(once)return
  once=true
  const {runId}=data,send=writer(process.stdout,lim),kind=data.program
  const ready=message('ready',runId),call=message('call',runId,{callId:1,name:'echo',arg:null})
  switch(kind){
    case 'invalid-version': await send.send({...ready,v:2});break
    case 'foreign-run': await send.send(message('ready','other'));break
    case 'duplicate-ready': await send.send(ready);await send.send(ready);break
    case 'duplicate-call': await send.send(ready);await send.send(call);await send.send(call);break
    case 'ungranted-call': await send.send(ready);await send.send({...call,name:'extra'});break
    case 'terminal-early': await send.send(message('done',runId,{status:'ok',value:1}));break
    case 'truncated': process.stdout.write(Buffer.from([0,0,0,10,123]),()=>process.exit(0));return
    case 'oversized': process.stdout.write(Buffer.from([255,255,255,255]),()=>process.exit(0));return
    case 'crash': process.exit(23)
    case 'pending-ready': return
    default: await send.send(ready);await send.send(message('done',runId,{status:'ok',value:3}))
  }
  process.stdin.pause()
},()=>process.exit(24))
process.stdin.on('data',x=>read.push(x))
process.stdin.on('end',()=>process.stdin.pause())
