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
    if (!Array.isArray(allowedStatuses) || allowedStatuses.length === 0 ||
        Array.from(allowedStatuses).some(status => typeof status !== 'string' || status.length === 0)) {
      throw new TypeError('ptc.expectStatus allowedStatuses must be a non-empty list of exact non-empty strings')
    }
    if (!allowedStatuses.includes(result.status)) throw new Error('ptc.expectStatus unexpected status: ' + result.status)
    return result
  }
  api.utf8Bytes = function utf8Bytes(value) {
    if (typeof value !== 'string') throw new TypeError('ptc.utf8Bytes requires a string')
    let bytes = 0
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code < 0x80) bytes++
      else if (code < 0x800) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length &&
          value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++ }
      else bytes += 3
    }
    return bytes
  }
  api.jsonBytes = function jsonBytes(value) {
    const json = JSON.stringify(value, function(key, item) {
      const original = this[key]
      if (original === undefined || typeof original === 'function' || typeof original === 'symbol' ||
          typeof original === 'bigint' || (typeof original === 'number' && !Number.isFinite(original)) ||
          (original && typeof original === 'object' && !Array.isArray(original) &&
            ![Object.prototype, null].includes(Object.getPrototypeOf(original)))) {
        throw new TypeError('ptc.jsonBytes requires JSON-compatible data')
      }
      return item
    })
    return api.utf8Bytes(json)
  }
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
    let offset = 1, bytes = 0, chars = 0, totalLines
    const parts = []
    for (;;) {
      const page = await tools.read({ file_path: filePath, offset, limit: pageLimit })
      if (!page || !Array.isArray(page.lines) || !Number.isSafeInteger(page.totalLines) || page.totalLines < 0 ||
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
    return options
  }
  function readOptions(options, filePath) {
    return { file_path: filePath, page_limit: options.page_limit,
      max_bytes: options.max_bytes_per_file, max_chars: options.max_chars_per_file }
  }
  async function collectFiles(options, mapper, name) {
    const maxTotal = options.max_total_bytes === undefined ? ${DEFAULT_RESULT_MAX_BYTES} : positiveInteger(options.max_total_bytes, 'max_total_bytes')
    const results = []
    let bytes = 2 // JSON array brackets; each retained result is measured with escaping.
    for (const filePath of options.files.slice()) {
      const text = await api.readAllText(readOptions(options, filePath))
      const result = await mapper({ file_path: filePath, text })
      if (name === 'ptc.mapTextFiles' && (result === text ||
          (result && typeof result === 'object' && Object.values(result).some(value => value === text)))) {
        throw new Error('ptc.mapTextFiles must reduce text, not retain the full source text; use ptc.readMany for raw files')
      }
      bytes += api.jsonBytes(result) + (results.length ? 1 : 0)
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

    const results = []
    for (const query of options.queries) {
      if (!query || typeof query !== 'object' || Array.isArray(query)) {
        throw new TypeError('ptc.grepMany each query must be an object')
      }
      results.push({ query, result: await tools.grep(query) })
    }
    return results
  }
`

export function buildPtcHelperPrelude(toolNames) {
  const names = new Set(toolNames)
  const sections = [COMMON_HELPERS]
  if (names.has('read')) sections.push(READ_HELPERS)
  if (names.has('grep')) sections.push(GREP_HELPERS)
  return `const ptc = (() => {
  const api = Object.create(null)
${sections.join('\n')}
  return Object.freeze(api)
})()
`
}

export function ptcHelperGuidance(toolNames) {
  const names = new Set(toolNames)
  const helpers = ['ptc.expectStatus(result, allowedStatuses)', 'ptc.utf8Bytes(text)', 'ptc.jsonBytes(value)']
  if (names.has('read')) helpers.push(
    'ptc.readAllText({file_path, page_limit?, max_bytes?, max_chars?})',
    'ptc.readMany({files, page_limit?, max_bytes_per_file?, max_chars_per_file?, max_total_bytes?})',
    'ptc.mapTextFiles({files, page_limit?, max_bytes_per_file?, max_chars_per_file?, max_total_bytes?}, mapper)',
  )
  if (names.has('grep')) helpers.push('ptc.grepMany({queries})')
  return 'PTC helpers available: ' + helpers.join(', ') + '. ' +
    'Full reads default to 4 MiB UTF-8 per file internally. readMany and mapTextFiles bound aggregate retained JSON to 480 KiB by default; explicit max_total_bytes allows larger internal data, not larger final output. ' +
    'Character options remain additional compatibility bounds. Ordinary read line truncation is unrecoverable. Read large internally, return compact; final model-facing JSON remains limited to 512 KiB. '
}
