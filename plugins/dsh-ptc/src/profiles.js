import { types } from 'node:util'
// Profile v1 is data, not an agent role or an executable policy source.
export const DEFAULT_LIMITS = Object.freeze({
  maxProgramBytes: 262144, maxWallMs: 10000, quickjsMemoryBytes: 33554432,
  maxStackBytes: 524288, maxToolCalls: 64, maxConcurrentToolCalls: 4,
  maxQueuedToolCalls: 16, maxMessageBytes: 1048576,
  maxTotalBridgeBytes: 8388608, maxOutputBytes: 65536,
  maxLogEntries: 256, maxValueDepth: 32, maxValueNodes: 10000,
})
export const MAX_LIMITS = Object.freeze({
  maxProgramBytes: 262144, maxWallMs: 30000, quickjsMemoryBytes: 67108864,
  maxStackBytes: 1048576, maxToolCalls: 256, maxConcurrentToolCalls: 8,
  maxQueuedToolCalls: 32, maxMessageBytes: 1048576,
  maxTotalBridgeBytes: 16777216, maxOutputBytes: 65536,
  maxLogEntries: 256, maxValueDepth: 32, maxValueNodes: 10000,
})
const MIN_LIMITS = Object.freeze({
  maxProgramBytes: 1, maxWallMs: 100, quickjsMemoryBytes: 8388608,
  maxStackBytes: 65536, maxToolCalls: 0, maxConcurrentToolCalls: 0,
  maxQueuedToolCalls: 0, maxMessageBytes: 1024,
  maxTotalBridgeBytes: 2048, maxOutputBytes: 0,
  maxLogEntries: 0, maxValueDepth: 1, maxValueNodes: 1,
})
export const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])
export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export function ownData(object, key) {
  if (types.isProxy(object)) throw new TypeError('Proxy object is not supported')
  const d = Object.getOwnPropertyDescriptor(object, key)
  if (!d || !Object.hasOwn(d, 'value')) throw new TypeError(`Missing or accessor property: ` + key)
  return d.value
}
export function plain(object) {
  if (!object || typeof object !== 'object' || types.isProxy(object) || Array.isArray(object) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(object))) throw new TypeError('Expected plain object')
  if (Object.getOwnPropertySymbols(object).length) throw new TypeError('Symbol keys are not supported')
  return object
}
function exact(object, keys) {
  plain(object)
  if (Reflect.ownKeys(object).length !== keys.length ||
      keys.some(key => !Object.hasOwn(object, key))) throw new TypeError('Unknown or missing profile field')
}
export function validatePtcProfile(input) {
  exact(input, ['schemaVersion', 'id', 'revision', 'tools', 'limits'])
  if (ownData(input, 'schemaVersion') !== 1) throw new TypeError('Unsupported profile version')
  const id = ownData(input, 'id'), revision = ownData(input, 'revision')
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || FORBIDDEN.has(id)) throw new TypeError('Invalid profile id')
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1000000) throw new TypeError('Invalid revision')
  const tools = ownData(input, 'tools')
  if (types.isProxy(tools) || !Array.isArray(tools) || tools.length > 64 || Reflect.ownKeys(tools).some(k => k !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(String(k)) || Number(k) >= tools.length))) throw new TypeError('Invalid tools array')
  const seen = new Set()
  const names = []
  for (let i = 0; i < tools.length; i++) {
    const name = ownData(tools, String(i))
    if (typeof name !== 'string' || name.length > 64 || !NAME.test(name) || FORBIDDEN.has(name) || seen.has(name)) throw new TypeError('Invalid or duplicate tool name')
    seen.add(name); names.push(name)
  }
  const limits = ownData(input, 'limits')
  exact(limits, Object.keys(DEFAULT_LIMITS))
  const copy = Object.create(null)
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const n = ownData(limits, key)
    if (!Number.isSafeInteger(n) || n < MIN_LIMITS[key] || n > MAX_LIMITS[key]) throw new TypeError('Invalid limit: ' + key)
    copy[key] = n
  }
  if (copy.maxConcurrentToolCalls > copy.maxToolCalls || copy.maxQueuedToolCalls > copy.maxToolCalls ||
      (copy.maxToolCalls > 0 && !copy.maxConcurrentToolCalls) ||
      copy.maxOutputBytes + 2048 > copy.maxMessageBytes ||
      copy.maxProgramBytes + 8192 > copy.maxMessageBytes ||
      copy.maxMessageBytes + 4 > copy.maxTotalBridgeBytes) throw new TypeError('Incompatible limits')
  const snapshot = Object.freeze({ schemaVersion: 1, id, revision, tools: Object.freeze(names), limits: Object.freeze(copy) })
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 8192) throw new TypeError('Profile exceeds 8192 bytes')
  return snapshot
}
