# dsh-postman-harness

## Статус

`dsh-postman-harness` не является отдельным browser transport. Production transport остаётся в
`postman/direct/`.

Plugin владеет trusted Harness orchestration boundary:

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
на его корень. Runtime boundary оставляет top-level Agent-у только read-only inspection +
`postman_bridge`, `postman_worker`, `postman_worker_stop`:

```text
read, glob, grep, skill, web_fetch, web_search, postman_bridge, postman_worker, postman_worker_stop
```

Любой `origin=subagent` считается non-Leader и получает deny всех трёх Leader-only tools. Luna Bridge
дополнительно получает свой отдельный `toolFilter`, который оставляет только transport tools.
Worker не имеет собственного узкого списка разрешений: его обычные инструменты приходят из
общего preset, в том числе read/glob/grep/write/edit, pwsh на Windows (bash на других системах),
jobs, web search/fetch и обычное делегирование. При создании Worker host берёт зарегистрированные
инструменты с префиксом `postman_` и задаёт только запрет на них в дочерней сессии; штатный
`report`, установленный в собственной области child, остаётся доступен. Модель Worker задаётся
отдельно от Bridge.

Host хранит отображение точного Leader session id в durable child session id только в памяти.
Первое задание запускает `startContinuable`, дальнейшие задания идут через `followup`.
Ответ `POSTMAN_WORKER_TASK_ACCEPTED` подтверждает только приём, а не выполнение.
Worker отправляет результат через штатный `report`. `postman_worker_stop` штатно освобождает
resident Activation и забывает отображение; durable Session не удаляется. После рестарта
Host реестр Worker не восстанавливается (ограничение MVP).

## Implementation package: отдельное локальное решение

Normal Direct/Postman Bridge доставляет любой безопасный ZIP; implementation schema не проверяется transport-слоем. Только после trusted correlated `RESULT_DURABLE` Host регистрирует process-local grant по `(Leader session, requestId)`, привязывая exact `resultZip` и SHA-256. Grant доказывает происхождение/целостность artifact, но не пригодность implementation package и не разрешение применять его. Это внутреннее trusted binding, а не предоставленный моделью token или постоянная база grants. Leader (Sol) отдельно решает, авторизовать ли применение REQ тем же продолжаемым Worker через `postman_worker({task, artifactRequestId})`.

Для такого поручения ChatGPT Web готовит декларативный ZIP по `REPO_POLICY.md`, `system/implementation-package-workflow.md` и `system/implementation-package-authoring.md`: `manifest.json`, сгенерированный Git `changes.patch`, `README.md`, `TEST_PLAN.md`; относящиеся к изменению тесты и узкие исключения `.gitignore` для иначе игнорируемых новых repository-owned файлов находятся в patch. Пакет не содержит своего applicator/diagnostics framework.

Зарегистрированный tool `implementation_artifact_apply({requestId, worktree})` предназначен для применения exact Postman artifact: он при исполнении проверяет точного активного Worker и отдельно допущенный REQ, разрешает REQ в сохранённый Host путь ZIP, повторно проверяет SHA-256 и проверяет идентичность Git repository/worktree до вызова уже существующего `system/implementation_package_runner.py`. Путь ZIP не берётся из текста задания, аргументов Worker или ZIP manifest. Runner сам проверяет clean/protected worktree и package, применяет patch, запускает targeted tests и создаёт диагностику.

Worker по отдельному заданию создаёт clean task branch/worktree от актуального `origin/preview`, вызывает tool только с REQ и worktree, проверяет фактический результат и передаёт child-scoped `report`: PASS с путями/проверками без автоматической публикации; FAIL с diagnostics ZIP, без ручного ремонта. `POSTMAN_WORKER_TASK_ACCEPTED` — лишь приём задания. Worker остаётся обычным coding-agent с shell и теоретически может запускать локальные программы сам; гарантия здесь — только допущенный Worker может пользоваться trusted Host grant и этим tool для exact Postman artifact, а не запрет самостоятельного запуска программ. Публикация — отдельное действие согласно repository policy; merge требует отдельной команды. Plugin не вводит новый runner и не запускает применение ZIP при transport handoff.

Harness model routing намеренно находится вне Agent presets. Поэтому для Leader в model selector
выбирается `GPT-6 Sol`; preset сам модель не переключает. Bridge Luna фиксирована кодом.

## Legacy async runtime

В основном entrypoint сохраняются исторические/совместимые компоненты:

- persistent `postman-harness-session`;
- probe protocol;
- SQLite-backed `PostmanRuntime`;
- `postman_async_send`;
- `postman_runtime_*`;
- result workspace/presentation helpers.

Они не являются fallback для normal Direct Postman или Postman Bridge.

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
