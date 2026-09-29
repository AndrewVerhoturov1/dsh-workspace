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
const leader = { session: { events: [user('report-1')] } }
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
