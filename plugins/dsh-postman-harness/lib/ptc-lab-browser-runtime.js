export const PTC_LAB_DEFAULT_PROGRAM = `console.log('simulation only');\nconst report = await tools.plan({intent: 'inspect'});\nreturn {role: 'leader', report};`

export class PtcLabBrowserRuntime {
  constructor() {
    this.worker = undefined
    this.cancelCurrent = undefined
    this.runId = 0
  }

  run({ role, program, signal }) {
    if (this.worker) return Promise.reject(new Error('A lab run is already active'))
    if (typeof Worker !== 'function') return Promise.reject(new Error('Browser Worker is unavailable'))
    const worker = new Worker(new URL('/plugins/dsh-postman-harness/assets/ptc-lab-browser-worker.mjs', window.location.origin), { type: 'module', name: 'ptc-lab-quickjs' })
    this.worker = worker
    const runId = ++this.runId
    return new Promise(resolve => {
      let settled = false
      const finish = result => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        worker.terminate()
        if (this.worker === worker) this.worker = undefined
        if (this.cancelCurrent === abort) this.cancelCurrent = undefined
        resolve(result)
      }
      const abort = () => {
        worker.postMessage({ type: 'abort', runId })
        finish({ logs: [], error: { kind: 'abort', message: 'Execution aborted' } })
      }
      this.cancelCurrent = abort
      worker.onmessage = event => {
        if (event.data?.type === 'done' && event.data.runId === runId) finish(event.data)
      }
      worker.onerror = event => {
        event.preventDefault()
        finish({ logs: [], error: { kind: 'worker', message: event.message || 'QuickJS worker failed' } })
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      worker.postMessage({ type: 'run', runId, role, program })
    })
  }

  abort() { this.cancelCurrent?.() }
  dispose() { this.abort() }
}
