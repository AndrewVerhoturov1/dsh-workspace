import { PostmanRuntime } from '../plugins/dsh-postman-harness/lib/runtime.js'

const signalPathIndex = process.argv.indexOf('--SignalPath')
const signalPath = signalPathIndex >= 0 ? process.argv[signalPathIndex + 1] : undefined
if (!signalPath) {
  console.error('SignalPath is required')
  process.exit(2)
}

const runtime = new PostmanRuntime()
let exitCode = 0
try {
  const result = runtime.ingestSignalFile(signalPath, { wake: false })
  console.log(JSON.stringify(result))
  exitCode = result.status === 'EXTERNAL_READY_UNKNOWN_REQUEST' || result.status === 'EXTERNAL_READY_INVALID' ? 2 : 0
} catch (error) {
  runtime.journal('GITHUB_SIGNAL_INGEST_FAILED', { error: String(error?.message ?? error) })
  console.error(`GITHUB_SIGNAL_INGEST_FAILED: ${error?.message ?? error}`)
  exitCode = 1
} finally {
  runtime.close()
}
process.exitCode = exitCode
