import assert from 'node:assert/strict'
import {POSTMAN_PTC_DISCIPLINE} from '../ptc-discipline.js'

// Obsolete normative Sol permission must not reach model instructions or tool schemas.
export const obsoleteSolPermission = /(?:Only on an explicit user request: create or continue the one Sol Worker|Use Sol Worker only when the user explicitly asks|Sol.{0,100}только (?:по прямой просьбе пользователя|прямо выбран пользователем|явный выбор пользователя)|Never (?:automatically escalate Luna to Sol|choose it autonomously)|no automatic Luna-to-Sol escalation|автоматической escalation Luna → Sol нет|fresh не разрешает автоматический выбор Sol|явный выбор Sol Worker пользователем|выбранный пользователем Sol route|user-selected Sol route|explicit user-selected Sol|no automatic choice of Sol)/i

// Small semantic markers, not a wording snapshot. Called on actual native requests.
export const managementMarkers = {
  leader: [
    /POSTMAN_LEADER_SKILL_VERSION: 33/, /Management Kernel/, /execution graph/i,
    /critical path/i, /dispatch first/i, /environment readiness/i, /Dependency provenance:/,
    /tasks are independent/, /DECISION/, /IMPLEMENTATION/, /EXTERNAL_RESEARCH/,
    /Secretary/, /postman_secretary_ledger/, /PostmanDevspace/, /laneId/,
    /postman_devspace_control/, /Computer Use/, /CHATGPT|ChatGPT/, /computer_use:'allow'\|'deny'/,
    /PTC = supervisor phase, not tool wrapper/, /Supervisor dispatch phase/,
    /Reconciliation\/cleanup phase/, /Known-status branching/, /external_event/,
    /not a required first step/, /no ritual snapshot or standalone model round/,
    /continuation_blocked/, /NOT_SENT \/ TERMINAL \/ OUTCOME_UNKNOWN/,
    /REPORT RECEIVED/, /VERIFIED BY LEADER/, /sufficient acceptance evidence/,
    /Exact-path-first delegation/, /hardBudget:60/, /softLimit:48/,
    /Already established:/, /Still needed:/, /Next decision boundary:/,
    /task worktree/i, /(?:one|один) active implementation writer/i,
    /Sol Worker/, /Worker N/, /Postman Artifact Bridge/, /Postman Ask Bridge/,
    /Postman Image Bridge/, /retire unused agents/, /STOP → revised plan → approval/,
    /TASK_CONTRACT/, /legacy/i
  ],
  luna: [/bounded FAST executor/, /Exact-path-first/, /Canonical skill already injected/,
    /skill\(postman-worker\)/, /Другие (?:специализированные|specialized) skills допустимы/i,
    /soft warning/i, /no new discovery branch/i, /NEEDS_PARENT_GUIDANCE/, /changed \/ verified \/ remaining/,
    /No architecture/, /Canonical Harness browser/, /Cheap evidence/, /unknown != complex/],
  secretary: [/fact collector/, /Exact-path-first/, /Canonical skill already injected/,
    /skill\(postman-secretary\)/, /Другие (?:специализированные|specialized) skills допустимы/i,
    /stop after requested facts|после report stop/, /meaningful milestones/, /No implementation/,
    /soft warning/i, /NEEDS_PARENT_GUIDANCE/, /поиск|поиск, веб|веб-поиск/, /unknown != complex/],
  sol: [/Engineering judgement stays with Sol/, /Dispatch-first algorithm/,
    /первой meaningful Sol decision/, /оба сразу/, /Dispatch first/,
    /PTC-first/, /Worker-first/, /Exact-path-first delegation/,
    /Canonical skill already injected/, /skill\(postman-sol-worker\)/,
    /direct-only/, /environment readiness/, /SHOW_TO_USER/, /POSTMAN_SOL_WORKER_SKILL_VERSION: 3/,
    /PTC = engineering phase, not tool wrapper/, /Investigation phase/, /Implementation phase/, /Verification closure phase/,
     /PTC-managed \/ PTC-only/, /ONE PTC/, /external_event/, /реальные owned Worker reports/,
     /terminal assignment result, не progress\/FYI/, /generic child report guidance/, /report завершает turn/, /decision-relevant escalation/, /не FYI\/progress\/обычный completion/,
    /дорогой (?:Leader-selectable|резервный маршрут)/, /Initial plan approval принадлежит Leader/, /без отдельного разрешения на роль/,
    /preapproved conditional escalation/, /revised-plan approval/, /unknown != complex/, /cheapest reliable route/i,
    /hardBudget:60/, /softLimit:48/, /smaller valid budget/,
    /Already established:/, /Still needed:/, /Next decision boundary:/,
    /Same task \+ large relevant context → compact/, /New assignment where old visible context is harmful → fresh/,
     /Worker N \(Sol\)/, /номер.*сессии|session.*number/i, /не повторно используй номера/, /fresh.*следующий номер/i, /label.*явно|явно.*label/i, /task-topic/,
     /Secretary`/, /Postman Artifact Bridge/, /Postman Ask Bridge/, /Postman Image Bridge/]
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
    for (const marker of [/Deterministic phase rule/, /Next-tool-known rule/,
      /materially\s+different implementation approaches/, /mechanical completion is NOT a boundary/,
      /Mandatory pre-return self-check/, /presumptively underbatched/, /decisionQuestion/,
      /human approval_boundary is a genuine stop/, /outside PTC/, /batching must never cross or hide this boundary/])
      assert.match(request.system, marker, role + ': Stage 3.5A discipline')
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
