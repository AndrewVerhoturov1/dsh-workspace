# Direct Web Postman (WP-014R)

Direct Web Postman is the production entrypoint for the simplified Postman flow.
It deliberately bypasses `dsh-postman-harness`/Cordis orchestration while reusing
all proven browser-first modules in `postman/web/`.

## Normal flow

```text
Luna
→ postman/direct/postman.ps1
→ postman/direct/postman_direct.py
→ publish intent-only REQ task to GitHub main
→ ensure dedicated Postman Chrome + CDP 127.0.0.1:9222
→ postman/web/web_worker_bridge.py
→ submit/observe/detect/download/validate
→ durable result ZIP
→ one JSON object returned to Luna
```

The bridge never applies the implementation ZIP. Luna remains responsible for
safe compatibility checks, application, tests, commit/PR, and user reporting.

## Browser smoke

```powershell
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `
  C:\Users\andre\.dsh\postman\direct\postman.ps1 `
  -BrowserSmoke
```

This must launch/reuse the dedicated visible Chrome and return JSON with
`promptSent=false`. It does not publish a task and does not send a ChatGPT prompt.

## Normal request

```powershell
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
$suffix = (Get-Random -Minimum 0 -Maximum 10000).ToString("0000")
$req = "REQ_${stamp}_${suffix}"
$task = 'Сделай простой калькулятор в древне-японском стиле.'

$jsonText = & pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `
  C:\Users\andre\.dsh\postman\direct\postman.ps1 `
  -RequestId $req `
  -Task $task
$result = $jsonText | ConvertFrom-Json
```

Success requires `ok=true`, `code=RESULT_DURABLE`, exact `requestId`, and an
existing validated `resultZip`.

## Safety

- One logical request has one canonical REQ.
- A persisted direct state for a REQ blocks automatic resend.
- GitHub publication uses authenticated `gh api` and writes only `<REQ>.md`.
- Task content is intent-only and does not infer implementation requirements.
- The dedicated Chrome profile is `%LOCALAPPDATA%\DSH\Postman\browser-profile`.
- The browser process is externally owned and is not closed by the worker.
- ZIPs are accepted only after the existing artifact validator proves trusted
  request/repository/baseCommit/filename/path metadata.
