# Direct Web Postman

`postman/direct/postman.ps1` — единственный production entrypoint normal `@Postman` flow.

Direct Postman не использует `dsh-postman-harness`/Cordis async transport как fallback.
Browser-first pipeline находится в `postman/web/`.

## Normal flow

```text
Luna
→ one background tools.pwsh job (`run_in_background: true`)
→ workspace-relative postman/direct/postman.ps1
→ postman/direct/postman_direct.py
→ validate new REQ
→ snapshot origin/main
→ publish self-contained REQ task to GitHub
→ ensure dedicated Postman Chrome
→ postman/web/web_worker_bridge.py
→ submit / observe / detect / download / validate
→ RESULT_DURABLE | ASSISTANT_COMPLETED_NO_ARTIFACT | ARTIFACT_REJECTED
→ one terminal JSON object back to Luna
→ durable: report exact requestId + resultZip
→ non-durable: return assistantText / validation reason for continuation decision
```

Luna передаёт current user intent без semantic augmentation. После обычного `@Postman`
удаляются только marker и непосредственно следующий separator. Для `--chat` transport control
`--chat <old REQ>` также не становится частью semantic intent.

Normal flow не распаковывает и не анализирует ZIP и не применяет его к repository.

## Workspace-relative entrypoint

Если caller уже PowerShell, nested `pwsh.exe` не нужен:

```powershell
$workspace = (Get-Location).Path
$bridge = Join-Path $workspace 'postman\direct\postman.ps1'

if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) {
    throw 'POSTMAN_DIRECT_BRIDGE_MISSING'
}
```

Не подставлять hardcoded `C:\Users\<name>\...`.

Для normal orchestration через `tools.pwsh` не задавать hardcoded `workdir`; используется текущий
workspace процесса. Luna также не делает собственный result-root write-probe до bridge:
создание/проверка result root принадлежит Direct Postman.

Tool-level shell failure до spawn, например `spawn EPERM`, означает, что Direct Postman
не стартовал. После такого failure нельзя выбирать latest/старый REQ как результат текущей операции
или автоматически повторять Send.

## Normal request

```powershell
$workspace = (Get-Location).Path
$bridge = Join-Path $workspace 'postman\direct\postman.ps1'

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$suffix = (Get-Random -Minimum 0 -Maximum 10000).ToString('0000')
$requestId = 'REQ_' + $stamp + '_' + $suffix

$task = 'Сделай краткий отчёт по указанной теме.'

$jsonText = & $bridge `
  -RequestId $requestId `
  -Task $task

$result = $jsonText | ConvertFrom-Json
```

Successful terminal transport handoff requires `ok=true`, exact current `requestId` and one code:

```text
RESULT_DURABLE
ASSISTANT_COMPLETED_NO_ARTIFACT
ARTIFACT_REJECTED
```

Only `RESULT_DURABLE` requires `resultZip`. The other two return `assistantText`; rejection
also returns `validationCode` and `validationMessage`.

## DSH orchestration for long requests

В текущем DSH deployment одна `functions.run_code` ячейка имеет wall limit 600000 ms,
а Direct Postman может законно работать до 45 минут. Поэтому normal `@Postman`
orchestration не держит `postman.ps1` foreground.

Правильная схема:

```text
run_code #1
→ tools.pwsh(run_in_background=true)
→ сохранить exact requestId + jobId
→ run_code завершён

run_code #2..N
→ job_output(exact jobId, wait=true, timeout_ms=480000)
→ running: новый отдельный wait того же job
→ completed + exit code 0: разобрать terminal JSON
```

Background `pwsh` не использует foreground timeout. `job_output` timeout не убивает
background process. Не запускать второй Postman/REQ после wait timeout.

Для orchestration raw user payload передаётся через UTF-8 Base64:

```powershell
& $bridge `
  -RequestId $requestId `
  -TaskBase64 $taskBase64
```

`-Task` сохраняется для обычного ручного PowerShell-вызова. Указать одновременно
`-Task` и `-TaskBase64` нельзя.

## Continue an existing ChatGPT conversation

Пользовательский syntax:

```text
@Postman --chat REQ_... <new intent>
```

Direct invocation:

```powershell
$jsonText = & $bridge `
  -RequestId $newRequestId `
  -ChatRequestId $oldRequestId `
  -Task $newIntent
```

Правила:

- `$oldRequestId` — только lookup key.
- Каждая continuation создаёт новый canonical REQ.
- Direct Postman разрешает exact сохранённый `conversationUrl`.
- Worker открывает exact `/c/<conversation-id>` и должен доказать, что это тот же conversation.
- Старый REQ и `--chat` не передаются Ч1 как часть нового intent.
- Search UI, угадывание conversation и silent fresh-chat fallback запрещены.
- Если URL отсутствует: `DIRECT_CHAT_REFERENCE_UNAVAILABLE` до Send.
- Если exact chat не подтверждён: fail closed до Send.

## Browser smoke

Browser smoke — отдельная диагностика, не normal preflight:

```powershell
$workspace = (Get-Location).Path
$bridge = Join-Path $workspace 'postman\direct\postman.ps1'
& $bridge -BrowserSmoke
```

Smoke не публикует task и не отправляет production prompt.

## Task publication

Direct Postman:

1. фиксирует trusted snapshot `origin/main`;
2. строит self-contained `<REQ>.md`;
3. публикует его;
4. отправляет в ChatGPT Web только canonical двухстрочный prompt:

```text
POSTMAN_REQUEST_ID: REQ_...
task_file: <exact SHA-pinned task URL>
```

External policy URL больше не является строкой browser prompt.

## Browser/result safety

Основные инварианты:

- one logical invocation → one new canonical REQ;
- persisted state блокирует blind resend того же REQ;
- dedicated browser profile: `%LOCALAPPDATA%\DSH\Postman\browser-profile`;
- externally-owned Chrome не закрывается worker-ом;
- Send выполняется один раз и требует proof;
- attachment должен принадлежать exact correlated assistant turn;
- download выполняется одним click через browser download event;
- expected filename должен совпадать;
- ZIP проходит минимальную transport validation: readable/non-empty, CRC/local-header
  integrity, traversal/absolute/drive/UNC path rejection, symlink rejection, простые size/count/ratio
  limits и SHA-256;
- `manifest.json` и его поля не являются transport gates;
- `repository`, `baseCommit`, `resultType`, patch/files schema и allowed/forbidden paths
  не являются normal transport content gates.

## Completed response without durable ZIP

Если correlated assistant-turn завершён, exact ZIP не найден и повторная проверка через 10 секунд
подтверждает отсутствие ZIP, current REQ завершается `ASSISTANT_COMPLETED_NO_ARTIFACT`.
Если ZIP найден, но minimal validator его отклонил, current REQ завершается `ARTIFACT_REJECTED`
с точными `validationCode`/`validationMessage`. Ни один из этих случаев не ждёт следующего reminder.
Conversation URL сохраняется, поэтому следующий новый REQ может использовать `-ChatRequestId`.

Reminders 10/20/30 и 45-minute deadline сохраняются для незавершённого assistant-turn.

## Durable result

После transport PASS:

```text
RESULT_DURABLE
→ durable result directory
   ├─ result.zip
   ├─ validation.json
   ├─ metadata.json
   └─ manifest.json   # только если был в ZIP
```

Текущий deployment default result root:

```text
D:\Downloads_dsh_auto
```

Он может быть переопределён через поддерживаемый Direct Postman configuration.
Luna не должна заранее имитировать внутренний write-probe.

После `RESULT_DURABLE` normal flow сообщает exact `requestId` и `resultZip` и
останавливается. `postman_result_workspace_register(...)` normal flow не вызывает,
Result Workspace автоматически не создаётся.

## Legacy/manual finalization

`resume_request.ps1`, PREPARE/TEST/PUBLISH, `integrate_result.ps1`,
`abandon_result.ps1` и presentation-finalization scripts сохраняются для отдельной
явно запрошенной работы с уже существующим durable result.

Они не являются частью normal `@Postman` lifecycle.
