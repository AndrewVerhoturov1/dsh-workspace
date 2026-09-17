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

The bridge never applies the implementation ZIP. Luna forwards the current `@Postman`
payload verbatim after removing only the transport marker/separator, does not augment it
from previous context, and does not inspect or interpret the returned ZIP. Normal flow
reports the exact durable result and optionally registers its result directory as a Harness
Workspace. Application, tests, commit, and PR remain available only through explicit manual
finalization.

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
- PREPARE V3 is request-scoped: unrelated branches, PRs and worktrees are audit
  state, not a global mutex. Only identity/resource collisions for the current REQ
  fail closed. Historical cleanup is outside the PREPARE critical path.
- The primary checkout is never switched or fast-forwarded by PREPARE. It is used
  only to fetch/resolve trusted `origin/main`; application happens in a dedicated
  clean request worktree.
- Patch payload accepts git-style or traditional unified diff. Same-path main
  advancement for patches is decided by real `git apply`; exact whole-file payload
  remains fail-closed on same-path advancement.
- `git diff --check` during PREPARE is audit/warning only; PUBLISH remains the hard
  whitespace gate before commit.
- A semantically tested result that is already present on `origin/main` terminates
  as `ALREADY_APPLIED` without creating an empty commit or PR.
- The dedicated Chrome profile is `%LOCALAPPDATA%\DSH\Postman\browser-profile`.
- The browser process is externally owned and is not closed by the worker.
- ZIPs are accepted only after the existing artifact validator proves trusted
  request/repository/baseCommit/filename/path metadata.

## Durable result and explicit finalization

After a successful transport, normal flow ends at the exact durable handoff:

```text
RESULT_DURABLE
→ optionally attempt postman_result_workspace_register(
    request_id=<exact REQ>,
    result_handoff_json=<exact resultHandoffPath>
  )
→ report exact REQ, exact resultZip and Workspace/registration diagnostic
→ STOP
```

Normal flow does not call `resume_request.ps1` or `integrate_result.ps1`, does not run
PREPARE/TEST/PUBLISH, create an implementation worktree/branch/commit/PR, or unpack and
re-analyse the ZIP. Workspace registration is presentation convenience, not an integrity gate.
If registration fails, RESULT_DURABLE and exact resultZip remain successful outputs; do not
create a second REQ or repeat ChatGPT/download/transport.

## Legacy/manual finalization

The existing `resume_request.ps1` state machine remains available only for an explicit
manual request against an already existing durable result. It can continue through
`READY_FOR_TEST → TEST_PASSED → PUBLISHED` and retains its existing receipt and identity
guards. Its UTF-8 `TestScript`/`TestSpec` inputs and deterministic PREPARE/TEST/PUBLISH
stages are legacy/manual behavior, not part of normal `@Postman` flow.

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
