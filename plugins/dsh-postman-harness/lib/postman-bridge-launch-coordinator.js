// Host-side admission for one plugin instance; only admitted, unfinished lifecycles count.
export function createPostmanBridgeLaunchCoordinator({
  now = () => Date.now(),
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const queue = []
  let activeCount = 0
  let lastStart
  let nextDelay
  let timer
  let disposed = false

  const abortError = () => new Error('POSTMAN_BRIDGE_ABORTED')
  const clearWait = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
  }
  const resetIdle = () => {
    if (activeCount !== 0 || queue.length !== 0) return
    clearWait()
    lastStart = undefined
    nextDelay = undefined
  }
  const jitter = () => {
    const value = random()
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new Error('POSTMAN_BRIDGE_RANDOM_INVALID')
    }
    return 5000 + Math.floor(value * 10001)
  }
  const settle = (entry, error, value) => {
    entry.signal?.removeEventListener('abort', entry.onAbort)
    if (error) entry.reject(error)
    else entry.resolve(value)
  }
  const drain = () => {
    if (disposed || timer !== undefined) return
    while (queue.length > 0 && activeCount < 3) {
      const remaining = lastStart === undefined ? 0 : lastStart + nextDelay - now()
      if (remaining > 0) {
        timer = setTimer(() => {
          timer = undefined
          drain()
        }, remaining)
        return
      }
      const entry = queue.shift()
      if (entry.signal?.aborted) {
        settle(entry, abortError())
        continue
      }
      // Reserve before invoking the callback: invocation is the actual launch boundary.
      activeCount += 1
      lastStart = now()
      try {
        nextDelay = jitter()
      } catch (error) {
        activeCount -= 1
        settle(entry, error)
        resetIdle()
        continue
      }
      entry.signal?.removeEventListener('abort', entry.onAbort)
      // Invoke synchronously so the timestamp belongs to ctx.subagents.start, not
      // to the later settlement of an admission promise/microtask.
      let work
      try {
        work = entry.launch()
      } catch (error) {
        work = Promise.reject(error)
      }
      const finish = (error, value) => {
        activeCount -= 1
        resetIdle()
        drain()
        settle(entry, error, value)
      }
      Promise.resolve(work).then(
        value => finish(undefined, value),
        error => finish(error),
      )
      // At least 5 seconds separate starts, regardless of available slots.
    }
  }

  return {
    get activeCount() { return activeCount },
    run(signal, launch) {
      if (typeof launch !== 'function') return Promise.reject(new Error('POSTMAN_BRIDGE_LAUNCH_REQUIRED'))
      if (disposed) return Promise.reject(new Error('POSTMAN_BRIDGE_COORDINATOR_DISPOSED'))
      if (signal?.aborted) return Promise.reject(abortError())
      return new Promise((resolve, reject) => {
        const entry = { signal, launch, resolve, reject }
        entry.onAbort = () => {
          const index = queue.indexOf(entry)
          if (index < 0) return // Admitted work retains its slot until full cleanup.
          queue.splice(index, 1)
          settle(entry, abortError())
          if (queue.length === 0) clearWait()
          resetIdle()
          drain()
        }
        signal?.addEventListener('abort', entry.onAbort, { once: true })
        queue.push(entry)
        drain()
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearWait()
      for (const entry of queue.splice(0)) settle(entry, new Error('POSTMAN_BRIDGE_COORDINATOR_DISPOSED'))
    },
  }
}
