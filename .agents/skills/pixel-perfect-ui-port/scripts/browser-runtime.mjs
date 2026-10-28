export async function requireHardwareGpu(browser) {
  const session = await browser.newBrowserCDPSession()
  try {
    const { gpu } = await session.send('SystemInfo.getInfo')
    const renderer = gpu?.auxAttributes?.glRenderer || ''
    const webgl = gpu?.featureStatus?.webgl
    const webgl2 = gpu?.featureStatus?.webgl2
    // A device in gpu.devices is not proof: NVIDIA can be present while ANGLE
    // renders through SwiftShader/WARP. Check the actual renderer and WebGL state.
    if (!renderer || /swiftshader|llvmpipe|softpipe|software|microsoft basic|\bwarp\b/i.test(renderer) ||
        ![webgl, webgl2].some(status => status === 'enabled')) {
      throw new Error('HARDWARE_GPU_UNAVAILABLE: ' + JSON.stringify({ renderer, webgl, webgl2 }))
    }
    return { renderer, webgl, webgl2 }
  } finally { await session.detach() }
}

// Configure only the supplied Playwright launcher. Other browser sessions and
// preview servers are never enumerated or terminated.
export function configureHardwareChromium(chromium) {
  const launch = chromium.launch.bind(chromium)
  const browsers = new Set()
  const pending = new Set()
  let stopping = false
  let closing
  chromium.launch = options => {
    if (stopping) return Promise.reject(new Error('BROWSER_SESSION_CLOSED'))
    const opening = Promise.resolve().then(() => launch({
      ...options,
      headless: true,
      channel: options?.channel ?? 'chromium',
      args: [...new Set([...(options?.args ?? []), '--enable-gpu'])]
    })).then(async browser => {
      if (stopping) {
        await browser.close()
        throw new Error('BROWSER_SESSION_CLOSED')
      }
      browsers.add(browser)
      browser.once?.('disconnected', () => browsers.delete(browser))
      try {
        await requireHardwareGpu(browser)
        if (stopping) throw new Error('BROWSER_SESSION_CLOSED')
        return browser
      } catch (error) {
        browsers.delete(browser)
        await browser.close()
        throw error
      }
    })
    pending.add(opening)
    return opening.finally(() => pending.delete(opening))
  }
  return () => {
    stopping = true
    return closing ??= (async () => {
      await Promise.allSettled([...browsers].map(browser => browser.close()))
      await Promise.allSettled([...pending])
      browsers.clear()
    })()
  }
}

// Temporary project tests use the same launch and GPU check without modifying
// their Playwright instance or joining a persistent MCP browser session.
export async function withHardwareChromium(chromium, operation, { signal, ...options } = {}) {
  signal?.throwIfAborted()
  const owned = { launch: chromium.launch.bind(chromium) }
  const close = configureHardwareChromium(owned)
  let rejectAbort
  const cancelled = new Promise((_, reject) => { rejectAbort = reject })
  const abort = () => {
    void close()
    rejectAbort(signal?.reason ?? new DOMException('Browser test cancelled', 'AbortError'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    return await Promise.race([cancelled, (async () => {
      const browser = await owned.launch(options)
      signal?.throwIfAborted()
      return operation(browser)
    })()])
  } finally {
    signal?.removeEventListener('abort', abort)
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    await close()
  }
}

