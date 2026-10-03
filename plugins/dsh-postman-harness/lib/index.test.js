import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, attachTaskUrl, createAndPublishTask, createTaskPackage, inject, PLUGIN_NAME, renderIntentTaskFile, TASK_DISCIPLINE } from './index.js'

test('package root keeps deferred task-creation helper exports', async () => {
  const requestId = 'REQ_20260831T043820Z_0042'
  const rendered = renderIntentTaskFile({ requestId, userIntent: 'intent' })
  assert.match(rendered, /intent/)
  const task = createTaskPackage({ requestId, userIntent: 'intent' })
  assert.equal(task.filename, `${requestId}.md`)
  const attached = attachTaskUrl({ request_id: requestId }, 'https://example.test/task.md')
  assert.equal(attached.task_url, 'https://example.test/task.md')
  const published = await createAndPublishTask(async value => ({ taskUrl: `https://example.test/${value.filename}` }), { requestId, userIntent: 'intent' })
  assert.equal(published.filename, `${requestId}.md`)
})

test('apply registers modern current-turn and result tools without legacy async tools', () => {
  const registeredTools = []
  const sections = []
  const effects = []
  const ctx = {
    tools: { register: tool => registeredTools.push(tool) },
    systemPrompt: { section: section => sections.push(section) },
    effect(callback, name) {
      effects.push({ callback, name })
      return () => {}
    },
  }

  apply(ctx)
  assert.ok(inject.includes('systemPrompt'), 'loader must wait for prompt service')
  assert.deepEqual(sections, [{name:'dsh:task-discipline',order:10,text:TASK_DISCIPLINE}])

  const names = registeredTools.map(tool => tool.name)
  assert.deepEqual(names, [
    'postman_result_workspace_register',
    'postman_result_workspace_unregister',
    'postman_result_present',
    'postman_send_current_turn',
    'postman_current_turn_status',
    'postman_ask_validate_reply',
    'postman_continue_last_request',
  ])
  for (const legacyName of [
    'postman_send',
    'postman_reply',
    'postman_async_send',
    'postman_runtime_get_request',
    'postman_runtime_accept_request',
    'postman_runtime_list_ready',
    'postman_runtime_deliver_ready',
    'postman_runtime_synthetic_ready',
  ]) {
    assert.equal(names.includes(legacyName), false, `${legacyName} must not be registered`)
  }
  assert.equal(effects.length, 1)
  assert.equal(effects[0].name, `${PLUGIN_NAME}.lifecycle()`)

  const dispose = effects[0].callback()
  assert.equal(typeof dispose, 'function')
  dispose()
})

assert.equal(typeof PLUGIN_NAME, 'string')
