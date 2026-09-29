import assert from 'node:assert/strict'
import { createPtcRuntimeForTest } from '../src/runtime.js'
import { DEFAULT_LIMITS } from '../src/profiles.js'
const p={schemaVersion:1,id:'pipe',revision:1,tools:[],limits:DEFAULT_LIMITS}
const broken=createPtcRuntimeForTest(new URL('./close-input.mjs',import.meta.url))
try {
  const x=await broken.run({program:' '.repeat(250000),profile:p,bindings:{}})
  assert.notEqual(x.status,'ok',JSON.stringify(x))
} finally { await broken.dispose() }
const healthy=createPtcRuntimeForTest(new URL('./fake-executor.mjs',import.meta.url))
try {
  const x=await healthy.run({program:'good',profile:p,bindings:{}})
  assert.equal(x.status,'ok',JSON.stringify(x))
} finally { await healthy.dispose() }
