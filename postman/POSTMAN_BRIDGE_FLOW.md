# Postman Bridge — supervisor/worker flow

После trusted terminal `postman_bridge_status({bridge_job_id})` возвращает `recoveryEligible` из существующего read-only Direct resolver. Leader может запросить `postman_bridge_status({bridge_job_id, recover:true})`: Host запускает прежний `DirectPostmanJobManager.continueLast` без child и без model-authored prompt/state. Новый Bridge job ждёт Direct обычным status/READY путём. Direct заново проверяет exact conversation/result/Send capability и фиксирует существующий durable recovery claim до публикации/Send. Повторная automatic recovery (включая restart) отклоняется до Send. `retrySync:true` по-прежнему исправляет только локальную синхронизацию публикации, не отправляет сообщение.

> Model-facing capability: `postman_bridge(message=...)`
> Bridge child: fresh one-shot `spawn`, fixed `codex / gpt-6-luna`
> Transports: `@Postman` artifact, `@PostmanAsk` text, `@PostmanImage` one image

Для входных файлов Leader сначала получает Host-issued descriptor через `postman_input_files` (PTC Leader — вложенным вызовом `ptc_execute`), после последнего REQ очищает свой staged bundle; затем передаёт descriptor как metadata complete delegation; Luna не получает binary tools и вызывает прежний zero-argument send. Native attachment — primary input transport: private local/current bytes → ZIP для Postman/Ask, одна visual image → native image для PostmanImage. Child не публикует inputs, не строит attachments и не использует raw_url fallback. GitHub — existing immutable source или separately approved public fallback only. См. [Postman Input Files](POSTMAN_INPUT_FILES.md).

## 1. Назначение

Postman Bridge позволяет умной основной модели работать как supervisor: она думает,
проверяет и решает, что спросить дальше, а transport operation выполняет отдельная минимальная
Luna child session.

Bridge не создаёт собственного transport. Это Leader-specific supervisor и trusted result handoff; общий transport lifecycle описан в [Current Flow](POSTMAN_CURRENT_FLOW.md), text delta — в [Ask Flow](POSTMAN_ASK_FLOW.md). После child current-turn boundary используются существующие
`postman/direct/postman.ps1` и `postman/direct/postman-ask.ps1` с exact task branch, переданной trusted Host.

## PostmanDevspace Stage 2 — persistent Luna

Новый `@PostmanDevspace` отделён от legacy one-shot Bridge. Host привязывает одну
`startContinuable` Luna к точному Leader task context и затем использует
`subagents.followup` в рамках той же Luna; запуск Direct принадлежит Host,
а не произвольному coordinator-сообщению. Второй REQ использует сохранённый
`conversationRef` текущего ChatGPT-чата. `postman_devspace_control` обслуживает
steer/preempt/stop/status для exact Bridge job; фактические Stop/Send статусы
не заменяются фактом QUEUED. `postman_devspace_luna_close` закрывает пустую
связистку до закрытия task context. Bell остаётся приоритетным, произвольный
текст не блокирует доставку; поздний bell может обновить тот же REQ.
Подробнее: [PostmanDevspace Flow](POSTMAN_DEVSPACE_FLOW.md).

## Supervisor control Stage 2

Оба top-level preset ID (production postman-leader и compatibility postman-leader-ptc) используют канонический supervisor PTC. Sol dispatch и yield выполняются внутри того же program; exact accepted asynchronous work с boundary: external_event auto-concludes после safe outer settlement. PTC не меняет Sol user authorization, Direct/Web timing, Send proof, UNKNOWN/recovery budget, correlation, terminal/grants или sync.

postman_team_status — bounded read-only routing snapshot; не completion polling, не full ledger/journal/result и не recovery. postman_bridge_stop({bridge_job_id}) адресует только exact owning Leader live job, durable cancellation intent -> abort exact controller -> штатный cleanup. Slot и input pin удерживаются до actual settlement. Запрос stop не означает, что Web ничего не сделал или REQ не существует; потенциальный Send остаётся unknown по existing evidence, valid trusted terminal остаётся authority. Terminal/grant/sync не уничтожаются. Lost cold handle -> STOP_NOT_LIVE, без fake cancellation, Direct resend/recovery или нового Web message. Foreign ID -> JOB_NOT_FOUND без metadata.

Sol subtree close/cancel/fresh — Host lifecycle, не ownership transfer; operational contract и preflight: [Host README](../plugins/dsh-postman-harness/README.md#supervisor-control-plane-stage-2).

## 2. Поток

```text
Postman Leader
→ postman_bridge(message="@PostmanAsk ..." | "@Postman ..." | "@PostmanImage ...")
← POSTMAN_BRIDGE_ACCEPTED + bridgeJobId (Leader сразу свободен)
→ Host job manager / existing Launch Coordinator
→ заново получить exact live Leader по parentSessionId; если недоступен — failed job без child
→ Host postman_task_prepare: exact origin/main → одна опубликованная task branch + clean worktree на Leader (старые pinned REQ/ветки не переназначать)
→ fresh spawn child
→ fixed gpt-6-luna
→ exact child user/message
→ child loads canonical delegate-via-postman / delegate-via-postman-ask / delegate-via-postman-image skill
→ postman_send_current_turn() with no text args
→ existing Direct Postman
→ Bridge публикует REQ в task branch через Host (не в main)
→ ChatGPT Web получает опубликованный REQ commit
→ terminal result
→ postman_current_turn_status()
→ bridge host reads the same trusted terminal directly
→ await run.dispose(); coordinator releases active slot
→ Host сохраняет проверенный terminal в долговременном журнале Leader
→ Host пробует безопасную синхронизацию общей ветки; при BUSY сохраняет terminal и не выдаёт grant
→ после успешной синхронизации Host регистрирует проверенный artifact grant при необходимости
→ Host followup POSTMAN_BRIDGE_READY (только событие)
→ parent Leader calls postman_bridge_status({bridge_job_id})
← trusted terminal result
```

Child assistant prose не является authority результата.

## 3. Exact-message boundary

`postman_bridge.message` является новым model-authored delegation от Leader-а, а не transport
копией текущего human user message. Он обязан начинаться с exact `@Postman`, `@PostmanAsk` или `@PostmanImage` и
проходит существующий `parsePostmanUserTurn` до spawn.

После spawn Harness создаёт child `user/message` с exact `message`. С этого момента действует
обычный trusted current-turn invariant: Luna не перепечатывает intent в tool arguments, а вызывает
`postman_send_current_turn()` без аргументов.

## 4. Bridge child contract

Bridge child всегда:

- provider `spawn`;
- route `codex / gpt-6-luna`;
- `maxDepth = 1`;
- one-shot;
- без inherited conversation history;
- с allowlist tools:
  - `skill`;
  - `postman_send_current_turn`;
  - `postman_current_turn_status`;
  - `postman_ask_validate_reply`.

Bridge ждёт Direct terminal самостоятельно, без промежуточных FYI родителю. Host доставляет terminal `POSTMAN_BRIDGE_READY` через штатный followup; child prose не authority.

`postman_continue_last_request`, generic subagents, shell, filesystem mutation, GitHub, web и
browser tools child-у не выдаются.

Reasoning effort отдельно не хардкодится: route использует поддерживаемый default Luna. Главная
экономия достигается фиксированной Luna, узкой persona и минимальным tool surface.

## 5. Skill selection

Child сначала загружает канонический skill по exact trigger:

```text
@Postman    → delegate-via-postman
@PostmanAsk   → delegate-via-postman-ask
@PostmanImage → image transport напрямую (отдельного навыка нет)
```

Bridge не дублирует transport lifecycle из этих skills. Для image MVP внутренние REQ_A и REQ_B обрабатывает Direct в одном вызове; финальный `IMAGE_RESULT_DURABLE` содержит путь к извлечённому изображению и не создаёт implementation grant.

## 6. Trusted result handoff

После settlement child run Bridge host читает `postman_current_turn_status` в scope exact child
session, ждёт полного `run.dispose()` и сохраняет trusted terminal в долговременном журнале Leader до синхронизации (и в памяти на время жизни процесса).
`postman_bridge` возвращает только admission, не completion: Leader сразу может читать, анализировать
и вызывать Worker. После Host `leader.followup(POSTMAN_BRIDGE_READY)` Leader вызывает
`postman_bridge_status({bridge_job_id})`. READY не содержит assistantText/ZIP и не является authority.
Status доступен только точной исходной top-level Leader session; другой Leader/Bridge/Worker
не может прочитать job. При недоставленном READY terminal остаётся доступным по сохранённому ID.
Перед запуском каждого Bridge Host записывает намерение под точным bridgeJobId в общем
долговременном реестре Leader. До трёх незавершённых заданий одного Leader допустимы
одновременно; четвёртое отклоняется с POSTMAN_BRIDGE_LIMIT_REACHED. Очередь публикации
одного task worktree — FIFO, с проверкой точного родительского коммита, принадлежности
удалённой ветке и переходом только fast-forward. Во время применения публикации runner и
явный restore блокируются, но другой Bridge может выполняться.

После аварийного перезапуска только задание без сохранённого проверенного terminal имеет статус
POSTMAN_BRIDGE_OUTCOME_UNKNOWN / INTERRUPTED и не запускается повторно. Проверенный terminal остаётся доступен по тому же bridgeJobId: `postman_bridge_status({bridge_job_id, retrySync: true})` повторяет только локальную синхронизацию, не отправку Web/REQ. Неизвестный исход
учитывается в лимите трёх: при трёх неизвестных заданиях новые допуски закрыты до
отдельного расследования. Автоматического подтверждения или очистки такого состояния нет;
это намеренное ограничение безопасности, а не сигнал повторить запрос. Для проверенного ответа временная занятость не превращается в unknown. После перезапуска recover допускает отстающий локальный HEAD лишь если каждый удалённый REQ-коммит от HEAD до точного remote HEAD покрыт доверенной квитанцией и проверен Git (родитель, ветка, worktree, база). Recover не изменяет рабочие файлы; отдельный retrySync требует чистого дерева и безопасно синхронизирует локально, не создавая новый REQ или Web-запрос. Восстановленный результат после успешного retrySync остаётся читаемым до остановки этого экземпляра плагина, но не архивируется бессрочно. Состояния received/pending или busy означают незавершённую синхронизацию; received/not-required — доказанный отказ до публикации без синхронизации, который не блокирует общие операции; неизвестный исход не превращается в not-required только из-за отсутствия publicationReceipt. До трёх полученных, но ещё не полностью обработанных ответов занимают отдельный ограниченный backlog; grant не выдаётся до безопасной синхронизации. Если проверка ZIP/grant не прошла после неё, diagnostic сохраняется, а `retrySync: true` повторно проверяет локальный grant без новой отправки Direct. Только неизвестный исход отправки остаётся unknown. Сигнал живого задания — собственный AbortController, а не exec.signal
завершившегося вызова. Остановка plugin отменяет очередь, посылает abort работающим
заданиям и ждёт очистки.

Это специально не зависит от того, как Luna сформулировала final assistant message.

Для text mode authority — весь trusted `TEXT_RESULT_DURABLE` terminal, а способ потребления
зависит от `deliveryMode`:

```text
deliveryMode=inline
→ terminal содержит assistantText
→ child вызывает postman_ask_validate_reply
→ EXACT_REPLY_MATCH разрешает exact child final reply
→ parent Leader получает тот же trusted terminal через postman_bridge_status

deliveryMode=file
→ terminal не содержит assistantText
→ terminal содержит проверенный resultFile descriptor
→ child НЕ вызывает `postman_ask_validate_reply`
→ child НЕ читает/не реконструирует resultFile
→ bridge host сохраняет descriptor для parent Leader; status tool возвращает его напрямую
```

Parent Leader для `inline` может анализировать/суммировать `assistantText`. Для `file` он
использует `resultFile` как authority и, только если содержание действительно нужно для
supervisor-решения, читает exact файл собственными `read`/`grep` выборочно. Не требуется и не
желательно целиком rehydrate-ить большой Markdown в один model turn.

Direct user-facing exact-reply/file-handoff contract относится к direct Luna response; supervisor
Leader получает trusted terminal data и сам решает, какую часть результата нужно анализировать.

## 7. Continuation

Bridge child не живёт между запросами. Continuity принадлежит доказанному ChatGPT conversation:

```text
call 1 → @PostmanAsk ...             → REQ_A
call 2 → @PostmanAsk --chat REQ_A... → REQ_B, same conversation
call 3 → @Postman --chat REQ_B ...   → REQ_C, same conversation, artifact mode
```

Каждый вызов создаёт новую Luna child session. Automatic artifact continuation tool child-у не
выдаётся: решение о следующем шаге принадлежит Leader.

`postman_bridge` помечен штатным `isConcurrencySafe` Harness 0.1.1-rc.2: Leader
может в одном ходе принять несколько независимых заданий и продолжить работу без ожидания Web. Один Host-side
координатор на жизненный цикл plugin допускает максимум три active Bridge: место
занято от фактического запуска child до terminal и завершения cleanup. Первый
запуск после полного простоя немедленный, следующие идут FIFO с независимой
случайной задержкой 5–15 секунд от предыдущего фактического запуска. Leader не
делает sleep и не разносит вызовы сам; уже запущенные Bridge продолжают работу
параллельно. У каждого вызова свои childSessionId, новый REQ, terminal и
освобождение child. Три Worker работают в той же общей task branch/worktree; это не дополнительные Bridge слоты.
Одинаковый `--chat` (в том числе разные старые REQ одного conversation URL)
отклоняется межпроцессной блокировкой до публикации и отправки; разные разговоры
не блокируют друг друга. Только короткие GitHub publication/CDP mutation участки последовательны. Web-наблюдение и downloads разных чатов параллельны; stable browser-wide GUID directory не подменяет exact page/request/download proof.
При занятом разговоре нет автоматического повтора отправки.

## 8. Postman Leader preset

Preset `postman-leader` / `Postman Leader` хранится в репозитории как файловая композиция
`.agent-presets/postman-leader/agent.cordis.yml` с описанием в `preset.yml`. Встроенный
`dsh-agent-presets` обнаруживает такие каталоги под `$DSH_HOME/.agent-presets`; поэтому при
проверке отдельного рабочего дерева `DSH_HOME` должен указывать на его корень. Web profile
не загружает отдельный preset-плагин: существующий `postman-bridge` подключается на уровне
host-композиции в bundle `dsh-postman-harness`.

Оба top-level Leader preset ID получают `ptc_execute` и role-limited ordinary visibility
(все operational tools PTC-managed; UI exceptions direct-only):

```text
ask_user_question
todo_write
exit_plan_mode
create_goal
get_goal
update_goal
read
read_image
grep
skill
web_fetch
postman_task_prepare
postman_task_restore
postman_input_files
postman_bridge
postman_bridge_status
postman_bridge_list
postman_bridge_stop
postman_team_status
postman_worker
postman_sol_worker
postman_worker_interrupt
postman_worker_stop
postman_worker_list
postman_worker_compact
postman_worker_fresh
postman_secretary
postman_secretary_ledger
```

`glob` и `web_search` не входят в список Leader: они запрещены только Leader и остаются доступны Worker из общего coding preset. Positive allowlist задан поверх общего
preset: фактический каталог Leader сокращается до этих имён независимо от остальных регистраций.

`write`, `edit`, shell, generic `subagent`, workflow, `web_search` и direct Postman tools скрыты runtime-ом у Leader. Зарегистрированный `implementation_artifact_apply` не входит в Leader allowlist: его execute path допускает только точного активного Worker после отдельной авторизации REQ. Worker остаётся с широким общим coding preset без положительного Worker allowlist; его runtime deny включает все зарегистрированные `postman_*` имена и не затрагивает `report`. Bridge сохраняет отдельный transport-only allowlist из четырёх инструментов: `skill`, `postman_send_current_turn`, `postman_current_turn_status`, `postman_ask_validate_reply`.
Host controls task/Bridge/Sol/Secretary принадлежат только верхнеуровневому Leader. Exact Sol получает только parent-scoped postman_worker/interrupt/stop/list/compact/fresh; exact Secretary — private postman_secretary_ledger. Обычный Worker не получает Postman controls, generic delegation или PTC; Secretary/Sol также не обходят topology через subagent/fork/workflow/ralph. Каждый tool body повторно проверяет exact Agent и ownership, не доверяя имени preset или saved ID.

Один live Agent всегда имеет ровно один Bridge restriction. Поскольку Harness разрешает сменить
preset у пустой сессии до первого turn, plugin слушает `agent-preset/selected`, заново определяет
live composition через `ctx.agents.get(sessionId)` и заменяет предыдущий restriction, снимая его
exact disposer. Это важно: restrictions пересекаются, поэтому простой второй allow поверх старого
deny не сделал бы Bridge видимым после `standard → postman-leader`.

Spawn child имеет `origin=subagent`, получает этот non-Leader deny и дополнительно собственный
Bridge `toolFilter`, поэтому не может рекурсивно вызвать `postman_bridge`.

Harness model routing намеренно находится вне Agent presets. Поэтому `postman-leader` задаёт роль
и tool boundary, но не переключает модель автоматически: для Leader в model selector выбирается
`GPT-6 Sol`. Luna Bridge фиксирована кодом независимо от модели parent.


### Sol Worker V1

`postman_sol_worker({task, label?})` создаёт или продолжает единственного Sol Worker; для нового задания тому же ребёнку передай `workerSessionId` (и при необходимости trusted `artifactRequestId`). `createNew: true` при занятом Sol-слоте возвращает `POSTMAN_SOL_WORKER_LIMIT_REACHED`. Фиксированная модель — `codex / gpt-6.1-sol`, reasoning `xhigh`. Лимиты независимы: Secretary ×1 + Worker ×2 + Sol ×1 на Leader; у Sol — собственные Worker ×2; pending/uncertain binding тоже занимает свой слот. Старые записи без `workerType` считаются Luna.

Sol — дорогой Leader-selectable маршрут утверждённого execution plan; отдельное разрешение на роль не требуется. Для каждой новой нетривиальной задачи: Leader routing decision → компактный plan → explicit user approval → execution. Выбор роли или исходное «сделай» не заменяет approval плана. Cheapest reliable route до следующей meaningful decision boundary: unknown != complex; после approval полезное bounded Worker reproduction/log/test evidence или Secretary files/symbols/config facts может предшествовать escalation. Direct Sol допустим для явно сложного local engineering/review; external/current research или полезное independent outside opinion → PostmanAsk. Preapproved conditional Sol escalation и continuation/correction в approved scope не требуют повторного approval. Новая независимая цель требует нового плана; material cost/scope/access/destructive-operation/transport change → STOP → revised plan → approval. ApprovalService/runtime state machine не добавляется, permission presets и отдельные Git/security/artifact approvals сохраняются. Обычные postman_worker / postman_worker_interrupt не назначают Sol (POSTMAN_SOL_WORKER_TOOL_REQUIRED).

У обоих top-level Leader ID инструмент только внутри supervisor PTC; после приёма и всей независимой работы boundary: external_event и безопасный auto-yield. Для уже активной exact работы Host применяет ту же boundary без нового dispatch и без polling. Sol наследует тот же task worktree, continuable durable Session, report, cold resume, coding tools и transport restrictions, с отдельным local engineering PTC profile без supervisor authority; controls собственных Worker PTC-managed / PTC-only с exact parent check через existing authoritative Host path (Sol engineering revision 2). Sol decision dispatch-ит оба полезных independent Worker в одной PTC phase, завершает known own mechanics и boundary: external_event auto-yield ждёт actual owned reports. report/notify_parent direct-only: report terminal; PARTIAL/BLOCKED с незавершёнными children доставляется без fake settlement, failed/cancelled отражаются как blockers, не success. notify_parent только decision-relevant NEEDS_PARENT_GUIDANCE, не FYI/progress. Общие `postman_worker_list` (тип/модель) и `postman_worker_stop` работают для обоих типов без approval; stop не доказывает успеха и не удаляет durable Session.

### Продолжение PR и граница этапа

Milestone и освобождение idle Worker/Sol/Luna не закрывают task binding. Последующие поручения по тому же PR используют прежние branch/worktree/base. Обычный cold recovery восстанавливает незакрытую привязку того же Leader без нового задания.

Для явного продолжения закрытого открытого PR: `postman_task_prepare({resume_pr:<номер>,project_path?:<canonical Git root>})`. `resume_pr` несовместим с `read_only`; без него прежний prepare создаёт новую задачу. Сначала освободи read-only children и lanes. Host сам читает PR и находит только созданную им сохранённую задачу; номер/путь в prompt не являются правом на произвольный checkout. Проверяются repository/origin, branch/worktree, pinned base, local/actual remote HEAD, открытый PR с прежней base, отсутствие другого текущего владельца и прежних writers. Новый top-level Leader в той же установке может принять только закрытую сохранённую задачу; чужой активный binding не передаётся.

Продолжение сохраняет staged/unstaged/untracked файлы и прежний PR. Оно не делает push, reset, checkout, rebase, merge или новый worktree. Удалённое отставание и неопределённые writers блокируют продолжение; старые UNKNOWN/FAILED не становятся PASS. Выдаётся новый bindingId, старые Worker/Bridge/grants остаются только в прежнем audit и не получают новую authority. Повторный вызов для уже активной задачи сохраняет её binding и агентов. Исторические записи без PR identity проверяются по сохранённой Host branch и реальному PR; массовой миграции нет.

`POSTMAN_TASK_RESUME_REJECTED` возвращает точный diagnostic и сохраняет текущий read-only контекст. Не обходи отказ через внешний workspace scope и не создавай fix-v2. Для прежнего DevSpace writer используй существующий `reconcileWriter`; неопределённое завершение детей требует штатного settlement.

### Explicit task-context retirement

Leader вызывает `postman_task_close()` после settled retirement либо явно `postman_task_close({abandon:true})` для отказа от незавершённого задания. Abandon адресно отзывает прежнюю authority и пытается отменить своих детей/bridge; сохраняет UNKNOWN/FAILED, REQ, результаты и файлы, не доказывая завершение shell. Новый prepare создаёт отдельное worktree. Реальный конфликтующий runner/sync остаётся BUSY. Ни Git cleanup/merge, ни stable preview не выполняются.

### Команда этапа 1: Secretary и обычный Worker

Worker под Leader и под Sol — одна сущность codex/gpt-6-luna/low с одним каноническим postman-worker skill и прямыми coding tools. Secretary — singleton того же FAST model/effort, отдельный postman-secretary skill, факты/документация/private ledger, без browser/PTC/delegation/artifact apply. Sol — postman-sol-worker skill и обязательная передача discovery/Git facts/routine checks своим Worker; два независимых задания передаются параллельно, инженерное решение остаётся Sol. Host внедряет полный canonical role skill при каждом model request; short persona не дублирует инструкции.

FAST hardBudget выбирает непосредственный parent: целое 8..100 включительно, default60 для substantial work, softLimit=floor(0.8*hardBudget): default60 →48, explicit100 →80. Каждому assignment независимый budget; FIFO claim, compact/cold resume и квоты исполнителей сохранены.

postman_secretary_ledger({}) — private durable ledger exact Leader/task; только Secretary заменяет content с exact revision. Goal, decisions, assignments, evidence/PASS inputs, blockers, questions и next path сохраняются без tracked file writes. Документация пишется только отдельным явным заданием. Ledger переживает fresh/restart; Leader имеет read-only доступ.

Sol и Leader имеют независимые parent quotas/reports. Leader не присваивает Sol-owned children, но явный exact cancel/fresh/close Sol выполняет адресный Host cascade собственных потомков. Worker/Secretary никого не создают. stop/close не означают успех задачи; новый assignment не обходит role/grant owner.

## 9. Передача implementation package локальному Worker

`RESULT_DURABLE` из exact child scope подтверждает происхождение и целостность ZIP, а не корректность implementation patch. Normal transport универсален и не требует `manifest.json`; Bridge child не применяет пакет. После correlated terminal Host сохраняет durable Leader-owned grant по точной сессии Leader и REQ с exact trusted ZIP и SHA-256. Grant — внутреннее доверенное соответствие, не model-provided token и не автоматическое разрешение на применение.

Для implementation package ChatGPT Web следует `REPO_POLICY.md`, `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md`: декларативный ZIP содержит `manifest.json`, Git-generated `changes.patch`, `README.md`, `TEST_PLAN.md`; targeted tests, новые файлы и необходимые узкие исключения `.gitignore` входят в patch. Собственного applicator и диагностики в ZIP нет.

```text
Bridge terminal RESULT_DURABLE
→ Host регистрирует grant для exact Leader session + REQ (trusted ZIP + SHA-256)
→ Sol отдельно авторизует REQ точному Worker: postman_worker({task, workerSessionId, artifactRequestId: "REQ_..."})
→ тот же continuable Worker получает trusted REQ, не model-authored ZIP path
→ Worker использует тот же Host-prepared clean worktree на опубликованном REQ commit; второй branch/worktree не создаёт
→ Worker вызывает implementation_artifact_apply({requestId: "REQ_...", worktree: "<clean worktree>"})
→ Host проверяет точного Worker, разрешает REQ в trusted ZIP и повторно сверяет SHA-256
→ Host запускает существующий system/implementation_package_runner.py
→ Worker проверяет фактический результат и отправляет report → Sol
```

`POSTMAN_WORKER_TASK_ACCEPTED` означает приём, не итог. Report содержит PASS/PARTIAL/BLOCKED/FAILED и существенные факты. Trusted runner/grant/SHA не заменяются prose. После runner FAIL dirty `postman_task_restore()` сохраняет старое дерево и создаёт новое чистое без reset/clean; возвращает POSTMAN_TASK_RESTORE_ISOLATED, не fake TASK_CONTEXT_RESTORED. Старые pinned REQ и grants не переназначаются. Для нового назначения собственному Worker нужен явный assignment и Leader-owned artifact grant. Публикация и merge регулируются REPO_POLICY.md.

Worker — обычный coding-agent с shell и теоретически может сам запускать локальные программы. Гарантия этой границы уже: только отдельно авторизованный Worker может использовать trusted Host grant и `implementation_artifact_apply` для exact Postman artifact; запрета на все самостоятельные локальные запуски здесь нет.

Для явно включённого пользователем Host `localDevelopment: true` обычное освобождение простаивающей сессии не требует идеальной исторической цепочки report; адресная отмена собственного Worker не требует повторного approval. Освобождение не подтверждает успеха задачи. Restore под штатной блокировкой освобождает только простаивающие Worker, сохраняет грязные файлы/index и допускается при сохранённом pending terminal без подмены его статуса: затем используется отдельный retrySync. Активное/неизвестное исполнение, постоянные worktree, чужие данные и раскрытие секретов не получают разрешения. Настройка и восстановление копии описаны в [Host README](../plugins/dsh-postman-harness/README.md#явный-свободный-режим-локальной-разработки).

### Durable recovery и observation

Новые operations durably сохраняют известные Host transport/phase/child/REQ/publication/terminal/sync/grant facts до side effects. При restart exact requestId читается только из journal либо exact trusted terminal; authoritative Direct state восстанавливает trusted terminal и необходимые локальные действия. Доказанный `PROVEN_NOT_SENT` или `publicationStarted:false` освобождает slot только при отсутствии противоречивой publication authority; published/may-be-sent без terminal остаётся blocked. Reserved/child-only/legacy rows не replay-ятся и не удаляются по возрасту/отсутствию Agent.

`postman_bridge_list()` — read-only все операции exact Leader с limit=3, used, `countsAgainstLimit` и причиной, lifecycle/correlation/publication/sync/grant. Неизвестные legacy поля — `unknown`. Чтение не запускает child, Direct, recovery, retrySync и не регистрирует grants.

DevSpace использует одну сохраняемую recovery-chain: исходный временный сбой → до трёх автоматических попыток. Временный/неоднозначный инструментальный `BLOCKED` также допускает наблюдение и восстановление; `NEED_DECISION`, явный permission/scope/security blocker и постоянная недоступность требуют решения. `DONE` не является инженерным PASS. Если собственный URL известен, Host наблюдает тот же чат; если сбой случился до URL/REQ/Luna, создаёт новую собственную попытку без выдуманной истории. Неизвестная старая запись удерживает прежний root, а новая попытка получает отдельную область и read-доступ к прежней. Поломанная logical reservation отзывается, не занимая все три линии навсегда. Каждая фактическая отправка имеет собственный REQ и durable intent; late bell не завершает соседний REQ.

После исчерпания `postman_bridge_status({bridge_job_id:<root>,recover:true})` сам проходит проверенную цепочку к последней попытке. Вызов по leaf поддержан; concurrent/cold повтор возвращает уже выделенного successor без нового Send. Успех, archive/revoke, чужой владелец, цикл или несовместимые ссылки не разрешают новую попытку. Автоматических попыток остаётся три; дальнейшие требуют явного `recover:true` Leader.

Timer 15/30/45 и explicit preempt/stop сохраняют право Stop при ACTIVE_TOOL/UNKNOWN. Положительно наблюдённый более новый user turn в том же чате лишает старый REQ права Stop и Send; эта проверка выполняется непосредственно перед UI действием. Скрытая старая история не является конфликтом сама по себе. Bell имеет приоритет; готовность composer можно ждать дольше 10 секунд. UI Stop не подтверждает завершение native Bash.

`postman_bridge_status({bridge_job_id,reconcileWriter:true})` адресно сверяет archived writer exact Leader; не совмещается с `recover`/`retrySync`. Host получает proof сам, без model-authored receipt. Положительный proof требует exact owner/REQ/root/branch/runtime generation, отзыва будущих инструментальных вызовов и фактического завершения отслеживаемых native writers; другой живой writer той же области сохраняет конфликт. `POSTMAN_WRITER_RELEASED` / `POSTMAN_WRITER_ALREADY_RELEASED` сохраняют settlement и снимают residual в current/retired registry без изменения файлов. Старый неотслеживаемый writer, потерянный runtime или неполное доказательство дают `POSTMAN_WRITER_EXIT_UNPROVEN` и `START_IN_NEW_ISOLATED_WORKSPACE`; read и независимые write не блокируются. Registry absence, модельный текст, UI Stop, свободный TCP-порт и browser-process exit не являются proof. Список инструментов и caller/PTC границы не расширяются.

`postman_worker_list()` отдельно показывает binding/delivery, quotas Secretary used/1, Worker used/2 и Sol used/1 (Sol видит только своих Worker used/2), runtime residency, durable closed/unavailable/diagnostic и turn/report evidence; состояние turn не успех задачи. Compact exact resident idle Worker — `postman_worker_compact({workerSessionId})`, та же Session/ID/quota. Чистый context — `postman_worker_fresh({workerSessionId,task})`: проверенное закрытие exact owned Session, резерв квоты и новый ID того же типа без visible history; audit и private Secretary ledger остаются. Continuation в approved plan не требует повторного user confirmation; fresh context не даёт blanket approval новой независимой цели или material change.

Artifact grant записывается в exact Leader-owned durable `artifactGrants[requestId]` **до** Bridge operation cleanup. Он переживает restart без Bridge row; resolve повторно проверяет ZIP/SHA, не является one-shot и не даёт foreign Leader authority. Cancel отзывает только Worker artifactRequests; новый exact Worker получает прежний REQ лишь через explicit обычную assignment.

## 10. Failure boundary

Bridge никогда не делает blind resend.

- caller не top-level `postman-leader` → `POSTMAN_BRIDGE_CALLER_REJECTED` до parsing/spawn;
- malformed message → `POSTMAN_BRIDGE_MESSAGE_REJECTED` до spawn;
- spawn/capability failure → `POSTMAN_BRIDGE_START_FAILED`;
- child не стартовал Direct → `POSTMAN_BRIDGE_NO_TRANSPORT`;
- Direct terminal failure возвращается parent-у как trusted `result`;
- legacy cancellation после начала не разрешает автоматический второй Send; DevSpace восстанавливается отдельными REQ после наблюдения своего чата и без слепого повтора side effects.

## 11. Ordinary subagents

Обычные `subagent`/`subagent_fork` capabilities Harness не изменяются. Для не-Leader Agents
`postmanBridgeRestrictionForAgent` запрещает ordinary Agents все зарегистрированные Postman Host controls и PTC. Только точные роли Postman имеют описанные выше исключения; ordinary Agents сохраняют остальные capabilities.
`glob` не запрещён Worker: он остаётся доступен ему из общего coding preset, но скрыт у Leader.
`postman_bridge` остаётся отдельным специализированным tool с фиксированной Luna.

**Lifecycle Worker:** ordinary Worker×2, Secretary×1, Sol×1 и два Sol-owned Worker сохраняются. Exact owner может cancel/retire без идеальной narrative/report цепочки; нужны реальные session/process facts. close не означает PASS. Неизвестный ещё живой процесс нельзя объявить остановленным; новая независимая область изолируется. Session/audit сохраняются; Sol PARTIAL/BLOCKED report доставляется с честно незавершёнными children.
## Execution-management clarification

Substantial FAST assignments use normal hardBudget:60 / softLimit:48, runtime8..100/default60, explicit100→soft80. Each assignment remains independent; compact/cold resume preserves accounting, Worker and PTC quotas do not change.

Before another Worker assignment: Already established (evidence), Still needed (one concrete remaining result), Next decision boundary (what decision this enables). Near hard limit alone is not a new assignment rationale; sufficient evidence goes to synthesis/decision/implementation/verification.

Existing settled Sol + approved new substantial task: Leader must compact exact Sol, branch on known status, then assign only after POSTMAN_WORKER_COMPACTED. New Sol created for this task: assign directly. Same-task continuation: no mandatory compact each turn. compact preserves Session/ID/authority/continuity; fresh alone provides new Session/clean visible history, same role/new explicit assignment/old audit. No new clean primitive. Context lifecycle is execution mechanics within approved scope, not separate approval.

A prerequisite requires named provenance: data, shared mutable worktree/resource, shared authority, shared exact quota/slot, explicit runtime contract, security constraint or user requirement. No source: independent tasks, no serialization. Uncertain Sol occupies its Sol slot, not independent Bridge/PostmanAsk/PostmanImage authority/quota.

Native stop requires sessions injection. Durable lifecycle.stop records exact operation/mode/child IDs before effects; retired children preserve completed evidence. Existing controls reconcile uncertain/stopping only when needed, without model activation: exact drained durable closure plus no owned bindings retires/free slot; exact native open-admission evidence restores truthful ready/live state; missing/contradictory evidence stays uncertain. No guessed release, polling loop or public recovery tool. Exact Sol PTC dispatcher survives in-flight authority revocation and returns PTC_CALLER_REJECTED rather than unknown tool.

