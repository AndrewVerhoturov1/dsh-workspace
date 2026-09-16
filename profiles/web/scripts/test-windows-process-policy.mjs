import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const profileRoot = resolveProfileRoot()
const requireFromProfile = createRequire(join(profileRoot, 'package.json'))

function resolveProfileRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

function packageRoot(name) {
  return dirname(requireFromProfile.resolve(`${name}/package.json`))
}

function moduleTable() {
  const calls = []
  const noopModule = new Proxy({}, {
    get: (_target, property) => {
      if (property === 'then') return undefined
      return () => undefined
    },
  })
  const childProcess = new Proxy({
    spawn: (...args) => {
      calls.push(args)
      return undefined
    },
  }, {
    get: (target, property) => target[property] ?? (() => undefined),
    set: (target, property, value) => {
      target[property] = value
      return true
    },
  })
  const fs = new Proxy({ promises: noopModule }, {
    get: (_target, property) => property === 'promises' ? noopModule : () => undefined,
    set: () => true,
  })
  const path = {
    resolve: (...parts) => parts.join('/'),
  }
  return { calls, childProcess, fs, path }
}

async function testPtcVirtualization() {
  const modulePath = join(packageRoot('dsh-ptc-plus'), 'internal', 'worker-cwd-virtualization.js')
  const { installWorkerCwdVirtualization } = await import(pathToFileURL(modulePath).href)
  const modules = moduleTable()
  const originalCwd = process.cwd
  try {
    installWorkerCwdVirtualization('C:/session', name => {
      if (name === 'node:child_process') return modules.childProcess
      if (name === 'node:fs') return modules.fs
      if (name === 'node:path') return modules.path
      throw new Error(`unexpected module ${name}`)
    })
    modules.childProcess.spawn('powershell.exe', ['-Command', 'Get-Date'], {
      cwd: 'C:/caller',
      windowsHide: false,
    })
    modules.childProcess.spawn('git', [])
  } finally {
    process.cwd = originalCwd
  }
  assert.deepEqual(modules.calls.map(args => args[2]), [
    { cwd: 'C:/caller', windowsHide: true },
    { cwd: 'C:/session', windowsHide: true },
  ])
}

async function testPatchContents() {
  const files = {
    subprocess: join(packageRoot('@deepseek-ai/dsh-subprocess-local'), 'lib', 'index.js'),
    pwsh: join(packageRoot('@deepseek-ai/dsh-pwsh-local'), 'lib', 'index.js'),
    sandbox: join(packageRoot('@deepseek-ai/dsh-pwsh-sandbox'), 'lib', 'index.js'),
    notification: join(packageRoot('dsh-notification'), 'index.js'),
  }
  const contents = Object.fromEntries(
    await Promise.all(Object.entries(files).map(async ([name, path]) => [name, await readFile(path, 'utf8')])),
  )
  assert.match(contents.subprocess, /windowsHide: platform === "win32"/)
  assert.match(contents.subprocess, /useConpty: true/)
  assert.match(contents.pwsh, /"-WindowStyle",\s*"Hidden"/)
  assert.match(contents.sandbox, /"-WindowStyle",\s*"Hidden"/)
  assert.match(contents.notification, /'-WindowStyle',\s*'Hidden'/)
  assert.match(contents.notification, /windowsHide: true/)
}

await testPtcVirtualization()
await testPatchContents()
console.log('Windows process policy checks passed')
