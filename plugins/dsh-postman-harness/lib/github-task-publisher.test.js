import assert from 'node:assert/strict'
import test from 'node:test'
import { createGitHubTaskPublisher } from './github-task-publisher.js'

test('publishes exact task bytes and returns immutable SHA-pinned URL', async () => {
  let captured
  const sha = '0123456789abcdef0123456789abcdef01234567'
  const spawnSyncImpl = (command, args, options) => {
    captured = {
      command,
      args,
      input: options.input,
    }
    return {
      status: 0,
      stdout: JSON.stringify({ commit: { sha } }),
      stderr: '',
    }
  }
  const publisher = createGitHubTaskPublisher({
    ghBinary: 'gh',
    spawnSyncImpl,
  })
  const content = '# POSTMAN TASK\n\nuser_intent:\nСделай калькулятор.\n'

  const result = await publisher.publish({
    requestId: 'REQ_20260902T000001Z_0001',
    filename: 'REQ_20260902T000001Z_0001.md',
    content,
  })

  assert.equal(captured.command, 'gh')
  assert.deepEqual(captured.args, [
    'api',
    'repos/AndrewVerhoturov1/dsh-workspace/contents/REQ_20260902T000001Z_0001.md',
    '--method',
    'PUT',
    '--input',
    '-',
  ])
  const payload = JSON.parse(captured.input)
  assert.equal(Buffer.from(payload.content, 'base64').toString('utf8'), content)
  assert.equal(payload.branch, 'main')
  assert.match(payload.message, /REQ_20260902T000001Z_0001/)
  assert.equal(result.taskUrl, `https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/${sha}/REQ_20260902T000001Z_0001.md`)
})

test('rejects non-canonical task filename before invoking gh', async () => {
  const publisher = createGitHubTaskPublisher({
    spawnSyncImpl: () => {
      throw new Error('spawn must not be called')
    },
  })
  await assert.rejects(
    publisher.publish({
      requestId: 'REQ_20260902T000001Z_0002',
      filename: '../REQ_20260902T000001Z_0002.md',
      content: '# POSTMAN TASK\n\nuser_intent:\nx\n',
    }),
    /task\.filename must be exactly/,
  )
})

test('fails closed when GitHub response lacks a valid commit SHA', async () => {
  const publisher = createGitHubTaskPublisher({
    spawnSyncImpl: () => ({
      status: 0,
      stdout: JSON.stringify({
        commit: {
          sha: 'short',
        },
      }),
      stderr: '',
    }),
  })
  await assert.rejects(
    publisher.publish({
      requestId: 'REQ_20260902T000001Z_0003',
      filename: 'REQ_20260902T000001Z_0003.md',
      content: '# POSTMAN TASK\n\nuser_intent:\nx\n',
    }),
    /valid commit SHA/,
  )
})
