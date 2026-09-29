import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, copyFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { patchSubagentSource, subagentOverlay } from './subagent-result-overlay.mjs'
const installed = process.env.DSH_ROOT ?? join(process.env.APPDATA ?? join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh')
const original = await readFile(join(installed, 'node_modules/@deepseek-ai/dsh-subagent/lib/index.js'), 'utf8')
const patched = patchSubagentSource(original)
function fragments(source) {
  const reason = source.slice(source.indexOf('function epochStopReason(events) {'), source.indexOf('\n/** Render any listener-thrown', source.indexOf('function epochStopReason(events) {')))
  const body = source.slice(source.indexOf('		capture: (child) => {'), source.indexOf('\n\t\tterminal,', source.indexOf('		capture: (child) => {')))
  const compute = new Function('foldConsumedWork', 'finalAssistantOutput', 'return ({ reason: ' + reason.replace('function epochStopReason(events)', 'function(events)') + ', capture: function(events) { const child = {session: {events}}; const boundary=0; let captured; const epochStopReason = () => "error"; const obj = {' + body + 'terminal: null}; obj.capture(child); return captured; } })')
  return compute(events => {
    const turns = events.filter(e => e.type === 'turn/end')
    return { end: turns.at(-1), droppedUnrun: events.some(e => e.type === 'agent/inbox/spliced' && e.data.outcome === 'canceled') }
  }, events => events.findLast(e => e.type === 'assistant/message')?.data.message.content)
}
test('unknown started work, no turn and completed turn are distinct', () => {
  const baseline = fragments(original), fixed = fragments(patched)
  assert.match(patched, /async closeContinuableChild\(parent, childId, verify\)/)
  assert.match(patched, /this\.closedChildren\.add\(childId\)/)
  const incomplete = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'tool/call', data: { name: 'pwsh' } },
    { type: 'step/start', data: { turn: 1 } }, { type: 'step/end', data: { turn: 1 } }]
  assert.equal(baseline.reason(incomplete), 'completed')
  assert.equal(fixed.reason(incomplete), 'error')
  assert.equal(fixed.reason([]), 'completed')
  assert.equal(fixed.reason([...incomplete, { type: 'turn/end', data: { reason: { kind: 'completed' } } }]), 'completed')
})
test('last tool call and older text cannot masquerade as latest closing message', () => {
  const baseline = fragments(original), fixed = fragments(patched)
  const event = (turn, content) => ({ type: 'assistant/message', data: { turn, message: { content } } })
  const history = [{ type: 'turn/start', data: { turn: 1 } }, event(1, [{ type: 'text', text: 'OLD' }]),
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 2 } }, event(2, [{ type: 'tool-call', name: 'pwsh' }])]
  assert.equal(baseline.capture(history).output[0].type, 'tool-call')
  assert.equal(fixed.capture(history).output, undefined)
  const current = [...history, event(2, [{ type: 'text', text: 'PARTIAL' }, { type: 'tool-call', name: 'report' }])]
  assert.deepEqual(fixed.capture(current).output, [{ type: 'text', text: 'PARTIAL' }])
  const open = [{ type: 'turn/start', data: { turn: 3 } },
    event(3, [{ type: 'text', text: 'Начинаю проверку' }]),
    event(3, [{ type: 'tool-call', name: 'pwsh' }])]
  assert.equal(fixed.capture(open).output, undefined)
  assert.equal(fixed.reason(open), 'error')
  assert.equal(fixed.capture([...history.slice(0, 3), ...open]).output, undefined)
  assert.equal(fixed.reason([...history.slice(0, 3), ...open]), 'error')
  assert.throws(() => patchSubagentSource('unexpected version'), /SHA-256 mismatch/)
})
test('offline overlay applies to a temporary package, backs up and refuses a second application', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postman-subagent-test-'))
  const folder = join(root, 'node_modules/@deepseek-ai/dsh-subagent')
  await mkdir(join(folder, 'lib'), { recursive: true })
  await copyFile(join(installed, 'node_modules/@deepseek-ai/dsh-subagent/package.json'), join(folder, 'package.json'))
  await copyFile(join(installed, 'node_modules/@deepseek-ai/dsh-subagent/lib/index.js'), join(folder, 'lib/index.js'))
  const shared = join(root, 'shared-index.js')
  await link(join(folder, 'lib/index.js'), shared)
  const backup = join(root, 'backup')
  assert.equal((await subagentOverlay(root, '--apply', backup)).status, 'APPLIED')
  assert.equal(await readFile(join(folder, 'lib/index.js'), 'utf8'), patched)
  assert.equal(await readFile(shared, 'utf8'), original)
  assert.equal(await readFile(join(backup, 'dsh-subagent-index.js'), 'utf8'), original)
  await assert.rejects(subagentOverlay(root, '--apply', backup), /SHA-256 mismatch/)
  assert.equal((await subagentOverlay(root, '--rollback', backup)).status, 'ROLLED_BACK')
  assert.equal(await readFile(join(folder, 'lib/index.js'), 'utf8'), original)
  await assert.rejects(subagentOverlay(root, '--rollback', backup), /SHA-256 mismatch/)
})
