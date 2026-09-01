import test from 'node:test'
import { strict as assert } from 'node:assert'
import {
  attachTaskUrl,
  createAndPublishTask,
  createTaskPackage,
  renderIntentTaskFile,
} from './task-creation-bridge.js'

const REQUEST_ID = 'REQ_20260901T120000Z_1234'
const USER_INTENT = 'Postman, создай простой калькулятор в древне-японском стиле.'

test('task package keeps only user intent and explicit requirements', () => {
  const content = renderIntentTaskFile({
    requestId: REQUEST_ID,
    userIntent: USER_INTENT,
    confirmedRequirements: ['Сохранить смысл запроса без изменений.'],
  })

  assert.equal(content, [
    '# POSTMAN TASK',
    '',
    'user_intent:',
    USER_INTENT,
    '',
    'confirmed_requirements:',
    '- Сохранить смысл запроса без изменений.',
    '',
  ].join('\n'))
  assert.doesNotMatch(content, /request_id:|task_url:|repository:|base_commit:/)
})

test('task publisher supplies the exact request task URL without caller task_url', async () => {
  const published = []
  const result = await createAndPublishTask(async (task) => {
    published.push(task)
    return { taskUrl: `https://example.test/tasks/${task.filename}` }
  }, { requestId: REQUEST_ID, userIntent: USER_INTENT })

  assert.equal(result.filename, `${REQUEST_ID}.md`)
  assert.equal(result.taskUrl, `https://example.test/tasks/${REQUEST_ID}.md`)
  assert.equal(published.length, 1)
  assert.equal(published[0].content.includes('task_url:'), false)
})

test('task publisher rejects an URL for a different task file', async () => {
  await assert.rejects(
    createAndPublishTask(() => ({ taskUrl: 'https://example.test/tasks/other.md' }), {
      requestId: REQUEST_ID,
      userIntent: USER_INTENT,
    }),
    /exact request task filename/,
  )
})

test('legacy attachment remains a Runtime-only compatibility helper', () => {
  const result = attachTaskUrl({ request_id: REQUEST_ID }, 'https://github.com/task.md')
  assert.equal(result.state, 'TASK_CREATED')
  assert.equal(result.task_url, 'https://github.com/task.md')
})

assert.equal(createTaskPackage({ requestId: REQUEST_ID, userIntent: USER_INTENT }).filename, `${REQUEST_ID}.md`)
