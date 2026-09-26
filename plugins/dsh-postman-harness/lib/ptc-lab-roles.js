import { QuickJSLabRuntime } from './quickjs-lab-runtime.js'

const jsonClone = value => JSON.parse(JSON.stringify(value))

/** Isolated demonstration of distinct Leader, Worker, and Bridge binding grants. */
export class PtcLabRoles {
  constructor({ timeoutMs = 1_000, maxWallMs = 3_000 } = {}) {
    this.runtimes = {
      leader: new QuickJSLabRuntime({ timeoutMs, maxWallMs }),
      worker: new QuickJSLabRuntime({ timeoutMs, maxWallMs }),
      bridge: new QuickJSLabRuntime({ timeoutMs, maxWallMs }),
    }
  }

  run(role, request) {
    const functions = this.bindingsFor(role)
    if (!functions) throw new TypeError(`unknown PTC lab role: ${role}`)
    return this.runtimes[role].run({ ...request, bindings: [{ global: 'tools', functions }] })
  }

  async dispose() {
    await Promise.all(Object.values(this.runtimes).map(runtime => runtime.dispose()))
  }

  bindingsFor(role) {
    switch (role) {
      case 'leader':
        return Object.freeze({
          plan: async args => ({ role: 'leader', accepted: Boolean(args?.intent) }),
          delegateWorker: async args => ({ delegated: Boolean(args?.task) }),
          delegateBridge: async args => ({ delegated: Boolean(args?.request) }),
        })
      case 'worker':
        return Object.freeze({
          executeLocal: async args => ({ role: 'worker', value: jsonClone(args) }),
        })
      case 'bridge':
        return Object.freeze({
          inspectReceipt: async args => ({ requestId: String(args?.requestId ?? ''), state: 'diagnostic-only' }),
        })
      default:
        return undefined
    }
  }
}
