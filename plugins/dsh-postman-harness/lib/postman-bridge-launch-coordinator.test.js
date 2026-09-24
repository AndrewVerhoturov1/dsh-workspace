import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostmanBridgeLaunchCoordinator } from './postman-bridge-launch-coordinator.js'

function clock(random = () => 0) {
  let time = 0
  let nextId = 0
  const timers = new Map()
  const coordinator = createPostmanBridgeLaunchCoordinator({
    now: () => time,
    random,
    setTimer(callback, delay) {
      const id = ++nextId
      timers.set(id, { at: time + delay, callback })
      return id
    },
    clearTimer: id => timers.delete(id),
  })
  async function advance(ms) {
    const end = time + ms
    while (true) {
      const due = [...timers].filter(([, task]) => task.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      time = due[1].at
      timers.delete(due[0])
      due[1].callback()
      await Promise.resolve()
    }
    time = end
    await Promise.resolve()
  }
  return { coordinator, advance, timers, get time() { return time } }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Injected clock means the test suite never actually waits 5–15 seconds.
test('first callback starts synchronously, retains capacity until full lifecycle settles', async () => {
  const { coordinator, timers } = clock()
  const work = deferred()
  const events = []
  const result = coordinator.run(undefined, async () => {
    events.push('start')
    await work.promise
    events.push('cleanup')
    return 'terminal'
  })
  assert.deepEqual(events, ['start'])
  assert.equal(coordinator.activeCount, 1)
  work.resolve()
  assert.equal(await result, 'terminal')
  assert.deepEqual(events, ['start', 'cleanup'])
  assert.equal(coordinator.activeCount, 0)
  assert.equal(timers.size, 0)
  coordinator.dispose()
})

test('second callback waits exactly 5000 ms at minimum jitter', async () => {
  const { coordinator, advance } = clock(() => 0)
  const firstWork = deferred()
  const first = coordinator.run(undefined, async () => firstWork.promise)
  const starts = []
  const second = coordinator.run(undefined, () => { starts.push('second'); return 'ok' })
  await advance(4999)
  assert.deepEqual(starts, [])
  await advance(1)
  assert.deepEqual(starts, ['second'])
  assert.equal(await second, 'ok')
  firstWork.resolve(); await first; coordinator.dispose()
})

test('second callback waits exactly 15000 ms at maximum jitter', async () => {
  const { coordinator, advance } = clock(() => 0.9999999999999999)
  const firstWork = deferred()
  const first = coordinator.run(undefined, async () => firstWork.promise)
  const starts = []
  const second = coordinator.run(undefined, () => { starts.push('second'); return 'ok' })
  await advance(14999)
  assert.deepEqual(starts, [])
  await advance(1)
  assert.deepEqual(starts, ['second'])
  assert.equal(await second, 'ok')
  firstWork.resolve(); await first; coordinator.dispose()
})

test('each launch samples its own delay and measures actual callback start', async () => {
  const samples = [0, 0.5, 0]
  const timing = clock(() => samples.shift() ?? 0)
  const { coordinator } = timing
  const starts = []
  const held = [deferred(), deferred(), deferred()]
  const runs = held.map((work, i) => coordinator.run(undefined, async () => {
    starts.push([i, timing.time]); return work.promise
  }))
  // Use the same mutable fake clock to record the exact synchronous callback boundary.
  // The clock's time getter, unlike Promise settlement, changes only in advance().
  await timing.advance(5000)
  await timing.advance(9999)
  assert.deepEqual(starts, [[0, 0], [1, 5000]])
  await timing.advance(1)
  assert.deepEqual(starts, [[0, 0], [1, 5000], [2, 15000]])
  held.forEach(work => work.resolve())
  await Promise.all(runs)
  coordinator.dispose()
})

test('maximum three active lifecycles; fourth waits until one settles', async () => {
  const timing = clock()
  const held = Array.from({ length: 4 }, deferred)
  const started = []
  const runs = held.map((work, i) => timing.coordinator.run(undefined, async () => {
    started.push(i); return work.promise
  }))
  await timing.advance(5000)
  await timing.advance(5000)
  assert.deepEqual(started, [0, 1, 2])
  assert.equal(timing.coordinator.activeCount, 3)
  await timing.advance(50000)
  assert.deepEqual(started, [0, 1, 2])
  held[1].resolve()
  await runs[1]
  assert.deepEqual(started, [0, 1, 2, 3])
  assert.equal(timing.coordinator.activeCount, 3)
  held[0].resolve(); held[2].resolve(); held[3].resolve()
  await Promise.all(runs)
  assert.equal(timing.coordinator.activeCount, 0)
  timing.coordinator.dispose()
})

test('fully idle coordinator resets spacing and next launch is immediate', async () => {
  const timing = clock(() => 0.9999999999999999)
  const first = timing.coordinator.run(undefined, () => 'first')
  assert.equal(await first, 'first')
  assert.equal(timing.coordinator.activeCount, 0)
  await timing.advance(1) // Much less than the previous 15-second jitter.
  const starts = []
  const second = timing.coordinator.run(undefined, () => {
    starts.push(timing.time)
    return 'second'
  })
  assert.deepEqual(starts, [1])
  assert.equal(await second, 'second')
  assert.equal(timing.timers.size, 0)
  timing.coordinator.dispose()
})

test('FIFO admissions preserve order despite occupied slots', async () => {
  const timing = clock()
  const held = Array.from({ length: 5 }, deferred)
  const started = []
  const runs = held.map((work, i) => timing.coordinator.run(undefined, async () => {
    started.push(i); return work.promise
  }))
  await timing.advance(5000)
  await timing.advance(5000)
  assert.deepEqual(started, [0, 1, 2])
  held[0].resolve(); await runs[0]
  await timing.advance(5000)
  assert.deepEqual(started, [0, 1, 2, 3])
  held[1].resolve(); await runs[1]
  await timing.advance(5000)
  assert.deepEqual(started, [0, 1, 2, 3, 4])
  held.slice(2).forEach(work => work.resolve())
  await Promise.all(runs)
  timing.coordinator.dispose()
})

test('already aborted signal invokes no callback or timer', async () => {
  const { coordinator, timers } = clock()
  const abort = new AbortController(); abort.abort()
  let called = false
  await assert.rejects(coordinator.run(abort.signal, () => { called = true }), /abort/i)
  assert.equal(called, false)
  assert.equal(coordinator.activeCount, 0)
  assert.equal(timers.size, 0)
  coordinator.dispose()
})

test('queued abort removes only its own waiter without disturbing next launch', async () => {
  const timing = clock()
  const held = deferred()
  const first = timing.coordinator.run(undefined, async () => held.promise)
  const abort = new AbortController()
  let canceledCalled = false
  const canceled = timing.coordinator.run(abort.signal, () => { canceledCalled = true })
  let successorCalled = false
  const successor = timing.coordinator.run(undefined, () => { successorCalled = true; return 'success' })
  abort.abort()
  await assert.rejects(canceled, /abort/i)
  await timing.advance(5000)
  assert.equal(canceledCalled, false)
  assert.equal(successorCalled, true)
  assert.equal(await successor, 'success')
  held.resolve(); await first; timing.coordinator.dispose()
})

test('abort after admission does not prematurely release active lifecycle', async () => {
  const { coordinator } = clock()
  const abort = new AbortController()
  const held = deferred()
  const running = coordinator.run(abort.signal, async () => held.promise)
  abort.abort()
  assert.equal(coordinator.activeCount, 1)
  held.resolve()
  await running
  assert.equal(coordinator.activeCount, 0)
  coordinator.dispose()
})

test('synchronous throw and async rejection release slot and propagate error', async () => {
  const { coordinator } = clock()
  await assert.rejects(coordinator.run(undefined, () => { throw new Error('sync failure') }), /sync failure/)
  assert.equal(coordinator.activeCount, 0)
  const asyncFailure = coordinator.run(undefined, async () => { throw new Error('async failure') })
  await assert.rejects(asyncFailure, /async failure/)
  assert.equal(coordinator.activeCount, 0)
  coordinator.dispose()
})

test('dispose rejects queued entries and clears timer but allows running lifecycle to finish', async () => {
  const timing = clock()
  const held = deferred()
  const running = timing.coordinator.run(undefined, async () => held.promise)
  let queuedCalled = false
  const queued = timing.coordinator.run(undefined, () => { queuedCalled = true })
  assert.equal(timing.timers.size, 1)
  timing.coordinator.dispose()
  await assert.rejects(queued, /dispos/i)
  assert.equal(timing.timers.size, 0)
  await assert.rejects(timing.coordinator.run(undefined, () => {}), /dispos/i)
  assert.equal(timing.coordinator.activeCount, 1)
  held.resolve(); await running
  await timing.advance(20000)
  assert.equal(queuedCalled, false)
  assert.equal(timing.coordinator.activeCount, 0)
})

test('independent instances admit immediately without shared capacity', async () => {
  const a = clock(); const b = clock()
  const heldA = deferred(); const heldB = deferred()
  const runA = a.coordinator.run(undefined, () => heldA.promise)
  const runB = b.coordinator.run(undefined, () => heldB.promise)
  assert.equal(a.coordinator.activeCount, 1)
  assert.equal(b.coordinator.activeCount, 1)
  heldA.resolve(); heldB.resolve()
  await Promise.all([runA, runB])
  a.coordinator.dispose(); b.coordinator.dispose()
})
