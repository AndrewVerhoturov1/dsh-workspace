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
на его корень. Runtime boundary даёт top-level Agent-у положительный allowlist ровно из 19
зарегистрированных tools:

```text
ask_user_question, todo_write, exit_plan_mode, create_goal, get_goal, update_goal, read, read_image, grep, skill, web_fetch, postman_task_prepare, postman_task_restore, postman_bridge, postman_bridge_status, postman_worker, postman_worker_interrupt, postman_worker_stop, postman_worker_list
```

`glob` и `web_search` намеренно отсутствуют; незарегистрированные имена не являются
допустимыми aliases. Positive allowlist действует поверх общего preset.

Любой `origin=subagent` считается non-Leader и получает deny всех Leader-only tools. Luna Bridge
дополнительно получает свой отдельный четырёхимённый `toolFilter`: `skill`,
`postman_send_current_turn`, `postman_current_turn_status`, `postman_ask_validate_reply`.
Worker не имеет собственного узкого списка разрешений: его обычные инструменты приходят из
общего preset, в том числе read/glob/grep/write/edit, pwsh на Windows (bash на других системах),
jobs, web search/fetch и обычное делегирование. При создании Worker host берёт все фактически
зарегистрированные инструменты с префиксом `postman_` и задаёт только запрет на них в дочерней
сессии; штатный `report`, установленный в собственной области child, остаётся доступен.
Модель Worker задаётся отдельно от Bridge.

Host сохраняет до трёх точных привязок `(Leader session id, workerSessionId)` в долговременном реестре до запуска каждого Worker. `postman_worker({task, createNew: true, label?})` создаёт независимого Worker; четвёртый возвращает `POSTMAN_WORKER_LIMIT_REACHED` до запуска. Адресные `postman_worker({task, workerSessionId, artifactRequestId?})`, `postman_worker_interrupt({workerSessionId, task})` и `postman_worker_stop({workerSessionId})` затрагивают только выбранного ребёнка. `postman_worker_list()` показывает привязки, но не статус исполнения. Без адреса старый вызов допустим при единственной привязке, при нескольких — `POSTMAN_WORKER_TARGET_REQUIRED`. Все трое используют одну task branch/worktree: пересекающиеся изменения надо координировать; sync и restore запрещены, пока есть привязки, ZIP runner допускается только без другого привязанного Worker.
Ответ `POSTMAN_WORKER_TASK_ACCEPTED` подтверждает только приём, а не выполнение. Host сохраняет FIFO-порядок приёма обычных `postman_worker` follow-up; это не обещает порядок их обработки со стороны Harness runtime.

`postman_worker_interrupt({workerSessionId, task})` ставит follow-up в FIFO выбранной сессии без отмены текущего шага. Другие Worker не блокируются её очередью. `postman_worker_stop({workerSessionId})` освобождает только выбранную Activation и удаляет только её привязку, Session сохраняется.

Worker отправляет результат через штатный `report`. `postman_worker_stop` штатно освобождает
resident Activation и закрывает долговременную привязку; сама Session не удаляется. После рестарта
Host проверяет точный сохранённый childId и продолжает его без создания второго Worker.

## Implementation package: отдельное локальное решение

Normal Direct/Postman Bridge доставляет любой безопасный ZIP; implementation schema не проверяется transport-слоем. Только после trusted correlated `RESULT_DURABLE` Host регистрирует process-local grant по `(Leader session, requestId)`, привязывая exact `resultZip` и SHA-256. Grant доказывает происхождение/целостность artifact, но не пригодность implementation package и не разрешение применять его. Это внутреннее trusted binding, а не предоставленный моделью token или постоянная база grants. Leader (Sol) отдельно выбирает точного Worker через `postman_worker({task, workerSessionId, artifactRequestId})`; грант одного Worker не доступен другому.

Для такого поручения ChatGPT Web готовит декларативный ZIP по `REPO_POLICY.md`, `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md`: `manifest.json`, сгенерированный Git `changes.patch`, `README.md`, `TEST_PLAN.md`; относящиеся к изменению тесты и узкие исключения `.gitignore` для иначе игнорируемых новых repository-owned файлов находятся в patch. Пакет не содержит своего applicator/diagnostics framework.

Зарегистрированный tool `implementation_artifact_apply({requestId, worktree})` предназначен для применения exact Postman artifact: он при исполнении проверяет точного активного Worker и отдельно допущенный REQ, разрешает REQ в сохранённый Host путь ZIP, повторно проверяет SHA-256 и проверяет идентичность Git repository/worktree до вызова уже существующего `system/implementation_package_runner.py`. Путь ZIP не берётся из текста задания, аргументов Worker или ZIP manifest. Runner сам проверяет clean/protected worktree и package, применяет patch, запускает targeted tests и создаёт диагностику.

Host `postman_task_prepare` от exact `origin/preview` создаёт и публикует одну task branch с clean worktree на Leader до Bridge; До трёх независимых Bridge jobs на Leader одновременно публикуют REQ commit туда, не в `main`; Host поочерёдно проверяет lineage и fast-forward-ит опубликованные commits. Незавершённые после аварии jobs не повторяются и учитываются в лимите. Worker по отдельному заданию использует это же clean worktree на опубликованном REQ commit, не создаёт вторую ветку, и вызывает tool только с REQ и worktree, проверяет фактический результат и передаёт child-scoped `report`: PASS с путями/проверками без автоматической публикации; FAIL с diagnostics ZIP, без ручного ремонта. `POSTMAN_WORKER_TASK_ACCEPTED` — лишь приём задания. Worker остаётся обычным coding-agent с shell и теоретически может запускать локальные программы сам; гарантия здесь — только допущенный Worker может пользоваться trusted Host grant и этим tool для exact Postman artifact, а не запрет самостоятельного запуска программ. Перед отдельным commit/push/PR реализации из ветки убираются REQ transport-файлы; URL прежних REQ закреплены за SHA, поэтому `--chat` сохраняется. Runner допускает `packageBase != HEAD`. Публикация — отдельное действие согласно repository policy; merge требует отдельной команды. Plugin не вводит новый runner и не запускает применение ZIP при transport handoff.

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
