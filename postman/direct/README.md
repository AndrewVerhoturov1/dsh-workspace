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
- PREPARE fails closed on live conflicting Postman resources: open task PRs,
  local/remote request branches, and registered additional worktrees.
- Terminal historical receipts are audit history, not global locks. If an old
  `published.json`/`abandoned.json` has no corresponding live branch or registered
  worktree, malformed or older receipt metadata does not block a new PREPARE.
  A live resource with ambiguous, contradictory, or missing ownership still
  fails closed.
- The dedicated Chrome profile is `%LOCALAPPDATA%\DSH\Postman\browser-profile`.
- The browser process is externally owned and is not closed by the worker.
- ZIPs are accepted only after the existing artifact validator proves trusted
  request/repository/baseCommit/filename/path metadata.

## Finalization and resume

After a successful transport, use the durable request state rather than starting
another transport request:

```text
RESULT_DURABLE
→ resume_request.ps1 -RequestId REQ_... -TestScript <exact UTF-8 script>
→ READY_FOR_TEST
→ TEST_PASSED
→ PUBLISHED
→ RESULT_PRESENTED (host/UI status, when requested)
→ merge decision
→ CLEANED
```

`resume_request.py` is the single state-machine entrypoint. It forwards the exact
receipt paths returned by each stage (`readyJson`, `testJson`, `publishedJson`),
validates every receipt in the current process, and resumes only the first missing
stage. A valid existing receipt is never recreated. Resume never invokes Direct
Postman or contacts Ch1 again. A corrupted or cross-request receipt fails closed.

Production tests should use a UTF-8 task-script file, not a long `python -c`
string. The script is outside the implementation worktree and its path and SHA-256
are recorded in `test.json`; the implementation fingerprint must remain unchanged.

## Explicit abandon

A closed, unmerged PR is not cleaned automatically. An operator must explicitly
run:

```text
abandon_result.ps1 -PublishedJson <exact published.json> -Reason "..." -ConfirmDiscard
```

The command verifies the exact request, PR, branch, commit, remote SHA, clean
worktree, and unregistered Result Workspace before deleting only those owned
resources. It writes `abandoned.json`; dirty, unknown, or mismatched resources
fail closed. Repeating the command returns `ALREADY_ABANDONED`.

## Presentation status

Semantic `TEST_PASSED` proves only deterministic task assertions. It does not mean
the UI was visually accepted. Publication may complete while presentation is
pending; host integration records `PRESENTED`/`PRESENTATION_PENDING` separately
with `presentation_status.ps1` (or its Python API). The report must distinguish
semantic test status, presentation status, and user visual acceptance.
