# Direct Web Postman — актуальный production flow

> Repository: `AndrewVerhoturov1/dsh-workspace`  
> Production entrypoint: `postman/direct/postman.ps1`  
> Normal trigger: exact current-message `@Postman`

## 1. Назначение

Direct Web Postman — transport между локальным Harness/Luna agent и ChatGPT Web.

Он обязан:

1. сохранить exact current user intent;
2. создать один новый canonical REQ;
3. опубликовать self-contained task-файл;
4. отправить в ChatGPT Web canonical двухстрочный link-only prompt;
5. доказать exact ChatGPT conversation и assistant turn;
6. получить exact correlated ZIP;
7. проверить transport safety/integrity/correlation;
8. атомарно сохранить `RESULT_DURABLE`;
9. вернуть локальному агенту exact durable metadata.

Postman не применяет ZIP к repository и не принимает semantic решение за пользователя.

## 2. Source of truth

Порядок приоритета:

```text
AGENTS.md
→ .agents/skills/delegate-via-postman/SKILL.md
→ postman/POSTMAN_CURRENT_FLOW.md
→ docs/web-postman-artifact-contract.md
→ module README/source/tests
```

`postman_async_send`, старый persistent POSTMAN agent и исторические WP milestone notes
не переопределяют этот production flow.

## 3. Trigger и intent boundary

Postman OFF by default.

Разрешающий trigger существует только для current user message:

```text
^\s*@Postman(?:\s|$)
```

Normal:

```text
@Postman <intent>
```

Continuation:

```text
@Postman --chat <old REQ> <new intent>
```

Для normal request Luna удаляет только `@Postman` и непосредственно следующий separator.

Для continuation `--chat <old REQ>` является transport metadata и не входит в semantic intent.
External ChatGPT получает только `<new intent>` через новый task-файл.

Previous Luna context не добавляется к payload.

## 4. Orchestration boundary Luna

Production entrypoint разрешается относительно current workspace:

```powershell
$workspace = (Get-Location).Path
$bridge = Join-Path $workspace 'postman\direct\postman.ps1'
```

Hardcoded Windows username не используется.

Если caller уже PowerShell, normal path вызывает `& $bridge` напрямую без nested `pwsh.exe`.

Для normal `tools.pwsh` invocation:

- не задавать hardcoded `workdir`;
- не выполнять Luna-side `New-Item`/`Set-Content`/`Out-File` result-root write probe;
- не дублировать внутренний result-root preparation Direct Postman.

Если shell tool не породил process (`spawn EPERM`, invalid cwd и т.п.), это
`POSTMAN_INVOCATION_NOT_STARTED`. Send не происходил. После этого нельзя выбирать старый/latest
REQ как результат текущей операции и нельзя автоматически повторять invocation.

## 5. Canonical REQ

Формат:

```text
REQ_YYYYMMDDTHHMMSSZ_NNNN
```

Один logical invocation создаёт один новый REQ.

Continuation также создаёт новый REQ; old REQ — только lookup key.

REQ строится без JavaScript-template interpolation hazard, например PowerShell concatenation:

```powershell
$requestId = 'REQ_' + $stamp + '_' + $suffix
```

Persisted state того же REQ блокирует blind resend.

## 6. Snapshot и GitHub task publication

Direct Postman фиксирует trusted snapshot `origin/main` перед публикацией task-файла.

Task filename:

```text
<REQ>.md
```

`base_commit` внутри task-файла — snapshot до transport-only publication commit.

Task-файл self-contained и содержит:

```text
protocol_version
request_id
repository
base_commit
expected_filename
allowed_paths_json
forbidden_paths_json
User intent
Execution contract
Result contract
```

Metadata paths не означают, что пользователь запросил repository changes, и не являются
normal ZIP validator content gates.

## 7. Canonical browser prompt

Browser prompt состоит ровно из двух строк:

```text
POSTMAN_REQUEST_ID: <REQ>
task_file: <exact SHA-pinned task URL>
```

Отдельной `policy:` строки нет.

User intent и result instructions не дублируются в browser prompt.

## 8. Dedicated Chrome

Default browser profile:

```text
%LOCALAPPDATA%\DSH\Postman\browser-profile
```

CDP endpoint текущего deployment:

```text
http://127.0.0.1:9222
```

Browser profile — durable browser identity. PID/Page/WebSocket IDs — runtime details.

Dedicated Chrome запускается с нейтральной страницей `about:blank`; рабочий ChatGPT chat
открывается только в отдельной owned Page. Worker закрывает принадлежащую ему рабочую вкладку
до отключения Playwright/CDP и подтверждает `ownedPageClosed`. Externally-owned
browser/context не закрываются.

## 9. Fresh chat path

Fresh request должен доказать до Send:

```text
owned Page
+ root chatgpt.com route
+ zero current conversation turns
+ visible empty composer
```

После вставки prompt проверяются exact text и hash.

Send разрешён один раз.

Success:

```text
exactly one new user turn
+ exact prompt text
+ empty composer
+ bound /c/... URL
= PROMPT_SEND_CONFIRMED
```

Если Send outcome неопределён:

```text
PROMPT_SEND_UNKNOWN
→ no blind resend
```

## 10. Continuation path

Old REQ разрешается только в locally saved exact conversation reference.

Lookup использует durable/direct/worker state для старого REQ.

Worker открывает exact:

```text
https://chatgpt.com/c/<conversation-id>
```

и должен подтвердить, что composer готов именно в этом conversation.

После этого новый REQ проходит обычный send/observe/download lifecycle.

Запрещено:

- Search UI fallback;
- угадывать conversation;
- silent fresh-chat fallback;
- отправлять old REQ или `--chat` как semantic intent.

Если reference отсутствует:

```text
DIRECT_CHAT_REFERENCE_UNAVAILABLE
→ STOP before Send
```

Если exact existing chat не подтверждён — fail closed до Send.

## 11. Assistant-turn correlation

Observer получает trusted user-turn/send proof и exact chat URL.

Допустимый target:

```text
exact proven user turn
→ immediately next conversation turn
→ role = assistant
```

Старые assistant turns из других REQ и глобальный поиск по body не используются.
Разрешённый assistant turn текущего REQ после completion проверяется на exact ZIP. Если ZIP
не найден, через 10 секунд выполняется одна свежая контрольная проверка того же exact turn.
Если ZIP всё ещё отсутствует, current REQ завершается `ASSISTANT_COMPLETED_NO_ARTIFACT` и
возвращает полный assistant text локальному агенту. Если текст изменился, требуется свежий
completion proof и 10-секундное окно начинается заново.

Во время generation observer опрашивает страницу раз в 3 секунды. Assistant turn должен
завершить generation и стабилизировать текст до artifact detection.

Если UI показывает `Соединение прервано` / `Connection interrupted`, это отдельное
recoverable состояние, а не completion. Worker не отправляет reminder, reload-ит ту же
owned Page того же conversation, ждёт подтверждённую загрузку exact chat и затем ещё
10 секунд стабилизации. Reload не создаёт новый REQ, не повторяет исходный prompt и не
сбрасывает общий deadline. Recovery ограничен тремя reload-попытками; после их исчерпания
worker ждёт восстановления интерфейса без бесконечного F5.

### 11.1. Служебные напоминания

Отсчёт начинается после первоначального `PROMPT_SEND_CONFIRMED`. Сроки reminders остаются
фиксированными: 10-я, 20-я и 30-я минуты; общий предел ожидания — 45 минут. Но наступление
срока само по себе больше не разрешает немедленный Send. Перед каждым reminder worker
обязательно перечитывает все разрешённые assistant turns текущего REQ и ещё раз ищет exact
RESULT. Если RESULT уже появился, он скачивается и reminder отменяется. Если действует
connection-interruption recovery или exact chat ещё не доказан как готовый, reminder ждёт
восстановления и не отправляется вслепую. После `RESULT_DURABLE` оставшиеся reminders
отменяются. Reload/recovery не сдвигает расписание и не перезапускает 45-минутный отсчёт.

Если ZIP скачан, но minimal transport validation его отклоняет, staging удаляется и current
REQ немедленно завершается `ARTIFACT_REJECTED`. Terminal JSON содержит assistant text,
`validationCode` и `validationMessage`; следующий action выбирает локальная LLM. Сам Postman
не ждёт следующего reminder после уже завершённого assistant-turn. Ошибки самого validator
infrastructure, записи, скачивания или неопределённого transport состояния остаются failure.

Каждое напоминание отправляется в тот же exact conversation и начинается так:

```text
POSTMAN_REQUEST_ID: <тот же REQ>
POSTMAN_TRANSPORT_CONTROL: REMINDER <1..3>/3
```

Дальше идёт фиксированный текст с просьбой продолжить исходную задачу, не начинать её
заново, не отвечать отдельно на служебное сообщение и выдать итог строго по исходным
правилам. Для напоминания новый REQ не создаётся, и новый semantic intent не появляется.

После доказанной отправки напоминания оно становится новым разрешённым correlation anchor:

```text
exact proven reminder user turn
→ immediately next conversation turn
→ role = assistant
```

Произвольный новый user turn разрешённым anchor не является. При `PROVEN_SENT` цикл
продолжается обычно. При `PROVEN_NOT_SENT` следующий срок разрешён только после
доказанной очистки текста из поля ввода. При `UNKNOWN` REQ немедленно завершается с
ошибкой; напоминания №2 и №3 не отправляются и служебное сообщение не повторяется вслепую.

## 12. Artifact envelope

Финальный assistant turn должен содержать ровно три непустые видимые строки:

```text
<<<POSTMAN_RESULT_BEGIN:<REQ>>>
POSTMAN_<REQ>_RESULT.zip
<<<POSTMAN_RESULT_END:<REQ>>>
```

Средняя строка — реальный downloadable control с exact visible filename.

Нельзя принимать:

- plain text вместо attachment;
- generic `Download ZIP`;
- attachment вне envelope;
- stale attachment;
- wrong REQ;
- ambiguous controls.

Перед click identity доказывается повторно.

## 13. Download

Правильный lifecycle:

```text
exact correlated control
→ page.expect_download()
→ exactly one click
→ browser download event
→ suggested filename check
→ request-scoped staging
```

Нельзя искать newest ZIP в Downloads или выбирать «последнюю кнопку Download».

После неопределённого click blind retry запрещён.

## 14. Transport validator

Validator намеренно минимальный. Hard gates:

- exact expected filename/correlation;
- readable non-empty ZIP;
- local/central header + CRC integrity;
- `..` traversal, absolute, Windows drive и UNC path rejection;
- symlink rejection;
- простые entry/count/compressed/uncompressed/ratio limits;
- actual SHA-256.

Не являются transport gates: manifest semantics, repository/baseCommit/resultType,
patch/files schema, Unicode/case collision policy и содержательная корректность результата.
Эти проверки принадлежат downstream агенту, если они вообще нужны конкретной задаче.

## 15. Optional manifest

`manifest.json` необязателен.

Если он:

- отсутствует;
- malformed;
- non-object;
- содержит unknown fields;

это само по себе не делает transport artifact invalid.

Только explicit string `requestId`, конфликтующий с trusted current REQ, является manifest hard reject.

## 16. RESULT_DURABLE

После validator PASS результат публикуется атомарно в request-scoped directory:

```text
<ResultRoot>\<REQ>\
├─ result.zip
├─ validation.json
├─ metadata.json
└─ manifest.json   # только если был в ZIP
```

Только `RESULT_DURABLE` означает successful transport.

Текущий deployment default:

```text
D:\Downloads_dsh_auto
```

Result-root creation/write-probe принадлежит Direct Postman, а не Luna preflight.

## 17. Terminal handoff без Result Workspace

После exact `RESULT_DURABLE` normal flow сообщает:

```text
exact requestId
exact resultZip
```

После этого — `STOP`.

Normal `@Postman` не вызывает `postman_result_workspace_register(...)` и не создаёт
Harness Workspace автоматически. Presentation/finalization, если понадобится, является
отдельным explicit workflow вне normal transport.

## 18. Что normal Postman не делает

Normal `@Postman` не:

- распаковывает ZIP;
- анализирует semantic correctness;
- применяет patch/files к repository;
- запускает PREPARE/TEST/PUBLISH;
- создаёт implementation worktree/branch/commit/PR;
- выбирает дальнейшее действие на основе содержимого ZIP;
- использует `postman_async_send`/`postman_runtime_*` как fallback;
- выполняет manual browser automation как fallback.

## 19. Legacy/manual finalization

Существующие:

```text
resume_request.ps1
prepare_result.py
test_result.py
publish_result.py
integrate_result.py
abandon_result.ps1
presentation_status.py
```

остаются отдельным explicit workflow для уже существующего durable result.

Они не являются normal `@Postman` flow.

## 20. `dsh-postman-harness`

Plugin сохраняется для auxiliary/legacy capabilities.

Normal `@Postman` не идёт через persistent POSTMAN agent или `postman_async_send`.

После `RESULT_DURABLE` normal `@Postman` не создаёт Result Workspace автоматически.

## 21. Production state

Web bridge monotonic transport state концептуально:

```text
ACCEPTED
→ WEB_STARTING
→ PROMPT_SENT
→ WAITING_ASSISTANT
→ ARTIFACT_FOUND
→ RESULT_DURABLE
```

Direct layer дополнительно хранит task/browser/handoff state.

Нельзя переводить request назад или повторять Send по догадке.

## 22. Acceptance status

2026-09-19 выполнен полный fresh + continuation E2E после production orchestration fixes.

Проверено:

```text
fresh REQ → RESULT_DURABLE → Workspace registered
continuation → new REQ
continuedFromRequestId = old REQ
same conversation identity
same conversation URL
semantic continuity
ARTIFACT_VALID
manifestless ZIP accepted
RESULT_DURABLE
Workspace registered
```

Полная acceptance запись:

```text
docs/postman-production-e2e.md
```

## 23. Короткая формула

```text
exact current intent
→ one new REQ
→ self-contained task
→ two-line browser prompt
→ exact ChatGPT conversation
→ до трёх служебных напоминаний на 10/20/30 минуте, пока нет RESULT_DURABLE
→ exact next assistant turn текущего разрешённого anchor
→ exact ZIP control
→ one download
→ safety/correlation validation
→ RESULT_DURABLE
→ optional Workspace
→ STOP
```
