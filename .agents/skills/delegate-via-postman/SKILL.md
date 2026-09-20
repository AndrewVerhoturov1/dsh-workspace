---
name: delegate-via-postman
description: >-
  Использовать только когда ТЕКУЩЕЕ пользовательское сообщение после необязательных
  начальных пробелов начинается с точного литерала @Postman. Выполнить задачу через
  Direct Web Postman: сохранить пользовательский intent без технических дополнений,
  создать ровно один canonical REQ, один раз вызвать
  workspace-relative `postman\direct\postman.ps1`, дождаться validated RESULT_DURABLE,
  сохранить validated RESULT_DURABLE, сообщить exact resultZip и остановиться. Регистрация
  Result Workspace — необязательная presentation convenience, а не integrity gate. Не использовать Cordis/postman_async_send, QChat или
  ручную автоматизацию браузера как fallback.
---

# Delegate via Postman — Direct Production

`DIRECT_POSTMAN_SKILL_VERSION: 18`

Исторический baseline до v12: `DIRECT_POSTMAN_SKILL_VERSION: 11`.

## 0. Золотой путь

После активации этого skill нормальный production-flow всегда такой:

```text
точный user intent
→ удалить только transport prefix @Postman
→ один canonical REQ
→ один background tools.pwsh job с единственным Direct Postman invocation
→ сохранить exact jobId
→ ждать только этот job через job_output
→ exact terminal JSON
→ RESULT_DURABLE
→ один раз попытаться зарегистрировать exact resultHandoffPath через
  postman_result_workspace_register(request_id=<exact REQ>, result_handoff_json=...)
→ сообщить REQ, resultZip и Workspace (или diagnostic регистрации)
→ STOP
```

После `RESULT_DURABLE` normal flow не вызывает resume/PREPARE/TEST/PUBLISH, не
создаёт implementation worktree/branch/commit/PR и не распаковывает ZIP. Регистрация
Workspace — только удобство показа, а не integrity gate.

После подтверждённой первоначальной отправки Direct Postman сам выполняет до трёх
служебных напоминаний в том же ChatGPT conversation и в рамках того же REQ:

```text
10 минут → напоминание №1
20 минут → напоминание №2
30 минут → напоминание №3
45 минут → если validated ZIP не получен, transport завершается с ошибкой
```

Расписание фиксированное и не зависит от того, пишет модель, молчит или вернула
промежуточный/ошибочный ответ. Если exact ZIP уже скачан и validated раньше,
оставшиеся напоминания отменяются. Если ZIP скачан, но не прошёл проверку содержимого,
REQ не завершается: `.staging/<REQ>` удаляется, и следующая попытка выполняется после
ближайшего планового напоминания. Ошибки внутреннего валидатора, записи, доверенной
аттестации, скачивания и неопределённые состояния завершают REQ немедленно.
Напоминание является transport control, не создаёт новый REQ и не меняет исходный user
intent. Для результата отправки `PROVEN_SENT` продолжает цикл, `PROVEN_NOT_SENT`
допускается только после безопасной очистки поля ввода, а `UNKNOWN` немедленно
останавливает REQ без напоминаний №2 и №3.

После terminal result Direct Postman закрывает принадлежащую ему рабочую вкладку ChatGPT.
Dedicated Chrome и внешний browser context не закрываются.

Не проектируй другой transport flow.

После загрузки этого skill не вызывай `delegate-via-postman` повторно в этой же операции.

## 1. Жёстко запрещённые обходы

Для обычного Postman request НЕ использовать:

```text
postman_async_send
postman_send
postman_runtime_*
dsh-postman-harness как production transport
persistent POSTMAN agent
QChat
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
postman_async_send
old Harness
QChat
manual browser
Playwright
обычная самостоятельная реализация Luna
```

`QChat` — отдельный transport и не является fallback.

## 3. Разделение ролей

### Ч1 — external task executor

Ч1 самостоятельно выполняет exact payload пользователя и формирует результат/ZIP.
Если задача требует исследования, текста, кода, файлов, архитектуры, тестов или
документации — эти содержательные решения принадлежат Ч1, а не Л1.

### Л1 — local transport agent

В normal `@Postman` flow Л1 отвечает только за:

```text
verbatim payload после удаления transport marker
canonical REQ
один Direct Postman invocation
minimal terminal transport gate
optional Result Workspace registration
короткий отчёт с exact resultZip/Workspace
STOP
```

Л1 не интерпретирует содержимое ответа Ч1, не применяет и не изменяет ZIP, не выбирает
semantic test и не начинает Git/PR integration. Содержательная работа с durable
результатом возможна только позже по отдельному explicit manual-finalization запросу.

## 4. Intent preservation

Главный инвариант:

> Не превращай пользовательский запрос в собственное техническое ТЗ.

Например:

```text
@Postman сделай простой калькулятор в древне-японском стиле.
```

Для вызова `@Postman сделай калькулятор` payload для Ч1 должен быть:

```text
сделай калькулятор
```

Для continuation-команды:

```text
@Postman --chat REQ_20260917T101323Z_7008 сравни это с новой версией
```

transport fields:

```text
chatRequestId = REQ_20260917T101323Z_7008
payload = сравни это с новой версией
```

Удаляются только `@Postman --chat <canonical REQ>` и непосредственно следующий
разделяющий whitespace. Остальной payload передаётся verbatim.

Удалить можно только точный transport marker `@Postman` и непосредственно следующий
за ним разделяющий whitespace. Все остальные символы текущего пользовательского
сообщения передавать в `-Task` verbatim: без перефразирования, исправления,
сокращения, дополнения или перестановки.

Не добавлять от себя:

```text
React
Vue
Svelte
адаптивность
accessibility
список кнопок
обработку деления на ноль
цветовую палитру
структуру каталогов
test framework
архитектурный паттерн
язык реализации
факты из предыдущих сообщений
расшифровку ссылок вроде "это", "как раньше", "те размеры"
```

Если exact `@Postman` payload ссылается на предыдущий контекст, Л1 НЕ разрешает эту
ссылку самостоятельно и НЕ добавляет предыдущий контекст. Ч1 получает ровно тот
payload, который написал оркестратор после transport marker. Оркестратор отвечает
за self-contained prompt.

## 5. Не интерпретировать задачу до Ч1

После exact `@Postman` trigger нельзя сначала:

```text
исследовать framework или предмет задачи
выбирать architecture/technology
загружать frontend-design
писать собственный код
создавать структуру проекта
разрешать ссылки на предыдущий контекст
уточнять или "улучшать" payload от имени пользователя
```

Сначала один Direct Postman с verbatim payload. До отправки разрешены только
transport-действия из этого skill: загрузка skill, проверка bridge и создание
canonical REQ.

## 6. Canonical production bridge

Единственный production entrypoint:

```text
<current workspace>\postman\direct\postman.ps1
```

Перед вызовом разрешена только простая проверка существования:

```powershell
$workspace = (Get-Location).Path
$bridge = Join-Path $workspace 'postman\direct\postman.ps1'
if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) {
    throw 'POSTMAN_DIRECT_BRIDGE_MISSING'
}
```

Если bridge отсутствует — STOP.

Production wrapper по умолчанию сохраняет durable artifacts в:

```text
D:\Downloads_dsh_auto
```

`postman.ps1` поддерживает override через `DSH_POSTMAN_RESULT_ROOT` / `-ResultRoot`.
Direct state, worker state и browser profile остаются в `%LOCALAPPDATA%\DSH\Postman`.

Luna-side normal invocation НЕ выполняет: `New-Item` для result root, `Set-Content`,
`Out-File`, redirection/write probe, `Remove-Item` probe или любые другие файловые
write-preflight операции. Result-root creation и write-probe полностью принадлежат
Direct Postman внутри bridge. Если internal result-root probe не проходит, Direct Postman
сам возвращает `DIRECT_RESULT_ROOT_UNAVAILABLE` до GitHub publication и browser Send.
До GitHub task publication и до browser Send Direct Postman обязан создать result root
и выполнить write-probe; Luna не дублирует эту проверку.

Если вызывающий shell уже PowerShell, вызывать `postman.ps1` напрямую через `&`.
Дополнительный nested `pwsh.exe` не является normal production path.

Не искать альтернативный transport.
Не переходить на Cordis.
Не переходить на QChat.
Не автоматизировать браузер вручную.

## 7. Создание REQ

Перед bridge invocation создать canonical:

```text
REQ_YYYYMMDDTHHMMSSZ_NNNN
```

REQ создаётся внутри первого короткого `run_code` до background-start, чтобы exact
`requestId` был известен отдельно от `jobId`. Использовать реальное текущее UTC-время:

```typescript
const stamp = new Date().toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}Z$/, 'Z');
const suffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
const requestId = `REQ_${stamp}_${suffix}`;
```

После создания REQ normal orchestration сразу запускает один background job.
После background-start exact REQ immutable. При collision/failure не создавать новый
REQ автоматически и не повторять Send.

Новый REQ для этой логической операции автоматически создавать нельзя.

## 8. Единственный production-вызов

Использовать payload из раздела Intent preservation.

В текущем deployment `functions.run_code` имеет hard wall limit 600000 ms, а Direct
Postman может законно работать до 45 минут. Поэтому normal production path всегда
запускает ровно один `tools.pwsh` job с `run_in_background: true`, сохраняет exact
`requestId` и exact `jobId`, а затем ждёт только этот job через `job_output`.

Никакого result-root preflight и отдельного browser preflight не добавлять.

Raw user payload не вставлять в PowerShell command. Перед запуском exact payload
кодируется в UTF-8 Base64. `postman.ps1` принимает `-TaskBase64`, поэтому в shell
команду попадает только безопасная base64-строка.

Fresh-chat production start:

```typescript
const payload = "EXACT_PAYLOAD_AS_JSON_STRING_LITERAL";
const { Buffer } = await import('node:buffer');

const stamp = new Date().toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}Z$/, 'Z');
const suffix = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
const requestId = `REQ_${stamp}_${suffix}`;
const taskBase64 = Buffer.from(payload, 'utf8').toString('base64');

const command = [
  "& (Join-Path (Get-Location).Path 'postman/direct/postman.ps1')",
  `-RequestId '${requestId}'`,
  `-TaskBase64 '${taskBase64}'`,
].join(' ');

const started = await tools.pwsh({
  command,
  description: 'Запустить Direct Postman в фоне',
  run_in_background: true,
});

return { requestId, jobId: started.jobId };
```

Для continuation того же conversation добавить только exact transport reference:

```typescript
const chatRequestId = "REQ_...";
const command = [
  "& (Join-Path (Get-Location).Path 'postman/direct/postman.ps1')",
  `-RequestId '${requestId}'`,
  `-ChatRequestId '${chatRequestId}'`,
  `-TaskBase64 '${taskBase64}'`,
].join(' ');
```

`requestId` — новый REQ этой операции. `chatRequestId` — старый REQ, по которому
Direct Postman находит сохранённый `conversationUrl`.

Первый `run_code` только запускает background job и возвращает
`{requestId, jobId}`. Не ждать Postman в этой же ячейке.

Дальше использовать отдельные короткоживущие `run_code` вызовы. Каждый ждёт exact job
не более 480000 ms — с запасом относительно 600000 ms wall limit:

```typescript
const update = await tools.job_output({
  job_id: "EXACT_JOB_ID",
  wait: true,
  timeout_ms: 480000,
});
return update;
```

Если `update.job.status == "running"`, выполнить новый отдельный `run_code` с тем же
`jobId`. Не использовать `sleep`, busy polling или цикл ожидания внутри одной ячейки.
Timed-out `job_output` оставляет background job живым.

Normal path не использует `job_list`: exact `jobId` уже известен. Не запускать
параллельно второй Postman request, не создавать второй REQ и не повторять Send.

Terminal background job принимается только если:

```text
job.status == completed
job.detail == exit code: 0
```

После этого terminal JSON берётся из stdout exact job и проходит обычный
`RESULT_DURABLE` gate ниже. `killed`, `failed` или non-zero exit — terminal failure
без retry/fallback.

### Контракт orchestration-вызова `tools.pwsh`

Для normal `@Postman` invocation вызывать `tools.pwsh` без поля `workdir`: используется
текущий workspace процесса. Не передавать hardcoded Windows-путь в `workdir`.

Background `pwsh` по контракту DSH не использует foreground `timeoutMs`; не передавать
`timeoutMs: 3000000`. Долгое время принадлежит background job, а ожидание разбивается
на отдельные `job_output` waits по 480000 ms.

### Внутренний link-only transport contract

Luna передаёт bridge только exact user payload. Normal orchestration использует `-TaskBase64`; ручной PowerShell-вызов может по-прежнему использовать `-Task`. Сам внешний prompt
формирует Direct Postman; Luna не собирает его вручную.

Канонический prompt Ч1 состоит ровно из двух строк:

```text
POSTMAN_REQUEST_ID: REQ_xxx
task_file: <SHA-pinned task link>
```

Внешний policy-link больше не является частью production prompt: exact published
`task_file` self-contained и содержит user intent, transport identity, universal ZIP
contract и legacy code-result contract. В prompt не должны находиться `repository`,
`base_commit`, `expected_filename`, `allowed_paths_json`, `forbidden_paths_json`, user
intent, result markers или implementation instructions.

`baseCommit` является transport correlation snapshot. Только для repository-changing
result он одновременно является implementation base; universal `artifact` не означает
repository mutation. SHA публикации task-файла хранится отдельно как
`taskPublicationCommit`. Luna не подменяет один SHA другим и не реконструирует task
manifest вручную.

## 9. Разбор JSON и минимальный transport gate

После `completed` exact background job с `exit code: 0` распарсить terminal JSON из stdout этого job:

```powershell
try {
    $result = $jsonText | ConvertFrom-Json
}
catch {
    throw 'POSTMAN_RESULT_JSON_INVALID'
}
```

После завершения Direct Postman Luna проверяет только transport boundary:

```text
$result.ok        == true
$result.code      == RESULT_DURABLE
$result.state     == RESULT_DURABLE
$result.requestId == exact $requestId
```

Не выполнять вручную `Get-FileHash`, повторный manifest/base/staleness/path validation
или отдельный `Test-Path` как normal handoff. Direct Postman уже проверяет normal
transport boundary: exact correlated filename, SHA-256, безопасную ZIP-структуру/paths
и archive limits. Manifest/repository/baseCommit/resultType/patch semantics относятся
к downstream/manual application, а не к normal `@Postman` transport gate.

После `RESULT_DURABLE` не открывать ChatGPT для визуального подтверждения.

### Канонический durable handoff, Workspace registration и STOP

После успешного `RESULT_DURABLE` Direct Postman атомарно сохраняет канонический
terminal JSON в deterministic path:

```text
C:\Users\andre\AppData\Local\DSH\Postman\direct\results\<REQ>.json
```

Этот файл — durable источник истины для сообщения пользователю. До этого состояния
сохраняется строгий fail-closed transport gate: `ok=true`, exact `code/state`,
correlation REQ и вся проверка ZIP принадлежат Direct Postman. Не реконструировать
receipt, не распаковывать и не анализировать ZIP повторно.

После exact `RESULT_DURABLE` разрешена одна presentation-попытка:

```text
postman_result_workspace_register(request_id=<exact REQ>, result_handoff_json=<exact resultHandoffPath>)
```

При успехе сообщить `requestId`, exact `resultZip` и `workspaceId`. Если регистрация
не удалась, transport всё равно успешен: сообщить diagnostic, не создавать второй REQ,
не повторять ChatGPT/download и не запускать resume. Затем normal flow останавливается.

`resume_request.ps1`, `integrate_result.ps1` и стадии PREPARE/TEST/PUBLISH не удаляются.
Они описаны ниже только как legacy/manual explicit finalization для уже существующего
durable результата; они не являются частью normal `@Postman` flow.

## 10. Что Direct Postman уже доказал

При `RESULT_DURABLE` не повторять вручную весь browser/artifact validator.

Direct pipeline уже доказал:

```text
корреляцию REQ
assistant turn
exact expected filename
download
SHA-256
безопасную ZIP-структуру и paths
archive limits / ZIP-bomb protection
отсутствие explicit conflicting string requestId в optional manifest
durable storage
```

Л1 делает только короткий local handoff gate из предыдущего раздела, при необходимости
пытается зарегистрировать exact durable result как Workspace и останавливается.

## 11. Failure handling

Для continuation отдельный terminal transport failure:

```text
DIRECT_CHAT_REFERENCE_UNAVAILABLE
```

означает, что для старого REQ нет сохранённого `/c/...` URL. В этом milestone не
использовать Search UI/лупу, не угадывать чат и не отправлять prompt в другой conversation.

Если `tools.pwsh` не породил процесс из-за tool-level shell failure, например `spawn EPERM`,
считать это `POSTMAN_INVOCATION_NOT_STARTED` и немедленно `STOP`. Direct Postman не стартовал
и Send не происходил. После такого failure запрещено читать старые `REQ_*.json`, выбирать
latest request, читать старый handoff как текущий, вызывать `job_list`, делать retry/fallback,
создавать второй REQ или автоматически повторять invocation. Сообщить только, что Direct
Postman не стартовал и Send не происходил. Это правило имеет приоритет над общей
диагностикой exact direct state ниже; после tool-level failure никакие request states не читаются.

После получения exact `jobId` этот job является единственным process authority текущего
REQ. `job_output` со статусом `running` не является failure и не разрешает новый запуск.
Если отдельная wait-ячейка `run_code` завершилась ошибкой, но exact `jobId` известен,
разрешено снова читать только этот же job через `job_output`; новый Postman/REQ запрещён.

Если background job имеет `failed`, `killed` или non-zero exit, либо bridge вернул
`ok=false`/invalid JSON — STOP.

Сохранить исходный exact REQ и exact jobId.

Не создавать автоматически второй REQ.
Не повторять Send.
Не открывать ChatGPT вручную.
Не брать визуально существующий ZIP.
Не использовать старый Harness.
Не использовать QChat.
Не пытаться доделать implementation самому.

Разрешено один раз прочитать exact direct state/worker state этого REQ для
диагностики, если стандартный state path известен.

После этого вернуть пользователю:

```text
requestId
code
state
error/reason
последнюю доказанную transport-фазу
```

Новая отправка возможна только после нового пользовательского сообщения с exact `@Postman` trigger.

## 12. BrowserSmoke

`BrowserSmoke` является диагностической операцией.

Не запускать его перед каждым нормальным Postman request.

Использовать только если пользователь прямо просит smoke/диагностику либо
исследуется неисправность browser bootstrap/CDP до новой разрешённой отправки.

```powershell
$workspace = (Get-Location).Path
$bridge = Join-Path $workspace 'postman\direct\postman.ps1'
& $bridge `
  -BrowserSmoke
```

Успех:

```text
ok = true
code = BROWSER_SMOKE_READY
promptSent = false
```

Smoke не является частью обычного golden path.

## 13. Не начинать Git integration в normal flow

Direct Postman сам публикует transport task в `main`.

Л1 не должна до или после получения Ч1 создавать implementation branch/worktree,
модифицировать repository или писать implementation в normal `@Postman` flow.

После validated `RESULT_DURABLE` normal flow заканчивается optional Workspace
registration и отчётом пользователю. Git integration возможна только позже по
отдельному explicit manual-finalization запросу.

Исключение: отдельная задача разработки/ремонта самого Postman transport.

## 14. Legacy/manual explicit finalization

Этот раздел не выполняется в normal `@Postman` flow. Для уже существующего durable
результата и отдельного явного запроса пользователя допускается только один entrypoint:

```text
C:\Users\andre\.dsh\postman\direct\resume_request.ps1
```

State machine:

```text
RESULT_DURABLE
→ READY_FOR_TEST
→ TEST_PASSED
→ PUBLISHED
```

`resume_request.py` программно передаёт exact `readyJson → testJson → publishedJson`,
проверяет request/repository/branch/worktree identity и не пересчитывает пути по
догадке. Existing valid receipts делают resume идемпотентным.

### Task test input

При explicit manual finalization test input — argv-safe файл вне implementation worktree:

```text
%LOCALAPPDATA%\DSH\Postman\handoff\<REQ>\task_test.py
```

или `test-spec.json` в том же handoff-каталоге.

Для одной semantic assertion создать UTF-8 `task_test.py` штатным Harness file
write/edit tool. Не строить содержимое теста как shell-строку. Затем:

```powershell
$resumeText = & 'C:\Users\andre\.dsh\postman\direct\resume_request.ps1' `
  -RequestId $requestId `
  -RepoRoot 'C:\Users\andre\.dsh' `
  -TestScript $testScript
$resume = $resumeText | ConvertFrom-Json
```

Для существующей repository/project test-команды разрешён argv-only `TestSpec`,
например:

```json
{
  "command": ["python", "-m", "pytest", "-q", "tests/task_test.py"]
}
```

или spec со script:

```json
{
  "script": "task_test.py",
  "args": []
}
```

После этого использовать `-TestSpec <exact path>`.

`-TestCommand` остаётся legacy compatibility mode runtime, но НЕ является normal
production path Luna. В normal flow запрещены `python -c`, PowerShell command-string
reconstruction и многострочные shell-quoting трюки.

Если при explicit manual finalization тест нельзя выбрать до PREPARE, сначала вызвать
`resume_request.ps1` без test input. Exact `READY_FOR_TEST` receipt даст authoritative `worktree` и `changedFiles`.
Разрешено минимально изучить эти файлы для выбора semantic test, создать TestScript/
TestSpec вне worktree и повторно вызвать `resume_request.ps1` для того же REQ.

Внутри resume PREPARE по-прежнему владеет policy/Git/worktree и canonical applicator,
TEST — semantic receipt/fingerprint, PUBLISH — stage/commit/push/remote-SHA/PR.
`C:\Users\andre\.dsh\postman\direct\integrate_result.ps1` остаётся canonical
applicator maintenance entrypoint, но Luna не вызывает его напрямую в normal flow.

Прямые `prepare_result.ps1`, `test_result.ps1`, `publish_result.ps1` остаются
низкоуровневыми implementation/diagnostic boundary и targeted-test surface. В обычной
пользовательской `@Postman` операции Luna их отдельно НЕ вызывает.

Успех manual finalization: exact `PUBLISHED`, `semanticTest=TEST_PASSED`, один OPEN PR
в `main`, `mergePerformed=false`. Любой `ok=false`/invalid receipt — STOP без ручного
fallback, нового REQ или повторного transport.

## 15. Что normal `@Postman` НЕ делает после RESULT_DURABLE

Normal flow не запускает следующие действия ни отдельными tool calls, ни через resume:

```text
prepare_result.ps1
test_result.ps1
publish_result.ps1
git status / branch / ls-remote / worktree preflight
gh pr list
git fetch
git worktree add
integrate_result.ps1 напрямую
Get-FileHash результата
повторный manifest/base/staleness check
git add
git commit
git push
remote SHA verification
gh pr create
повторное чтение только что созданного PR
```

Эти действия остаются доступными только как explicit manual finalization для уже
существующего durable результата; они не принадлежат normal `@Postman` flow.

Запрещены по-прежнему `git reset --hard`, `git clean`, automatic stash, force push и
ручная перепись artifact через LLM tools.

## 16. Legacy/manual finalization failure handling

В explicit manual finalization `resume_request.ps1` и его внутренние PREPARE/TEST/PUBLISH стадии являются
fail-closed. Не заменять failure собственными shell-командами и не обходить resume
низкоуровневыми boundary wrappers.

Не создавать второй branch и новый Postman REQ из-за local-finalization failure.
Existing RESULT_DURABLE и valid receipts сохраняются; последующий retry должен быть
тем же `resume_request.ps1 -RequestId <exact REQ>`.

Dirty failure worktree сохраняется для диагностики. TEST receipt связан SHA-256 с
exact READY JSON, TestScript SHA-256 и fingerprint implementation bytes. PUBLISH не
merge-ит PR и не удаляет remote branch.

## 17. Legacy/manual task-specific test selection

Только при explicit manual finalization после RESULT_DURABLE/READY_FOR_TEST можно выбрать
одну проверку, которая лучше всего доказывает пользовательский intent. Приоритет:
тесты Ч1, repository-defined test, существующая project command, одна минимальная
semantic assertion.

TestScript/TestSpec должен проверять именно объективные требования пользователя, не
их ослабленную замену. Если пользователь потребовал «чёрную кнопку», недостаточно
проверить лишь наличие `background`; semantic test должен доказать чёрный цвет. Если
есть требования к количеству элементов, тексту, конкретному файлу, hover/active,
сохранности остального и т.п., проверять соответствующие объективные свойства.

Для субъективных UI-требований (`стильно`, `красиво`, `современно`) semantic test
проверяет только объективно формализуемую часть. Визуальная presentation и user
acceptance остаются отдельными состояниями и не подменяются `TEST_PASSED`.

Для UI допускается один цельный UTF-8 E2E/script вне implementation worktree.
BrowserSmoke не является task test. Normal test path не использует `python -c` или
`-TestCommand`; использовать `-TestScript`/`-TestSpec` через resume.

## 18. Git publication boundary for manual finalization

При explicit manual finalization Git publication успешна только при exact `PUBLISHED`, который доказывает commit,
remote exact SHA, один OPEN PR `base=main` с exact head branch/SHA, удалённый task worktree
и отсутствие автоматического merge.

## 19. Финальный отчёт

При normal transport сообщить только пользовательский минимум:

```text
RESULT_DURABLE
exact requestId
exact resultZip как кликабельный local path
Workspace title/id, если регистрация успешна
одну короткую diagnostic строку, если регистрация не удалась
```

`resultHandoffPath`, SHA-256, browser/CDP/validator internals, semantic test, commit,
remote synchronization, PR и merge не показывать без диагностической необходимости.
Они относятся к transport internals или explicit manual finalization.

### Кликабельные изменённые файлы только при explicit manual PUBLISHED finalization

Authoritative список брать только из exact `PUBLISHED` receipt `changedFiles`.
Для каждого файла построить exact существующий локальный путь от retained
`published.worktree` + relative `changedFiles`.

В финальном ответе каждый изменённый локальный файл упомянуть как Markdown inline code
— отдельным элементом, например:

`C:\Users\andre\AppData\Local\DSH\Postman\worktrees\REQ_xxx\docs\example.html`

Harness Web делает такие существующие file-path references кликабельными. Использовать
exact path из receipt, а не придумывать `C:\Users\andre\.dsh\postman\worktrees`.
Если штатный file tool уже surfaced файл и basename уникален среди изменённых файлов
этого turn, допустим inline-code basename; иначе использовать абсолютный exact path.

Для локальных файлов не использовать bare path, `file://` и не придумывать Markdown
URL. Web/PR URL оформлять обычной Markdown-ссылкой.

Не перегружать пользователя browser/CDP внутренностями без диагностической
необходимости.

При failure сообщить:

```text
exact REQ
terminal code
terminal state
точный blocker
что не было выполнено после blocker
```

## 20. Критические инварианты

1. Postman OFF по умолчанию; разрешён только при exact `@Postman` в начале текущего пользовательского сообщения после необязательных начальных пробелов.
2. Разрешение действует только для текущего сообщения и не наследуется из предыдущих сообщений.
3. Без exact trigger не загружать `delegate-via-postman`, не создавать REQ, не вызывать Direct Postman, не использовать другие Postman transport и не обращаться к Ч1.
4. После trigger Л1 не интерпретирует и не расширяет payload до отправки Ч1.
5. После удаления только `@Postman` + separator весь оставшийся текст передаётся verbatim; previous-context augmentation запрещён.
6. Один logical request → один REQ.
7. После начала Direct Postman invocation REQ immutable.
8. Production transport — только `<current workspace>\postman\direct\postman.ps1`.
9. `postman_async_send` и Cordis path не являются production transport.
10. BrowserSmoke не является normal preflight.
11. Chrome/ChatGPT/Send/download принадлежат Direct Postman, а не Л1.
12. После возможной отправки automatic resend запрещён.
13. Только exact `RESULT_DURABLE` является успешным transport result.
14. Не создавать implementation branch только ради transport до результата.
15. Пользовательский dirty worktree не очищать и не переписывать.
16. В normal flow Л1 не интерпретирует, не применяет и не изменяет результат Ч1.
17. После RESULT_DURABLE normal flow останавливается после optional Workspace registration.
18. `resume_request.ps1`, PREPARE/TEST/PUBLISH и `integrate_result.ps1` — только legacy/manual explicit finalization.
19. Normal flow не создаёт implementation worktree/branch/commit/PR и не распаковывает ZIP.
20. Workspace registration — presentation convenience, а не integrity gate.
21. Ошибка Workspace registration не отменяет успешный RESULT_DURABLE и не вызывает retry.
22. Direct Postman сам владеет minimal safety-only transport validation до RESULT_DURABLE.
23. Правила exact-bytes для `files/` относятся только к explicit manual finalization; normal flow не читает содержимое ZIP.
24. `RESULT_DIAGNOSTIC_ONLY` не является implementation success и не разрешает automatic resend.
25. Resume/PREPARE/TEST/PUBLISH не создают новый Postman REQ и не обращаются повторно к Ч1.
26. `changedFiles`/retained worktree показываются только при explicit manual PUBLISHED finalization, не в normal transport report.
27. Нет validated correlated artifact → нет успешного Postman результата.
28. Durable Workspace registration передаёт exact current REQ как `request_id`; receipt requestId обязан совпасть до `workspaceRegistry.create/delete`.
29. `@Postman --chat <old REQ> <intent>` открывает только сохранённый exact conversation URL; UI search fallback отсутствует.
30. Старый REQ является только conversation reference; новая отправка всегда получает новый canonical REQ.
31. Continuation payload не содержит `--chat` и старый REQ; Ч1 получает только новый user intent.
32. Успешный RESULT_DURABLE сохраняет `conversationUrl`/`conversationId`, если browser transport их доказал.
33. `manifest.json`, `protocolVersion`, `repository`, `baseCommit`, `resultType`, `patch` и `files` не являются normal transport hard gate; только explicit conflicting string `requestId` в optional manifest остаётся reject.
34. Luna-side normal invocation не выполняет result-root `New-Item`, `Set-Content`, `Out-File`, redirection/write probe, `Remove-Item` probe или другие файловые write-preflight операции; этим владеет Direct Postman внутри bridge.
35. Tool-level shell failure до получения `jobId`, например `spawn EPERM`, означает `POSTMAN_INVOCATION_NOT_STARTED`: не читать старые/latest REQ states, не выполнять recovery, не повторять invocation и остановиться с сообщением, что Send не происходил.
36. Normal invocation создаёт ровно один background `tools.pwsh` job и сохраняет exact `jobId`.
37. `job_output` timeout/`running` оставляет exact job живым и никогда не разрешает второй REQ/Send.
38. Normal orchestration передаёт verbatim payload через UTF-8 Base64; `-Task` остаётся совместимым ручным wrapper-входом.


## Result Workspace после RESULT_DURABLE

После exact successful `RESULT_DURABLE` normal flow может один раз попытаться
зарегистрировать durable result как обычный Harness Workspace:

```text
postman_result_workspace_register(request_id=<exact REQ>, result_handoff_json=<exact resultHandoffPath>)
```

Инструмент принимает exact current `request_id` вместе с exact `resultHandoffPath`,
проверяет совпадение `receipt.requestId == request_id` до Workspace create/delete,
затем проверяет только receipt/layout gate. Он не распаковывает ZIP и не повторяет
artifact validation. После identity gate он вызывает
`ctx.workspaceRegistry.create(resultDirectory, title)` с рекомендуемым title
`Postman <REQ> — result` и пишет `<resultDirectory>\\result-workspace.json` внутри
exact result directory.

Результат регистрации содержит `source: RESULT_DURABLE`, exact `requestId`,
`resultDirectory`, `resultZip`, `resultHandoffJson` и `workspaceId`. Это presentation
convenience, а не integrity gate. Ошибка регистрации не отменяет transport success:
не создавать второй REQ, не повторять ChatGPT/download, не запускать resume и сообщить
пользователю exact RESULT_DURABLE, resultZip и diagnostic.

После регистрации пользователь может открыть Workspace штатными средствами Harness;
никаких новых Chrome/CDP, Session или preview-сервисов для регистрации не создавать.

Старый `published_json` режим остаётся совместимым: он регистрирует retained PUBLISHED
worktree, пишет sibling `result-workspace.json` рядом с published receipt и сохраняет
старый `clearResultPresentation` только для legacy unregister. Durable unregister не
вызывает published-result presentation cleanup: он удаляет только Workspace registration,
помечает свой sidecar как `RESULT_WORKSPACE_UNREGISTERED` и не удаляет result directory,
`result.zip` или другие durable receipts.

Пользователь не должен вводить git/SHA/worktree-команды или команды терминала вручную.
