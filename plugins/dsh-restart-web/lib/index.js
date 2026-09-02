'use strict'

Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' })

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const name = 'dsh-restart-web'
const inject = ['webServer']
const CANONICAL_PORT = 4173
const CANONICAL_PROFILE = 'web'
const CANONICAL_WORKING_DIRECTORY = process.env.DSH_WORKING_DIRECTORY || 'C:\\Users\\andre\\.dsh'
const LAUNCHER_ROOT = process.env.DSH_LAUNCHER_ROOT || path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\andre', 'AppData', 'Local'),
  'DeepSeekHarnessLauncher',
)
const CONTROLLER_SOURCE = path.join(LAUNCHER_ROOT, 'dsh-process-controller.js')
const RESTART_HELPER_SOURCE = path.join(LAUNCHER_ROOT, 'Web-Restart.vbs')

function controllerPath() {
  const configured = process.env.DSH_PROCESS_CONTROLLER
  return configured || CONTROLLER_SOURCE
}

function spawnRestartController() {
  const script = controllerPath()
  if (!fs.existsSync(script)) throw new Error(`Контроллер DSH не найден: ${script}`)
  if (!fs.existsSync(RESTART_HELPER_SOURCE)) throw new Error(`Сценарий перезапуска не найден: ${RESTART_HELPER_SOURCE}`)
  const child = process.platform === 'win32'
    ? spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), [RESTART_HELPER_SOURCE], {
      cwd: CANONICAL_WORKING_DIRECTORY,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    : spawn(process.execPath, argumentsList, {
      cwd: CANONICAL_WORKING_DIRECTORY,
      detached: true,
      stdio: 'ignore',
    })
  child.unref()
  return child.pid
}

function apply(ctx) {
  const webServer = ctx.webServer
  const dispose = webServer.register({
    kind: 'exact',
    path: '/api/dsh-restart',
    handler: async (_req, res) => {
      try {
        const pid = spawnRestartController()
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, status: 'RESTART_SCHEDULED', pid }))
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(error && error.message || error) }))
      }
    },
  })
  ctx.effect(() => dispose, 'dsh-restart-web route')
}

module.exports.name = name
module.exports.inject = inject
module.exports.apply = apply
module.exports.CANONICAL_PORT = CANONICAL_PORT
module.exports.CANONICAL_PROFILE = CANONICAL_PROFILE
module.exports.spawnRestartController = spawnRestartController
