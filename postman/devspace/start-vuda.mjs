import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findVudaRuntime } from './vuda-runtime.mjs'

import { configureHardwareChromium } from '../../.agents/skills/pixel-perfect-ui-port/scripts/browser-runtime.mjs'
export { configureHardwareChromium as configureVudaChromium, requireHardwareGpu, withHardwareChromium }
  from '../../.agents/skills/pixel-perfect-ui-port/scripts/browser-runtime.mjs'

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
  const closeBrowsers = configureHardwareChromium(chromium)
  let closing
  const shutdown = () => {
    // Windows MCP shutdown closes stdin before it forcibly terminates Node.
    // Close only browsers launched by this server while graceful cleanup is possible.
    closing ??= closeBrowsers().finally(() => process.exit(0))
  }
  process.stdin.once('end', shutdown)
  process.stdin.once('close', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await import(pathToFileURL(runtime.serverEntry).href)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startVuda({ packageDirectory: process.argv[2], root: process.argv[3] })
}
