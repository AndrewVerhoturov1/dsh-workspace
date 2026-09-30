const DEFAULT_READ_ALL_MAX_CHARS = 450000
const DEFAULT_PAGE_LIMIT = 2000

const READ_HELPERS = `
  function positiveInteger(value, name) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer')
    return value
  }

  function optionsObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(name + ' options must be an object')
    return value
  }

  api.readAllText = async function readAllText(rawOptions) {
    const options = optionsObject(rawOptions, 'ptc.readAllText')
    const filePath = options.file_path
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('ptc.readAllText file_path must be a non-empty string')
    const pageLimit = options.page_limit === undefined ? ${DEFAULT_PAGE_LIMIT} : positiveInteger(options.page_limit, 'page_limit')
    const maxChars = options.max_chars === undefined ? ${DEFAULT_READ_ALL_MAX_CHARS} : positiveInteger(options.max_chars, 'max_chars')

    let offset = 1
    let chars = 0
    const parts = []

    for (;;) {
      const page = await tools.read({ file_path: filePath, offset, limit: pageLimit })
      if (!page || !Array.isArray(page.lines) || !Number.isInteger(page.totalLines) || page.totalLines < 0) {
        throw new Error('ptc.readAllText received an invalid read result')
      }

      if (page.lines.length === 0) {
        if (page.totalLines === 0 || offset > page.totalLines) break
        throw new Error('ptc.readAllText made no progress')
      }

      const texts = []
      for (const line of page.lines) {
        if (!line || !Number.isInteger(line.number) || typeof line.text !== 'string') {
          throw new Error('ptc.readAllText received an invalid line')
        }
        if (line.text.includes('... (line truncated to ')) {
          throw new Error('ptc.readAllText cannot recover a line truncated by ordinary read')
        }
        texts.push(line.text)
      }

      const chunk = texts.join('\\n')
      chars += chunk.length + (parts.length > 0 ? 1 : 0)
      if (chars > maxChars) {
        throw new Error('ptc.readAllText max_chars exceeded; process/filter the file inside PTC instead of returning it whole')
      }
      parts.push(chunk)

      const lastLine = page.lines[page.lines.length - 1].number
      if (lastLine >= page.totalLines) break
      if (lastLine < offset) throw new Error('ptc.readAllText made no forward progress')
      offset = lastLine + 1
    }

    return parts.join('\\n')
  }

  api.readMany = async function readMany(rawOptions) {
    const options = optionsObject(rawOptions, 'ptc.readMany')
    if (!Array.isArray(options.files) || options.files.length === 0) {
      throw new TypeError('ptc.readMany files must be a non-empty array')
    }

    const results = []
    for (const filePath of options.files) {
      if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('ptc.readMany file paths must be non-empty strings')
      const text = await api.readAllText({
        file_path: filePath,
        ...(options.page_limit === undefined ? {} : { page_limit: options.page_limit }),
        ...(options.max_chars_per_file === undefined ? {} : { max_chars: options.max_chars_per_file }),
      })
      results.push({ file_path: filePath, text })
    }
    return results
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
  const sections = []
  if (names.has('read')) sections.push(READ_HELPERS)
  if (names.has('grep')) sections.push(GREP_HELPERS)
  if (sections.length === 0) return ''

  return `const ptc = (() => {
  const api = Object.create(null)
${sections.join('\n')}
  return Object.freeze(api)
})()
`
}

export function ptcHelperGuidance(toolNames) {
  const names = new Set(toolNames)
  const helpers = []
  if (names.has('read')) {
    helpers.push(
      'ptc.readAllText({file_path, page_limit?, max_chars?})',
      'ptc.readMany({files, page_limit?, max_chars_per_file?})',
    )
  }
  if (names.has('grep')) helpers.push('ptc.grepMany({queries})')
  if (helpers.length === 0) return ''

  return 'PTC helpers available: ' + helpers.join(', ') + '. ' +
    'Use them to keep sequential mechanical work inside one ptc_execute; end the batch only when a new model decision, user input, or external async event is required. '
}
