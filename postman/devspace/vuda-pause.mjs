// Explicit pause only: silence between MCP calls can be a running game test.
export const pauseTool = {
  name: 'vuda_pause',
  description: 'Pause JavaScript in this chat’s VUDA page while working on code or after finishing browser checks. Keeps the page and its state; the next browser tool automatically resumes it. Call when the page is no longer needed now. Do NOT pause while a game, animation, timer or unattended browser test must continue running. Other chats are unaffected; the 30-minute idle close still applies.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
}

export function configureVudaPause(chromium) {
  const launch = chromium.launch.bind(chromium)
  const browsers = new Set()
  const frozen = new Map()
  chromium.launch = async options => {
    const browser = await launch(options)
    browsers.add(browser)
    browser.once?.('disconnected', () => browsers.delete(browser))
    return browser
  }
  async function resume() {
    for (const [page, session] of frozen) {
      if (!page.isClosed()) {
        await session.send('Debugger.disable')
      }
      frozen.delete(page)
      await session.detach().catch(() => {})
    }
  }
  return {
    resume,
    async pause() {
      try {
        for (const browser of browsers) {
          for (const context of browser.contexts()) {
            for (const page of context.pages()) {
              if (page.isClosed() || frozen.has(page)) continue
              const session = await context.newCDPSession(page)
              // Record before sending so partial failure can resume every page.
              frozen.set(page, session)
              // Lifecycle freezing is ineffective on Playwright's force-visible
              // pages. Pause JS instead, retaining its stack and pending callbacks.
              await session.send('Debugger.enable')
              let timer, onPaused
              const paused = new Promise((resolve, reject) => {
                onPaused = resolve
                timer = setTimeout(() => reject(new Error('VUDA_PAUSE_TIMEOUT')), 5_000)
                session.once('Debugger.paused', onPaused)
              })
              // An idle page may never reach Debugger.pause's next statement.
              // This separate debugger statement pauses even without app timers;
              // its CDP response completes when resume disables this debugger.
              const execution = session.send('Runtime.evaluate', { expression: 'debugger;', disableBreaks: false })
              try {
                await Promise.race([paused, execution.then(() => {
                  throw new Error('VUDA_PAUSE_NOT_CONFIRMED')
                })])
              }
              finally { clearTimeout(timer); session.off('Debugger.paused', onPaused) }
            }
          }
        }
        return frozen.size
      } catch (error) {
        await resume()
        throw error
      }
    }
  }
}

export function installVudaPauseHandlers(Server, lifecycle) {
  const original = Server.prototype.setRequestHandler
  Server.prototype.setRequestHandler = function (schema, handler) {
    const method = schema.shape.method.value
    if (method === 'tools/list') {
      return original.call(this, schema, async (...args) => {
        const result = await handler(...args)
        return { ...result, tools: [...result.tools, pauseTool] }
      })
    }
    if (method === 'tools/call') {
      // Also serialize local MCP calls: pause must never interrupt an active tool.
      let tail = Promise.resolve()
      return original.call(this, schema, (...args) => {
        const next = tail.then(async () => {
          if (args[0].params.name === pauseTool.name) {
            const pausedPages = await lifecycle.pause()
            return { content: [{ type: 'text', text: JSON.stringify({ paused: true, pausedPages,
              resumesOnNextTool: true }) }] }
          }
          await lifecycle.resume()
          return handler(...args)
        })
        tail = next.catch(() => {})
        return next
      })
    }
    return original.call(this, schema, handler)
  }
  return () => { Server.prototype.setRequestHandler = original }
}
