import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorktreeStudio from '../src/index.ts'
import { registerWorktreeStudioWeb } from '../src/web.ts'
import { createRepositoryFixture, removeFixture, type RepositoryFixture } from './helpers.ts'

let context: Context | undefined
let fixture: RepositoryFixture | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (fixture !== undefined) await removeFixture(fixture.root)
  fixture = undefined
})

async function start(): Promise<{ readonly baseUrl: string; readonly repository: string }> {
  fixture = await createRepositoryFixture()
  context = new Context()
  await context.plugin(HttpServer, { host: '127.0.0.1', port: 0 })
  await context.plugin(LocalSubprocessRuntime)
  await context.plugin(WorktreeStudio, {
    managedRoot: fixture.managedRoot,
    statePath: fixture.statePath,
    gitTimeoutMs: 10_000,
    terminationGraceMs: 200,
    validationTimeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
    reviewMaxBytes: 64 * 1024,
    requireValidation: true,
    allowDelivery: false,
    cloneRoot: join(fixture.root, 'clone'),
    cloneTimeoutMs: 10_000,
  })
  return {
    baseUrl: `http://127.0.0.1:${String(context.webServer.port)}`,
    repository: fixture.repository,
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

async function requestWithHost(url: string, host: string): Promise<number | undefined> {
  const target = new URL(url)
  return await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { host },
    }, (response) => {
      response.resume()
      response.once('end', () => { resolve(response.statusCode) })
    })
    request.once('error', reject)
    request.end()
  })
}

describe('branchline Web route', () => {
  it('rejects a stale runtime.start token before calling the runtime', async () => {
    const currentToken = 'a'.repeat(64)
    const staleToken = 'b'.repeat(64)
    const taskId = 'wt-00000000-0000-4000-8000-000000000001'
    let inspectCalls = 0
    let startCalls = 0
    let handler: any
    const ctx = {
      webServer: {
        register(options: any) {
          handler = options.handler
          return () => undefined
        },
      },
      worktreeStudio: {
        inspect: async (id: string) => {
          inspectCalls += 1
          expect(id).toBe(taskId)
          return { task: { id, changeToken: currentToken }, review: {} }
        },
      },
    }
    const runtime = {
      startTask: async () => {
        startCalls += 1
        return { runtimeId: 'must-not-start' }
      },
    }
    registerWorktreeStudioWeb(ctx as any, {} as any, runtime as any)

    const request: any = Object.assign(
      Readable.from([JSON.stringify({ operation: 'runtime.start', id: taskId, changeToken: staleToken })]),
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:4173',
          origin: 'http://127.0.0.1:4173',
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        socket: { remoteAddress: '127.0.0.1' },
      },
    )
    let status = 0
    let payload: any
    const response: any = {
      writeHead(value: number) { status = value },
      end(value: string) { payload = JSON.parse(value) },
    }

    await handler(request, response)
    expect(status).toBe(409)
    expect(payload).toMatchObject({ ok: false, error: { code: 'state-conflict' } })
    expect(inspectCalls).toBe(1)
    expect(startCalls).toBe(0)
  })

  it('serves the real loopback route and creates a task through its JSON API', async () => {
    const running = await start()
    const origin = running.baseUrl
    const createdResponse = await fetch(`${running.baseUrl}/api/dsh-branchline`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'sec-fetch-site': 'same-origin',
      },
      body: JSON.stringify({
        operation: 'create',
        repository: running.repository,
        title: 'API task',
        validationCommand: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      }),
    })
    expect(createdResponse.status).toBe(200)
    const created = await json(createdResponse)
    expect(created).toMatchObject({
      ok: true,
      value: {
        title: 'API task',
        phase: 'active',
        exists: true,
      },
    })

    const dashboardResponse = await fetch(
      `${running.baseUrl}/api/dsh-branchline?repository=${encodeURIComponent(running.repository)}`,
      { headers: { origin, 'sec-fetch-site': 'same-origin' } },
    )
    expect(dashboardResponse.status).toBe(200)
    expect(await json(dashboardResponse)).toMatchObject({
      ok: true,
      value: { tasks: [{ title: 'API task' }] },
    })
  })

  it('inspects an existing worktree through the runtime API without taking ownership', async () => {
    const running = await start()
    const response = await fetch(`${running.baseUrl}/api/dsh-branchline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: running.baseUrl, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ operation: 'runtime.inspect', worktreePath: running.repository }),
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      ok: true,
      value: { source: 'external-worktree' },
    })
  })

  it('rejects cross-site, rebound-host, and unsupported-method requests', async () => {
    const running = await start()
    const crossSite = await fetch(`${running.baseUrl}/api/dsh-branchline`, {
      headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(403)

    const rebound = await requestWithHost(`${running.baseUrl}/api/dsh-branchline`, 'attacker.example')
    expect(rebound).toBe(403)

    const unsupported = await fetch(`${running.baseUrl}/api/dsh-branchline`, {
      method: 'DELETE',
      headers: { origin: running.baseUrl, 'sec-fetch-site': 'same-origin' },
    })
    expect(unsupported.status).toBe(405)
  })

  it('rejects create requests that mix or misuse repository sources', async () => {
    const running = await start()
    const origin = running.baseUrl
    const post = (body: Record<string, unknown>): Promise<Response> => fetch(`${running.baseUrl}/api/dsh-branchline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify(body),
    })

    const mixed = await post({
      operation: 'create',
      repository: running.repository,
      cloneFrom: 'owner/repo',
      title: 'mixed sources',
    })
    expect(mixed.status).toBe(400)
    expect(await json(mixed)).toMatchObject({ ok: false, error: { code: 'invalid-input' } })

    const invalidSource = await post({
      operation: 'create',
      cloneFrom: 'not a source',
      title: 'invalid clone source',
    })
    expect(invalidSource.status).toBe(400)
    expect(await json(invalidSource)).toMatchObject({ ok: false, error: { code: 'invalid-input' } })

    const missingSource = await post({ operation: 'create', title: 'no source' })
    expect(missingSource.status).toBe(400)
    expect(await json(missingSource)).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
  })
})
