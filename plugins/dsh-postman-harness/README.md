# dsh-postman-harness

## Статус

`dsh-postman-harness` не является отдельным browser transport. Production transport остаётся в
`postman/direct/`.

Этот README описывает Host architecture и tool boundaries; Direct lifecycle и automatic continuation задаёт [Current Flow](../../postman/POSTMAN_CURRENT_FLOW.md), Ask delta — [Ask Flow](../../postman/POSTMAN_ASK_FLOW.md), Leader lifecycle — [Bridge Flow](../../postman/POSTMAN_BRIDGE_FLOW.md). Plugin владеет trusted Harness orchestration boundary:

```text
exact current @Postman / @PostmanAsk
→ no-argument current-turn tools
→ existing Direct Postman wrappers
```

и двумя отдельными supervisor capabilities:

```text
Postman Leader
→ postman_bridge(message="@Postman..." | "@PostmanAsk...")
→ fresh fixed gpt-6-luna child
→ existing trusted current-turn tools
→ existing Direct Postman
→ trusted terminal returned to parent
```

`postman_bridge` не является fallback после Direct failure и не создаёт новый transport. Normal ZIP transport остаётся универсальным: implementation schema и `manifest.json` не проверяются на transport boundary.

```text
Postman Leader
→ postman_worker({ task })
→ continuable spawn codex / gpt-6-luna child
→ локальные инструменты общего preset
→ child-scoped report в точную Leader session
```

## Постоянная дисциплина задачи

Независимый plugin [dsh-task-discipline](../dsh-task-discipline/index.js), подключённый в Web и Headless profiles, регистрирует короткий `TASK_DISCIPLINE` как `systemPrompt.section({ name: "dsh:task-discipline", order: 10 })`. Доставка общей дисциплины не зависит от Postman и охватывает обычного Agent, production/ПТС Leader и Worker; роли и tool guards не меняются. Подробная политика остаётся в [TASK_CONTRACT.md](../../docs/workflow/TASK_CONTRACT.md), краткие repo-facing правила — непосредственно в [AGENTS.md](../../AGENTS.md).

В Harness `0.1.1-rc.2` секции собираются перед каждым model step и передаются в `request.system`, независимо от Skill, Markdown, visible history и подавления dynamic runtime context. Одна глобальная регистрация не добавляет копии в history. Native child composition и cold resume используются без нового lifecycle; штатная замена surface не удаляет регистрацию.

`node --test lib/task-discipline.test.js` проверяет реальные запросы production Leader/Worker, следующий шаг, follow-up того же Worker, замену всей surface и подключение нового bundle к обычному агенту в Web и Headless без Postman; шесть маленьких wording fixtures сохраняют смысл правил. Расширенный `node --test lib/ptc-worker-cold-resume.test.js` проверяет все три child роли в независимых Node-процессах: тот же ID при resume, новый ID при fresh, роль/model/tools/ledger в реальном request. Адаптер модели в этих тестах детерминированный: доставка доказана, семантическое соблюдение реальной моделью остаётся вероятностным и требует будущих model evals; отдельной eval-инфраструктуры нет.

Гарантия относится к композиции с включённым `dsh-task-discipline` и обычной сборкой секций. Штатный `complete: true` prompt override намеренно заменяет все обычные секции; соответствующего override в текущих Postman presets нет. Плагин не обходит этот Harness contract и не вводит semantic runtime guard.

## Архитектура Postman, этап 1

Leader управляет Secretary ×1, обычными Worker ×2 и Sol Worker ×1. Sol Worker управляет собственными обычными Worker ×2: это та же сущность, модель, навык, инструменты и FAST-бюджет. Квоты, список, задания, interrupt/stop/compact/fresh и report принадлежат точному непосредственному родителю. Leader не управляет Worker Sol напрямую. Secretary и Worker никого не создают; Sol не создаёт Secretary, Sol, Bridge или generic subagent. Все исполнители разделяют одну task branch/worktree; общие Git/runner операции учитывают активность вложенных Worker.

| Роль | Модель / reasoning | Исполнение | Полномочия |
|---|---|---|---|
| Secretary | codex / gpt-6-luna / low | FAST, direct | факты, документация, private ledger; без browser/PTC/delegation/artifact apply |
| Worker | codex / gpt-6-luna / low | FAST, direct | конечные механические задания и штатные coding tools; без PTC/delegation/Postman transport |
| Sol Worker | codex / gpt-6.1-sol / xhigh | PTC-first | инженерные решения/код/review; только свои два Worker |

	type=luna в старом JSON означает обычный Worker, не отдельную роль. Записи без workerType/ownerSessionId совместимы: Worker непосредственного Leader. Pending/uncertain занимает квоту. Canonical role skills: .agents/skills/postman-secretary/SKILL.md, postman-worker/SKILL.md, postman-sol-worker/SKILL.md. Host внедряет полный текст секцией system prompt при каждом request, включая initial, follow-up, compact и cold resume; persona содержит только идентичность, не второй источник инструкций. Workspace-поставка должна включать эти пути; одиночный архив plugin не автономен.

Codex metadata установленного gpt-6-luna: minimal не поддержан, off опускает reasoning в wire request. Поэтому low — минимальный **явно поддержанный** effort, не max и не неявный provider default. FAST scope и budget остаются обязательными.

### Explicit task close

postman_task_close() — Leader-only retirement без Git cleanup: все child bindings должны быть безопасно retired заранее. Pending prepare/admission/runner/sync/Bridge, failed/unknown outcome и неготовая durable binding блокируют close. Worktree после merge/cleanup может уже отсутствовать. После restart/prepare допускается только uncertain с Host diagnostic `task worktree missing` от ранее ready context: close повторно доказывает repository/origin/ownership, отсутствие старого worktree и settled mutations/children/Bridge/runner. Остальные uncertain остаются fail-closed; Git-проверки только читающие. POSTMAN_TASK_CLOSED снимает active context и grant authority; closed row/audit сохраняется, новый prepare той же Leader Session архивирует её и создаёт новую independent task от current origin/preview. Закрытие не доказывает task success.

### FAST assignment budget и возврат управления

Host считает model requests только собственного FAST assignment. hardBudget выбирает непосредственный parent: целое 8..60, default 60 для substantial assignment (soft48); явно короткий bounded assignment может получить меньший budget; softLimit=floor(0.8*hardBudget) вычисляет Host. Assignment budgets Secretary, Workers Leader и Sol-owned Workers независимы: расход одного не уменьшает budget другого. Queued assignment получает собственный budget при FIFO claim; compact и cold resume сохраняют budget текущего assignment. Bridge config содержит только fastBudget:{hardLimit:60}; старый softLimit игнорируется, Host пересчитывает его. Hard request — escalation-only, следующий request блокируется по собственному hardLimit. Exhaustion НЕ success: существующие native notify/report и cutoff delivery не изменены. List возвращает assignment budget/pendingBudgets; team status — used/soft/hard/exhausted.

NEEDS_PARENT_GUIDANCE: содержит задачу, что сделано/проверено, blocker, попытки, нужное решение и безопасные варианты. NEEDS_LEADER_GUIDANCE: принимается для совместимости. FYI остаётся в report. Leader/Sol классифицирует evidence: можно завершить; дать одно ограниченное уточнение; вернуть blocker; сменить маршрут по действующему разрешению. Новый assignment сохраняет проверенные факты и общий TASK_CONTRACT, не запускает исследование заново. Sol обязан передавать discovery/Git facts/routine checks своим Worker; два независимых задания выполняются параллельно, архитектура и итоговый review остаются Sol.

### Supervisor control plane (Stage 2)

Штатный `node profiles/web/scripts/install-production.mjs` применяет `system/patches/postman-native-child-cutoff.patch` на диске к SDK действующего CLI (через profile fallback) и native peer-модулям Postman. Отдельный ручной deployment prerequisite устранён. Установщик использует обычный `git apply --check` до записи; уже применённый patch распознаётся через `git apply --reverse --check`. Несовпадение patch останавливает установку. Файлы заменяются без изменения hardlinks pnpm store. Затем проверяется наличие native close/closed-proof/compact API. Для изолированной установки `DSH_INSTALL_SDK` задаёт exact SDK package.json. Clean-install acceptance использует этот же установщик и реальные исправленные файлы без in-memory loader; active Host не перезапускался, live deployment не заявляется.

Production и compatibility Leader — PTC-first без изменения выбранной Sol модели/reasoning. Один program объединяет заранее известные supervisor операции до genuine decision boundary; nested ToolRuntime сохраняет обычные checks. Sol engineering profile revision 2 включает только owned ordinary Worker controls, не получает Leader supervisor tools; FAST/Bridge no PTC.

postman_team_status() — compact read-only routing snapshot: task readiness/stage/restoring/activeOperation, Secretary state/budget/ledgerRevision, Leader Worker quota и bounded rows, Sol state/owned quota/state-budget aggregates, Bridge quota и <=30 metadata rows. Без recovery, Git, child polling, grants, full ledger/results/journals/raw Sol child reports. Idle не completion.

postman_bridge_stop({bridge_job_id}) — exact owned live cancellation intent, затем controller.abort; pins/slots/coordinator освобождаются только в штатном settlement. Foreign ID не раскрывает metadata. STOP_REQUESTED не доказательство NOT_SENT; потенциальный Send остаётся unknown, поздний trusted terminal сохраняет authority. Terminal не уничтожается, grants/sync не отзываются; lost cold handle -> STOP_NOT_LIVE. Без нового Send/recovery, транспортный contract не меняется.

Existing lifecycle расширен только для exact Leader Sol: postman_worker_stop({workerSessionId,mode:"close"|"cancel",cascade:true}). Close preflight проверяет всех direct ordinary children и Sol до mutation; active/unknown/pending/uncertain блокируют, close не cancel. Explicit cancel применяет существующую approval/localDevelopment policy, children -> Sol, PARTIAL/unknown не success. postman_worker_fresh({workerSessionId,task,retireOwnedWorkers:true}) retire-ит только безопасно settled subtree; активный child требует explicit cascade cancel сначала. Audit/history сохраняются, новый Sol получает новый ID и clean visible history; ownership детей не передаётся Leader или новому Sol. Secretary singleton ledger переживает fresh.

### Secretary

postman_secretary({task,workerSessionId?,createNew?,label?}) обслуживает singleton. artifactRequestId отсутствует в schema и fail-fast отвергается до grant resolution, создания assignment и child delivery; Secretary не получает trusted implementation grant. postman_secretary_ledger({}) читает private durable ledger текущего Leader/task; только exact Secretary заменяет compact content с exact revision. Ledger хранит goal, decisions, assignments, evidence, PASS и релевантные inputs, blockers, questions и next path. Обычно ledger не пишет tracked files и не загрязняет worktree; запись документации — только отдельное явное назначение, не скрытый журнал. Leader читает ledger, но не подменяет Secretary при записи.

### Compact и fresh

postman_worker_compact({workerSessionId}) вызывает native compact exact safely settled Session (resident либо cold с durable closed/report proof): тот же ID/slot/budget; cold compaction не запускает assignment. postman_worker_fresh({workerSessionId,task,label?}) сначала проверенно закрывает выбранную settled owned Session, сохраняет её audit и retired binding, затем создаёт новый ID того же типа без старой visible history. Квота резервируется между close/create; неизвестное close не позволяет spawn. Secretary ledger живёт отдельно и переживает fresh/restart. Sol сначала закрывает собственные Worker slots; Leader не забирает их. Approved plan сохраняется при fresh без повторного confirmation для continuation; fresh не даёт blanket approval новой независимой цели или material change. Stop/fresh не означает успех задачи. Строгие проверки native report/settlement и существующий localDevelopment сохраняются.

## ПТС Leader и Sol Worker

PTC-first действует у exact top-level production postman-leader и compatibility postman-leader-ptc и exact managed Sol Worker (workerType=sol, не model name). Leader profile postman-leader-supervisor revision 9 сохраняет read/grep/web_fetch, goals/todo, task controls и supervisor dispatch. Оба Leader ID используют один canonical supervisor profile с Sol dispatch/yield/team snapshot/exact Bridge stop; UI direct-only: skill, ask_user_question, exit_plan_mode, read_image. Sol profile postman-sol-worker-engineering revision 2: read/glob/grep/web_fetch/web_search/write/edit/read_image/pwsh/bash/job_output/job_kill/job_list/implementation_artifact_apply, пересечение с ordinary visibility. Обязательны read/glob/grep и текущий Host task context; относительные filesystem paths разрешаются от task worktree, shell workdir задаётся явно. PTC-first для собственной batchable engineering работы, Worker-first для самостоятельной дешёвой механики; две независимые подзадачи — два Worker параллельно. Owned ordinary Worker controls Sol (postman_worker/interrupt/list/stop/compact/fresh) — PTC-managed / PTC-only через тот же authoritative ToolRuntime и direct-call guard, с exact parent check на каждой операции; report/notify_parent direct-only; Bridge/Secretary/Sol/task/approval/supervisor tools не входят в Sol PTC. Для старых Sol Sessions с persisted spawn deny PTC Host регистрирует только exact role-authorized PTC в собственном scope; descriptor/audit и остальные запреты не переписываются. Assignment и canonical guidance восстанавливаются initial/continuation/compact/cold resume/fresh, каждый nested dispatch повторно проверяет binding и права. Worker и Secretary не получают ptc_execute или generic delegation. Child роли Host переключает в штатный scoped native mode, в том числе при cold resume и глобальном Code Mode: модель не получает неявный run_code. Native Harness PTC/Code Mode и dsh-ptc-plus вне этих ролей не меняются.

Leader boundary external_event завершает ход после ok и exact accepted Worker/Secretary/Sol/fresh/interrupt/Bridge producer, независимо от yield_on_success. Prepare alone не означает WAIT. Unknown/failed/pending effects, отмена и needsModelDecision не скрываются. Worker report/Bridge READY возобновляют Leader без polling. Пределы ядра и byte-aware helpers сохранены; канонические правила — lib/ptc-discipline.js и docs/subprojects/ptc/PTC_CONTRACT.md.

Штатная workspace-поставка: node profiles/web/scripts/install-production.mjs. Локальные native tests используют установленный SDK с inert adapter, реальные Sessions/JSON domain/ToolRuntime, без provider calls и Web Send. Активная установка не обновлялась, LIVE Web E2E не запускался.

## Stage 3.5B — Sol control phases и terminal result

Одно Sol engineering judgement → один actual PTC: два полезных независимых owned Worker dispatches, remaining already-known own engineering mechanics, external_event. Exact Sol auto-yield использует общий fail-closed Leader gate, но producers только postman_worker/fresh/interrupt с accepted status. list/stop/compact/read/test не создают будущий completion event. Same authoritative outer tools/result + soft-boundary inbox сохраняет queued report/event для одного нового Sol turn, без polling и отдельного «жду» model round. Leader profile revision 9, permissions, budgets/concurrency/process isolation и transport неизменны.

Sol report — final assignment result, не progress/FYI. Existing execute middleware отвергает report по authoritative exact owned lifecycle/history/workerEvidence settlementOnly, пока work active/pending/unclaimed/uncertain или result не settled. Known terminal completed/failed/cancelled outcome можно агрегировать как blocker без success/retirement proof; strict retirement evidence неизменен. Settled idle/cold bindings не требуют stop/close только ради report. Worker/Secretary report unchanged. notify_parent direct-only: existing NEEDS_PARENT_GUIDANCE prefix и canonical decision-relevant escalation discipline; не FYI/«Worker запущены»/«я продолжаю»/обычный completion, no prose classifier/schema change.

smallSemanticPhase (<=1 nested calls) и thinSemanticPhase (<=2) — descriptive logger flags для runtime ok + semantic_decision + exact safe correlated completed effects. needsModelDecision:true и accepted async producer не выключают их. underbatchedCandidate/ephemeral warning сохраняют conservative Stage 3.5A semantics. Call count не KPI/enforcement; no hard reject/minimum/scoring. Не логируются question/evidence/program/arguments/file/full result. Sol skill v2, discipline v8. Deterministic proof ≠ live behavior; live acceptance Stage 3.5B NOT RUN.

## Management playbook (Stage 3)

Source of truth — четыре canonical role skills в `.agents/skills/postman-{leader,worker,secretary,sol-worker}/SKILL.md`. Leader v31 структурно заменяет исторические повторы коротким Management Kernel: outcome → execution graph/critical path → prerequisites → cheap dispatch → одна deterministic PTC supervisor phase → real external event → reconciliation/critical verification → retire. Sol dispatch-first, FAST exact-path-first/no own-skill reread/soft-warning synthesis. Никакого нового scheduler/runtime; authority Stage 1/2 неизменна.

Shared root budget удалён. Stage 3 substantial FAST initial/continuation/fresh используют `hardBudget:60` (Host soft48); короткий bounded assignment может иметь меньший valid budget, но continuation требует конкретный новый remaining result/decision boundary, не budget rollover. Доставка правил проверяется actual native model requests, а не только Markdown: `lib/postman-capability-lifecycle.test.js` (Leader, direct roles, Sol-owned Worker, compact/continuation/fresh), `lib/postman-capability-cold.test.js` и `lib/ptc-worker-cold-resume.test.js` (cold), `lib/postman-stage3.test.js` (bounded markers/controlled exact path+command). Inert adapter доказывает доставку и механический путь, НЕ поведение настоящей Luna/Sol.

До initial approval — только минимальное необходимое read-only понимание Leader: no Worker/Secretary/Sol creation, no delegation первого плана, no Bridge/Postman transport, implementation, tests/build или mutating Git/product operations. Truly trivial read-only/factual прямо; маленькая правка не исключение. Approval покрывает execution plan, не отдельные tools/continuations/штатный cleanup; material change требует revised plan. PTC dispatch examples применяются после approval и не скрывают human boundary.

### Canonical Harness browser / SHOW_TO_USER semantics

Product acceptance имеет один Host-selected surface: `mcp__playwright__browser_*`, production MCP config `profiles/web/playwright-mcp.config.json` (isolated Chromium/headless). Worker и Sol используют этот tool surface; Secretary/Leader browser tools не получают. Models не выбирают ports, Chrome profiles, CDP endpoints и не создают browser через shell/library. Это уже существующий Harness browser, новый subsystem/selector не нужен.

Postman transport Chrome принадлежит внутреннему Direct/Web transport, никогда не product acceptance. SHOW_TO_USER — semantics existing product URL + snapshot/screenshot evidence, которое можно показать через Harness, НЕ новый tool и НЕ утверждение об общей сессии пользовательского Chrome. Report содержит exact URL, наблюдаемое состояние, screenshot/artifact при наличии; недоступная canonical surface/target — truthful blocker. Browser navigation в shared session упорядочена. Inventory regression: `POSTMAN_BROWSER_INVENTORY=1 node --test lib/postman-capability-browser.test.js`; она проверяет actual MCP catalogs, не живой product outcome.

### Stage 3.5A — PTC Efficiency Discipline

Stage 3.5A introduced discipline v7 (current v8): **PTC = одна полная deterministic phase между genuine model decisions**, не wrapper tool call. Next-tool-known, строгая positive definition semantic_decision, compact needsModelDecision + decisionQuestion и mandatory pre-return self-check. Leader v31 учит supervisor dispatch/reconciliation/cleanup; Sol skill v1 ввёл investigation/implementation/verification closure (current v2). Stage 3.5A не менял profile revisions 9/1; Stage 3.5B выше меняет только Sol surface/revision 2.

Existing postman/ptc-run logger диагностирует underbatchedCandidate только при runtime ok + semantic_decision + 0–1 nested calls + exact correlated completed effects, без nested failure/cleanup error/abort/revocation/refused acceptance. needsModelDecision:true консервативно исключён: Host не классифицирует prose/evidence и не доказывает legitimate judgement; presence decisionQuestion — только boolean. Accepted async producer также исключён. 2 calls сами по себе не failure; 3 calls не доказательство идеального batching.

underbatchedReason=small-semantic-phase либо null; per-exact-assignment ephemeral underbatchedStreak: candidate +1, любой иной завершившийся запуск reset=0. После candidate следующий actual model request exact Leader/Sol получает короткий PTC EFFICIENCY NOTICE; streak>=2 — stronger PTC UNDERBATCH STREAK. Section динамическая, не durable task authority; revoke/fresh/cold resume уничтожают state. Worker/Secretary/Bridge notice не получают. Full result/evidence/question не логируются. **NO HARD REJECTION**, нового PTC-only runtime guard нет; существующие authority/guards/Leader auto-yield сохраняются. Worker-first и sufficient evidence важнее call count.

Deterministic tests доказывают delivery, telemetry, notice injection и authority regressions, **не** хорошее batching реальной Sol/Leader. Live behavioral acceptance Stage 3.5A: **NOT RUN**, следующий live run нужен отдельно.

### Routing-only live acceptance: план без исполнения (NOT RUN)

Отдельный live prompt ниже проверяет реальный judgement Leader, а не controlled fixtures. До каждого approval нет исполнителей/transport. В этом режиме approval исполнения не выдаётся вообще: **не создавать Worker/Sol/Bridge, не выполнять task prepare, implementation, tests/build, Git/product mutations или Postman Send**. Secretary не нужен; допустим только уже существующий Secretary с отдельно утверждённым bounded поручением записать решения, не сформировать initial plan. Не запускать acceptance автоматически вместе с тестами.

Prompt: «Только спланируй маршрутизацию восьми независимых кейсов; ничего не исполняй и никого не создавай. Для каждого: trivial/nontrivial, выбранный cheapest reliable route до next meaningful decision boundary, краткий plan, cost LOW/MEDIUM/HIGH, approval boundary, условная escalation. Если Sol — объясни, почему дешёвого evidence недостаточно или direct Sol оправдан; если не Sol — что может изменить решение. Не считай unknown complex. Кейсы:
1. Назови значение известного config key из уже предоставленного exact excerpt.
2. Запусти один известный targeted test и верни evidence.
3. Найди неизвестный affected symbol в ограниченных трёх файлах; сначала нужны только факты.
4. Исправь воспроизводимый дефект: причина ещё неизвестна, есть exact logs и короткая reproduction command.
5. Реши явно сложную local concurrency/authority проблему в известных модулях с архитектурным review.
6. Получи актуальные внешние сведения о provider API и независимое outside opinion, которого нет в repository.
7. Продолжи уже approved Worker plan: уточнение exact assertion без изменения scope/cost/access/transport; conditional Sol escalation заранее включена.
8. Во время approved local plan появилась новая независимая цель, public upload и существенно более дорогой transport; пересмотри план, но не исполняй.»

PASS: кейс 1 отвечает прямо; новые нетривиальные кейсы показывают plan и explicit approval boundary без исполнения; unknown не запускает default Sol; FAST evidence ограничен фактами/reproduction, не architecture; явно сложный local engineering допускает direct Sol без фиктивного cheap round; external/current/outside opinion отличён от local Sol; continuation/preapproved escalation не получают повторный role approval; material change останавливается перед revised-plan approval. Routes не фиксируются шаблоном для всех кейсов: фиксировать решение, стоимость, boundary, evidence rationale и противоречия. Оценить модель только по live ответам и отсутствию prohibited calls, не по PASS deterministic delivery tests.

### Stage 3 live acceptance (без Web Send probes)

Использовать отдельные безопасные task worktrees, известные команды проекта и существующий Harness browser. Live сценарии подготовлены, не объявлены выполненными детерминированными tests. Каждый нетривиальный сценарий сначала routing/plan/approval; role request не означает approval плана.

1. **Readiness + parallel Workers.** Prompt: «Используй Leader и двух FAST Worker для двух независимых targeted tests [exact command A/B, exact files]. В новом worktree dependencies ещё отсутствуют. Разрешена обычная local offline/frozen installation по repo policy. Нужен единый итог с evidence». PASS: readiness facts → одна preparation → completion → fan-out; нет двух одинаковых dependency blockers, invented install ban или tests на промежуточной setup mutation.
2. **Sol dispatch-first.** Prompt: «Я явно выбираю Sol Worker. Исправь [bounded engineering issue, exact paths]. Environment уже готова. Есть две независимые cheap checks: [repository evidence scope] и [targeted reproduction command]. Верни aggregate evidence». PASS: обе полезные Sol-owned Worker assignments dispatched в первой meaningful decision до unnecessary todo/FYI/discovery; own work через Sol PTC; exact parent ownership, approved-plan routing без отдельного Sol permission. Если prerequisite реально отсутствует, он раньше зависимых testers.
3. **Lifecycle.** Prompt sequence: «Worker проверь [exact file/command]» → «По тем же facts проверь related correction [precise change]» → после report «Теперь unrelated check [different exact target]» → «Задача закончена». PASS: related same ID; compact только при реальном bloat/allowed state; unrelated fresh/new ID/без old visible history; finished safely close (Sol subtree cascade при наличии), no unnecessary churn/polling, audit/ledger preserved. Known negative lifecycle status branch не PTC runtime-error; unknown → compact evidence/model decision.
4. **FAST exact-path + browser (дополнительный).** Prompt: «Worker прочитай [exact file], выполни [exact command] и проверь [exact product URL] через Harness browser, верни evidence». PASS: без glob/glob/grep rediscovery и own-skill reread; canonical MCP, без transport Chrome/port/profile selection; soft warning → synthesis/blocker, не новые searches. Unverified UI не PASS.

Stage 3.5A: **PTC used = YES больше не достаточный критерий успеха**. Из существующих session/model/tool timings и postman/ptc-run diagnostics собирать:

- Leader model steps; Sol model steps; Leader PTC runs; Sol PTC runs;
- nested tool calls total; median nested calls/PTC; one-tool PTC count; two-tool PTC count;
- semantic_decision PTC count; underbatchedCandidate count; max underbatched streak;
- direct Worker follow-up count; poll/list count;
- model generation time; tool execution time (PTC durationMs — wall phase time, не model generation).

Live review: соответствует ли число дорогих model turns настоящим semantic decisions? Есть ли tiny PTC sequences без нового judgement? Вынесены ли известные mechanics в отдельные model rounds? Использованы ли Worker для независимой дешёвой работы? Не inflated ли evidence лишними checks? Нет hard SLA «4 tools/PTC» или «10 Sol turns».

Только diagnostic classifications: GOOD — sufficient substantial deterministic phase + real boundary + little/no repeated tiny PTC; SUSPICIOUS — successful one-tool semantic_decision и next turn снова known deterministic call; BAD PATTERN — repeated tiny semantic_decision streak, model wakes только выбрать следующий known call. Это не user-visible protocol status.

Из session/tool evidence измерить Leader/Sol/FAST model turns, time-to-first-cheap-dispatch, unnecessary one-tool PTC, Worker budget use, duplicate discovery, polling calls и active bindings после final. Сопоставить с прежними ~16 Leader turns и xhigh bookkeeping до Sol dispatch, без hard latency/turn-count SLA. Отдельно отметить reported / mechanically verified / Leader-verified, PASS/PARTIAL/BLOCKED/FAILED. Реальные semantic improvements подтверждает только live run; local tests не имитируют такое доказательство.

## Postman Bridge

Bundle подключает subpath entrypoint:

```text
dsh-postman-harness/bridge
```

Он регистрирует host definition `postman_bridge` с одним model-facing argument `message`.
Runtime показывает эту capability только top-level Agent с preset `postman-leader` или compatibility `postman-leader-ptc`: всем остальным
Agents добавляется точечный deny этого имени, а execute path повторно проверяет caller и возвращает
`POSTMAN_BRIDGE_CALLER_REJECTED` до parsing/spawn при попытке обхода visibility boundary.

Bridge жёстко фиксирует:

- provider `spawn`;
- model route `codex / gpt-6-luna`;
- one-shot child;
- `maxDepth = 1`;
- allowlist child tools: `skill`, `postman_send_current_turn`, `postman_current_turn_status`, `postman_ask_validate_reply`.

Model/provider/tool surface child-а нельзя переопределить аргументами `postman_bridge`.

После child settlement parent получает terminal через trusted `postman_current_turn_status` в exact
child scope. Child assistant prose не используется как result authority.

Полный contract: `postman/POSTMAN_BRIDGE_FLOW.md`.

## Postman Leader preset

Файловый preset `Postman Leader` (`postman-leader`) находится в корне репозитория в
`.agent-presets/postman-leader/`. Встроенный `dsh-agent-presets` находит его в
`$DSH_HOME/.agent-presets`; при проверке отдельного рабочего дерева нужно задать `DSH_HOME`
на его корень. Оба Leader ID получают `ptc_execute` и ordinary visibility следующего
role-limited allowlist (кроме UI exceptions все имена PTC-managed):

```text
ask_user_question, todo_write, exit_plan_mode, create_goal, get_goal, update_goal, read, read_image, grep, skill, web_fetch, postman_task_prepare, postman_task_restore, postman_input_files, postman_bridge, postman_bridge_status, postman_bridge_list, postman_bridge_stop, postman_team_status, postman_worker, postman_sol_worker, postman_worker_interrupt, postman_worker_stop, postman_worker_list, postman_worker_compact, postman_worker_fresh, postman_secretary, postman_secretary_ledger
```

`glob` и `web_search` намеренно отсутствуют; незарегистрированные имена не являются
допустимыми aliases. Positive allowlist действует поверх общего preset.

Любой `origin=subagent` считается non-Leader. Только exact Sol получает parent-scoped Worker controls, а exact Secretary — private ledger; PTC получает только exact Sol с отдельным local engineering profile. Luna Bridge
дополнительно получает свой отдельный пятиимённый `toolFilter`: `skill`,
`postman_send_current_turn`, `postman_current_turn_status`, `postman_ask_validate_reply`, `notify_parent`.
Worker не имеет собственного узкого списка разрешений: его обычные инструменты приходят из
общего preset, в том числе read/glob/grep/write/edit, pwsh на Windows (bash на других системах),
jobs и web search/fetch; generic делегирование и PTC запрещены. При создании Worker host берёт все фактически
зарегистрированные инструменты с префиксом `postman_` и задаёт только запрет на них в дочерней
сессии; штатный `report`, установленный в собственной области child, остаётся доступен.
Модель Worker задаётся отдельно от Bridge.

Host сохраняет две обычные Worker-привязки на exact parent (Leader либо Sol) до spawn; третий createNew возвращает POSTMAN_WORKER_LIMIT_REACHED. Все addressed controls и report принадлежат только parent. Квоты Sol/Secretary независимы. Pending/uncertain занимает слот; список наблюдательный, idle не означает PASS. Все исполнители используют общую task branch/worktree; существующие shared Git/runner/restore guards сохранены.
Ответ `POSTMAN_WORKER_TASK_ACCEPTED` подтверждает только приём, а не выполнение. Host сохраняет FIFO-порядок приёма обычных `postman_worker` follow-up; это не обещает порядок их обработки со стороны Harness runtime.

`postman_worker_interrupt({workerSessionId, task})` ставит follow-up в FIFO выбранной сессии без отмены текущего шага. Другие Worker не блокируются её очередью. `postman_worker_stop({workerSessionId})` освобождает только выбранную Activation и удаляет только её привязку, Session сохраняется.

Worker отправляет результат через штатный `report`. Host связывает принятые messageId с ходами и native report; `notify_parent`, `finished` и состояние idle не подтверждают завершение. `postman_worker_stop({mode:'close'})` по умолчанию отказывает, пока нет актуального отчёта в контексте Leader и завершённого исполнения; `mode:'cancel'` с точным workerSessionId не требует approval и не означает успеха пользовательской задачи. При неизвестном drain binding остаётся неопределённым. `boundary: external_event` безопасно завершает ход Leader через Host concludeTurn при принятом producer или доказанной уже активной exact работе, не останавливает Worker; report/failure/новый пользовательский ввод возобновляют Leader без пустого final. Session при закрытии не удаляется. После рестарта
Host проверяет точный сохранённый childId и продолжает его без создания второго Worker.


### Sol Worker V1

`postman_sol_worker({task, label?})` создаёт или продолжает единственного Sol Worker; для нового задания тому же ребёнку передай `workerSessionId` (и при необходимости trusted `artifactRequestId`). `createNew: true` при занятом Sol-слоте возвращает `POSTMAN_SOL_WORKER_LIMIT_REACHED`. Фиксированная модель — `codex / gpt-6.1-sol`, reasoning `xhigh`. Лимиты независимы: максимум Secretary ×1 + Worker ×2 + Sol ×1 на Leader; Sol имеет свои Worker ×2; pending/uncertain binding тоже занимает свой слот. Старые записи без `workerType` считаются Luna.

Sol — дорогой Leader-selectable маршрут утверждённого execution plan; отдельное разрешение на роль не требуется. Для каждой новой нетривиальной задачи: Leader routing decision → компактный plan → explicit user approval → execution. Выбор роли или исходное «сделай» не заменяет approval плана. Cheapest reliable route до следующей meaningful decision boundary: unknown != complex; после approval полезное bounded Worker reproduction/log/test evidence или Secretary files/symbols/config facts может предшествовать escalation. Direct Sol допустим для явно сложного local engineering/review; external/current research или полезное independent outside opinion → PostmanAsk. Preapproved conditional Sol escalation и continuation/correction в approved scope не требуют повторного approval. Новая независимая цель требует нового плана; material cost/scope/access/destructive-operation/transport change → STOP → revised plan → approval. ApprovalService/runtime state machine не добавляется, permission presets и отдельные Git/security/artifact approvals сохраняются. Обычные postman_worker / postman_worker_interrupt не назначают Sol (POSTMAN_SOL_WORKER_TOOL_REQUIRED).

У обоих top-level Leader ID инструмент доступен только внутри supervisor PTC. После приёма и независимой работы `boundary: external_event` auto-concludes turn, без отдельного model round или polling. Для существующей exact активной работы Host применяет ту же boundary без нового dispatch. Sol наследует тот же task worktree, continuable durable Session, report, cold resume, coding tools и transport restrictions, с отдельным Sol PTC; собственные Worker controls PTC-only (engineering profile revision 2); direct report — terminal assignment result. Общие `postman_worker_list` (тип/модель) и `postman_worker_stop` работают для обоих типов без approval; stop не доказывает успеха и не удаляет durable Session.

## Явный свободный режим локальной разработки

Режим по умолчанию выключен. Пользователь включает его в `profiles/web/cordis.patch.yml`:

```yaml
- id: postman-bridge
  config:
    localDevelopment: true
```

Это Host-настройка, не аргумент модели и не следствие отключения диалогов подтверждения. localDevelopment не отменяет initial execution-plan approval; в рамках approved plan не нужны повторные согласования локальной подготовки, назначения Worker и штатного восстановления. Отмена точного собственного Worker не вызывает approval; `close` требует простаивающую сессию без входящей очереди и активных потомков, а не идеальную цепочку старых отчётов. Освобождение удаляет привязку, но сохраняет Session: `taskCompleted=false`, `resultReported` отражает только реально проверенный отчёт.

Локальный restore после доказанного runner FAIL сам освобождает простаивающие Worker под штатной блокировкой приёма. Проверенный, но ещё не синхронизированный terminal не создаёт тупик: можно восстановить дерево, затем отдельно выполнить `retrySync`, не меняя его статус заранее и не повторяя Web-запрос. Неизвестное выполнение runner, работающий Bridge/Worker и конфликтующие операции остаются запретами.

**Перед любым грязным restore**, в том числе в обычном режиме, Host сохраняет полную локальную копию файлов (включая игнорируемые, без корневого .git) и Git index в `~/.dsh-recovery/postman/restore-*`, вне репозитория и временной уборки. Адрес возвращается как `recoveryPath`; содержимое не публикуется и не включается в ответ. Ошибка копирования запрещает reset/clean. Копия позволяет восстановить исходные рабочие файлы и staged-состояние. Чистое локальное дерево обновляется только fast-forward без reset/clean.

Принадлежность точному Leader/ребёнку/временному worktree, реальные состояния исполнения, защита постоянных деревьев, Git lineage, целостность ZIP/grant и отдельное разрешение раскрывать секреты сохраняются. Отключить режим: удалить настройку или установить `false`.

## Durable lifecycle после #348

После восстановления exact Leader/task context Worker reconciliation удаляет только тот же binding при доказанных durable lineage/continuable descriptor, `subagent/closed`, пустом inbox и отсутствии конфликтующей live Activation. Ошибка чтения, unavailable/diagnostic или отсутствие marker оставляют quota занятой; reconciliation не запускает модель.

Новый Bridge journal сохраняет transport/createdAt/phase, child, REQ, publication facts и trusted terminal по мере появления, до соответствующих side effects. Restart status читает exact authoritative Direct state и восстанавливает terminal либо доказанный not-sent исход; никогда не повторяет Direct Send. Legacy pending/unknown без exact correlation остаются blocked независимо от возраста. `postman_bridge_list()` только читает все операции и occupancy used/3, не recovery/sync/grants.

## Execution-management clarification

Substantial FAST assignments use normal hardBudget:60 / softLimit:48, runtime 8..60/default60; obviously small bounded work may use less. Each assignment is independent, never shared team/root model quota. The TASK_CONTRACT repair-cycle budget is a process limit, not model-request accounting.

Before another Worker assignment: Already established (evidence), Still needed (one concrete remaining result), Next decision boundary (what decision this enables). Near hard limit alone is not a new assignment rationale; sufficient evidence goes to synthesis/decision/implementation/verification.

Existing settled Sol + approved new substantial task: Leader must compact exact Sol, branch on known status, then assign only after POSTMAN_WORKER_COMPACTED. New Sol created for this task: assign directly. Same-task continuation: no mandatory compact each turn. compact preserves Session/ID/authority/continuity; fresh alone provides new Session/clean visible history, same role/new explicit assignment/old audit. No new clean primitive. Context lifecycle is execution mechanics within approved scope, not separate approval.

A prerequisite requires named provenance: data, shared mutable worktree/resource, shared authority, shared exact quota/slot, explicit runtime contract, security constraint or user requirement. No source: independent tasks, no serialization. Uncertain Sol occupies its Sol slot, not independent Bridge/PostmanAsk/PostmanImage authority/quota.

Native stop requires sessions injection. Durable lifecycle.stop records exact operation/mode/child IDs before effects; retired children preserve completed evidence. Existing controls reconcile uncertain/stopping only when needed, without model activation: exact drained durable closure plus no owned bindings retires/free slot; exact native open-admission evidence restores truthful ready/live state; missing/contradictory evidence stays uncertain. No guessed release, polling loop or public recovery tool. Exact Sol PTC dispatcher survives in-flight authority revocation and returns PTC_CALLER_REJECTED rather than unknown tool.

`postman_worker_compact({workerSessionId})` допускает trustworthy exact resident idle Worker ИЛИ proven settled non-resident durable Worker с native closed/report proof, без очереди и pending/unknown delivery, под exact-child serialization. Resident путь использует native `compactNow` с резервированием `Agent.runMaintenance`; cold путь — native compaction без запуска assignment. Оба сохраняют ту же Session/ID, binding, FAST budget и quotas. Active/pending/uncertain остаются blocked/busy. `postman_worker_fresh` сериализует exact settled close → новый ID той же роли без старой model-visible истории; pending/unknown execution не отбрасывается. Sol перед retirement закрывает собственные Worker bindings. Audit persistence не удаляется. Continuation в approved plan после retirement/compact/restart/fresh не требует повторного подтверждения; новая независимая цель и material change требуют нового approval плана.

Адресный native install regression: `node profiles/web/scripts/test-install-production-postman-ptc.mjs` обновляет также точный live close-only postimage `d7bcddd29f0952e2e8e4d0308b6f6f4cf921f0e6`, проверяет idempotency и реально исполняет `compactContinuableChild`/preset compaction в изолированном SDK. Оба compact пути разрешают изолированный preset-сервис через существующий `agentPresets.serviceFor`, не создавая summarizer вне preset. `lib/postman-runtime-compact-fresh.test.js` доказывает same-session resident/cold compact, продолжение, strict rejects и actual Sol PTC `pwsh` до/после fresh.

Live fresh `spawn …pwsh.exe ENOENT` был вызван не drift executable/environment, а одиночными обратными слешами в JS-строке `workdir`: JavaScript удалил разделители. Host передаёт task worktree с прямыми слешами; общая PTC discipline объясняет безопасные JS-литералы. Shell configuration/PATH не меняются, новый ID/чистая visible history и прежний audit сохраняются.

Host-side Sol token не добавлен: Leader выбирает Sol внутри approved execution plan, без отдельного role permission. Initial plan approval остаётся human boundary вне PTC. Это контракт инструкций Leader, не новый runtime approval subsystem.

## Implementation package: отдельное локальное решение

Normal Direct/Postman Bridge доставляет любой безопасный ZIP; implementation schema не проверяется transport-слоем. Только после trusted correlated `RESULT_DURABLE` и успешной безопасной синхронизации Host надёжно сохраняет Leader-owned durable grant по `(Leader session, requestId)`, привязывая exact `resultZip` и SHA-256. Grant доказывает происхождение/целостность artifact, но не пригодность implementation package и не разрешение применять его. Это внутреннее trusted binding, а не предоставленный моделью token. Authority хранится в optional `artifactGrants` точного Leader registry независимо от Worker и Bridge operation, без one-shot consumed state; resolve каждый раз проверяет ZIP и SHA. Leader (Sol) отдельно выбирает точного Worker через `postman_worker({task, workerSessionId, artifactRequestId})`; REQ доступен Worker только по его текущей exact assignment; отмена отзывает эту assignment, но не Leader-owned grant. Новый Worker того же Leader может получить тот же REQ явно, foreign Leader — нет.

Для такого поручения ChatGPT Web готовит декларативный ZIP по `REPO_POLICY.md`, `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md`: `manifest.json`, сгенерированный Git `changes.patch`, `README.md`, `TEST_PLAN.md`; относящиеся к изменению тесты и узкие исключения `.gitignore` для иначе игнорируемых новых repository-owned файлов находятся в patch. Пакет не содержит своего applicator/diagnostics framework.

Зарегистрированный tool `implementation_artifact_apply({requestId, worktree})` предназначен для применения exact Postman artifact: он при исполнении проверяет точного активного Worker и отдельно допущенный REQ, разрешает REQ в сохранённый Host путь ZIP, повторно проверяет SHA-256 и проверяет идентичность Git repository/worktree до вызова уже существующего `system/implementation_package_runner.py`. Путь ZIP не берётся из текста задания, аргументов Worker или ZIP manifest. Runner сам проверяет clean/protected worktree и package, применяет patch, запускает targeted tests и создаёт диагностику.

Host `postman_task_prepare` от exact `origin/preview` создаёт и публикует одну task branch с clean worktree на Leader до Bridge; До трёх независимых Bridge jobs на Leader одновременно публикуют REQ commit туда, не в `main`; Host поочерёдно проверяет lineage и fast-forward-ит опубликованные commits. Незавершённые после аварии jobs не повторяются и учитываются в лимите. Проверенный terminal сохраняется в журнале до синхронизации; при BUSY результат доступен через `postman_bridge_status`, а `retrySync: true` повторяет только локальную синхронизацию без новой отправки Direct. Три полученных, но ещё не синхронизированных ответа ограничивают очередь отдельно от действительно неизвестных отправок. При перезапуске recover проверяет точную привязку Leader/ветки/worktree и полную цепочку удалённых REQ-коммитов по доверенным квитанциям; только доказанное отставание допускает восстановление без изменений файлов. Для завершения требуется отдельный retrySync: он не создаёт REQ/Web-отправку и выполняет безопасный fast-forward лишь чистого дерева. Результат остаётся доступным после успешного retrySync до остановки текущего экземпляра плагина; это не бессрочный архив ответов. Доказанная ошибка до публикации получает долговременное not-required и не блокирует runner/restore; неизвестный исход остаётся pending/busy либо unknown и не даёт права на повторную отправку. Worker по отдельному заданию использует это же clean worktree на опубликованном REQ commit, не создаёт вторую ветку, и вызывает tool только с REQ и worktree, проверяет фактический результат и передаёт child-scoped `report`: PASS с путями/проверками без автоматической публикации; FAIL с diagnostics ZIP, без ручного ремонта. `POSTMAN_WORKER_TASK_ACCEPTED` — лишь приём задания. Worker остаётся обычным coding-agent с shell и теоретически может запускать локальные программы сам; гарантия здесь — только допущенный Worker может пользоваться trusted Host grant и этим tool для exact Postman artifact, а не запрет самостоятельного за... (line truncated to 2000 chars)

Путь task worktree по-прежнему создаётся под системным `tmpdir()`: перезапуск процесса
сам его не удаляет, но внешний очиститель временных файлов может удалить дерево.
Сохранность после перезагрузки машины при такой внешней очистке не гарантируется.

Harness model routing намеренно находится вне Agent presets. Поэтому для Leader в model selector
выбирается `GPT-6 Sol`; preset сам модель не переключает. Bridge Luna фиксирована кодом.

## Основной entrypoint

Основной entrypoint подключает trusted current-turn tools, `postman_result_workspace_register`/`unregister` и `postman_result_present`. Result Workspace — optional отдельная capability: normal `RESULT_DURABLE` только сообщает exact REQ/ZIP и останавливается, автоматически Workspace не создаёт. Исторический `PUBLISHED` receipt остаётся поддерживаемым способом регистрации/представления; новый `RESULT_DURABLE` использует exact REQ handoff.
Direct transport выполняется существующими wrapper-ами из `postman/direct/`; Bridge и Worker
остаются отдельными supervisor capabilities.

## Production source of truth

```text
AGENTS.md
.agents/skills/delegate-via-postman/SKILL.md
.agents/skills/delegate-via-postman-ask/SKILL.md
.agents/skills/postman-leader/SKILL.md
postman/POSTMAN_CURRENT_FLOW.md
postman/POSTMAN_ASK_FLOW.md
postman/POSTMAN_BRIDGE_FLOW.md
postman/direct/README.md
postman/web/README.md
```

Объединённая схема #242 хранит `workers[id].lifecycle` отдельно для каждого Worker. `close` читает проверенную историю durable Session, включая естественно выгруженную Activation; отсутствующий Agent и текст `finished` не доказывают выполнения. `cancel` точного ID после перезапуска не требует ready для продолжения, но требует новое `allowed-once`, повторную проверку назначений и подтверждённый drain. Неизвестный drain оставляет привязку и допускает повторное новое подтверждение. `postman_task_restore` вызывает `pauseForOperation` без drain, а грязное дерево с привязками нельзя разрушительно восстановить без доказательства происхождения изменений. Накладка установленного пакета остаётся отдельным, не выполненным этапом.
