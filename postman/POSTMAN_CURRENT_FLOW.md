# Direct Web Postman — актуальный production flow

> Repository: `AndrewVerhoturov1/dsh-workspace`  
> Production entrypoint: `postman/direct/postman.ps1`  
> Normal trigger: exact current-message `@Postman`

Входные файлы являются optional transport metadata внутри task, без изменения User intent или двухстрочного browser prompt; см. [Postman Input Files](POSTMAN_INPUT_FILES.md).

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

Исторические WP milestone notes не переопределяют этот production flow.

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

Direct Postman фиксирует trusted snapshot branch, явно переданной trusted Host: standalone transport выбирает `main`, Leader child получает exact подготовленную task branch.

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
Implementation author discipline (fixed; implementation-package rules only for intent changing the named repository)
Result contract
```

Metadata paths не означают, что пользователь запросил repository changes, и не являются
normal ZIP validator content gates. Fixed implementation-author discipline не изменяет exact `User intent`: implementation-package requirements действуют только при запросе изменить repository, указанный в task; самостоятельный code artifact без repository changes выдаётся в естественном формате. Условия для Web содержатся в самом task, без дополнительного policy URL; подробный canonical contract — [External Implementation Author](../system/postman-external-implementation-author.md). Для repository implementation Web готовит полный implementation и необходимые tests, а downstream Local Worker/central runner выполняют authoritative apply и targeted tests на реальном worktree. Normal transport остаётся универсальным и не становится implementation validator.

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

Automatic continuation разрешена только после `ASSISTANT_COMPLETED_NO_ARTIFACT` или `ARTIFACT_REJECTED`, если terminal text однозначно допускает продолжение без выбора пользователя. Новый REQ наследует `rootRequestId` и увеличивает `continuationIndex`; максимум два automatic continuation на root chain (индексы 1 и 2). Иные terminals, включая `POSTMAN_TRANSPORT_FAILED`, не разрешают automatic continuation. Ручной пользовательский `@Postman --chat <old REQ> <new intent>` всегда создаёт новую root chain с `continuationIndex=0`, сохраняя old REQ только как conversation lookup key. Не повторять Send прежнего REQ и не подменять неизвестный outcome новым запросом.

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

Observer опрашивает exact assistant turn раз в 3 секунды. Структурный финальный ответ
и completion-действия усиливают доказательство завершения; после этого сохраняются
inactive generation и стабильный текст exact turn до artifact detection.

### 11.1. Transport control, recovery и естественные продолжения

После первоначального `PROMPT_SEND_CONFIRMED` request-stage имеет абсолютные checkpoints
10/20/30/40/50 минут и soft deadline 60 минут. Reload не сдвигает расписание. Слоты —
не очередь обязательных сообщений: `PENDING`, `SENT`, `CONSUMED_BY_RECOVERY`,
`SUPPRESSED_FINAL`, `CANCELLED_RESULT_READY`. Все наступившие, но ещё не отправленные
слоты consume-ятся в начале recovery; checkpoints, пересечённые внутри recovery, тоже.
После recovery старые напоминания не догоняются, будущие сохраняют исходные времена.

В каждый момент активен максимум один transport flow. Обычный reminder допускается
только при exact correlated `WORKING` и доказанных Send guards. Pause/Stop сам по себе
не доказывает финал. Final-answer latch запрещает ordinary reminders; UNKNOWN остаётся
fail-closed. Готовый exact RESULT проверяется до любого продолжения и отменяет дальнейшие
control messages. Произвольный новый user turn не становится разрешённым anchor.

Detector ищет локальные видимые candidates, не глобальный body. Headline
«Соединение прервано» / «Connection interrupted» не требует фиксированного subtitle.
Whitespace/case/punctuation и раздельные headline/subtitle допускаются. Обёртка
`data-turn-key` не делает системный banner текстом transcript. Evidence включает
role alert/status, aria-live, system wrapper, nearby retry, insideMarkdown/turn wrapper.
Обычные literal quotes/code и user text отвергаются с reason. Strong evidence принимается
сразу; weak подтверждается следующим poll через 1–3 секунды.

Connection flow: `CONNECTION_INTERRUPTED → CONNECTION_RECOVERY → WORKING`.
Worker reload-ит ту же owned Page, доказывает exact conversation URL, исходный trusted
request anchor, lineage последнего разрешённого user turn и live empty composer, затем
выдерживает 10 секунд стабилизации. Максимум три reload-попытки в одном bounded cycle.
Нет нового REQ/chat, поиска похожей conversation или resend исходного prompt.
Неудача bounded proof завершает request диагностируемой ошибкой, а не бесконечным F5.

Additional Processing распознаётся по RU/EN вариантам «Наши системы… обрабатывают…»,
«дополнительная обработка», «Our systems… processing», «additional processing» и DOM evidence.
Flow: `ADDITIONAL_PROCESSING → SYSTEM_STOP → SYSTEM_RELOAD → SYSTEM_CHAT_REPROOF
→ SYSTEM_WAIT → SYSTEM_CONTINUE → WORKING`. Stop/Pause текущей генерации нажимается
один раз, если безопасный control есть. ABSENT и UNKNOWN Stop не terminal failure;
повторного Stop-click нет. Затем один reload exact chat и обязательный same-chat/original
lineage/composer re-proof, случайное равномерное ожидание 10–17 секунд и повторный proof.
Если результат уже готов или final latched, continuation не отправляется.

Одно непрерывное появление каждого banner — один event с request-bound identity.
Пока он присутствует, повторный recovery не запускается. Исчезновение при обычном
наблюдении rearm-ит detector; новое появление создаёт новый event. Сигналы внутри активного
flow диагностируются, но не запускают второй сценарий. Малого request-wide лимита
на реальные новые Additional Processing events нет. Каждый cycle bounded 180 секундами.

Обычные reminders и special system continuation выбирают случайно одну из 50 русских
фраз в `web/continuation_prompts.py`; повторы допустимы. Видимое сообщение — только
естественная просьба продолжить незавершённую исходную задачу с текущего места.
REQ/control identifiers и технические заголовки в эти сообщения не вставляются.
До composer/Send durable state сохраняет requestId, exact conversation, slot/eventId,
templateId, exactPromptText, SHA-256 и expected user-turn relation (ordinal + hashes
предшествующих видимых user turns). После Send доказываются exact текст, увеличение user
count ровно на один, та же conversation и прежняя lineage; закрепляются ordinal/groupKey.
Повторно выбранная фраза не может перепривязать более старый watch к последнему совпадению.
Artifact proof продолжения требует internal intent и original REQ lineage; RESULT envelope
и ZIP validation не изменены. Special continuation не расходует ordinary slot и не меняет часы.

Composer должен быть готов сразу. Safe-send окно максимум 5 секунд, poll 1 секунда,
click timeout максимум 1 секунда. Две инъецируемые паузы 1–5 секунд разделяют решение,
insert и final proof. Exact URL, текущий anchor, отсутствие постороннего user turn,
final latch, system interruption и exact unsent text перепроверяются непосредственно
перед единственным Send. После вставки подавленное сообщение очищается с proof.
UNKNOWN post-click запрещает resend; неподтверждённая cleanup остаётся fail-closed.

На 60 минутах обычный WORKING без результата завершается timeout. Только recovery,
начавшийся до soft deadline, может закончить один текущий cycle; hard limit — soft + 45 секунд
(и собственный предел cycle, если он раньше). Reload, proof, wait, Send и result observation
используют остаток этого лимита. После cycle за soft deadline новые flows/reminders не
начинаются: результат принимается в пределах grace, иначе timeout.

Durable/failure state содержит compact `transportEventJournal` (256 записей: начало и
последний хвост, sequence и dropped count), фазы, active event, судьбы слотов, detector
poll/candidate/confirmed counters, last text/evidence/reject reason, Stop outcome, reload
attempts и same-chat proof, фактический wait, exact selected prompt и Send proof.
Записи неизменны после добавления; snapshots не содержат гигантского DOM/body.

Завершённый assistant turn без ZIP перепроверяется через 10 секунд и возвращает
`ASSISTANT_COMPLETED_NO_ARTIFACT`; отвергнутый minimal validator ZIP немедленно даёт
`ARTIFACT_REJECTED`. Неопределённые transport/validator infrastructure outcomes остаются
failure. Postman не применяет artifact к repository автоматически.


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
Harness Workspace автоматически. Отдельное представление результата или применение пакета требует своего explicit workflow вне normal transport.

## 18. Что normal Postman не делает

Normal `@Postman` не:

- распаковывает ZIP;
- анализирует semantic correctness;
- применяет patch/files к repository;
- применяет artifact автоматически;
- создаёт implementation worktree/branch/commit/PR;
- выбирает дальнейшее действие на основе содержимого ZIP;
- выполняет manual browser automation как fallback.

## 19. `dsh-postman-harness`

Plugin предоставляет trusted current-turn boundary и supervisor capabilities для Bridge/Worker.
Старые persistent async service и send/runtime tools удалены; они не являются транспортом или fallback.

После `RESULT_DURABLE` normal `@Postman` не создаёт Result Workspace автоматически.

## 20. Production state

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

## 21. Acceptance status

Историческое свидетельство: 2026-09-19 выполнен fresh + continuation E2E после production orchestration fixes. Тогда Workspace регистрировался отдельно; текущий normal flow останавливается после terminal handoff.

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

## 22. Короткая формула

```text
exact current intent
→ one new REQ
→ self-contained task
→ two-line browser prompt
→ exact ChatGPT conversation
→ checkpoints на 10/20/30/40/50 минуте; WORKING разрешает reminder даже при Pause/Stop
→ exact next assistant turn текущего разрешённого anchor
→ exact ZIP control
→ one download
→ safety/correlation validation
→ RESULT_DURABLE
→ сообщить exact requestId/resultZip
→ STOP
```
