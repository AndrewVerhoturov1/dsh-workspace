import { EventEmitter } from 'node:events'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// All transport boundaries are mocked BEFORE import: no process, request state,
// task file, browser, network, or live Direct Postman can be reached by this suite.
const io = vi.hoisted(() => ({
  access: vi.fn(), mkdtemp: vi.fn(), writeFile: vi.fn(), rm: vi.fn(),
  spawn: vi.fn(), randomInt: vi.fn(),
}))
vi.mock('node:fs/promises', () => ({ access: io.access, mkdtemp: io.mkdtemp, writeFile: io.writeFile, rm: io.rm }))
vi.mock('node:child_process', () => ({ spawn: io.spawn }))
vi.mock('node:crypto', () => ({ randomInt: io.randomInt }))
import { invokeDirectPostman, resolveDirectPostmanBridgePath } from '../src/tools/postman-direct.ts'

const oldRequest = 'REQ_20260101T000000Z_0001'
let terminal: Record<string, unknown>
let processExit: number | null
let rawOutput: string | undefined
let wrapper: string

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  let nonce = 10
  io.randomInt.mockImplementation(() => nonce++)
  io.access.mockImplementation(async (value: string) => {
    if (value.endsWith('postman.ps1')) return
    throw Object.assign(new Error('missing fake request state'), { code: 'ENOENT' })
  })
  io.mkdtemp.mockResolvedValue(path.join('mock-temp', 'transport'))
  io.writeFile.mockResolvedValue(undefined)
  io.rm.mockResolvedValue(undefined)
  processExit = 0
  rawOutput = undefined
  wrapper = ''
  terminal = { ok: true, requestId: 'REQ_20260102T030405Z_0010', state: 'RESULT_DURABLE', code: 'RESULT_DURABLE', resultZip: 'C:/fixture/результат.zip', resultHandoffPath: 'C:/fixture/handoff.json' }
  io.spawn.mockImplementation(() => {
    const child = new EventEmitter()
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
    const stdin = Object.assign(new EventEmitter(), { end: (value: string) => {
      wrapper = value
      queueMicrotask(() => {
        stdout.emit('data', rawOutput ?? JSON.stringify(terminal))
        child.emit('close', processExit)
      })
    } })
    return Object.assign(child, { stdout, stderr, stdin })
  })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('Direct Postman workspace resolution', () => {
  it('uses the current workspace, not legacy home or a fixed user path', () => {
    vi.stubEnv('DSH_HOME', 'C:/legacy-home')
    const workspace = path.resolve('isolated-workspace')
    expect(resolveDirectPostmanBridgePath(workspace)).toBe(path.join(workspace, 'postman', 'direct', 'postman.ps1'))
    expect(resolveDirectPostmanBridgePath()).toBe(path.join(process.cwd(), 'postman', 'direct', 'postman.ps1'))
  })
})

describe('Direct Postman isolated transport contract', () => {
  it('preserves the exact task, hides the process and enforces UTF-8 at both boundaries', async () => {
    const task = '  Задача 🧪\r\n"quoted" $variable; --chat should remain text\nконец  '
    vi.stubEnv('ATG_POSTMAN_CHAT_REQUEST_ID', oldRequest)
    const result = await invokeDirectPostman({ task })
    expect(result.ok).toBe(true)
    expect(result.resultZip).toBe(terminal['resultZip'])
    expect(io.writeFile).toHaveBeenCalledWith(path.join('mock-temp', 'transport', 'task.txt'), task, { encoding: 'utf8' })
    expect(io.spawn).toHaveBeenCalledTimes(1)
    const [command, argv, options] = io.spawn.mock.calls[0]!
    expect(String(command)).not.toContain(task)
    expect(argv).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'])
    expect(options).toMatchObject({ windowsHide: true, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: {
      ATG_POSTMAN_BRIDGE: resolveDirectPostmanBridgePath(), ATG_POSTMAN_CHAT_REQUEST_ID: '', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    } })
    expect(wrapper).toContain('[Console]::OutputEncoding = $utf8')
    expect(wrapper).toContain('$OutputEncoding = $utf8')
    expect(wrapper).toContain('[System.IO.File]::ReadAllText')
    expect(wrapper).not.toContain(task)
    expect(io.rm).toHaveBeenCalledWith(path.join('mock-temp', 'transport'), { recursive: true, force: true })
  })

  it('uses the old request only as lookup key and allocates a new identity for every send', async () => {
    const first = await invokeDirectPostman({ task: 'first' })
    terminal = { ...terminal, requestId: 'REQ_20260102T030405Z_0011', continuedFromRequestId: oldRequest }
    const second = await invokeDirectPostman({ task: 'исправить только это', chatRequestId: oldRequest })
    expect(first.requestId).not.toBe(second.requestId)
    expect(second.requestId).not.toBe(oldRequest)
    expect(second.continuedFromRequestId).toBe(oldRequest)
    expect(io.spawn.mock.calls[1]![2].env).toMatchObject({ ATG_POSTMAN_CHAT_REQUEST_ID: oldRequest, ATG_POSTMAN_REQUEST_ID: second.requestId })
    expect(io.writeFile.mock.calls[1]![1]).toBe('исправить только это')
  })

  it.each(['requestId', 'state', 'code', 'resultZip', 'resultHandoffPath'])('rejects an incomplete success missing %s', async field => {
    delete terminal[field]
    expect((await invokeDirectPostman({ task: 'fixture' })).ok).toBe(false)
    expect(io.spawn).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ requestId: oldRequest }, 'POSTMAN_REQUEST_ID_MISMATCH'],
    [{ state: 'PUBLISHED' }, 'POSTMAN_RESULT_NOT_DURABLE'],
    [{ code: 'OK' }, 'POSTMAN_RESULT_NOT_DURABLE'],
    [{ ok: false, code: 'DIRECT_CHAT_REFERENCE_UNAVAILABLE', state: 'FAILED', error: 'Чат не найден' }, 'DIRECT_CHAT_REFERENCE_UNAVAILABLE'],
  ])('fails closed without retry for %j', async (change, code) => {
    Object.assign(terminal, change)
    const result = await invokeDirectPostman({ task: 'fixture' })
    expect(result).toMatchObject({ ok: false, code })
    expect(io.spawn).toHaveBeenCalledTimes(1)
  })

  it('does not accept an earlier success before malformed final output', async () => {
    rawOutput = JSON.stringify(terminal) + '\n{broken final record'
    expect(await invokeDirectPostman({ task: 'fixture' })).toMatchObject({ ok: false, code: 'POSTMAN_RESULT_JSON_INVALID' })
  })
  it('accepts canonical final JSON after diagnostic lines', async () => {
    rawOutput = 'diagnostic\n' + JSON.stringify(terminal) + '\n'
    expect((await invokeDirectPostman({ task: 'fixture' })).ok).toBe(true)
  })
  it('rejects success on nonzero process exit', async () => {
    processExit = 1
    expect(await invokeDirectPostman({ task: 'fixture' })).toMatchObject({ ok: false, code: 'POSTMAN_PROCESS_EXIT_NONZERO' })
  })
  it('never invokes a missing entrypoint or searches a legacy installation', async () => {
    io.access.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(await invokeDirectPostman({ task: 'fixture' })).toMatchObject({ ok: false, code: 'POSTMAN_DIRECT_BRIDGE_MISSING' })
    expect(io.spawn).not.toHaveBeenCalled()
  })
  it('rejects invalid input and pre-aborted work before transport', async () => {
    await expect(invokeDirectPostman({ task: ' ' })).rejects.toThrow('empty')
    await expect(invokeDirectPostman({ task: 'fixture', chatRequestId: 'https://example.invalid/chat' })).rejects.toThrow('canonical')
    await expect(invokeDirectPostman({ task: 'fixture', signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled')
    expect(io.spawn).not.toHaveBeenCalled()
    expect(io.writeFile).not.toHaveBeenCalled()
  })
  it('cleans the temporary directory even when writing the task fails', async () => {
    io.writeFile.mockRejectedValue(new Error('disk full'))
    await expect(invokeDirectPostman({ task: 'fixture' })).rejects.toThrow('disk full')
    expect(io.spawn).not.toHaveBeenCalled()
    expect(io.rm).toHaveBeenCalledTimes(1)
  })
  it('returns a spawn failure without any fallback', async () => {
    io.spawn.mockImplementation(() => { throw new Error('spawn denied') })
    expect(await invokeDirectPostman({ task: 'fixture' })).toMatchObject({ ok: false, code: 'POSTMAN_INVOCATION_NOT_STARTED' })
    expect(io.spawn).toHaveBeenCalledTimes(1)
    expect(io.rm).toHaveBeenCalledTimes(1)
  })
})
