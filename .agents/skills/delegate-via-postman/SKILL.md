---
name: delegate-via-postman
description: >-
  Использовать только когда ТЕКУЩЕЕ пользовательское сообщение после необязательных
  начальных пробелов начинается с точного литерала @Postman. Выполнить задачу через
  Direct Web Postman: сохранить пользовательский intent без технических дополнений,
  создать canonical REQ и вызвать workspace-relative `postman\direct\postman.ps1`.
  Терминалом одного REQ может быть validated RESULT_DURABLE, завершённый текст без ZIP
  или отклонённый ZIP; два последних результата возвращаются Л1 вместе с assistantText/причиной.
  Не создавать Result Workspace автоматически. Не использовать ручную
  автоматизацию браузера как fallback.
---

# Delegate via Postman — Direct Production

`DIRECT_POSTMAN_SKILL_VERSION: 23`

`TRUSTED_CURRENT_TURN_BOUNDARY_VERSION: 1`

## Trusted current-turn operation

Normal `@Postman` не формирует payload в LLM-коде. После загрузки skill Л1 вызывает без текстовых аргументов:

```text
postman_send_current_turn()
postman_current_turn_status()
postman_continue_last_request()   # только разрешённая automatic continuation
```

Trusted plugin получает exact current `user/message` из Harness, механически разбирает marker/`--chat`, создаёт canonical REQ и вызывает существующий `<current workspace>\postman\direct\postman.ps1`. Нельзя копировать current user message в JavaScript, PowerShell, Base64 или tool argument. Если `postman_send_current_turn`/`postman_current_turn_status` недоступны — `STOP`; model-copy fallback запрещён. Не запускать shell, Chrome, browser, ZIP download или Git integration вручную вместо них. Transport lifecycle (напоминания, correlation, validator и закрытие owned Page) — в `postman/POSTMAN_CURRENT_FLOW.md`.

## 1. Жёстко запрещённые обходы

Для обычного Postman request НЕ использовать:

```text
dsh-postman-harness как production transport
frontend-design до получения результата Ч1
другие implementation/design skills до получения результата Ч1
Playwright MCP
Computer Use
ORCA / навыки ORCA IDE
ручное открытие ChatGPT
ручное нажатие Send
ручной запуск Chrome
ручное скачивание ZIP из ChatGPT
BrowserSmoke как обычный preflight
```

Не читать `postman/direct/README.md`, исходники bridge или browser-код только для того,
чтобы понять обычный способ запуска. Вся production-команда уже определена этим skill.

## 2. Trigger

### Exclusive current-message trigger

Postman по умолчанию OFF. Единственный разрешающий trigger — ТЕКУЩЕЕ
пользовательское сообщение, которое после возможных начальных пробелов начинается с
точного литерала `@Postman`. Формально принимается только начало:

```text
^\s*@Postman(?:\s|$)
```

Это означает:

```text
@Postman <intent>       → trigger
   @Postman <intent>     → trigger
```

Continuation того же ChatGPT conversation использует transport control сразу после marker:

```text
@Postman --chat REQ_20260917T101323Z_7008 <intent>
```

Старый REQ здесь не является новым request id и не передаётся Ч1 как часть intent.
Каждая continuation-операция создаёт новый canonical REQ.

Любая другая формулировка — НЕ trigger и не разрешает загрузку skill или запуск
Postman. В частности, НЕ trigger:

```text
Postman сделай X
Postman, сделай X
Через Postman сделай X
Используй Postman
продолжи проект Postman
реализуй WP-020
исправь код Postman
доработай Direct Postman
```

Само обсуждение Postman transport также не является trigger:

```text
Как работает Postman?
Почему Postman использует Chrome?
Надо ли нам менять Postman?
```

### Обязательная загрузка skill до task-specific действий

Только после exact trigger из текущего сообщения первым task-specific действием должен
быть вызов:

```text
skill(delegate-via-postman)
```

До загрузки этого skill Luna не должна выполнять task-specific действия, которые
интерпретируют, расширяют или выполняют пользовательский запрос:

```text
glob/read по task-файлам
локальное исследование для уточнения intent
edit
write
выбор архитектуры/технологии
task-specific shell-команды
frontend/design skills
```

Если `@Postman` отсутствует в текущем сообщении, этот skill не должен загружаться по
инициативе Luna только потому, что задача связана с Postman, сложна или касается
разработки самого Postman. В этом случае `delegate-via-postman` не активируется, а
задача выполняется локально Luna.

Разрешение Postman действует только для текущего пользовательского сообщения и не
наследуется из предыдущих сообщений: `Postman permission is current-message-only`.

Нельзя начинать самостоятельную реализацию после exact trigger до загрузки
`delegate-via-postman`. Если skill отсутствует, не загружается, недействителен или
недоступен, действует fail-closed правило: `STOP`.

При таком отказе запрещены самостоятельная реализация и любой fallback:

```text
manual browser
Playwright
обычная самостоятельная реализация Luna
```

## 3. Разделение ролей

### Ч1 — external task executor

Ч1 самостоятельно выполняет exact payload пользователя и формирует результат/ZIP.
Если задача требует исследования, текста, кода, файлов, архитектуры, тестов или
документации — эти содержательные решения принадлежат Ч1, а не Л1.

### Л1 — local transport agent

В normal `@Postman` flow Л1 загружает skill, вызывает trusted no-argument tools, принимает terminal текущего REQ и сообщает результат либо решает о разрешённом automatic continuation. Разбор intent, создание REQ и запуск Direct wrapper принадлежат trusted runtime, а не Л1.

Л1 не анализирует содержимое durable ZIP, не применяет и не изменяет ZIP, не выбирает
semantic test и не начинает Git/PR integration. Для двух non-durable terminal outcomes
Л1 может прочитать только terminal assistantText и exact validation reason, чтобы решить:
нужен ли короткий continuation того же conversation или требуется пользователь. Новые
содержательные требования от себя добавлять нельзя.

## 4. Intent и запуск trusted transport

Л1 не превращает пользовательский запрос в техническое ТЗ, не разрешает ссылки на предыдущий контекст и не копирует payload в код. Trusted runtime удаляет только exact transport marker `@Postman` и непосредственно следующий separator; при ручном `--chat <old REQ>` удаляет transport metadata, оставляя новый intent verbatim. Ч1 получает этот intent без дополнений. До отправки не исследовать предмет задачи, не выбирать технологию и не выполнять задачу самостоятельно.

Единственный normal entrypoint — no-argument `postman_send_current_turn()`. Trusted plugin создаёт один canonical `REQ_YYYYMMDDTHHMMSSZ_NNNN`, вызывает workspace-relative `postman/direct/postman.ps1` и возвращает связанный результат; ожидание — только `postman_current_turn_status()`. Не создавать REQ, `jobId`, `TaskBase64` и `tools.pwsh` invocation в модели. Shell failure до старта — `POSTMAN_INVOCATION_NOT_STARTED`: Send не происходил, не читать старые/latest REQ и не делать retry. Running/unknown outcome не разрешает новую отправку; не использовать browser fallback.

Для ручного пользовательского `@Postman --chat <old REQ> <new intent>` старый REQ служит только exact conversation reference; новый REQ начинает root chain с `continuationIndex=0`. Automatic continuation допускается только после `ASSISTANT_COMPLETED_NO_ARTIFACT` или `ARTIFACT_REJECTED`, когда terminal text однозначно допускает продолжение без выбора пользователя. Л1 вызывает `postman_continue_last_request()` без аргументов: trusted runtime наследует `rootRequestId`, увеличивает `continuationIndex` и ограничивает chain двумя automatic continuation (индексы 1 и 2). Не повторять Send прежнего REQ. `POSTMAN_TRANSPORT_FAILED` и другие outcomes не являются поводом для automatic continuation. Детали состояния и exact conversation proof — `postman/POSTMAN_CURRENT_FLOW.md`.

Внешний browser prompt формирует Direct Postman, не Л1:

Одна из 50 естественных русских стартовых фраз из отдельного launch pool, затем
exact SHA-pinned task URL. Полный prompt и SHA сохраняются во внутреннем state;
REQ остаётся в task URL/file. Видимые `POSTMAN_REQUEST_ID:`, `task_file:` и
`POSTMAN_TRANSPORT_CONTROL` в новых launch prompts отсутствуют. Legacy fallback
для старых requests не используется для новых natural prompts.

## 5. Terminal gate и handoff

Принимать только trusted terminal текущего REQ. `RESULT_DURABLE` требует exact `requestId` и `resultZip`; Direct уже проверил correlation, SHA-256, ZIP safety и сохранил durable result. Не распаковывать ZIP, не повторять validator/manifest checks и не открывать ChatGPT для подтверждения. Сообщить exact `requestId` и кликабельный `resultZip`, затем `STOP`. Не вызывать `postman_result_workspace_register` и не создавать Result Workspace автоматически. Исторический PUBLISHED Result Workspace остаётся отдельным explicit workflow.

`ASSISTANT_COMPLETED_NO_ARTIFACT` и `ARTIFACT_REJECTED` — terminal handoff без durable ZIP, а не transport failure. Для них читать только `assistantText` и, у rejection, exact `validationCode`/`validationMessage`. Если Ч1 требует данные/выбор либо сообщает настоящий blocker — вернуть terminal пользователю. Только при однозначном промежуточном progress вызвать `postman_continue_last_request()` (не более двух раз на root chain): коротко попросить продолжить прежнюю задачу/выдать ZIP, при rejection передать только exact validation reason; не цитировать старый ответ целиком. Если лимит исчерпан, вернуть terminal, не отправлять третий запрос.

`POSTMAN_TRANSPORT_FAILED` сохраняет exact `requestId`, `transportCode`, `transportMessage`, `details` и non-zero exit; это не successful terminal и не повод продолжать автоматически. Некоррелированный, некорректный или неизвестный результат — fail-closed, без подмены старым REQ. Normal transport не оценивает содержимое package и не применяет artifact; implementation требует отдельного разрешения и workflow.

## 6. Failure и запреты normal flow

`DIRECT_CHAT_REFERENCE_UNAVAILABLE` означает отсутствие доказанного exact conversation URL: `STOP` до Send, без Search UI и silent fresh-chat fallback. При `POSTMAN_INVOCATION_NOT_STARTED` процесс не стартовал и Send не происходил; не читать старые/latest REQ states, не выполнять recovery и retry. После возможного Send неизвестный исход, interrupt или failure не разрешают blind resend. `POSTMAN_TRANSPORT_FAILED` возвращать с exact причиной, без automatic continuation; новый запрос после настоящего transport failure требует нового user message с exact `@Postman` trigger.

Не запускать BrowserSmoke как normal preflight (он допустим только при явной диагностике), не открывать/управлять ChatGPT вручную, не запускать Chrome или альтернативный transport, не выполнять содержательную задачу вместо Ч1. Normal flow не создаёт implementation branch/worktree/commit/PR, не очищает пользовательский dirty worktree и не применяет ZIP. После `RESULT_DURABLE` — exact `requestId`/`resultZip` и `STOP`; при failure — exact REQ/code/reason и последняя доказанная фаза без предположений. Детали механического Direct lifecycle — `postman/POSTMAN_CURRENT_FLOW.md`.

