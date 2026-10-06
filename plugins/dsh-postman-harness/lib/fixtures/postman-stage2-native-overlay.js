import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

// Exact checked-in native patch overlay in memory, never SDK mutations.
const patch = readFileSync(new URL('../../../../system/patches/postman-native-child-cutoff.patch', import.meta.url), 'utf8')
const lines = patch.replaceAll(String.fromCharCode(13), "").split(String.fromCharCode(10))
const hunks = []; let current, file
for (const line of lines) {
  if (line.startsWith('diff --git ')) { file = line.split(' b/node_modules/')[1]; current = null; continue }
  if (line.startsWith('---') || line.startsWith('+++')) continue
  if (line.startsWith('@@')) { current = { before: [], after: [], file }; hunks.push(current); continue }
  if (!current || ![' ', '+', '-'].includes(line[0])) continue
  if (line[0] !== '+') current.before.push(line.slice(1))
  if (line[0] !== '-') current.after.push(line.slice(1))
}
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  const matching = hunks.filter(hunk => url.endsWith('/' + hunk.file))
  if (!matching.length) return result
  let source = String(result.source)
  for (const hunk of matching) {
    const before = hunk.before.join(String.fromCharCode(10)) + String.fromCharCode(10)
    const after = hunk.after.join(String.fromCharCode(10)) + String.fromCharCode(10)
    if (source.split(before).length !== 2) throw new Error('Native cutoff baseline hunk mismatch: ' + before.slice(0, 120))
    source = source.replace(before, after)
  }
  return { ...result, source }
} })
