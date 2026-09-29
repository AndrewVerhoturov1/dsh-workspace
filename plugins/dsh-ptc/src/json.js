import { plain, ownData, FORBIDDEN } from './profiles.js'
import { types } from 'node:util'

// Never stringify arbitrary host values: getters and toJSON must not execute.
export function boundedJson(value, limits, byteLimit = limits.maxMessageBytes) {
  let count = 0
  function visit(item, depth, seen) {
    if (++count > limits.maxValueNodes || depth > limits.maxValueDepth) throw new TypeError('JSON depth or node limit exceeded')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || types.isProxy(item)) throw new TypeError('Unsupported JSON value')
    if (seen.has(item)) throw new TypeError('Cyclic JSON value')
    seen.add(item)
    let out
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).some(k => k !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(String(k)) || Number(k) >= item.length))) throw new TypeError('Nonstandard JSON array')
      out = []
      for (let i = 0; i < item.length; i++) out.push(visit(ownData(item, String(i)), depth + 1, seen))
    } else {
      plain(item)
      out = Object.create(null)
      if (Reflect.ownKeys(item).length !== Object.keys(item).length) throw new TypeError('Nonenumerable JSON property')
      for (const key of Object.keys(item)) {
        if (FORBIDDEN.has(key)) throw new TypeError('Unsafe JSON key')
        out[key] = visit(ownData(item, key), depth + 1, seen)
      }
    }
    seen.delete(item)
    return out
  }
  const copy = visit(value, 1, new Set())
  const text = JSON.stringify(copy)
  if (Buffer.byteLength(text, 'utf8') > byteLimit) throw new TypeError('JSON byte limit exceeded')
  return { value: copy, text }
}
