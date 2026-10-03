import { types } from 'node:util'

export class JsonLimitError extends TypeError {
  constructor(code, message = 'JSON ' + code + ' limit exceeded') { super(message); this.code = code }
}

// One descriptor-only validator for Host, QuickJS boundary and PTC helpers.
// Capture intrinsics before program code runs; never invoke getters or toJSON.
export function createJsonCodec(isProxy = () => false) {
  const keys = Reflect.ownKeys, desc = Object.getOwnPropertyDescriptor, proto = Object.getPrototypeOf
  const create = Object.create, setProto = Object.setPrototypeOf, stringify = JSON.stringify
  const array = Array.isArray, finite = Number.isFinite, own = Object.hasOwn
  const objectProto = Object.prototype, arrayProto = Array.prototype, SetType = Set, ErrorType = TypeError
  const call = Function.prototype.call.bind(Function.prototype.call)
  const has = Set.prototype.has, add = Set.prototype.add, remove = Set.prototype.delete
  const charCodeAt = String.prototype.charCodeAt, number = Number, string = String, integer = Number.isSafeInteger
  const test = RegExp.prototype.test, indexPattern = /^(0|[1-9][0-9]*)$/, namePattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/
  const utf8Bytes = text => {
    let bytes = 0
    for (let i = 0; i < text.length; i++) {
      const code = call(charCodeAt, text, i)
      if (code < 0x80) bytes++
      else if (code < 0x800) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
          call(charCodeAt, text, i + 1) >= 0xdc00 && call(charCodeAt, text, i + 1) <= 0xdfff) { bytes += 4; i++ }
      else bytes += 3
    }
    return bytes
  }
  const fieldPath = (path, key, isArray) => typeof key !== 'string' ? path + '[symbol key]' :
    isArray && call(test, indexPattern, key) ? path + '[' + key + ']' :
    call(test, namePattern, key) ? path + '.' + key : path + '[' + stringify(key) + ']'
  const fail = (path, reason, code = 'invalid-json') => {
    const error = new ErrorType(path + ': ' + reason + '.')
    error.code = code
    throw error
  }
  function encode(value, limits, byteLimit = limits.maxMessageBytes, byteCode = 'maxMessageBytes') {
    let count = 0
    const seen = new SetType(), arrays = []
    function visit(item, depth, path) {
      if (++count > limits.maxValueNodes) fail(path, 'JSON node limit exceeded', 'maxValueNodes')
      if (depth > limits.maxValueDepth) fail(path, 'JSON depth limit exceeded', 'maxValueDepth')
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
      if (typeof item === 'number') {
        if (!finite(item)) fail(path, 'non-finite number is not JSON-compatible')
        return item
      }
      if (typeof item !== 'object') fail(path, typeof item + ' is not JSON-compatible')
      if (isProxy(item)) fail(path, 'proxy is not JSON-compatible')
      if (call(has, seen, item)) fail(path, 'circular reference is not JSON-compatible')
      call(add, seen, item)
      const isArray = array(item), prototype = proto(item)
      if (isArray ? prototype !== arrayProto : prototype !== objectProto && prototype !== null)
        fail(path, 'nonstandard ' + (isArray ? 'array' : 'object') + ' is not JSON-compatible')
      const out = isArray ? [] : create(null)
      if (isArray) { setProto(out, null); arrays[arrays.length] = out }
      const length = isArray ? desc(item, 'length').value : 0
      for (const key of keys(item)) {
        if (isArray && key === 'length') continue
        const child = fieldPath(path, key, isArray)
        if (typeof key !== 'string') fail(child, 'symbol key is not JSON-compatible')
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail(child, 'unsafe key is not JSON-compatible')
        if (isArray && (!integer(number(key)) || number(key) < 0 || string(number(key)) !== key || number(key) >= length))
          fail(child, 'extra array field is not JSON-compatible')
        const field = desc(item, key)
        if (!field || !own(field, 'value')) fail(child, 'accessor is not JSON-compatible')
        if (!field.enumerable) fail(child, 'nonenumerable field is not JSON-compatible')
        out[key] = visit(field.value, depth + 1, child)
      }
      if (isArray) for (let i = 0; i < length; i++)
        if (!own(out, '' + i)) fail(path + '[' + i + ']', 'array hole is not JSON-compatible')
      call(remove, seen, item)
      return out
    }
    const copy = visit(value, 1, 'value'), text = stringify(copy), bytes = utf8Bytes(text)
    for (let i = 0; i < arrays.length; i++) setProto(arrays[i], arrayProto)
    if (bytes > byteLimit) fail('value', 'JSON byte limit exceeded (' + byteCode + ')', byteCode)
    return { value: copy, text, bytes }
  }
  return { encode, utf8Bytes }
}

const codec = createJsonCodec(types.isProxy)
export function boundedJson(value, limits, byteLimit = limits.maxMessageBytes) {
  try { return codec.encode(value, limits, byteLimit) }
  catch (error) {
    if (['maxValueNodes', 'maxValueDepth', 'maxMessageBytes'].includes(error.code))
      throw new JsonLimitError(error.code, error.message)
    throw error
  }
}
