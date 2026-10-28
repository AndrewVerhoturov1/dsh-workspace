import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findVudaRuntime } from './vuda-runtime.mjs'

// VUDA 1.1.0 has no launch-options setting. Change only its in-process
// Playwright instance; the pixel verifier and other MCP servers are unaffected.
export function configureVudaChromium(chromium) {
  const launch = chromium.launch.bind(chromium)
  const browsers = new Set()
  const pending = new Set()
  chromium.launch = options => {
    const opening = Promise.resolve().then(() => launch({
      ...options,
      headless: true,
      channel: options?.channel ?? 'chromium',
      args: [...new Set([...(options?.args ?? []), '--enable-gpu'])]
    }))
    pending.add(opening)
    return opening.then(browser => {
      if (browser) {
        browsers.add(browser)
        browser.once?.('disconnected', () => browsers.delete(browser))
      }
      return browser
    }).finally(() => pending.delete(opening))
  }
  return async () => {
    await Promise.allSettled([...pending])
    await Promise.allSettled([...browsers].map(async browser => browser.close()))
    browsers.clear()
  }
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
  const closeBrowsers = configureVudaChromium(chromium)
  let closing
  const shutdown = () => {
    // Windows MCP shutdown closes stdin before it forcibly terminates Node.
    // Close only browsers launched by this server while graceful cleanup is possible.
    closing ??= closeBrowsers().finally(() => process.exit(0))
  }
  process.stdin.once('end', shutdown)
  process.stdin.once('close', shutdown)
  await import(pathToFileURL(runtime.serverEntry).href)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startVuda({ packageDirectory: process.argv[2], root: process.argv[3] })
}
