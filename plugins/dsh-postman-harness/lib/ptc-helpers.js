import { POSTMAN_PTC_SUCCESS_STATUSES } from './postman-bridge-core.js'
import { createJsonCodec } from 'dsh-ptc/json'

const DEFAULT_READ_ALL_MAX_BYTES = 4 * 1024 * 1024
// Leave room for the program's surrounding final JSON below the 512 KiB ceiling.
const DEFAULT_RESULT_MAX_BYTES = 480 * 1024
const DEFAULT_PAGE_LIMIT = 2000

const COMMON_HELPERS = String.raw`
  function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer')
    return value
  }
  function optionsObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name + ' options must be an object')
    return value
  }
  api.expectStatus = function expectStatus(result, allowedStatuses) {
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(result)) ||
        !Object.hasOwn(result, 'status') || typeof result.status !== 'string') {
      throw new TypeError('ptc.expectStatus result must be an object with a string status')
    }
    if (typeof allowedStatuses === 'string') {
      if (!Object.hasOwn(successStatuses, allowedStatuses)) throw new TypeError('ptc.expectStatus unknown or unavailable tool: ' + allowedStatuses)
      allowedStatuses = successStatuses[allowedStatuses]
    }
    if (!Array.isArray(allowedStatuses) || allowedStatuses.length === 0 ||
        Array.from(allowedStatuses).some(status => typeof status !== 'string' || status.length === 0)) {
      throw new TypeError('ptc.expectStatus allowedStatuses must be a non-empty list of exact non-empty strings')
    }
    if (!allowedStatuses.includes(result.status)) throw new Error('ptc.expectStatus unexpected status: ' + result.status)
    return result
  }
  api.utf8Bytes = function utf8Bytes(value) {
    if (typeof value !== 'string') throw new TypeError('ptc.utf8Bytes requires a string')
    return jsonCodec.utf8Bytes(value)
  }
  api.jsonBytes = value => jsonCodec.encode(value, jsonLimits, Infinity).bytes
`

const READ_HELPERS = `
  api.readAllText = async function readAllText(rawOptions) {
    const options = optionsObject(rawOptions, 'ptc.readAllText')
    const filePath = options.file_path
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('ptc.readAllText file_path must be a non-empty string')
    const pageLimit = options.page_limit === undefined ? ${DEFAULT_PAGE_LIMIT} : positiveInteger(options.page_limit, 'page_limit')
    const maxBytes = options.max_bytes === undefined ? ${DEFAULT_READ_ALL_MAX_BYTES} : positiveInteger(options.max_bytes, 'max_bytes')
    // Compatibility: the old character option is an additional bound, not a byte budget.
    const maxChars = options.max_chars === undefined ? Infinity : positiveInteger(options.max_chars, 'max_chars')
    if (fullTextRead) {
      const parts = []
      let textOffset = 0, lineOffset = 1, totalChars, totalBytes, version
      for (;;) {
        const page = await tools.read({ file_path: filePath, offset: lineOffset, limit: pageLimit,
          __ptc_text: { offset: textOffset, maxBytes } })
        if (!page || typeof page.text !== 'string' || typeof page.eof !== 'boolean' || typeof page.version !== 'string' ||
            !Number.isSafeInteger(page.totalChars) || page.totalChars < 0 ||
            !Number.isSafeInteger(page.totalBytes) || page.totalBytes < 0 ||
            !Number.isSafeInteger(page.nextLine) || page.nextLine < lineOffset ||
            page.nextOffset !== textOffset + page.text.length || page.nextOffset > page.totalChars ||
            (totalChars !== undefined && (totalChars !== page.totalChars || totalBytes !== page.totalBytes || version !== page.version)) ||
            page.eof !== (page.nextOffset === page.totalChars))
          throw new Error('ptc.readAllText received an invalid or changing full read result; text is incomplete')
        if (!page.eof && !page.text.length) throw new Error('ptc.readAllText made no progress; text is incomplete')
        if (page.totalBytes > maxBytes) throw new Error('ptc.readAllText max_bytes exceeded; text is incomplete')
        parts.push(page.text)
        totalChars = page.totalChars; totalBytes = page.totalBytes; version = page.version
        textOffset = page.nextOffset; lineOffset = page.nextLine
        if (page.eof) break
      }
      const text = parts.join('') // Host pages already preserve the line-text contract.
      if (text.length > maxChars) throw new Error('ptc.readAllText max_chars exceeded; text is incomplete')
      return text
    }
    let offset = 1, bytes = 0, chars = 0, totalLines
    const parts = []
    for (;;) {
      const page = await tools.read({ file_path: filePath, offset, limit: pageLimit })
      if (!page || typeof page !== 'object' || Array.isArray(page) ||
          !Array.isArray(page.lines) || !Number.isSafeInteger(page.totalLines) || page.totalLines < 0 ||
          (totalLines !== undefined && totalLines !== page.totalLines)) {
        throw new Error('ptc.readAllText received an invalid or changing read result')
      }
      totalLines = page.totalLines
      if (page.lines.length === 0) {
        if (offset > totalLines) break
        throw new Error('ptc.readAllText made no progress; text is incomplete')
      }
      const texts = []
      let expectedLine = offset
      for (const line of page.lines) {
        if (!line || line.number !== expectedLine++ || line.number > totalLines || typeof line.text !== 'string') {
          throw new Error('ptc.readAllText received an invalid line or made no forward progress; text is incomplete')
        }
        if (line.text.includes('... (line truncated to ')) {
          throw new Error('ptc.readAllText cannot recover a line truncated by ordinary read')
        }
        texts.push(line.text)
      }
      const chunk = texts.join('\\n')
      const separator = parts.length > 0 ? 1 : 0
      chars += chunk.length + separator
      bytes += api.utf8Bytes(chunk) + separator
      if (bytes > maxBytes || chars > maxChars) {
        throw new Error('ptc.readAllText ' + (bytes > maxBytes ? 'max_bytes' : 'max_chars') + ' exceeded; text is incomplete')
      }
      parts.push(chunk)
      offset = expectedLine
      if (offset > totalLines) break
    }
    return parts.join('\\n')
  }

  function fileOptions(rawOptions, name) {
    const options = optionsObject(rawOptions, name)
    if (!Array.isArray(options.files) || options.files.length === 0 ||
        Array.from(options.files).some(path => typeof path !== 'string' || !path.trim())) {
      throw new TypeError(name + ' files must be a non-empty array of non-empty strings')
    }
    for (const key of ['page_limit','max_bytes_per_file','max_chars_per_file'])
      if (options[key] !== undefined) positiveInteger(options[key], key)
    return options
  }
  function readOptions(options, filePath) {
    return { file_path: filePath, page_limit: options.page_limit,
      max_bytes: options.max_bytes_per_file, max_chars: options.max_chars_per_file }
  }
  function retainsSource(value, text) {
    if (typeof value === 'string') return value === text || (text.length >= 1024 && value.includes(text))
    if (!value || typeof value !== 'object') return false
    return Object.values(value).some(item => retainsSource(item, text))
  }
  async function collectFiles(options, mapper, name) {
    const maxTotal = options.max_total_bytes === undefined ? ${DEFAULT_RESULT_MAX_BYTES} : positiveInteger(options.max_total_bytes, 'max_total_bytes')
    const results = []
    let bytes = 2 // JSON array brackets; each retained result is measured with escaping.
    for (const filePath of options.files.slice()) {
      const text = await api.readAllText(readOptions(options, filePath))
      const result = await mapper({ file_path: filePath, text })
      const resultBytes = api.jsonBytes(result) // Validate before walking or retaining mapper data.
      if (name === 'ptc.mapTextFiles' && text.length > 0 && retainsSource(result, text)) {
        throw new Error('ptc.mapTextFiles must reduce text, not retain the full source text (including nested fields); use ptc.readMany for raw files inside PTC')
      }
      bytes += resultBytes + (results.length ? 1 : 0)
      if (bytes > maxTotal) throw new Error(name + ' max_total_bytes exceeded; read large internally, return compact (use mapTextFiles)')
      results.push(result)
    }
    return results
  }
  api.readMany = async function readMany(rawOptions) {
    return collectFiles(fileOptions(rawOptions, 'ptc.readMany'), value => value, 'ptc.readMany')
  }
  api.mapTextFiles = async function mapTextFiles(rawOptions, mapper) {
    const options = fileOptions(rawOptions, 'ptc.mapTextFiles')
    if (typeof mapper !== 'function') throw new TypeError('ptc.mapTextFiles mapper must be a local function')
    return collectFiles(options, mapper, 'ptc.mapTextFiles')
  }
`

const GREP_HELPERS = `
  api.grepMany = async function grepMany(rawOptions) {
    const options = rawOptions
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        !Array.isArray(options.queries) || options.queries.length === 0) {
      throw new TypeError('ptc.grepMany queries must be a non-empty array')
    }

    const queries = Array.from(options.queries)
    if (queries.some(query => !query || typeof query !== 'object' || Array.isArray(query) ||
        typeof query.pattern !== 'string' || (query.path !== undefined && typeof query.path !== 'string') ||
        (query.include !== undefined && typeof query.include !== 'string'))) {
      throw new TypeError('ptc.grepMany each query must be an object with a string pattern and optional string path/include')
    }
    const results = []
    for (const query of queries) {
      const result = await tools.grep(query)
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.matches)) {
        throw new TypeError('ptc.grepMany expected tools.grep result {matches: Array}; raw tool results are objects, not iterable arrays')
      }
      const item = { query, result }
      api.jsonBytes(item) // Validate retained JSON without a new helper-specific byte ceiling.
      results.push(item)
    }
    return results
  }
`

export function buildPtcHelperPrelude(toolNames, jsonLimits = { maxValueDepth: 32, maxValueNodes: 10000 }, fullTextRead = false) {
  const names = new Set(toolNames)
  const successStatuses = Object.fromEntries(Object.entries(POSTMAN_PTC_SUCCESS_STATUSES).filter(([name]) => names.has(name)))
  const sections = ['const successStatuses = ' + JSON.stringify(successStatuses) + '; Object.values(successStatuses).forEach(Object.freeze); Object.freeze(successStatuses);', COMMON_HELPERS]
  if (names.has('read')) sections.push(READ_HELPERS)
  if (names.has('grep')) sections.push(GREP_HELPERS)
  return `const ptc = (() => {
  const api = Object.create(null)
  const jsonCodec = (${createJsonCodec.toString()})()
  const jsonLimits = ${JSON.stringify(jsonLimits)}
  const fullTextRead = ${fullTextRead}
${sections.join('\n')}
  return Object.freeze(api)
})()
`
}

export function ptcHelperGuidance(toolNames) {
  const names = new Set(toolNames)
  const helpers = ['ptc.expectStatus(result, allowedStatusesOrVisiblePostmanToolName)', 'ptc.utf8Bytes(text)', 'ptc.jsonBytes(value)']
  if (names.has('read')) helpers.push(
    'ptc.readAllText({file_path, page_limit?, max_bytes?, max_chars?})',
    'ptc.readMany({files, page_limit?, max_bytes_per_file?, max_chars_per_file?, max_total_bytes?})',
    'ptc.mapTextFiles({files, page_limit?, max_bytes_per_file?, max_chars_per_file?, max_total_bytes?}, mapper)',
  )
  if (names.has('grep')) helpers.push('ptc.grepMany({queries})')
  return 'PTC helpers available: ' + helpers.join(', ') + '. ' +
    'expectStatus accepts either your exact status array or a visible Postman tool name for Host-maintained exact success statuses; unknown statuses still stop. ' +
    'Returns: readAllText -> string; readMany -> Array<{file_path,text}>; mapTextFiles -> Array<mapper JSON>; grepMany -> Array<{query,result:{matches:Array}}> (not a flat match array). ' +
    'Raw tool values are objects: read.lines, glob.paths, grep.matches; do not iterate the whole result. ' +
    'Full reads default to 4 MiB UTF-8 per file internally. readMany and mapTextFiles bound aggregate retained JSON to 480 KiB by default; explicit max_total_bytes allows larger internal data, not larger final output. grepMany has no separate retained-result byte ceiling. ' +
    'Character options remain additional compatibility bounds. Ordinary read line truncation is unrecoverable. Read large internally, prefer mapTextFiles for mechanical reduction and return compact when possible; needed larger results remain valid up to the standard 512 KiB output limit. Result and aggregate logs have separate budgets. ' +
    'Read once and reuse local text for multiple checks in the same program; reread after write/edit or when freshness is needed. No helper caches files. '
}
