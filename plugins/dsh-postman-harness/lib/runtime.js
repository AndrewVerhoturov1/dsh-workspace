import { createHash } from 'node:crypto'
import { mkdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const RUNTIME_SCHEMA_VERSION = 1
export const REQUEST_STATUSES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  TASK_CREATED: 'TASK_CREATED',
  TASK_PUBLISHED: 'TASK_PUBLISHED',
  WAITING: 'WAITING',
  READY: 'READY',
  DELIVERING: 'DELIVERING',
  DELIVERED: 'DELIVERED',
  DELIVERY_RETRY: 'DELIVERY_RETRY',
  DELIVERY_BLOCKED_ORIGIN_MISSING: 'DELIVERY_BLOCKED_ORIGIN_MISSING',
})

export const CANONICAL_REQUEST_ID_PATTERN = /^REQ_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_(\d{4})$/
const MAX_PAYLOAD_CHARS = 64 * 1024

function defaultRuntimeDir() {
  return process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
}

export const POSTMAN_RUNTIME_DIR = join(defaultRuntimeDir(), 'DSH', 'Postman')
export const POSTMAN_DB_PATH = join(POSTMAN_RUNTIME_DIR, 'postman.db')
export const POSTMAN_JOURNAL_PATH = join(POSTMAN_RUNTIME_DIR, 'logs', 'postman.jsonl')
export const POSTMAN_RESULT_ROOT = join(POSTMAN_RUNTIME_DIR, 'results')

function assertRequestId(value) {
  assertCanonicalRequestId(value)
}

export function isCanonicalRequestId(value) {
  if (typeof value !== 'string') return false
  const match = CANONICAL_REQUEST_ID_PATTERN.exec(value)
  if (match === null) return false
  const [, year, month, day, hour, minute, second] = match
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
  const parsed = new Date(iso)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === iso
}

function assertCanonicalRequestId(value) {
  if (!isCanonicalRequestId(value)) {
    throw new Error('requestId must match REQ_YYYYMMDDTHHMMSSZ_NNNN with a valid UTC timestamp')
  }
}

export function messageIdForRequestId(requestId) {
  assertCanonicalRequestId(requestId)
  return `MSG_${requestId.slice(4)}`
}

function assertAgentId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('originAgentId must be a non-empty string')
  }
}

function assertPayload(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PAYLOAD_CHARS) {
    throw new Error(`payload must be a non-empty string of at most ${MAX_PAYLOAD_CHARS} characters`)
  }
}

function assertTaskUrl(value) {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('taskUrl must be a non-empty URL of at most 2048 characters')
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('taskUrl must be an absolute HTTP(S) URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('taskUrl must be an absolute HTTP(S) URL')
  }
  return value
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function nowIso(now) {
  return new Date(now()).toISOString()
}

function toRecord(row) {
  if (row === undefined) return undefined
  return { ...row }
}

function deliveryKeyFor(requestId, resultSha256) {
  return `${requestId}:${resultSha256}`
}

function defaultJournalPath(dbPath) {
  return join(dirname(dbPath), 'logs', 'postman.jsonl')
}

export class PostmanRuntime {
  constructor({
    dbPath = POSTMAN_DB_PATH,
    journalPath = defaultJournalPath(dbPath),
    now = Date.now,
    database,
    beforeCommit,
    onReady,
  } = {}) {
    this.dbPath = dbPath
    this.journalPath = journalPath
    this.now = now
    this.beforeCommit = beforeCommit
    this.onReady = onReady
    mkdirSync(dirname(dbPath), { recursive: true })
    mkdirSync(dirname(journalPath), { recursive: true })
    this.db = database ?? new DatabaseSync(dbPath)
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        origin_agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(message_id),
        origin_agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        task_url TEXT,
        ready_at TEXT,
        delivered_at TEXT,
        result_text TEXT,
        result_sha256 TEXT,
        delivery_key TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_key TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests(request_id),
        target_agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        harness_event_id TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_status_idx ON requests(status);
      CREATE INDEX IF NOT EXISTS deliveries_request_idx ON deliveries(request_id);
    `)
    const requestColumns = this.db.prepare('PRAGMA table_info(requests)').all().map((column) => column.name)
    if (!requestColumns.includes('task_url')) this.db.exec('ALTER TABLE requests ADD COLUMN task_url TEXT')
    this.db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('schema_version', String(RUNTIME_SCHEMA_VERSION))
  }

  close() {
    this.db.close()
  }

  get schemaVersion() {
    return Number(this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version').value)
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.beforeCommit?.()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Preserve the original failure. SQLite will recover the connection.
      }
      throw error
    }
  }

  journal(event, fields = {}) {
    const entry = {
      timestamp: new Date(this.now()).toISOString(),
      event,
      ...fields,
    }
    appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  createRequest({ requestId, originAgentId, payload, taskUrl }) {
    assertCanonicalRequestId(requestId)
    assertAgentId(originAgentId)
    assertPayload(payload)
    assertTaskUrl(taskUrl)

    const resolvedMessageId = messageIdForRequestId(requestId)
    const createdAt = nowIso(this.now)
    let record
    this.transaction(() => {
      if (this.db.prepare('SELECT request_id FROM requests WHERE request_id = ?').get(requestId) !== undefined) {
        throw new Error(`requestId ${requestId} is already registered`)
      }
      if (this.db.prepare('SELECT message_id FROM messages WHERE message_id = ?').get(resolvedMessageId) !== undefined) {
        throw new Error(`messageId ${resolvedMessageId} is already registered`)
      }

      this.db.prepare('INSERT INTO messages (message_id, origin_agent_id, created_at, payload, status) VALUES (?, ?, ?, ?, ?)')
        .run(resolvedMessageId, originAgentId, createdAt, payload, REQUEST_STATUSES.ACCEPTED)
      this.db.prepare('INSERT INTO requests (request_id, message_id, origin_agent_id, status, created_at, task_url) VALUES (?, ?, ?, ?, ?, ?)')
        .run(requestId, resolvedMessageId, originAgentId, REQUEST_STATUSES.ACCEPTED, createdAt, taskUrl ?? null)
      record = this.getRequest(requestId)
    })
    this.journal('MESSAGE_RECEIVED', {
      messageId: resolvedMessageId,
      requestId,
      originAgentId,
      payloadLength: payload.length,
      payloadSha256: sha256(payload),
      status: REQUEST_STATUSES.ACCEPTED,
    })
    this.journal('REQUEST_CREATED', { messageId: resolvedMessageId, requestId, originAgentId, status: REQUEST_STATUSES.ACCEPTED })
    this.journal('REQUEST_ACCEPTED', { messageId: resolvedMessageId, requestId, originAgentId, status: REQUEST_STATUSES.ACCEPTED })
    return record
  }

  markTaskCreated({ requestId, taskUrl }) {
    assertRequestId(requestId)
    const publishedTaskUrl = assertTaskUrl(taskUrl)
    if (publishedTaskUrl === undefined) throw new Error('taskUrl is required to create a task')

    let record
    this.transaction(() => {
      const current = this.getRequest(requestId)
      if (current === undefined) return
      if (current.status === REQUEST_STATUSES.ACCEPTED) {
        this.db.prepare('UPDATE requests SET status = ?, task_url = ? WHERE request_id = ?')
          .run(REQUEST_STATUSES.TASK_CREATED, publishedTaskUrl, requestId)
        this.db.prepare('UPDATE messages SET status = ? WHERE message_id = ?')
          .run(REQUEST_STATUSES.TASK_CREATED, current.message_id)
      } else if (current.status === REQUEST_STATUSES.TASK_CREATED && current.task_url !== publishedTaskUrl) {
        throw new Error(`requestId ${requestId} already has a different taskUrl`)
      }
      record = this.getRequest(requestId)
    })
    if (record?.status === REQUEST_STATUSES.TASK_CREATED) {
      this.journal('TASK_CREATED', { messageId: record.message_id, requestId, originAgentId: record.origin_agent_id, taskUrl: record.task_url, status: record.status })
    }
    return record
  }

  markTaskPublished({ requestId, taskUrl }) {
    assertRequestId(requestId)
    const publishedTaskUrl = assertTaskUrl(taskUrl)
    if (publishedTaskUrl === undefined) throw new Error('taskUrl is required to publish a task')

    let record
    this.transaction(() => {
      const current = this.getRequest(requestId)
      if (current === undefined) return
      if (current.status === REQUEST_STATUSES.TASK_CREATED) {
        if (current.task_url !== publishedTaskUrl) throw new Error(`requestId ${requestId} taskUrl does not match the created task`)
        this.db.prepare('UPDATE requests SET status = ? WHERE request_id = ?')
          .run(REQUEST_STATUSES.TASK_PUBLISHED, requestId)
        this.db.prepare('UPDATE messages SET status = ? WHERE message_id = ?')
          .run(REQUEST_STATUSES.TASK_PUBLISHED, current.message_id)
      } else if (current.status === REQUEST_STATUSES.TASK_PUBLISHED && current.task_url !== publishedTaskUrl) {
        throw new Error(`requestId ${requestId} already has a different published taskUrl`)
      }
      record = this.getRequest(requestId)
    })
    if (record?.status === REQUEST_STATUSES.TASK_PUBLISHED) {
      this.journal('TASK_PUBLISHED', { messageId: record.message_id, requestId, originAgentId: record.origin_agent_id, taskUrl: record.task_url, status: record.status })
    }
    return record
  }

  acceptRequest(requestId) {
    assertRequestId(requestId)
    let record
    this.transaction(() => {
      const current = this.getRequest(requestId)
      if (current === undefined) return
      if ([REQUEST_STATUSES.ACCEPTED, REQUEST_STATUSES.TASK_PUBLISHED].includes(current.status)) {
        this.db.prepare('UPDATE requests SET status = ? WHERE request_id = ?').run(REQUEST_STATUSES.WAITING, requestId)
        this.db.prepare('UPDATE messages SET status = ? WHERE message_id = ?').run(REQUEST_STATUSES.WAITING, current.message_id)
      }
      record = this.getRequest(requestId)
    })
    if (record?.status === REQUEST_STATUSES.WAITING) this.journal('REQUEST_WAITING', { messageId: record.message_id, requestId, originAgentId: record.origin_agent_id, status: record.status })
    return record
  }

  getRequest(requestId) {
    assertRequestId(requestId)
    return toRecord(this.db.prepare('SELECT requests.*, messages.payload AS payload, ? AS result_path FROM requests JOIN messages ON messages.message_id = requests.message_id WHERE requests.request_id = ?').get(join(POSTMAN_RESULT_ROOT, requestId), requestId))
  }

  listActionable() {
    return this.db.prepare("SELECT * FROM requests WHERE status IN ('READY', 'DELIVERY_RETRY') ORDER BY ready_at, created_at").all().map(toRecord)
  }

  listPending() {
    return this.db.prepare("SELECT * FROM requests WHERE status IN ('ACCEPTED', 'TASK_CREATED', 'TASK_PUBLISHED', 'WAITING', 'READY', 'DELIVERING', 'DELIVERY_RETRY') ORDER BY created_at").all().map(toRecord)
  }

  markReady({ requestId, result, deliveryKey, wake = true }) {
    assertRequestId(requestId)
    assertPayload(result)
    const resultSha256 = sha256(result)
    const stableDeliveryKey = deliveryKey ?? deliveryKeyFor(requestId, resultSha256)
    if (typeof stableDeliveryKey !== 'string' || stableDeliveryKey.length === 0 || stableDeliveryKey.length > 300) {
      throw new Error('deliveryKey must be a non-empty string')
    }
    let record
    let duplicate = false
    let conflict = false
    this.transaction(() => {
      const current = this.getRequest(requestId)
      if (current === undefined) return
      if ([REQUEST_STATUSES.READY, REQUEST_STATUSES.DELIVERING, REQUEST_STATUSES.DELIVERED].includes(current.status)) {
        duplicate = current.delivery_key === stableDeliveryKey && current.result_sha256 === resultSha256
        conflict = !duplicate
        record = current
        return
      }
      if (![REQUEST_STATUSES.ACCEPTED, REQUEST_STATUSES.WAITING, REQUEST_STATUSES.DELIVERY_RETRY].includes(current.status)) {
        record = current
        return
      }
      const readyAt = nowIso(this.now)
      this.db.prepare('UPDATE requests SET status = ?, ready_at = ?, result_text = ?, result_sha256 = ?, delivery_key = ?, error = NULL WHERE request_id = ?')
        .run(REQUEST_STATUSES.READY, readyAt, result, resultSha256, stableDeliveryKey, requestId)
      this.db.prepare('INSERT OR IGNORE INTO deliveries (delivery_key, request_id, target_agent_id, status, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(stableDeliveryKey, requestId, current.origin_agent_id, REQUEST_STATUSES.READY, readyAt)
      record = this.getRequest(requestId)
    })
    if (record === undefined) {
      this.journal('UNKNOWN_REQUEST', { requestId, deliveryKey: stableDeliveryKey, status: 'UNKNOWN_REQUEST' })
      return { status: 'UNKNOWN_REQUEST', requestId, deliveryKey: stableDeliveryKey }
    }
    if (duplicate) {
      this.journal('DUPLICATE_SUPPRESSED', { requestId, originAgentId: record.origin_agent_id, deliveryKey: stableDeliveryKey, status: record.status })
      return { status: 'DUPLICATE_SUPPRESSED', requestId, deliveryKey: stableDeliveryKey, record }
    }
    if (conflict) {
      this.journal('RESULT_CONFLICT', { requestId, originAgentId: record.origin_agent_id, deliveryKey: stableDeliveryKey, status: record.status })
      return { status: 'RESULT_CONFLICT', requestId, deliveryKey: stableDeliveryKey, record }
    }
    if (record.status !== REQUEST_STATUSES.READY) return { status: record.status, requestId, deliveryKey: stableDeliveryKey, record }
    this.journal('REQUEST_READY', { messageId: record.message_id, requestId, originAgentId: record.origin_agent_id, deliveryKey: stableDeliveryKey, status: record.status, resultLength: result.length, resultSha256 })
    let wakeup = wake ? 'NOT_REQUESTED' : 'DEFERRED'
    if (wake && this.onReady !== undefined) {
      this.journal('POSTMAN_WAKE_REQUESTED', { requestId, deliveryKey: stableDeliveryKey, status: REQUEST_STATUSES.READY })
      try {
        const result = this.onReady(record)
        if (result?.then !== undefined) return Promise.resolve(result).then(() => {
          this.journal('POSTMAN_WAKE_SUCCEEDED', { requestId, deliveryKey: stableDeliveryKey, status: REQUEST_STATUSES.READY })
          return { status: 'READY', requestId, deliveryKey: stableDeliveryKey, wakeup: 'SUCCEEDED', record }
        }).catch((error) => {
          this.journal('POSTMAN_WAKE_FAILED', { requestId, deliveryKey: stableDeliveryKey, status: REQUEST_STATUSES.READY, error: String(error?.message ?? error) })
          return { status: 'READY', requestId, deliveryKey: stableDeliveryKey, wakeup: 'FAILED', record }
        })
        this.journal('POSTMAN_WAKE_SUCCEEDED', { requestId, deliveryKey: stableDeliveryKey, status: REQUEST_STATUSES.READY })
        wakeup = 'SUCCEEDED'
      } catch (error) {
        this.journal('POSTMAN_WAKE_FAILED', { requestId, deliveryKey: stableDeliveryKey, status: REQUEST_STATUSES.READY, error: String(error?.message ?? error) })
        wakeup = 'FAILED'
      }
    }
    return { status: 'READY', requestId, deliveryKey: stableDeliveryKey, wakeup, record }
  }

  // Compatibility alias for the WP-004/005 synthetic test seam. Production Web
  // Worker code uses markReady so that the source of the result is explicit.
  markSyntheticReady(input) {
    return this.markReady(input)
  }

  beginDelivery(requestId) {
    assertRequestId(requestId)
    let result
    this.transaction(() => {
      const request = this.getRequest(requestId)
      if (request === undefined) return
      const delivery = this.db.prepare('SELECT * FROM deliveries WHERE request_id = ?').get(requestId)
      if (request.status === REQUEST_STATUSES.DELIVERED) {
        result = { status: 'DUPLICATE_SUPPRESSED', request, delivery: toRecord(delivery) }
        return
      }
      if (request.status === REQUEST_STATUSES.DELIVERING) {
        result = { status: 'IN_PROGRESS', request, delivery: toRecord(delivery) }
        return
      }
      if (![REQUEST_STATUSES.READY, REQUEST_STATUSES.DELIVERY_RETRY].includes(request.status) || delivery === undefined) {
        result = { status: request.status, request, delivery: toRecord(delivery) }
        return
      }
      this.db.prepare('UPDATE requests SET status = ?, error = NULL WHERE request_id = ?').run(REQUEST_STATUSES.DELIVERING, requestId)
      this.db.prepare('UPDATE deliveries SET status = ? WHERE delivery_key = ?').run(REQUEST_STATUSES.DELIVERING, delivery.delivery_key)
      result = { status: REQUEST_STATUSES.DELIVERING, request: this.getRequest(requestId), delivery: toRecord(this.db.prepare('SELECT * FROM deliveries WHERE request_id = ?').get(requestId)) }
    })
    if (result?.status === REQUEST_STATUSES.DELIVERING) this.journal('DELIVERY_STARTED', { messageId: result.request.message_id, requestId, originAgentId: result.request.origin_agent_id, deliveryKey: result.delivery.delivery_key, status: result.status })
    return result
  }

  completeDelivery({ requestId, deliveryKey, harnessEventId = null }) {
    assertRequestId(requestId)
    let record
    this.transaction(() => {
      const request = this.getRequest(requestId)
      const delivery = this.db.prepare('SELECT * FROM deliveries WHERE delivery_key = ? AND request_id = ?').get(deliveryKey, requestId)
      if (request === undefined || delivery === undefined) return
      if (request.status === REQUEST_STATUSES.DELIVERED && delivery.status === REQUEST_STATUSES.DELIVERED) {
        record = { status: 'DUPLICATE_SUPPRESSED', request, delivery: toRecord(delivery) }
        return
      }
      if (request.status !== REQUEST_STATUSES.DELIVERING || delivery.status !== REQUEST_STATUSES.DELIVERING) {
        record = { status: request.status, request, delivery: toRecord(delivery) }
        return
      }
      const completedAt = nowIso(this.now)
      this.db.prepare('UPDATE deliveries SET status = ?, completed_at = ?, harness_event_id = ? WHERE delivery_key = ?')
        .run(REQUEST_STATUSES.DELIVERED, completedAt, harnessEventId, deliveryKey)
      this.db.prepare('UPDATE requests SET status = ?, delivered_at = ? WHERE request_id = ?').run(REQUEST_STATUSES.DELIVERED, completedAt, requestId)
      record = { status: REQUEST_STATUSES.DELIVERED, request: this.getRequest(requestId), delivery: toRecord(this.db.prepare('SELECT * FROM deliveries WHERE delivery_key = ?').get(deliveryKey)) }
    })
    if (record?.status === REQUEST_STATUSES.DELIVERED) this.journal('DELIVERED', { messageId: record.request.message_id, requestId, originAgentId: record.request.origin_agent_id, deliveryKey, harnessEventId, status: record.status })
    return record
  }

  failDelivery({ requestId, deliveryKey, error }) {
    assertRequestId(requestId)
    let record
    this.transaction(() => {
      const request = this.getRequest(requestId)
      const delivery = this.db.prepare('SELECT * FROM deliveries WHERE delivery_key = ? AND request_id = ?').get(deliveryKey, requestId)
      if (request === undefined || delivery === undefined) return
      this.db.prepare('UPDATE deliveries SET status = ?, error = ? WHERE delivery_key = ?').run(REQUEST_STATUSES.DELIVERY_RETRY, String(error), deliveryKey)
      this.db.prepare('UPDATE requests SET status = ?, error = ? WHERE request_id = ?').run(REQUEST_STATUSES.DELIVERY_RETRY, String(error), requestId)
      record = { status: REQUEST_STATUSES.DELIVERY_RETRY, request: this.getRequest(requestId), delivery: toRecord(this.db.prepare('SELECT * FROM deliveries WHERE delivery_key = ?').get(deliveryKey)) }
    })
    if (record !== undefined) this.journal('DELIVERY_FAILED', { messageId: record.request.message_id, requestId, originAgentId: record.request.origin_agent_id, deliveryKey, status: record.status, error: String(error) })
    return record
  }

  blockOriginMissing({ requestId, deliveryKey, error = 'origin agent is missing' }) {
    assertRequestId(requestId)
    let record
    this.transaction(() => {
      const request = this.getRequest(requestId)
      const delivery = this.db.prepare('SELECT * FROM deliveries WHERE delivery_key = ? AND request_id = ?').get(deliveryKey, requestId)
      if (request === undefined || delivery === undefined) return
      this.db.prepare('UPDATE deliveries SET status = ?, error = ? WHERE delivery_key = ?').run(REQUEST_STATUSES.DELIVERY_BLOCKED_ORIGIN_MISSING, error, deliveryKey)
      this.db.prepare('UPDATE requests SET status = ?, error = ? WHERE request_id = ?').run(REQUEST_STATUSES.DELIVERY_BLOCKED_ORIGIN_MISSING, error, requestId)
      record = { status: REQUEST_STATUSES.DELIVERY_BLOCKED_ORIGIN_MISSING, request: this.getRequest(requestId), delivery: toRecord(this.db.prepare('SELECT * FROM deliveries WHERE delivery_key = ?').get(deliveryKey)) }
    })
    if (record !== undefined) this.journal('ORIGIN_MISSING', { messageId: record.request.message_id, requestId, originAgentId: record.request.origin_agent_id, deliveryKey, status: record.status })
    return record
  }
}
