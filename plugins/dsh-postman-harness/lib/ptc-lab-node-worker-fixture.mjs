import { parentPort } from 'node:worker_threads'
import { runBrowserLabProgram } from './ptc-lab-browser-worker.mjs'

parentPort.on('message', async message => {
  if (message.type !== 'run') return
  const result = await runBrowserLabProgram({ role: message.role, program: message.program, timeoutMs: message.timeoutMs })
  parentPort.postMessage({ type: 'done', runId: message.runId, ...result })
})
