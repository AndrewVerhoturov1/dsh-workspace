import { boundedJson } from './json.js'
import { MAX_LIMITS } from './profiles.js'
// Fixed protocol overhead is independent of the profile's arg/value depth and nodes.
const ENVELOPE_LIMITS = Object.freeze({ ...MAX_LIMITS, maxValueDepth: MAX_LIMITS.maxValueDepth + 4, maxValueNodes: MAX_LIMITS.maxValueNodes + 1000 })
const SHAPES = Object.freeze({
  start: ['v','type','runId','program','language','profile'], ready: ['v','type','runId'],
  call: ['v','type','runId','callId','name','arg'],
  reply: ['v','type','runId','callId','ok','value','error'],
  log: ['v','type','runId','text'],
  done: ['v','type','runId','status','value','error','cleanupError'],
})
const OPTIONAL = { reply: ['value','error'], done: ['value','error','cleanupError'] }
export class ProtocolError extends Error {}
export function message(type, runId, fields = {}) { return { v: 1, type, runId, ...fields } }
export function checkMessage(obj, direction, runId, limits) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) ||
      !Object.hasOwn(SHAPES, obj.type) || obj.v !== 1 || obj.runId !== runId) throw new ProtocolError('Invalid envelope/version/runId')
  const fields = SHAPES[obj.type], optional = OPTIONAL[obj.type] || []
  if (Object.keys(obj).some(k => !fields.includes(k)) || fields.some(k => !optional.includes(k) && !Object.hasOwn(obj, k))) throw new ProtocolError('Invalid message fields')
  if (!((direction === 'parent' && ['ready','call','log','done'].includes(obj.type)) ||
        (direction === 'child' && ['start','reply'].includes(obj.type)))) throw new ProtocolError('Invalid message direction')
  if (obj.type === 'call' || obj.type === 'reply') {
    if (!Number.isSafeInteger(obj.callId) || obj.callId < 1 || obj.callId > limits.maxToolCalls) throw new ProtocolError('Invalid callId')
  }
  if (obj.type === 'call' && (typeof obj.name !== 'string' || !Object.hasOwn(obj,'arg'))) throw new ProtocolError('Invalid call')
  if (obj.type === 'reply' && (typeof obj.ok !== 'boolean' || obj.ok === Object.hasOwn(obj,'error') || obj.ok !== Object.hasOwn(obj,'value') || (obj.ok === false && typeof obj.error !== 'string'))) throw new ProtocolError('Invalid reply')
  if (obj.type === 'log' && typeof obj.text !== 'string') throw new ProtocolError('Invalid log')
  if (obj.type === 'done' && (typeof obj.status !== 'string' || (Object.hasOwn(obj,'error') && (typeof obj.error !== 'object' || !obj.error || typeof obj.error.code !== 'string' || typeof obj.error.message !== 'string')) || (Object.hasOwn(obj,'cleanupError') && (typeof obj.cleanupError?.code !== 'string' || typeof obj.cleanupError?.message !== 'string')) || (obj.status === 'ok') !== Object.hasOwn(obj,'value') || (obj.status !== 'ok' && !Object.hasOwn(obj,'error')))) throw new ProtocolError('Invalid terminal')
  if (obj.type === 'start' && (typeof obj.program !== 'string' || !['javascript','typescript'].includes(obj.language))) throw new ProtocolError('Invalid start')
  // Envelopes have a fixed service budget; only arg/value use the profile's JSON budget.
  try {
    boundedJson(obj, ENVELOPE_LIMITS)
    if (obj.type === 'call') boundedJson(obj.arg, limits)
    if (obj.type === 'reply' && obj.ok) boundedJson(obj.value, limits)
    if (obj.type === 'done' && obj.status === 'ok') boundedJson(obj.value, limits)
  } catch (error) { throw new ProtocolError('Invalid message JSON: ' + error.message) }
  return obj
}
export class FrameReader {
  constructor(limits, onMessage, onError) { this.limits=limits; this.onMessage=onMessage; this.onError=onError; this.pending=Buffer.alloc(0); this.total=0; this.failed=false }
  push(chunk) {
    if (this.failed) return
    try {
      this.total += chunk.length
      if (this.total > this.limits.maxTotalBridgeBytes) throw new ProtocolError('Total incoming bridge bytes exceeded')
      let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
      while (buf.length >= 4) {
        const length = buf.readUInt32BE(0)
        if (!length || length > this.limits.maxMessageBytes) throw new ProtocolError('Frame length exceeded or zero')
        if (buf.length < length + 4) break
        let text
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(4, 4 + length)) }
        catch { throw new ProtocolError('Invalid UTF-8') }
        let obj
        try { obj = JSON.parse(text) } catch { throw new ProtocolError('Invalid JSON') }
        this.onMessage(obj)
        buf = buf.subarray(4 + length)
      }
      // A single incoming chunk can be large; the total cap above bounds it.
      this.pending = buf
    } catch (error) { this.failed=true; this.onError(error) }
  }
  end() { if (!this.failed && this.pending.length) { this.failed=true; this.onError(new ProtocolError('Truncated frame')) } }
}
export function encodeFrame(obj, limits) {
  const json = boundedJson(obj, ENVELOPE_LIMITS).text
  const body = Buffer.from(json, 'utf8')
  if (!body.length || body.length > limits.maxMessageBytes) throw new ProtocolError('Outbound frame limit')
  const frame = Buffer.allocUnsafe(body.length + 4)
  frame.writeUInt32BE(body.length, 0); body.copy(frame,4)
  return frame
}
export function writer(stream, limits, onFailure = () => {}) {
  let total=0, chain=Promise.resolve(), closed=false, failure
  let notifyClosed
  const channelEnded=new Promise(resolve=>{notifyClosed=resolve})
  function fail(error) {
    if (failure || closed) return
    failure=error; notifyClosed(error); onFailure(error)
  }
  stream.on('error',fail)
  stream.on('close',()=>fail(new ProtocolError('Channel closed')))
  return { send(obj) {
    if (closed || failure) return Promise.reject(failure || new ProtocolError('Channel closed'))
    const frame=encodeFrame(obj,limits)
    total+=frame.length
    if (total>limits.maxTotalBridgeBytes) return Promise.reject(new ProtocolError('Total outgoing bridge bytes exceeded'))
    const work=Promise.race([chain.then(()=>new Promise((resolve,reject)=>{
      if (failure || stream.destroyed || stream.writableEnded) return reject(failure || new ProtocolError('Channel unavailable'))
      stream.write(frame,error=>error?reject(error):resolve())
    })),channelEnded.then(error=>Promise.reject(error))])
    chain=work.catch(()=>{})
    return work
  }, close() { closed=true; notifyClosed(new ProtocolError('Channel closed')); stream.end() } }
}
