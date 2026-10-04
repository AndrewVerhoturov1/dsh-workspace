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

`node --test lib/task-discipline.test.js` проверяет реальные запросы production Leader/Worker, следующий шаг, follow-up того же Worker, замену всей surface и подключение нового bundle к обычному агенту в Web и Headless без Postman; шесть маленьких wording fixtures сохраняют смысл правил. Расширенный `node --test lib/ptc-worker-cold-resume.test.js` проверяет в двух Node-процессах тот же Worker ID, native preset inheritance/reconstruction и весь блок в каждом Leader/Worker request. Адаптер модели в этих тестах детерминированный: доставка доказана, семантическое соблюдение реальной моделью остаётся вероятностным и требует будущих model evals; отдельной eval-инфраструктуры нет.

Гарантия относится к композиции с включённым `dsh-task-discipline` и обычной сборкой секций. Штатный `complete: true` prompt override намеренно заменяет все обычные секции; соответствующего override в текущих Postman presets нет. Плагин не обходит этот Harness contract и не вводит semantic runtime guard.

## Экспериментальный ПТС Leader и Worker

Один обычный `ptc_execute` регистрируется в bridge entrypoint с общим QuickJS runtime. Точный живой top-level `postman-leader-ptc` работает PTC-first с профилем `postman-leader-supervisor` revision 8: `todo_write`, цели `create/get/update`, `read/grep/web_fetch`, task prepare/restore, input files, Bridge/status/list и Worker/interrupt/stop/list/compact вызываются только из `ptc_execute`. Один outer program объединяет несколько supervisor operations, сокращая model turns; Host ToolRuntime guard отвергает их model-direct вызовы и пропускает вложенные вызовы с parent outer token через штатный `ctx.tools.execute` от того же Agent и rootCallId. Прямыми остаются `ptc_execute`, `skill`, `ask_user_question`, `exit_plan_mode`, `read_image`, `postman_yield`, `postman_sol_worker` (вне PTC). Production `postman-leader` остаётся direct-mode без PTC и без изменения authority. Skill v25 выше execution mode: approval для средней/сложной задачи до task preparation/делегирования, repo discovery/execution — Worker/Postman по маршруту; Worker report и Bridge READY — новые события, не polling внутри программы.

Только его точный текущий Host-admitted Worker получает отдельный `postman-worker-mutation` revision 4: `read/glob/grep/web_fetch/web_search/write/edit`, пересечённые с обычной видимостью; первые три обязательны. Production Leader/Workers, Bridge, произвольные дети и дети Worker ПТС не получают. Worker сохраняет остальные обычные coding tools, но внутри PTC нет shell/jobs/report/notify_parent, `postman_*` или иных полномочий. Аргументы — программа, краткое описание причины границы, обязательный `boundary`, необязательные `yield_on_success` и язык; динамическая секция автоматически внедряет канонический [ptc-discipline.js](lib/ptc-discipline.js) v2 и реальные доступные схемы. Worker managed names имеют общий source of truth для profile и model-direct guard: прямые `read/glob/grep/web_fetch/web_search/write/edit` отклоняются, nested calls разрешены в прежних границах. Luna Worker запускается с `reasoningEffort=max`, Sol Worker — `xhigh`; общий request waterfall сохраняет соответствующее значение и при cold resume. Shell не служит обходом PTC-first. Program-First доводит одну программу до следующей настоящей точки решения. Исполнение одноразовое, без повтора и без изменения доверенных результатов Postman.

Leader `boundary: external_event` завершает ход через штатный concludeTurn после `ok` и exact accepted Worker/interrupt/Bridge producer, независимо от `yield_on_success` (сохранён для совместимости). Prepare alone не вызывает WAIT. Все внутренние calls должны быть completed, без cleanupError, failed/pending/unknown effects, отмены, needsModelDecision или отзыва authority. Worker report / Bridge READY возобновляют Leader; отдельный model call ради postman_yield и polling не нужны. Leader revision 8: 300000 ms, 256 calls, 64 MiB QuickJS, 16 MiB bridge, concurrency 1; final JSON по-прежнему 512 KiB. Общее ядро допускает не более 10 активных процессов. Byte-aware helpers читают внутри до 4 MiB на файл; readMany контролирует общий retained JSON, mapTextFiles последовательно сокращает файлы и отклоняет возврат полного source text напрямую/прямым полем (raw files — через readMany). На каждый запуск — технический postman/ptc-run в штатном Cordis logger postman-ptc, не durable session event, без program/содержимого файлов/result; oversizedResultCandidate отмечает >64 KiB без hard failure. Native Harness PTC/Code Mode, run_code/edit_run_code/dsh-ptc-plus не меняются.

Host сверяет exact Agent с существующим Worker `liveSlot`, живым experimental Leader, ready binding и task context. На created текущий exact Host pending start/follow-up admission даёт provisional PTC и discipline до первого model request; arbitrary child/preset/saved ID не дают доступа. Ready подтверждает тот же slot. Настоящий Jsonl round-trip + cold resume exact Worker после PTC проверен в двух отдельных Node процессах: первый resumed request имеет PTC/discipline/max и исполняет PTC успешно. Failure/stale admission/abort, stop, uncertainty, disposal, preset/context replacement и durable reactivation используют адресный refresh/отзыв. Worker notify_parent принимает только exact NEEDS_LEADER_GUIDANCE: для решения сейчас, включая первый provisional request по существующему ptcSlot; FYI остаётся до report, Bridge factual path прежний. Каждый из трёх Worker имеет свой Agent и запуск; общий runtime сохраняет глобальные пределы. Вложенные вызовы идут через `ctx.tools.execute` исходного Worker и каждый раз проверяют текущие права. Stage 4 live Worker-приёмка подтвердила namespace, настоящий glob/read/grep, continuable follow-up, selective stop трёх Worker и отсутствие PTC production Worker, но обнаружила, что относительный read использовал `.dsh`/session cwd вместо task worktree. Этап 4.5 исправил эту базу. Stage 5 включил mutation и проверен автоматическими тестами без установки и без live model acceptance (Stage 6 отдельно).

Worker PTC (Luna и Sol) сохраняет Host-bound context.worktree только как базу относительных `read/write/edit.file_path`, `glob.path` и `grep.path`; search без path получает этот корень. Абсолютные внешние пути, нормализованные `..` и symlink/junction больше не отклоняются отдельным worktree-фильтром: их разрешает штатная файловая политика DSH. `read-only` запрещает запись, `workspace-write` допускает её только в разрешённых корнях (включая временные каталоги), `danger-full-access` не ограничивает пути. Leader уже не проходил этот фильтр и не изменён. Exact Agent/Worker slot, идентичность task context до и после вызова, revocation, видимость инструментов, schema validation, fs-observation-policy и stale/version semantics остаются прежними; `ctx.tools.execute` сохраняет исходного Agent и parent/root linkage. PTC mutation не транзакционна: completed write/edit не откатывается после ошибки; rollback/retry нет. Набор инструментов, native Harness PTC, разрешения раскрытия секретов, Postman-артефакты и защита Git не изменены. Целевые тесты с установленной native policy: `DSH_TEST_NATIVE_ROOT` указывает на пакет установленного CLI `@deepseek-ai/dsh` (без изменения этого пакета).

Штатная поставка из репозитория: `node profiles/web/scripts/install-production.mjs` сначала устанавливает production-зависимости Postman-плагина через `pnpm install --offline --frozen-lockfile --prod` в `plugins/dsh-postman-harness`, затем устанавливает web-профиль с `link:../../plugins/dsh-postman-harness`. Относительное `file:../dsh-ptc` попадает в зависимости самого плагина; pnpm устанавливает ядро и транзитивный QuickJS/WASM без ручного размещения каталога или старого `node_modules`. Один архив Postman-плагина не является автономной поставкой. Чистая одноразовая проверка: `node profiles/web/scripts/test-install-production-postman-ptc.mjs`. Установка пользовательского профиля и приёмка модели здесь не выполнялись. Актуальный контракт: docs/subprojects/ptc/PTC_CONTRACT.md.

## Postman Bridge

Bundle подключает subpath entrypoint:

```text
dsh-postman-harness/bridge
```

Он регистрирует host definition `postman_bridge` с одним model-facing argument `message`.
Runtime показывает эту capability только top-level Agent с preset `postman-leader`: всем остальным
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
на его корень. Runtime boundary даёт top-level Agent-у положительный allowlist ровно из 24
зарегистрированных tools:

```text
ask_user_question, todo_write, exit_plan_mode, create_goal, get_goal, update_goal, read, read_image, grep, skill, web_fetch, postman_task_prepare, postman_task_restore, postman_input_files, postman_bridge, postman_bridge_status, postman_bridge_list, postman_worker, postman_sol_worker, postman_worker_interrupt, postman_worker_stop, postman_yield, postman_worker_list, postman_worker_compact
```

`glob` и `web_search` намеренно отсутствуют; незарегистрированные имена не являются
допустимыми aliases. Positive allowlist действует поверх общего preset.

Любой `origin=subagent` считается non-Leader и получает deny всех Leader-only tools; исключение `ptc_execute` действует только для подтверждённого Worker experimental Leader. Luna Bridge
дополнительно получает свой отдельный пятиимённый `toolFilter`: `skill`,
`postman_send_current_turn`, `postman_current_turn_status`, `postman_ask_validate_reply`, `notify_parent`.
Worker не имеет собственного узкого списка разрешений: его обычные инструменты приходят из
общего preset, в том числе read/glob/grep/write/edit, pwsh на Windows (bash на других системах),
jobs, web search/fetch и обычное делегирование. При создании Worker host берёт все фактически
зарегистрированные инструменты с префиксом `postman_` и задаёт только запрет на них в дочерней
сессии; штатный `report`, установленный в собственной области child, остаётся доступен.
Модель Worker задаётся отдельно от Bridge.

Host сохраняет до трёх точных Luna-привязок `(Leader session id, workerSessionId)` в долговременном реестре до запуска каждого Worker. `postman_worker({task, createNew: true, label?})` создаёт независимого Worker; четвёртый возвращает `POSTMAN_WORKER_LIMIT_REACHED` до запуска. Адресные `postman_worker({task, workerSessionId, artifactRequestId?})`, `postman_worker_interrupt({workerSessionId, task})` и `postman_worker_stop({workerSessionId})` затрагивают только выбранного ребёнка. `postman_worker_list()` read-only показывает привязки, quotas и authoritative residency/turn/report evidence; settled/idle не доказывают успеха. Без адреса старый вызов допустим при единственной привязке, при нескольких — `POSTMAN_WORKER_TARGET_REQUIRED`. Все трое используют одну task branch/worktree: пересекающиеся изменения надо координировать; сохранённая привязка не блокирует синхронизацию сама по себе. Host закрывает допуск конфликтующих действий на общей операции; потенциально выполняющийся Worker делает её BUSY. Продолжение доступно по прежнему ID; stop требуется лишь для окончательного закрытия. При сохранённой хотя бы одной Worker-привязке restore грязного дерева отклоняется: Host не может доказать, какие байты созданы runner и не изменены другими исполнителями. Случай «runner изменил файлы → FAIL → очистить только его изменения и продолжить тем же Worker» пока не реализован; остановка Worker сама по себе такого доказательства не даёт.
Ответ `POSTMAN_WORKER_TASK_ACCEPTED` подтверждает только приём, а не выполнение. Host сохраняет FIFO-порядок приёма обычных `postman_worker` follow-up; это не обещает порядок их обработки со стороны Harness runtime.

`postman_worker_interrupt({workerSessionId, task})` ставит follow-up в FIFO выбранной сессии без отмены текущего шага. Другие Worker не блокируются её очередью. `postman_worker_stop({workerSessionId})` освобождает только выбранную Activation и удаляет только её привязку, Session сохраняется.

Worker отправляет результат через штатный `report`. Host связывает принятые messageId с ходами и native report; `notify_parent`, `finished` и состояние idle не подтверждают завершение. `postman_worker_stop({mode:'close'})` по умолчанию отказывает, пока нет актуального отчёта в контексте Leader и завершённого исполнения; `mode:'cancel'` с точным workerSessionId не требует approval и не означает успеха пользовательской задачи. При неизвестном drain binding остаётся неопределённым. `postman_yield()` завершает только активный ход Leader через Host concludeTurn, не останавливает Worker; report/failure/новый пользовательский ввод возобновляют Leader без пустого final. Session при закрытии не удаляется. После рестарта
Host проверяет точный сохранённый childId и продолжает его без создания второго Worker.


### Sol Worker V1

`postman_sol_worker({task, label?})` создаёт или продолжает единственного Sol Worker; для нового задания тому же ребёнку передай `workerSessionId` (и при необходимости trusted `artifactRequestId`). `createNew: true` при занятом Sol-слоте возвращает `POSTMAN_SOL_WORKER_LIMIT_REACHED`. Фиксированная модель — `codex / gpt-6.1-sol`, reasoning `xhigh`. Лимиты независимы: максимум 3 Luna + 1 Sol на Leader; pending/uncertain binding тоже занимает свой слот. Старые записи без `workerType` считаются Luna.

Sol предназначен для сложной работы, но V1 разрешает его **только по прямой просьбе пользователя использовать Sol Worker**. Нет автоматической escalation Luna → Sol, выбора по сложности/размеру или после неудачи Luna. Перед первым назначением и каждым новым отдельным заданием тому же Sol (включая follow-up по `workerSessionId`) Leader спрашивает через `ask_user_question`: «Разрешить запустить Sol Worker для этой задачи?», и ждёт положительного ответа. Этого ответа достаточно для вызова `postman_sol_worker`; второго системного `Allow once` нет. При отказе, отмене или отсутствии ответа Leader не передаёт задание. Подтверждение относится только к этому заданию, даже в `localDevelopment`; прежняя просьба использовать Sol или route approval не заменяет вопроса. Это правило инструкций Leader: инструмент не обращается к `ApprovalService` и не хранит подтверждения. Permission presets, `approval: ask/never` и глобальная permission-система Harness не меняются. Обычные `postman_worker` и `postman_worker_interrupt` не передают новые задания Sol (`POSTMAN_SOL_WORKER_TOOL_REQUIRED`).

У top-level production и experimental PTC Leader инструмент доступен напрямую; внутрь PTC profile не включён. После приёма без независимой работы вызывается `postman_yield()`, не polling. Sol наследует тот же task worktree, continuable durable Session, report, cold resume, coding tools, transport restrictions и Worker PTC у experimental Leader. Общие `postman_worker_list` (тип/модель) и `postman_worker_stop` работают для обоих типов без approval; stop не доказывает успеха и не удаляет durable Session.

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

`postman_worker_compact({workerSessionId})` использует штатный native `compactNow` только для trustworthy exact resident idle Worker без очереди и pending/unknown delivery под exact-child serialization. ID, binding и quotas сохраняются. Fresh context — отдельный существующий workflow: успешный exact close/cancel, durable closed старого ID и удаление binding → `createNew:true` с новым ID без старой model-visible истории. Audit persistence не удаляется. Новый Sol task всё равно требует нового положительного user answer.

Host-side Sol token не добавлен: pinned `ask_user_question` возвращает exact human occurrence и caller, но удаляет typed intent/detail и не предоставляет Sol-assignment discriminator. Выводить позитивное Sol-разрешение из question/option/free text было бы недоверенной эвристикой; existing explicit contract сохранён.

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
