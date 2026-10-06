import assert from 'node:assert/strict'
import {POSTMAN_PTC_DISCIPLINE} from '../ptc-discipline.js'

// Small semantic markers, not a wording snapshot. Called on actual native requests.
export const managementMarkers = {
  leader: [/POSTMAN_LEADER_SKILL_VERSION: 30/, /Management Kernel/, /execution graph/i,
    /critical path/i, /dispatch first/i, /environment readiness/i, /Exact-path-first delegation/,
    /Known-status branching/, /retire unused agents/, /REPORT RECEIVED/, /VERIFIED BY LEADER/,
    /external_event/, /один active implementation writer/, /Canonical Harness browser/,
    /PTC = supervisor phase, not tool wrapper/, /Supervisor dispatch phase/, /Reconciliation\/cleanup phase/, /sufficient acceptance evidence/],
  luna: [/bounded FAST executor/, /Exact-path-first/, /Canonical skill already injected/,
    /skill\(postman-worker\)/, /Другие специализированные skills допустимы/,
    /soft warning/i, /no new discovery branch/i, /NEEDS_PARENT_GUIDANCE/, /changed \/ verified \/ remaining/,
    /No architecture/, /Canonical Harness browser/],
  secretary: [/fact collector/, /Exact-path-first/, /Canonical skill already injected/,
    /skill\(postman-secretary\)/, /Другие специализированные skills допустимы/,
    /stop after requested facts/, /meaningful milestones/, /No implementation/,
    /soft warning/i, /NEEDS_PARENT_GUIDANCE/],
  sol: [/Engineering judgement stays with Sol/, /Dispatch-first algorithm/,
    /первой meaningful Sol decision/, /оба сразу/, /Dispatch first/,
    /PTC-first/, /Worker-first/, /Exact-path-first delegation/,
    /Canonical skill already injected/, /skill\(postman-sol-worker\)/,
    /direct-only/, /environment readiness/, /SHOW_TO_USER/, /POSTMAN_SOL_WORKER_SKILL_VERSION: 1/,
    /PTC = engineering phase, not tool wrapper/, /Investigation phase/, /Implementation phase/, /Verification closure phase/],
}

export function assertManagementRequest(role, request) {
  assert.equal(typeof request.system, 'string', role + ': actual request.system')
  // Leader skill is Host-projected runtime context in request.messages; child
  // canonical roles are system sections. Both are actual model inputs.
  const instructions = role === 'leader' ? request.system + '\n' + JSON.stringify(request.messages) : request.system
  for (const marker of managementMarkers[role]) assert.ok(marker.test(instructions), role + ': missing ' + marker)
  if (role === 'leader' || role === 'sol') {
    assert.ok(request.system.includes(POSTMAN_PTC_DISCIPLINE), role + ': Host-injected canonical discipline')
    for (const marker of [/Deterministic phase rule/, /Next-tool-known rule/,
      /materially\s+different implementation approaches/, /mechanical completion is NOT a boundary/,
      /Mandatory pre-return self-check/, /presumptively underbatched/, /decisionQuestion/])
      assert.match(request.system, marker, role + ': Stage 3.5A discipline')
    assert.doesNotMatch(request.system, /experimental Leader|Child role execution is direct/i)
  }
  if (role === 'luna' || role === 'secretary') {
    assert.ok(!request.system.includes(POSTMAN_PTC_DISCIPLINE), role + ': no canonical PTC discipline')
    assert.doesNotMatch(request.system, /PTC EFFICIENCY NOTICE|PTC UNDERBATCH STREAK|Deterministic phase rule/)
  }
  const names = request.tools.map(t => t.name)
  assert.ok(names.includes('skill'), role + ': other specialized skills stay available')
  assert.equal(names.includes('ptc_execute'), role === 'leader' || role === 'sol', role + ': PTC authority')
  if (role !== 'leader') {
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph', 'postman_bridge'])
      assert.ok(!names.includes(name), role + ': no generic delegation/transport')
    assert.equal(names.includes('postman_worker'), role === 'sol', role + ': child ownership')
    assert.equal(request.model, role === 'sol' ? 'gpt-6.1-sol' : 'gpt-6-luna')
    assert.equal(request.reasoningEffort, role === 'sol' ? 'xhigh' : 'low')
  }
}
