import { spawnSync } from 'node:child_process'

const DEFAULT_REPOSITORY = 'AndrewVerhoturov1/dsh-workspace'
const DEFAULT_BRANCH = 'main'
const REQUEST_ID_PATTERN = /^REQ_\d{8}T\d{6}Z_\d{4}$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function validateRepository(value) {
  const repository = requiredText(value, 'repository')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('repository must be owner/name')
  }
  return repository
}

function validateBranch(value) {
  const branch = requiredText(value, 'branch')
  if (/\s|\.\.|[~^:?*\[\\]/.test(branch) || branch.startsWith('-') || branch.endsWith('.') || branch.endsWith('/')) {
    throw new Error('branch contains unsupported characters')
  }
  return branch
}

function validateTask(task) {
  if (task === null || typeof task !== 'object') throw new Error('task must be an object')
  const requestId = requiredText(task.requestId, 'task.requestId')
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error('task.requestId must match REQ_YYYYMMDDTHHMMSSZ_NNNN')
  }
  const expectedFilename = `${requestId}.md`
  if (task.filename !== expectedFilename) {
    throw new Error(`task.filename must be exactly ${expectedFilename}`)
  }
  if (typeof task.content !== 'string' || task.content.trim().length === 0) {
    throw new Error('task.content must be a non-empty string')
  }
  return { requestId, filename: expectedFilename, content: task.content }
}

function parseGitHubResponse(stdout) {
  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error('GitHub task publication returned invalid JSON')
  }
  const commitSha = payload?.commit?.sha
  if (typeof commitSha !== 'string' || !COMMIT_SHA_PATTERN.test(commitSha)) {
    throw new Error('GitHub task publication did not return a valid commit SHA')
  }
  return commitSha.toLowerCase()
}

export function createGitHubTaskPublisher({
  repository = process.env.DSH_POSTMAN_TASK_REPOSITORY ?? DEFAULT_REPOSITORY,
  branch = process.env.DSH_POSTMAN_TASK_BRANCH ?? DEFAULT_BRANCH,
  ghBinary = process.env.DSH_POSTMAN_GH_BINARY ?? 'gh',
  cwd,
  spawnSyncImpl = spawnSync,
} = {}) {
  const resolvedRepository = validateRepository(repository)
  const resolvedBranch = validateBranch(branch)
  const resolvedGhBinary = requiredText(ghBinary, 'ghBinary')

  return Object.freeze({
    async publish(task) {
      const validated = validateTask(task)
      const endpoint = `repos/${resolvedRepository}/contents/${encodeURIComponent(validated.filename)}`
      const input = JSON.stringify({
        message: `postman: publish task ${validated.requestId}`,
        content: Buffer.from(validated.content, 'utf8').toString('base64'),
        branch: resolvedBranch,
      })
      const result = spawnSyncImpl(
        resolvedGhBinary,
        ['api', endpoint, '--method', 'PUT', '--input', '-'],
        {
          cwd,
          encoding: 'utf8',
          input,
          windowsHide: true,
        },
      )
      if (result.error) {
        throw new Error(`GitHub task publication failed to start gh: ${result.error.message}`)
      }
      if (result.status !== 0) {
        const detail = String(result.stderr ?? '').trim() || `gh exited with status ${result.status}`
        throw new Error(`GitHub task publication failed: ${detail}`)
      }
      const commitSha = parseGitHubResponse(String(result.stdout ?? ''))
      return {
        taskUrl: `https://raw.githubusercontent.com/${resolvedRepository}/${commitSha}/${validated.filename}`,
        commitSha,
      }
    },
  })
}
