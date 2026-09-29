import assert from 'node:assert/strict'
import test from 'node:test'
import { workerEvidence } from './postman-worker-evidence.js'
const user = id => ({ type: 'user/message', data: { id } })
const start = turn => ({ type: 'turn/start', data: { turn } })
const end = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const call = (turn, callId, name = 'report', output = 'result') => ({ type: 'tool/call',
  data: { turn, callId, name, arguments: { output } } })
const result = (turn, callId, isError = false) => ({ type: 'tool/result',
  data: { turn, message: { source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, isError }] } } })
const worker = (admissions = ['a']) => ({ id: 'w', state: 'ready', delivery: 'none', lifecycle: { version: 1,
  admissions: admissions.map(messageId => ({ id: messageId, state: 'accepted', messageId })),
  reports: [{ childId: 'w', turn: 1, callId: 'r', messageId: 'report-1' }] } })
const child = events => ({ status: 'idle', session: { events } })
const delivered = id => ({ type: 'user/message', data: { id, source: { kind: 'subagent-report', senderSessionId: 'w' } } })
const leader = { session: { events: [delivered('report-1')] } }
const complete = [start(1), user('a'), call(1, 'r'), result(1, 'r'), end(1)]
test('batch claimed in one turn accepts one native final report after delivery', () => {
  assert.equal(workerEvidence(worker(['a', 'b']), child([start(1), user('a'), user('b'),
    call(1, 'r'), result(1, 'r'), end(1)]), leader).ready, true)
  assert.equal(workerEvidence(worker(), child(complete), leader).ready, true)
  // The installed agent-loop persists the model's original JSON argument string.
  assert.equal(workerEvidence(worker(), child([start(1), user('a'),
    { ...call(1, 'r'), data: { ...call(1, 'r').data, arguments: '{"output":"result"}' } },
    result(1, 'r'), end(1)]), leader).ready, true)
})
test('pending, active, missing end, failed end, missing report, and false delivery all reject', () => {
  const cases = [
    [worker(), child([]), leader],
    [worker(), child(complete.slice(0, -1)), leader],
    [worker(), { ...child(complete), status: 'running' }, leader],
    [worker(), child([...complete.slice(0, -1), end(1, 'aborted')]), leader],
    [worker(), child([start(1), user('a'), end(1)]), leader],
    [worker(), child(complete), { session: { events: [] } }],
    [worker(['a', 'b']), child(complete), leader],
    [{ ...worker(), delivery: 'unknown' }, child(complete), leader],
    [{ ...worker(), lifecycle: undefined }, child(complete), leader],
  ]
  for (const [state, c, l] of cases) assert.equal(workerEvidence(state, c, l).ready, false)
})
test('intermediate report or notify followed by useful work needs a new report', () => {
  assert.equal(workerEvidence(worker(), child([start(1), user('a'), call(1, 'r'), result(1, 'r'),
    call(1, 'later', 'pwsh'), result(1, 'later'), end(1)]), leader).ready, false)
  assert.equal(workerEvidence(worker(), child([start(1), user('a'), call(1, 'r', ' '),
    result(1, 'r'), end(1)]), leader).ready, false)
  assert.equal(workerEvidence(worker(), child([start(1), user('a'),
    call(1, 'r', 'reported', 'notify_parent'), result(1, 'r'), end(1)]), leader).ready, false)
})
test('old report cannot finish new assignment, later turn or failed report result', () => {
  assert.equal(workerEvidence(worker(['a', 'b']), child([...complete, start(2), user('b'), end(2)]), leader).ready, false)
  assert.equal(workerEvidence(worker(['a', 'b']), child([start(1), user('a'), call(1, 'r'), result(1, 'r'), user('b'), end(1)]), leader).ready, false)
  assert.equal(workerEvidence(worker(), child([...complete, start(2), call(2, 'other', 'pwsh'), end(2)]), leader).ready, false)
  assert.equal(workerEvidence(worker(), child([start(1), user('a'), call(1, 'r'), result(1, 'r', true), end(1)]), leader).ready, false)
})

test('a fresh native message outside Postman admissions requires a current successful report', () => {
  const first = [...complete, start(2), user('untracked'), call(2, 'later', 'pwsh'), result(2, 'later')]
  for (const suffix of [[end(2)], [call(2, 'bad', 'report', ' '), result(2, 'bad'), end(2)],
    [call(2, 'bad'), result(2, 'bad', true), end(2)]])
    assert.equal(workerEvidence(worker(), child([...first, ...suffix]), leader).ready, false)
  const updated = worker()
  updated.lifecycle.reports.push({ childId: 'w', turn: 2, callId: 'fresh', messageId: 'report-2' })
  const latest = child([...first, call(2, 'fresh'), result(2, 'fresh'), end(2)])
  assert.equal(workerEvidence(updated, latest, leader).ready, false)
  assert.equal(workerEvidence(updated, latest, { session: { events: [...leader.session.events, delivered('report-2')] } }).ready, true)
})
test('completed ordinary tool errors may precede a delivered current report', () => {
  const w = worker()
  const fixed = [start(1), user('a'), call(1, 'failed', 'read'), result(1, 'failed', true),
    call(1, 'fixed', 'read'), result(1, 'fixed'), call(1, 'r'), result(1, 'r'), end(1)]
  const negative = [start(1), user('a'), call(1, 'missing', 'read'), result(1, 'missing', true),
    call(1, 'r', 'report', 'file missing'), result(1, 'r'), end(1)]
  assert.equal(workerEvidence(w, child(fixed), leader).ready, true)
  assert.equal(workerEvidence(w, child(negative), leader).ready, true)
  for (const events of [
    [start(1), user('a'), call(1, 'pending', 'read'), call(1, 'r'), result(1, 'r'), end(1)],
    [start(1), user('a'), call(1, 'late', 'read'), call(1, 'r'), result(1, 'r'), result(1, 'late', true), end(1)],
    [start(1), user('a'), call(1, 'failed', 'read'), result(1, 'failed', true), call(1, 'r'), result(1, 'r', true), end(1)],
    [start(1), user('a'), call(1, 'failed', 'read'), result(1, 'failed', true), call(1, 'r', 'report', ' '), result(1, 'r'), end(1)],
    [start(1), user('a'), call(1, 'failed', 'read'), result(1, 'failed', true), call(1, 'r'), result(1, 'r'), user('later'), end(1)],
    [start(1), user('a'), call(1, 'failed', 'read'), result(1, 'failed', true), call(1, 'r'), result(1, 'r'), call(1, 'later', 'read'), end(1)],
  ]) assert.equal(workerEvidence(w, child(events), leader).ready, false)
  assert.equal(workerEvidence(w, child(fixed), { session: { events: [] } }).ready, false)
})

test('unsettled earlier tool invalidates report, text-only closing step does not', () => {
  const w = worker()
  assert.equal(workerEvidence(w, child([start(1), user('a'), call(1, 'work', 'pwsh'),
    call(1, 'r'), result(1, 'r'), result(1, 'work'), end(1)]), leader).ready, false)
  assert.equal(workerEvidence(w, child([start(1), user('a'), call(1, 'r'), result(1, 'r'),
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'closing' }] } } }, end(1)]), leader).ready, true)
})
