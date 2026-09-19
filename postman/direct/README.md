# Direct Web Postman

`postman/direct/postman.ps1` — единственный production entrypoint normal `@Postman` flow.

Direct Postman не использует `dsh-postman-harness`/Cordis async transport как fallback.
Browser-first pipeline находится в `postman/web/`.

## Normal flow

```text
Luna
→ workspace-relative postman/direct/postman.ps1
→ postman/direct/postman_direct.py
→ validate new REQ
→ snapshot origin/main
→ publish self-contained REQ task to GitHub
→ ensure dedicated Postman Chrome
→ postman/web/web_worker_bridge.py
→ submit / observe / detect / download / validate
→ RESULT_DURABLE
→ one terminal JSON object back to Luna
→ optional Result Workspace registration
→ STOP
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

Success требует одновременно:

```text
ok = true
code = RESULT_DURABLE
requestId = exact current REQ
resultZip = existing validated durable ZIP
```

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
- ZIP проверяется на container integrity, path safety, collisions, special entries,
  archive limits, CRC и SHA-256;
- `manifest.json` необязателен;
- если optional manifest содержит строковый `requestId`, конфликт с trusted current REQ — hard reject;
- `repository`, `baseCommit`, `resultType`, patch/files schema и allowed/forbidden paths
  не являются normal transport content gates.

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

После `RESULT_DURABLE` normal flow может один раз вызвать:

```text
postman_result_workspace_register(
  request_id=<exact REQ>,
  result_handoff_json=<exact resultHandoffPath>
)
```

Workspace registration — presentation convenience, не integrity gate. Если она не удалась,
сообщается exact `resultZip` и diagnostic; новый REQ не создаётся и transport не повторяется.

## Legacy/manual finalization

`resume_request.ps1`, PREPARE/TEST/PUBLISH, `integrate_result.ps1`,
`abandon_result.ps1` и presentation-finalization scripts сохраняются для отдельной
явно запрошенной работы с уже существующим durable result.

Они не являются частью normal `@Postman` lifecycle.
