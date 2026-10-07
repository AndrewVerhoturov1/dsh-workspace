import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {capabilityRuntime} from './fixtures/postman-capability-runtime.js'
import {managementMarkers, assertManagementRequest, obsoleteSolPermission} from './fixtures/postman-stage3-contract.js'
import {postmanRoleInstruction, FAST_WORKER_BUDGET} from './postman-worker.js'
import {POSTMAN_PTC_DISCIPLINE} from './ptc-discipline.js'

const root = new URL('../../../', import.meta.url)
test('bounded Stage 3 source contract: kernel first, routing, safety and FAST budget', async () => {
  const leader = await readFile(new URL('.agents/skills/postman-leader/SKILL.md', root), 'utf8')
  for (const marker of managementMarkers.leader) assert.match(leader, marker)
  assert.ok(leader.indexOf('## 2. Management Kernel') < leader.indexOf('## 4. Routing'))
  assert.ok(leader.split('\n').length < 350, 'structural rewrite, not another append-only playbook')
  for (const kind of ['DECISION','FACT','IMPLEMENTATION','MECHANICAL_VERIFY','USER_VISIBLE_VERIFY','EXTERNAL_RESEARCH','TRANSPORT','USER_INPUT']) assert.ok(leader.includes(kind), kind)
  for (const role of ['luna','secretary','sol']) {
    const skill = postmanRoleInstruction(role)
    for (const marker of managementMarkers[role]) assert.match(skill, marker)
    assert.match(skill, /hardBudget:15/)
  }
  assert.match(leader, /constraint без источника/i)
  for (const path of ['.agents/skills/postman-leader/SKILL.md',
    '.agents/skills/postman-sol-worker/SKILL.md',
    '.agent-presets/postman-leader/agent.cordis.yml', '.agent-presets/postman-leader-ptc/agent.cordis.yml',
    'plugins/dsh-postman-harness/README.md', 'postman/POSTMAN_BRIDGE_FLOW.md',
    'docs/subprojects/postman/SUBPROJECT.md', 'docs/subprojects/ptc/PTC_CONTRACT.md']) {
    const text = await readFile(new URL(path, root), 'utf8')
    assert.doesNotMatch(text, obsoleteSolPermission, path + ': no obsolete normative Sol permission')
    assert.doesNotMatch(text, /Sol controls direct-only у Sol|controls собственных Worker остаются direct-only|Worker controls (?:are )?direct-only/, path + ': no obsolete Sol direct-control flow')
  }
  assert.match(leader, /NOT_SENT \/ TERMINAL \/ OUTCOME_UNKNOWN/)
  assert.match(POSTMAN_PTC_DISCIPLINE, /true successful-path/)
  assert.match(POSTMAN_PTC_DISCIPLINE, /multi-outcome lifecycle/)
  assert.doesNotMatch(POSTMAN_PTC_DISCIPLINE, /experimental Leader|Child role execution is direct/i)
  assert.match(POSTMAN_PTC_DISCIPLINE, /canonical\/compat Leader uses supervisor PTC/)
  assert.match(POSTMAN_PTC_DISCIPLINE, /Host-managed Sol Worker\s+uses a separate engineering PTC profile/)
  assert.match(POSTMAN_PTC_DISCIPLINE, /Sol owned Worker controls are PTC-managed \/ PTC-only/)
  assert.match(POSTMAN_PTC_DISCIPLINE, /ordinary Worker and Secretary remain direct-only, without PTC/)
  const readme = await readFile(new URL('plugins/dsh-postman-harness/README.md', root), 'utf8')
  const compact = readme.split('\n').find(line => line.startsWith('`postman_worker_compact('))
  assert.match(compact, /resident idle Worker ИЛИ proven settled non-resident durable Worker/)
  assert.match(compact, /ту же Session\/ID, binding, FAST budget/)
  assert.match(compact, /Active\/pending\/uncertain остаются blocked\/busy/)
  assert.doesNotMatch(readme, /compactNow` только для trustworthy exact resident/)
  const contract = await readFile(new URL('docs/subprojects/ptc/PTC_CONTRACT.md', root), 'utf8')
  assert.match(contract, /Skill v31/); assert.doesNotMatch(contract, /Skill v(?:29|30)/)
  assert.match(contract, /postman_task_prepare\/postman_task_restore\/postman_task_close\/postman_input_files/)
  assert.match(contract, /postman_task_close` явно retire-ит settled Leader task binding/)
  assert.match(contract, /не Git cleanup и не доказательство success/)
  assert.match(contract, /runtime default — hard16; configurable `hardBudget` 8\.\.24; независимый budget каждого assignment/)
  assert.match(contract, /Stage 3 assignments явно запрашивают `hardBudget:15` → Host soft12/)
  assert.equal(FAST_WORKER_BUDGET.hardLimit, 16)
  const example = leader.match(/const r = await tools.postman_worker_compact[\s\S]*?unexpected_status[^\n]*/)?.[0]
  assert.ok(example, 'known status branching example')
  assert.doesNotMatch(example, /expectStatus/)
  assert.match(example, /POSTMAN_WORKER_COMPACT_NOT_RESIDENT/)
  const browser = JSON.parse(await readFile(new URL('profiles/web/playwright-mcp.config.json', root), 'utf8'))
  assert.equal(browser.browser.isolated, true)
  assert.equal(browser.browser.browserName, 'chromium')
  assert.equal(browser.browser.launchOptions.headless, true)
  for (const text of [leader, postmanRoleInstruction('luna'), postmanRoleInstruction('sol')]) {
    assert.match(text, /mcp__playwright__browser_/)
    assert.match(text, /SHOW_TO_USER/)
    assert.match(text, /transport Chrome/i)
  }
})

// Scripted text-only turns verify contract delivery before any task preparation.
// They are NOT evidence that a real model makes the right routing decision.
for (const preset of ['postman-leader', 'postman-leader-ptc']) {
  test(preset + ' actual routing requests retain initial approval in localDevelopment', {timeout:45000}, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'postman-stage3-routing-'))
    const f = await capabilityRuntime(dir, {preset, localDevelopment:true})
    t.after(async () => {await f.dispose(); await rm(dir, {recursive:true, force:true, maxRetries:5, retryDelay:100})})
    for (const prompt of [
      'Trivial factual request: report the value from this supplied exact config excerpt: enabled=true.',
      'New task: run one known targeted test. Propose a compact execution plan; no execution before approval.',
      'Unknown affected symbol: bounded facts first, then decide if difficult engineering needs Sol.',
      'Obviously difficult local concurrency/authority engineering review; select a reliable route and request plan approval.',
      'External current provider API research and a useful independent outside opinion; propose routing only.',
      'Same approved scope correction; conditional Sol escalation was preapproved. Do not ask per-role approval.',
      'New independent outcome plus public transport and material cost/access change: stop for revised-plan approval.',
    ]) {
      const request = await f.turn(f.leader, prompt)
      assertManagementRequest('leader', request)
      assert.match(request.system, /localDevelopment[^.]*does not bypass initial execution-plan approval/)
      assert.match(request.system, /Truly trivial read-only\/factual requests execute directly/)
      assert.match(request.system, /no Worker\/Secretary\/Sol, Bridge\/Postman transport, implementation, tests\/build or mutating Git\/product operations/)
      assert.match(request.system, /Local deep engineering\/review -> Sol; external\/current research or useful independent outside opinion -> PostmanAsk/)
      assert.match(request.system, /STOP -> revised plan -> approval/)
      assert.equal(f.results.length, 0, 'delivery-only fixture executes no tools or transport')
      assert.equal(f.registry.get('leader'), null, 'no task preparation or role creation')
    }
  })
}

// Controlled model is scripted: proves delivery and an executable bounded path,
// NOT that a real Luna/Sol chooses these actions. Live prompts remain in README.
test('controlled exact file + command needs no broad discovery under Leader or Sol', {timeout:45000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'postman-stage3-exact-'))
  const gate = Promise.withResolvers(), entered = Promise.withResolvers()
  t.after(() => gate.resolve())
  let f, exact
  const command = "Write-Output 'exact-command-evidence'"
  f = await capabilityRuntime(dir, {preset:'postman-leader', plan:async (agent, request, n) => {
    if (agent.id === 'leader') return null
    if (agent.options.model === 'gpt-6.1-sol') {
      assertManagementRequest('sol', request); entered.resolve(agent); await gate.promise
      return {name:'report', args:{output:'PASS controlled owned evidence aggregated'}}
    }
    assertManagementRequest('luna', request)
    if (n === 1) {
      assert.ok(JSON.stringify(request.messages).includes(JSON.stringify(exact).slice(1,-1)), 'assignment delivers exact path')
      assert.ok(JSON.stringify(request.messages).includes(command), 'assignment delivers exact command')
      return {name:'read', args:{file_path:exact}}
    }
    if (n === 2) return {name:'pwsh', args:{command, workdir:f.worktree, description:'Print exact controlled command evidence'}}
    return {name:'report', args:{output:'PASS: changed none; verified exact file and command; remaining none'}}
  }})
  t.after(async () => {await f.dispose(); await rm(dir, {recursive:true, force:true, maxRetries:5, retryDelay:100})})
  await f.prepare(); exact = join(f.worktree, 'exact.txt'); await writeFile(exact, 'exact-file-evidence')
  assertManagementRequest('leader', await f.turn(f.leader))
  const value = r => {assert.equal(r.isError, false, JSON.stringify(r)); return r.value}
  const call = async (name, args) => {
    const r = value(await f.execute(f.leader, 'ptc_execute', {program:'return await tools.'+name+'('+JSON.stringify(args)+')',description:'Dispatch exact controlled task before review',boundary:'semantic_decision'}))
    assert.equal(r.status, 'ok', JSON.stringify(r)); return r.value
  }
  const assignment = {task:'Objective: verify exact file '+exact+' and exact command '+command+'. Type: mechanical verification. Scope: these targets only; no writes. Done: exact evidence matches. Verification: file text exact-file-evidence and command output exact-command-evidence. Stop: report or precise blocker. Established: environment ready.', hardBudget:15}
  const direct = await call('postman_worker', assignment)
  assert.equal(direct.status, 'POSTMAN_WORKER_TASK_ACCEPTED'); await f.childDone(direct.workerSessionId)
  const acceptedSol = await call('postman_sol_worker', {task:'Approved execution plan: Leader selected expensive Sol for bounded controlled evidence aggregation, no implementation.'})
  assert.equal(acceptedSol.status, 'POSTMAN_WORKER_TASK_ACCEPTED'); const sol = await entered.promise
  const owned = value(await f.execute(sol,'ptc_execute',{program:'return await tools.postman_worker('+JSON.stringify(assignment)+')',description:'Dispatch owned bounded check before review',boundary:'semantic_decision'})).value
  assert.equal(owned.status, 'POSTMAN_WORKER_TASK_ACCEPTED'); await f.childDone(owned.workerSessionId)
  for (const id of [direct.workerSessionId, owned.workerSessionId]) {
    const actions = f.results.filter(r => r.agent.id === id)
    assert.deepEqual(actions.map(r => r.name), ['read','pwsh','report'])
    for (const r of actions) assert.equal(r.result.isError, false, JSON.stringify(r.result))
    assert.equal(actions[0].result.value.lines[0].text, 'exact-file-evidence')
    assert.match(JSON.stringify(actions[1].result.value), /exact-command-evidence/)
    const budget = f.registry.get('leader').workers[id].budget
    assert.equal(budget.hardLimit, 15); assert.equal(budget.softLimit, 12); assert.equal(budget.used, 3)
    for (const {request} of f.requests.filter(r => r.agent.id === id)) assertManagementRequest('luna', request)
  }
  gate.resolve(); await f.childDone(sol.id)
})
