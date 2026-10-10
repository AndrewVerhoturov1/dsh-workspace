---
name: promote-main-to-preview
description: >-
  Separate stable promotion of an explicitly tested, current-human-approved exact
  main SHA into preview using a non-force fast-forward, never a PR merge.
---

# Promote Main To Preview

`PROMOTE_MAIN_TO_PREVIEW_SKILL_VERSION: 1`

## Branch roles and scope

```text
main = everyday integration (task PRs target main with user-decision squash)
preview = last explicitly verified stable release
stable release: approved exact main SHA A → preview (non-force FF)
```

This skill **only** performs stable release promotion. Ordinary task acceptance into `main` does not update `preview`. Persistent older task bases/REQs remain pinned; this skill does not migrate or rewrite them.

## Authorization boundary

The **CURRENT human instruction** must separately and explicitly approve promotion of the **exact full 40-hex main SHA A**, based on the already verified release. Previous approvals, a task merge, a remembered intent, or a checked box are insufficient. If the user did not give this exact GO, **STOP** and request it. Never infer approval, create it, or treat an executor switch as a replacement for it. There is no new ApprovalService or approval authority.

`-ApprovedMainSha` and `-UserGo` (Python: `--approved-main-sha` and `--user-go`) are mandatory executor arguments. The flag merely asserts that the human GO has already occurred; it cannot establish that fact itself. Missing human GO or missing/partial SHA must stop **before any mutable Git action**.

Coordinate/serialize promotion with other writers of remote `main` and `preview`. The pre-push ref check is **not atomic CAS**, and does not prevent all races; normal server-side non-FF push rejection must be respected.

## Canonical invocation

After verifying the user's CURRENT exact-SHA GO (replace this example SHA):

```powershell
$resultText = & 'C:\Users\andre\.dsh\tools\promote-main-to-preview\promote_main_to_preview.ps1' `
  -ApprovedMainSha '0123456789abcdef0123456789abcdef01234567' -UserGo
$result = $resultText | ConvertFrom-Json
```

Python equivalent: `python -X utf8 tools/promote-main-to-preview/promote_main_to_preview.py --approved-main-sha <full40SHA> --user-go`.

## Executor guards

The executor checks exact Git repository root and `origin` identity, performs a fresh fetch, and reads **actual** remote refs. It requires:

```text
actual origin/main == approved A
actual origin/preview == P
freshly fetched origin/main == A and origin/preview == P
P is an ancestor of A (or P == A for a verified no-op)
rechecked actual main == A and preview == P immediately before push
```

It pushes **literal A**, once, with `git push origin A:refs/heads/preview`, with no force/lease. After success, it verifies actual `origin/preview == A`. If main moved after the push, it reports a warning with the new main SHA, **not** a second promotion. Ref read errors, divergence, movement before push, permissions or push failure are blockers without bypass/retry.

## Local preview (separate optional stage)

Only **after verified remote success**, and only when the existing preview worktree is clean and local update guards allow a safe fast-forward, run separately:

```powershell
& 'C:\Users\andre\.dsh\tools\preview-worktree\preview_worktree.ps1' -Action update
```

This is not automatic stability or approval. If the local worktree is dirty/diverged/unavailable, stop local update and retain user data; remote result must be reported separately. The remote executor never checks out, resets, stashes, cleans, deletes, or overwrites either permanent worktree, never deletes `preview`, and does not create its own preview commit.

## Prohibitions

```text
PR-based release; GitHub merge/squash for stable promotion
force or force-with-lease push; automatic retry after ref movement
promoting new origin/main HEAD without a new exact human GO
auto-sync preview after regular task PR
reset/stash/clean or deletion of permanent worktrees or user data
changing roles, trust grants, runners, ApprovalService
```

## Report

Report `approvedMainSha`, `previewBefore`, `originMain`, `originPreview`, `pushPerformed`, `mainMovedAfterPush`, `warnings`, and any blocker/verification failure. A verified `P == A` is a no-op. If local preview update was separately requested and safely completed, report its own status independently. `mainWorkingTreeTouched=false` and `previewWorkingTreeTouched=false` describe **this remote executor only**.
