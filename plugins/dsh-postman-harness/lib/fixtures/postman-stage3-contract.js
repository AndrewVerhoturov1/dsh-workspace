import assert from 'node:assert/strict'

// Small semantic markers, not a wording snapshot. Called on actual native requests.
export const managementMarkers = {
  leader: [/POSTMAN_LEADER_SKILL_VERSION: 29/, /Management Kernel/, /execution graph/i,
    /critical path/i, /dispatch first/i, /environment readiness/i, /Exact-path-first delegation/,
    /Known-status branching/, /retire unused agents/, /REPORT RECEIVED/, /VERIFIED BY LEADER/,
    /external_event/, /один active implementation writer/, /Canonical Harness browser/],
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
    /direct-only/, /environment readiness/, /SHOW_TO_USER/],
}

export function assertManagementRequest(role, request) {
  assert.equal(typeof request.system, 'string', role + ': actual request.system')
  // Leader skill is Host-projected runtime context in request.messages; child
  // canonical roles are system sections. Both are actual model inputs.
  const instructions = role === 'leader' ? request.system + '\n' + JSON.stringify(request.messages) : request.system
  for (const marker of managementMarkers[role]) assert.ok(marker.test(instructions), role + ': missing ' + marker)
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
