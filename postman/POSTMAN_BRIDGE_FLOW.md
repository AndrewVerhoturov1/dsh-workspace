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
→ Host postman_task_prepare: exact origin/preview → одна опубликованная task branch + clean worktree на Leader
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
  - `postman_ask_validate_reply`;
  - `notify_parent` (только промежуточное сообщение, не trusted result).

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
postman_yield
postman_worker_list
postman_worker_compact
postman_worker_fresh
postman_secretary
postman_secretary_ledger
```

`glob` и `web_search` не входят в список Leader: они запрещены только Leader и остаются доступны Worker из общего coding preset. Positive allowlist задан поверх общего
preset: фактический каталог Leader сокращается до этих имён независимо от остальных регистраций.

`write`, `edit`, shell, generic `subagent`, workflow, `web_search` и direct Postman tools скрыты runtime-ом у Leader. Зарегистрированный `implementation_artifact_apply` не входит в Leader allowlist: его execute path допускает только точного активного Worker после отдельной авторизации REQ. Worker остаётся с широким общим coding preset без положительного Worker allowlist; его runtime deny включает все зарегистрированные `postman_*` имена и не затрагивает `report`. Bridge сохраняет отдельный неизменный allowlist из пяти инструментов: `skill`, `postman_send_current_turn`, `postman_current_turn_status`, `postman_ask_validate_reply`, `notify_parent`.
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

У обоих top-level Leader ID инструмент только внутри supervisor PTC; после приёма и всей независимой работы boundary: external_event и безопасный auto-yield. Explicit postman_yield внутри программы gated полным outer settlement, не polling. Sol наследует тот же task worktree, continuable durable Session, report, cold resume, coding tools и transport restrictions, с отдельным local engineering PTC profile без supervisor authority; controls собственных Worker PTC-managed / PTC-only с exact parent check через existing authoritative Host path (Sol engineering revision 2). Sol decision dispatch-ит оба полезных independent Worker в одной PTC phase, завершает known own mechanics и boundary: external_event auto-yield ждёт actual owned reports. report/notify_parent direct-only: report terminal, owned active/pending/uncertain work блокирует его, settled/cold bindings не блокируют; failed/cancelled можно агрегировать как blockers, не success. notify_parent только decision-relevant NEEDS_PARENT_GUIDANCE, не FYI/progress. Общие `postman_worker_list` (тип/модель) и `postman_worker_stop` работают для обоих типов без approval; stop не доказывает успеха и не удаляет durable Session.

### Explicit task-context retirement

Leader вызывает postman_task_close() после безопасного retirement всех child bindings; active/queued/uncertain work отклоняет close. POSTMAN_TASK_CLOSED retires durable active binding/grant authority без Git cleanup и без success claim. Старый worktree после merge/cleanup может отсутствовать. Audit остаётся; postman_task_prepare() той же Leader Session создаёт новую независимую задачу от current origin/preview.

### Команда этапа 1: Secretary и обычный Worker

Worker под Leader и под Sol — одна сущность codex/gpt-6-luna/low с одним каноническим postman-worker skill и прямыми coding tools. Secretary — singleton того же FAST model/effort, отдельный postman-secretary skill, факты/документация/private ledger, без browser/PTC/delegation/artifact apply. Sol — postman-sol-worker skill и обязательная передача discovery/Git facts/routine checks своим Worker; два независимых задания передаются параллельно, инженерное решение остаётся Sol. Host внедряет полный canonical role skill при каждом model request; short persona не дублирует инструкции.

FAST hardBudget выбирает только непосредственный parent: целое 8..24, default 16. Host вычисляет softLimit=floor(0.8*hardBudget). Каждый assignment Secretary, Worker Leader и Sol-owned Worker имеет независимый budget; расход одного не влияет на остальные. Queued assignment получает собственный budget при FIFO claim; compact и cold resume сохраняют budget текущего assignment. Hard request escalation-only, исчерпание собственного hardLimit блокирует следующий request. Native notify/report/cutoff и transport unchanged.

postman_secretary_ledger({}) — private durable ledger exact Leader/task; только Secretary заменяет content с exact revision. Goal, decisions, assignments, evidence/PASS inputs, blockers, questions и next path сохраняются без tracked file writes. Документация пишется только отдельным явным заданием. Ledger переживает fresh/restart; Leader имеет read-only доступ.

Sol и Leader имеют независимые parent quotas и reports. Leader не может list/control Sol Worker descendants напрямую; Worker/Secretary никого не создают. Shared worktree guards учитывают вложенных Worker. Sol сначала завершает/закрывает собственные Worker slots перед fresh/close; stop не означает успех задачи. Approved-plan Sol route сохраняется при fresh для continuation без повторного approval; новая независимая цель или material change требуют revised plan и approval.

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

`POSTMAN_WORKER_TASK_ACCEPTED` означает только приём задания, не итог: Sol дожидается `report`. На PASS Worker сообщает результат runner и затронутые пути без автоматического commit/push/PR; на FAIL — diagnostics ZIP и STOP без локального ремонта patch. Если runner оставил грязное временное worktree и нужна новая попытка, Leader сначала получает report и отдельно вызывает `postman_task_restore()` только при доказанном разрешении удалить затрагиваемые изменения. Worker-привязки ради операции не закрываются: Host проверяет точный временный worktree/ветку, состояние Bridge/runner и удалённый SHA, после чего явно сбрасывает только это дерево к remote HEAD. Перед очисткой Host сохраняет рабочие файлы и index в приватной локальной recovery-копии вне репозитория; при утерянной Host-привязке восстановление запрещено. После успеха прежние Worker продолжаются по своим `workerSessionId`; при любой сохранённой Worker-привязке и грязном дереве restore отклоняется без очистки: принадлежность байтов runner не доказана. Обычный сценарий «runner изменил файлы → FAIL → убрать только его изменения и продолжить того же Worker» пока не реализован, а остановка всех Worker не доказывает право на очистку. Требуется отдельная проверка происхождения и возможного вмешательства других исполнителей. После FAIL Sol решает, исследовать ли проблему, запросить новый ZIP или остановиться. До отдельного commit/push/PR реализации REQ transport-файлы удаляются из task branch; SHA-pinned URL старых REQ и `--chat` сохраняются. `packageBase` не обязан совпадать с HEAD опубликованного REQ commit: применимость проверяет runner. Публикация после PASS поручается отдельно по repository policy; merge требует отдельной явной команды пользователя.

Worker — обычный coding-agent с shell и теоретически может сам запускать локальные программы. Гарантия этой границы уже: только отдельно авторизованный Worker может использовать trusted Host grant и `implementation_artifact_apply` для exact Postman artifact; запрета на все самостоятельные локальные запуски здесь нет.

Для явно включённого пользователем Host `localDevelopment: true` обычное освобождение простаивающей сессии не требует идеальной исторической цепочки report; адресная отмена собственного Worker не требует повторного approval. Освобождение не подтверждает успеха задачи. Restore под штатной блокировкой освобождает только простаивающие Worker, сохраняет грязные файлы/index и допускается при сохранённом pending terminal без подмены его статуса: затем используется отдельный retrySync. Активное/неизвестное исполнение, постоянные worktree, чужие данные и раскрытие секретов не получают разрешения. Настройка и восстановление копии описаны в [Host README](../plugins/dsh-postman-harness/README.md#явный-свободный-режим-локальной-разработки).

### Durable recovery и observation

Новые operations durably сохраняют известные Host transport/phase/child/REQ/publication/terminal/sync/grant facts до side effects. При restart exact requestId читается только из journal либо exact trusted terminal; authoritative Direct state восстанавливает trusted terminal и необходимые локальные действия. Доказанный `PROVEN_NOT_SENT` или `publicationStarted:false` освобождает slot только при отсутствии противоречивой publication authority; published/may-be-sent без terminal остаётся blocked. Reserved/child-only/legacy rows не replay-ятся и не удаляются по возрасту/отсутствию Agent.

`postman_bridge_list()` — read-only все операции exact Leader с limit=3, used, `countsAgainstLimit` и причиной, lifecycle/correlation/publication/sync/grant. Неизвестные legacy поля — `unknown`. Чтение не запускает child, Direct, recovery, retrySync и не регистрирует grants.

`postman_worker_list()` отдельно показывает binding/delivery, quotas Secretary used/1, Worker used/2 и Sol used/1 (Sol видит только своих Worker used/2), runtime residency, durable closed/unavailable/diagnostic и turn/report evidence; состояние turn не успех задачи. Compact exact resident idle Worker — `postman_worker_compact({workerSessionId})`, та же Session/ID/quota. Чистый context — `postman_worker_fresh({workerSessionId,task})`: проверенное закрытие exact owned Session, резерв квоты и новый ID того же типа без visible history; audit и private Secretary ledger остаются. Continuation в approved plan не требует повторного user confirmation; fresh context не даёт blanket approval новой независимой цели или material change.

Artifact grant записывается в exact Leader-owned durable `artifactGrants[requestId]` **до** Bridge operation cleanup. Он переживает restart без Bridge row; resolve повторно проверяет ZIP/SHA, не является one-shot и не даёт foreign Leader authority. Cancel отзывает только Worker artifactRequests; новый exact Worker получает прежний REQ лишь через explicit обычную assignment.

## 10. Failure boundary

Bridge никогда не делает blind resend.

- caller не top-level `postman-leader` → `POSTMAN_BRIDGE_CALLER_REJECTED` до parsing/spawn;
- malformed message → `POSTMAN_BRIDGE_MESSAGE_REJECTED` до spawn;
- spawn/capability failure → `POSTMAN_BRIDGE_START_FAILED`;
- child не стартовал Direct → `POSTMAN_BRIDGE_NO_TRANSPORT`;
- Direct terminal failure возвращается parent-у как trusted `result`;
- cancellation после начала не разрешает автоматический второй Send.

## 11. Ordinary subagents

Обычные `subagent`/`subagent_fork` capabilities Harness не изменяются. Для не-Leader Agents
`postmanBridgeRestrictionForAgent` запрещает ordinary Agents все зарегистрированные Postman Host controls и PTC. Только точные роли Postman имеют описанные выше исключения; ordinary Agents сохраняют остальные capabilities.
`glob` не запрещён Worker: он остаётся доступен ему из общего coding preset, но скрыт у Leader.
`postman_bridge` остаётся отдельным специализированным tool с фиксированной Luna.

**Совмещённый lifecycle Worker (#242 + #246):** обычные Worker ×2, Secretary ×1 и Sol ×1 Leader, плюс Worker ×2 Sol, независимо делят одно Host task worktree. Адресный обычный close возможен после успешного native report, доставки в контекст точного непосредственного parent и завершения всей актуальной работы; Agent может быть уже освобождён, тогда Host только читает durable Session. Неполная история — отказ без остановки; точный `mode: "cancel"` требует нового однократного Host approval. Restore не вызывает drain и не очищает грязное дерево при сохранённых Worker-привязках. `postman_yield` уступает лишь ход Leader через `concludeTurn`, не закрывает Worker и не создаёт пустой final.
