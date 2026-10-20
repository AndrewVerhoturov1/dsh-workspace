import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findVudaRuntime } from './vuda-runtime.mjs'

// VUDA 1.1.0 has no launch-options setting. Change only its in-process
// Playwright instance; the pixel verifier and other MCP servers are unaffected.
export function configureVudaChromium(chromium) {
  const launch = chromium.launch.bind(chromium)
  chromium.launch = options => launch({
    ...options,
    headless: true,
    channel: options?.channel ?? 'chromium',
    args: [...new Set([...(options?.args ?? []), '--enable-gpu'])]
  })
}

export async function startVuda(options) {
  const runtime = await findVudaRuntime(options)
  // The tunnel's API key and inherited provider credentials must not reach VUDA.
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile',
    'localappdata', 'appdata', 'comspec', 'pathext', 'home', 'lang'])
  for (const key of Object.keys(process.env)) {
    if (!allowed.has(key.toLowerCase())) delete process.env[key]
  }
  Object.assign(process.env, runtime.env)
  process.chdir(runtime.cwd)
  const require = createRequire(runtime.serverEntry)
  const { chromium } = require('playwright')
  configureVudaChromium(chromium)
  await import(pathToFileURL(runtime.serverEntry).href)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startVuda({ packageDirectory: process.argv[2], root: process.argv[3] })
}
