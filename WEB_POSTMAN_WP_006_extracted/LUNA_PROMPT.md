# WP-006 / P5 — Artifact DOM Detection

You are applying an externally-authored implementation package.

Repository:
`AndrewVerhoturov1/dsh-workspace`

Required base:
`d837b85996ebe82cda40c72bfe03b629b2f5ed71`

Target temporary branch:
`postman/web-postman-wp-006`

## 1. Repository preflight

Read `AGENTS.md` and `REPO_POLICY.md`.

Before branch creation verify:

- current repository and remote;
- local `main`;
- actual `origin/main`;
- related open PRs;
- worktrees;
- no unfinished Postman implementation branch requiring resolution.

Required `origin/main` SHA:

`d837b85996ebe82cda40c72bfe03b629b2f5ed71`

Preserve all unrelated local/user/runtime data. Do not stash, reset, clean,
force-push or broad-stage.

If the base has moved, stop with `BASE_CHANGED`; do not adapt the supplied code
yourself.

## 2. Validate package before workspace mutation

Read:

- `manifest.json`
- `instructions.md`
- `expected-tests.md`

Validate ZIP and manifest using the repository's existing artifact-validator
policy/implementation where applicable.

Only these repo paths may change:

```text
postman/web/artifact_detector.py
postman/web/tests/test_artifact_detector.py
postman/web/README.md
docs/web-postman-implementation-plan.md
docs/web-postman-artifact-contract.md
```

## 3. Create the milestone branch

Create:

`postman/web-postman-wp-006`

from exact base `d837b85996ebe82cda40c72bfe03b629b2f5ed71`.

## 4. Apply supplied implementation only

First:

```powershell
git apply --check changes.patch
```

Then apply `changes.patch`.

Copy the two package files from `files/` to their exact repo-relative paths:

```text
postman/web/artifact_detector.py
postman/web/tests/test_artifact_detector.py
```

Do not redesign or independently fix implementation code. If package code is
defective, return `FAIL_CODE` with bounded diagnostics.

## 5. Offline tests first

Run:

```powershell
python -m py_compile postman/web/artifact_detector.py postman/web/browser_observer.py postman/web/browser_submit.py
python -m unittest discover -s postman/web/tests -p test_artifact_detector.py -v
python -m unittest discover -s postman/web/tests -p test_browser_observer.py -v
python -m unittest discover -s postman/web/tests -p test_browser_submit.py -v
python -m unittest discover -s postman/web/tests -p test_browser_bootstrap.py -v
node --test postman/web/tests/artifact-validator.test.mjs
git diff --check
```

Require:

- WP-006 suite: all PASS;
- WP-005/P4: 42/42 PASS;
- WP-004/P3: 34/34 PASS;
- WP-003: 28/28 PASS;
- WP-002: 60/60 PASS;
- `git diff --check`: PASS.

Also verify source-level P5 boundary:

```text
no locator("body")
no click()
no expect_download()
no save_as()
```

If offline fails, STOP. Do not run live.

## 6. One low-noise live P5 smoke

Run only after complete offline PASS.

Use exactly one unique request id. Example PowerShell:

```powershell
$req = "REQ_WP006_SMOKE_" + [guid]::NewGuid().ToString("N").Substring(0,8).ToUpper()
$file = "POSTMAN_${req}_RESULT.zip"
$prompt = @"
Create one tiny ZIP file attachment named exactly: $file
The ZIP should contain one small UTF-8 text file named probe.txt.

In the final assistant response include these three lines exactly once, in this order, as plain text:
<<<POSTMAN_RESULT_BEGIN:$req>>>
POSTMAN_ARTIFACT:$file
<<<POSTMAN_RESULT_END:$req>>>

The ZIP attachment/download control must belong to this same assistant response.
Do not create or mention another ZIP filename.
"@

python postman/web/artifact_detector.py --request-id "$req" --expected-filename "$file" --prompt "$prompt"
```

Acceptance:

```text
code = ARTIFACT_DOM_CONFIRMED
requestId = exact $req
expectedFilename = exact $file
downloadStarted = false
submitCode = PROMPT_SEND_CONFIRMED
submitSendState = PROVEN_SENT
```

Noise/safety:

```text
maximum live prompts = 1
automatic retry = 0
manual retry = 0
downloads = 0
```

If send becomes UNKNOWN, response lacks attachment, DOM detection fails, or a
temporary platform limit appears: STOP. Do not send a second prompt.

For unclear DOM failure you may collect bounded diagnostics from the owned Page
and exact correlated assistant turn only: screenshot, relevant subtree shape,
selector counts, bounded attributes/text lengths, and result JSON. Do not
collect cookies, tokens, credentials, browser profile contents or Local Storage
dumps. Do not invent a code repair.

## 7. Review and publish

If offline + live smoke PASS:

- review task-scoped diff;
- explicitly stage only the five allowed paths;
- commit;
- push `postman/web-postman-wp-006`;
- verify local HEAD == origin branch HEAD;
- create PR to `main`;
- verify PR head SHA.

Do not merge.
Do not create WP-007.

If publication fails, return `BLOCKED_SYNC`.

## Report

```text
WP-006 / P5 ARTIFACT DOM DETECTION REPORT

STATUS: PASS | BASE_CHANGED | FAIL_CODE | FAIL_OFFLINE | FAIL_LIVE_DIAGNOSTICS | BLOCKED_SYNC | FAIL

Base:
- expected:
- actual origin/main:

Branch:
- name:
- commit:
- local HEAD:
- origin HEAD:
- SHA match:

Changed paths:

Offline:
- py_compile:
- WP-006:
- WP-005/P4:
- WP-004/P3:
- WP-003:
- WP-002:
- git diff --check:
- stale artifact regression:
- wrong filename regression:
- outside-turn regression:
- unrelated Download regression:
- no-click/download boundary:

Live:
- prompts sent:
- retries:
- request id:
- expected filename:
- code:
- exact envelope:
- attachment candidate:
- downloadStarted:
- submitCode:
- submitSendState:
- chat URL:

GitHub:
- push:
- PR:
- PR state:
- PR head:

Merge performed: NO
WP-007 created: NO
```
