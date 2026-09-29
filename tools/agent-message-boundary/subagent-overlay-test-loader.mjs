// Load the SHA-pinned offline overlay for isolated tests without editing installed DSH.
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { patchSubagentSource } from './subagent-result-overlay.mjs'

const root = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'),
  'npm/node_modules/@deepseek-ai/dsh')
const file = join(root, 'node_modules/@deepseek-ai/dsh-subagent/lib/index.js')
const url = pathToFileURL(file).href
registerHooks({
  load(specifier, context, nextLoad) {
    if (specifier !== url) return nextLoad(specifier, context)
    return { format: 'module', shortCircuit: true, source: patchSubagentSource(readFileSync(file, 'utf8')) }
  },
})
