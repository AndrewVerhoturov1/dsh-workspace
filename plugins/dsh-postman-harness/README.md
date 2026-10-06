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

Host считает model requests каждого assignment и durable task-team root objective. FAST hardBudget выбирает только непосредственный parent: целое 8..24, default 16. Host вычисляет softLimit=floor(0.8*hardBudget). Если root remaining меньше requested hardBudget (включая default), assignment не принимается: POSTMAN_WORKER_OBJECTIVE_BUDGET_INSUFFICIENT с remaining/requested; silent уменьшения нет. Durable root objective имеет общий cumulative cap 48 model requests; follow-up, queued assignment, fresh, compact и cold resume не обнуляют расход. Для той же незавершённой цели сохраняй rootObjectiveId из list; действительно независимую цель объявляй newObjective с содержательным описанием. Не объявляй прежнюю нерешённую цель новой ради бюджета. Root может быть общим для Secretary и Workers Leader/Sol в одной task; одинаковое описание использует существующий root. Bridge config содержит только fastBudget:{hardLimit:16}; старый softLimit игнорируется, Host пересчитывает его. Hard request — escalation-only, следующий request блокируется; root cap может остановить раньше assignment hard. Exhaustion НЕ success: существующие native notify/report и cutoff delivery не изменены. List возвращает assignment budget/root/pendingBudgets и objectives; team status — compact rootUsed/rootCap. Legacy history без доказуемого cumulative расхода fail-closed использует исчерпанный root вместо сброса.

NEEDS_PARENT_GUIDANCE: содержит задачу, что сделано/проверено, blocker, попытки, нужное решение и безопасные варианты. NEEDS_LEADER_GUIDANCE: принимается для совместимости. FYI остаётся в report. Leader/Sol классифицирует evidence: можно завершить; дать одно ограниченное уточнение; вернуть blocker; сменить маршрут по действующему разрешению. Новый assignment сохраняет проверенные факты и общий TASK_CONTRACT, не запускает исследование заново. Sol обязан передавать discovery/Git facts/routine checks своим Worker; два независимых задания выполняются параллельно, архитектура и итоговый review остаются Sol.

### Supervisor control plane (Stage 2)

Штатный `node profiles/web/scripts/install-production.mjs` применяет `system/patches/postman-native-child-cutoff.patch` на диске к SDK действующего CLI (через profile fallback) и native peer-модулям Postman. Отдельный ручной deployment prerequisite устранён. Установщик использует обычный `git apply --check` до записи; уже применённый patch распознаётся через `git apply --reverse --check`. Несовпадение patch останавливает установку. Файлы заменяются без изменения hardlinks pnpm store. Затем проверяется наличие native close/closed-proof/compact API. Для изолированной установки `DSH_INSTALL_SDK` задаёт exact SDK package.json. Clean-install acceptance использует этот же установщик и реальные исправленные файлы без in-memory loader; active Host не перезапускался, live deployment не заявляется.

Production и compatibility Leader — PTC-first без изменения выбранной Sol модели/reasoning. Один program объединяет заранее известные supervisor операции до genuine decision boundary; nested ToolRuntime сохраняет обычные checks. Sol engineering profile revision 1 не получает supervisor tools; FAST/Bridge no PTC.

postman_team_status() — compact read-only routing snapshot: task readiness/stage/restoring/activeOperation, Secretary state/budget/ledgerRevision, Leader Worker quota и bounded rows, Sol state/owned quota/state-budget aggregates, Bridge quota и <=30 metadata rows. Без recovery, Git, child polling, grants, full ledger/results/journals/raw Sol child reports. Idle не completion.

postman_bridge_stop({bridge_job_id}) — exact owned live cancellation intent, затем controller.abort; pins/slots/coordinator освобождаются только в штатном settlement. Foreign ID не раскрывает metadata. STOP_REQUESTED не доказательство NOT_SENT; потенциальный Send остаётся unknown, поздний trusted terminal сохраняет authority. Terminal не уничтожается, grants/sync не отзываются; lost cold handle -> STOP_NOT_LIVE. Без нового Send/recovery, транспортный contract не меняется.

Existing lifecycle расширен только для exact Leader Sol: postman_worker_stop({workerSessionId,mode:"close"|"cancel",cascade:true}). Close preflight проверяет всех direct ordinary children и Sol до mutation; active/unknown/pending/uncertain блокируют, close не cancel. Explicit cancel применяет существующую approval/localDevelopment policy, children -> Sol, PARTIAL/unknown не success. postman_worker_fresh({workerSessionId,task,retireOwnedWorkers:true}) retire-ит только безопасно settled subtree; активный child требует explicit cascade cancel сначала. Audit/history сохраняются, новый Sol получает новый ID и clean visible history; ownership детей не передаётся Leader или новому Sol. Secretary singleton ledger переживает fresh.

### Secretary

postman_secretary({task,workerSessionId?,createNew?,label?}) обслуживает singleton. artifactRequestId отсутствует в schema и fail-fast отвергается до grant resolution, создания assignment и child delivery; Secretary не получает trusted implementation grant. postman_secretary_ledger({}) читает private durable ledger текущего Leader/task; только exact Secretary заменяет compact content с exact revision. Ledger хранит goal, decisions, assignments, evidence, PASS и релевантные inputs, blockers, questions и next path. Обычно ledger не пишет tracked files и не загрязняет worktree; запись документации — только отдельное явное назначение, не скрытый журнал. Leader читает ledger, но не подменяет Secretary при записи.

### Compact и fresh

postman_worker_compact({workerSessionId}) вызывает native compact exact resident idle Session: тот же ID/slot/budget. postman_worker_fresh({workerSessionId,task,label?}) сначала проверенно закрывает выбранную settled owned Session, сохраняет её audit и retired binding, затем создаёт новый ID того же типа без старой visible history. Квота резервируется между close/create; неизвестное close не позволяет spawn. Secretary ledger живёт отдельно и переживает fresh/restart. Sol сначала закрывает собственные Worker slots; Leader не забирает их. Уже выбранный пользователем Sol route не требует повторного подтверждения fresh; fresh не разрешает автоматический выбор Sol. Stop/fresh не означает успех задачи. Строгие проверки native report/settlement и существующий localDevelopment сохраняются.

## ПТС Leader и Sol Worker

PTC-first действует у exact top-level production postman-leader и compatibility postman-leader-ptc и exact managed Sol Worker (workerType=sol, не model name). Leader profile postman-leader-supervisor revision 9 сохраняет read/grep/web_fetch, goals/todo, task controls и supervisor dispatch. Оба Leader ID используют один canonical supervisor profile с Sol dispatch/yield/team snapshot/exact Bridge stop; UI direct-only: skill, ask_user_question, exit_plan_mode, read_image. Sol profile postman-sol-worker-engineering revision 1: read/glob/grep/web_fetch/web_search/write/edit/read_image/pwsh/bash/job_output/job_kill/job_list/implementation_artifact_apply, пересечение с ordinary visibility. Обязательны read/glob/grep и текущий Host task context; относительные filesystem paths разрешаются от task worktree, shell workdir задаётся явно. PTC-first для собственной batchable engineering работы, Worker-first для самостоятельной дешёвой механики; две независимые подзадачи — два Worker параллельно. Worker controls Sol — direct-only, с exact parent check на каждой операции; Bridge/Secretary/Sol/task/approval/supervisor tools не входят в Sol PTC. Для старых Sol Sessions с persisted spawn deny PTC Host регистрирует только exact role-authorized PTC в собственном scope; descriptor/audit и остальные запреты не переписываются. Assignment и canonical guidance восстанавливаются initial/continuation/compact/cold resume/fresh, каждый nested dispatch повторно проверяет binding и права. Worker и Secretary не получают ptc_execute или generic delegation. Child роли Host переключает в штатный scoped native mode, в том числе при cold resume и глобальном Code Mode: модель не получает неявный run_code. Native Harness PTC/Code Mode и dsh-ptc-plus вне этих ролей не меняются.

Leader boundary external_event завершает ход после ok и exact accepted Worker/Secretary/Sol/fresh/interrupt/Bridge producer, независимо от yield_on_success. Prepare alone не означает WAIT. Unknown/failed/pending effects, отмена и needsModelDecision не скрываются. Worker report/Bridge READY возобновляют Leader без polling. Пределы ядра и byte-aware helpers сохранены; канонические правила — lib/ptc-discipline.js и docs/subprojects/ptc/PTC_CONTRACT.md.

Штатная workspace-поставка: node profiles/web/scripts/install-production.mjs. Локальные native tests используют установленный SDK с inert adapter, реальные Sessions/JSON domain/ToolRuntime, без provider calls и Web Send. Активная установка не обновлялась, LIVE Web E2E не запускался.

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
ask_user_question, todo_write, exit_plan_mode, create_goal, get_goal, update_goal, read, read_image, grep, skill, web_fetch, postman_task_prepare, postman_task_restore, postman_input_files, postman_bridge, postman_bridge_status, postman_bridge_list, postman_bridge_stop, postman_team_status, postman_worker, postman_sol_worker, postman_worker_interrupt, postman_worker_stop, postman_yield, postman_worker_list, postman_worker_compact, postman_worker_fresh, postman_secretary, postman_secretary_ledger
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

Worker отправляет результат через штатный `report`. Host связывает принятые messageId с ходами и native report; `notify_parent`, `finished` и состояние idle не подтверждают завершение. `postman_worker_stop({mode:'close'})` по умолчанию отказывает, пока нет актуального отчёта в контексте Leader и завершённого исполнения; `mode:'cancel'` с точным workerSessionId не требует approval и не означает успеха пользовательской задачи. При неизвестном drain binding остаётся неопределённым. `postman_yield()` завершает только активный ход Leader через Host concludeTurn, не останавливает Worker; report/failure/новый пользовательский ввод возобновляют Leader без пустого final. Session при закрытии не удаляется. После рестарта
Host проверяет точный сохранённый childId и продолжает его без создания второго Worker.


### Sol Worker V1

`postman_sol_worker({task, label?})` создаёт или продолжает единственного Sol Worker; для нового задания тому же ребёнку передай `workerSessionId` (и при необходимости trusted `artifactRequestId`). `createNew: true` при занятом Sol-слоте возвращает `POSTMAN_SOL_WORKER_LIMIT_REACHED`. Фиксированная модель — `codex / gpt-6.1-sol`, reasoning `xhigh`. Лимиты независимы: максимум Secretary ×1 + Worker ×2 + Sol ×1 на Leader; Sol имеет свои Worker ×2; pending/uncertain binding тоже занимает свой слот. Старые записи без `workerType` считаются Luna.

Sol предназначен для сложной работы, но V1 разрешает его **только по прямой просьбе пользователя использовать Sol Worker**. Нет автоматической escalation Luna → Sol, выбора по сложности/размеру или после неудачи Luna. Прямая просьба пользователя использовать Sol Worker уже является достаточным разрешением для немедленного вызова `postman_sol_worker`. Не задавай отдельный `ask_user_question` перед созданием или продолжением Sol Worker. Follow-up и новые задания по `workerSessionId` не требуют дополнительного подтверждения в рамках уже выбранного пользователем Sol-маршрута, включая `localDevelopment`. Новый approval-механизм не добавляется: инструмент по-прежнему не обращается к `ApprovalService` и не хранит подтверждения. Permission presets, `approval: ask/never` и глобальная permission-система Harness не меняются. Обычные `postman_worker` и `postman_worker_interrupt` не передают новые задания Sol (`POSTMAN_SOL_WORKER_TOOL_REQUIRED`).

У обоих top-level Leader ID инструмент доступен только внутри supervisor PTC. После приёма и независимой работы `boundary: external_event` auto-concludes turn, без отдельного model round или polling; explicit `postman_yield({})` допускается в конце программы только после безопасного outer settlement. Sol наследует тот же task worktree, continuable durable Session, report, cold resume, coding tools и transport restrictions, с отдельным Sol PTC; собственные Worker controls остаются direct-only. Общие `postman_worker_list` (тип/модель) и `postman_worker_stop` работают для обоих типов без approval; stop не доказывает успеха и не удаляет durable Session.

## Явный свободный режим локальной разработки

Режим по умолчанию выключен. Пользователь включает его в `profiles/web/cordis.patch.yml`:

```yaml
- id: postman-bridge
  config:
    localDevelopment: true
```

Это Host-настройка, не аргумент модели и не следствие отключения диалогов подтверждения. В рамках уже порученной задачи не нужны повторные согласования локальной подготовки, назначения Worker и восстановления. Отмена точного собственного Worker не вызывает approval; `close` требует простаивающую сессию без входящей очереди и активных потомков, а не идеальную цепочку старых отчётов. Освобождение удаляет привязку, но сохраняет Session: `taskCompleted=false`, `resultReported` отражает только реально проверенный отчёт.

Локальный restore после доказанного runner FAIL сам освобождает простаивающие Worker под штатной блокировкой приёма. Проверенный, но ещё не синхронизированный terminal не создаёт тупик: можно восстановить дерево, затем отдельно выполнить `retrySync`, не меняя его статус заранее и не повторяя Web-запрос. Неизвестное выполнение runner, работающий Bridge/Worker и конфликтующие операции остаются запретами.

**Перед любым грязным restore**, в том числе в обычном режиме, Host сохраняет полную локальную копию файлов (включая игнорируемые, без корневого .git) и Git index в `~/.dsh-recovery/postman/restore-*`, вне репозитория и временной уборки. Адрес возвращается как `recoveryPath`; содержимое не публикуется и не включается в ответ. Ошибка копирования запрещает reset/clean. Копия позволяет восстановить исходные рабочие файлы и staged-состояние. Чистое локальное дерево обновляется только fast-forward без reset/clean.

Принадлежность точному Leader/ребёнку/временному worktree, реальные состояния исполнения, защита постоянных деревьев, Git lineage, целостность ZIP/grant и отдельное разрешение раскрывать секреты сохраняются. Отключить режим: удалить настройку или установить `false`.

## Durable lifecycle после #348

После восстановления exact Leader/task context Worker reconciliation удаляет только тот же binding при доказанных durable lineage/continuable descriptor, `subagent/closed`, пустом inbox и отсутствии конфликтующей live Activation. Ошибка чтения, unavailable/diagnostic или отсутствие marker оставляют quota занятой; reconciliation не запускает модель.

Новый Bridge journal сохраняет transport/createdAt/phase, child, REQ, publication facts и trusted terminal по мере появления, до соответствующих side effects. Restart status читает exact authoritative Direct state и восстанавливает terminal либо доказанный not-sent исход; никогда не повторяет Direct Send. Legacy pending/unknown без exact correlation остаются blocked независимо от возраста. `postman_bridge_list()` только читает все операции и occupancy used/3, не recovery/sync/grants.

`postman_worker_compact({workerSessionId})` использует штатный native `compactNow` только для trustworthy exact resident idle Worker без очереди и pending/unknown delivery под exact-child serialization. Штатный `compactNow` сам резервирует `Agent.runMaintenance`; ID, binding, FAST budget и quotas сохраняются. `postman_worker_fresh` сериализует exact settled close → новый ID той же роли без старой model-visible истории; pending/unknown execution не отбрасывается. Sol перед retirement закрывает собственные Worker bindings. Audit persistence не удаляется. В уже явно выбранном пользователем Sol-маршруте новое задание и fresh context после retirement/compact/restart не требуют повторного подтверждения; автоматического выбора Sol эти операции не разрешают.

Host-side Sol token не добавлен: достаточное разрешение — явный выбор Sol Worker пользователем; отдельный `ask_user_question` для назначения Sol не нужен. Это контракт инструкций Leader, не новый runtime approval subsystem.

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
