import assert from 'node:assert/strict'
import {POSTMAN_PTC_DISCIPLINE} from '../ptc-discipline.js'

// Obsolete normative Sol permission must not reach model instructions or tool schemas.
export const obsoleteSolPermission = /(?:Only on an explicit user request: create or continue the one Sol Worker|Use Sol Worker only when the user explicitly asks|Sol.{0,100}только (?:по прямой просьбе пользователя|прямо выбран пользователем|явный выбор пользователя)|Never (?:automatically escalate Luna to Sol|choose it autonomously)|no automatic Luna-to-Sol escalation|автоматической escalation Luna → Sol нет|fresh не разрешает автоматический выбор Sol|явный выбор Sol Worker пользователем|выбранный пользователем Sol route|user-selected Sol route|explicit user-selected Sol|no automatic choice of Sol)/i

// Small semantic markers, not a wording snapshot. Called on actual native requests.
export const managementMarkers = {
  leader: [/POSTMAN_LEADER_SKILL_VERSION:/, /Secretary/, /postman_secretary_ledger/,
    /PostmanDevspace/, /laneId/, /postman_devspace_control/, /Computer Use/,
    /PTC обязателен/, /wait_for_event:true/, /Host не готовит ветки/,
    /Готовый bell\/текстовый отчёт доступен/, /независимо от состояния Luna/,
    /NOT_SENT \/ TERMINAL \/ OUTCOME_UNKNOWN/, /повторным Send/,
    /TASK_CONTRACT/, /REPO_POLICY/, /hardBudget:60/, /softLimit:48/],
  luna: [/bounded FAST executor/, /Exact-path-first/, /Canonical skill already injected/,
    /soft warning/i, /NEEDS_PARENT_GUIDANCE/, /changed \/ verified \/ remaining/,
    /No architecture/, /Canonical Harness browser/, /назначенный `cwd`/],
  secretary: [/fact collector/, /Exact-path-first/, /Canonical skill already injected/,
    /meaningful milestones/, /No implementation/, /NEEDS_PARENT_GUIDANCE/,
    /поиск|веб/, /postman_secretary_ledger/],
  sol: [/Engineering judgement stays with Sol/, /Dispatch-first algorithm/,
    /PTC-first/, /Worker-first/, /POSTMAN_SOL_WORKER_SKILL_VERSION:/,
    /wait_for_event:true/, /отказы.*данные|Отказ.*данные/,
    /report.*terminal assignment result/, /NEEDS_PARENT_GUIDANCE/,
    /hardBudget:60/, /softLimit:48/, /Worker N \(Sol\)/, /REPO_POLICY/],
}

export function assertManagementRequest(role, request) {
  assert.equal(typeof request.system, 'string', role + ': actual request.system')
  // Leader skill is Host-projected runtime context in request.messages; child
  // canonical roles are system sections. Both are actual model inputs.
  const instructions = role === 'leader' ? request.system + '\n' + JSON.stringify(request.messages) : request.system
  for (const marker of managementMarkers[role]) assert.ok(marker.test(instructions), role + ': missing ' + marker)
  assert.equal(instructions.match(obsoleteSolPermission)?.[0] ?? null, null, role + ': obsolete Sol permission in actual model input')
  assert.equal(JSON.stringify(request.tools).match(obsoleteSolPermission)?.[0] ?? null, null, role + ': obsolete Sol permission in delivered schemas')
  if (role === 'leader' || role === 'sol') {
    assert.ok(request.system.includes(POSTMAN_PTC_DISCIPLINE), role + ': Host-injected canonical discipline')
    for (const marker of [/Only program is required/, /wait_for_event:true/,
      /tool refusal is ordinary data/, /Completed effects/])
      assert.match(request.system, marker, role + ': minimal PTC discipline')
    assert.doesNotMatch(request.system, /Mandatory pre-return self-check|presumptively underbatched|Known-status branching/)
    assert.doesNotMatch(request.system, /experimental Leader|Child role execution is direct/i)
  }
  assert.doesNotMatch(instructions, /Sol controls direct-only у Sol|Worker controls[^\n.;]*direct-only/, role + ': no obsolete Sol direct-control guidance')
  if (role === 'sol') assert.doesNotMatch(request.system, /direct postman_worker/)
  if (role === 'luna' || role === 'secretary') {
    assert.ok(!request.system.includes(POSTMAN_PTC_DISCIPLINE), role + ': no canonical PTC discipline')
    assert.doesNotMatch(request.system, /PTC EFFICIENCY NOTICE|PTC UNDERBATCH STREAK|Deterministic phase rule/)
  }
  const names = request.tools.map(t => t.name)
  assert.ok(names.includes('skill'), role + ': other specialized skills stay available')
  if (role === 'leader') {
    assert.ok(names.includes('ask_user_question'), 'Leader: approval UI remains direct-only')
    assert.ok(names.includes('exit_plan_mode'), 'Leader: plan approval boundary stays outside PTC')
  }
  assert.equal(names.includes('ptc_execute'), role === 'leader' || role === 'sol', role + ': PTC authority')
  if (role !== 'leader') {
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph', 'postman_bridge'])
      assert.ok(!names.includes(name), role + ': no generic delegation/transport')
    assert.equal(names.includes('postman_worker'), role === 'sol', role + ': child ownership')
    assert.equal(request.model, role === 'sol' ? 'gpt-6.1-sol' : 'gpt-6-luna')
    assert.equal(request.reasoningEffort, role === 'sol' ? 'xhigh' : 'low')
  }
}
