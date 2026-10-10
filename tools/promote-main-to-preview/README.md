# promote-main-to-preview

Stable release executor for the approved branch contract:

```text
main = integration; preview = last explicitly approved stable
exact approved origin/main SHA A → origin/preview (non-force fast-forward)
```

Use **only after a separate, CURRENT human GO for the exact full 40-character SHA A** and after the tested release has been verified. `-UserGo` / `--user-go` is an executor assertion, **not evidence** of human approval. Serialize this operation with other Git writers; checking refs immediately before push is **not an atomic compare-and-swap**.

## Invocation

```powershell
& 'C:\Users\andre\.dsh\tools\promote-main-to-preview\promote_main_to_preview.ps1' `
  -ApprovedMainSha '0123456789abcdef0123456789abcdef01234567' -UserGo
```

Replace the sample SHA with the separately approved real SHA. Python equivalent:

```text
python -X utf8 tools/promote-main-to-preview/promote_main_to_preview.py --approved-main-sha <full40SHA> --user-go
```

Optional `-RepoRoot` / `--repo-root` selects the top-level repository directory; `origin` must be `AndrewVerhoturov1/dsh-workspace`.

## Preflight and effects

1. Reject missing GO flag or non-full SHA **before repository mutation**. Check top-level Git repository and exact GitHub `origin` identity.
2. Fetch remote refs; compare actual `origin/main` to approved SHA A and ensure both actual remote SHAs match freshly fetched tracking refs. Let `origin/preview = P`.
3. Prove `P` is an ancestor of A (`git merge-base --is-ancestor P A`). If `P == A`, reverify actual refs and report an idempotent no-op.
4. Recheck actual remote `main = A`, `preview = P` immediately before push. Any movement stops without retry.
5. **Exactly once**, run `git push origin A:refs/heads/preview` (literal A; no force or lease). Verify actual remote `preview == A`. If `main` moved after push, report the movement without promoting its new HEAD.

Divergence, missing/invalid refs, identity mismatch, permission/push failure, or failed final verification are blockers; never bypass or retry automatically. A normal push relies on Git's server-side non-fast-forward protection; pre-push checks do not provide atomic CAS.

No PR, merge, squash, preview commits, automatic task sync, or permanent worktree checkout/reset/clean/deletion is performed. After remote success only, a **separate** clean/safe local preview fast-forward may use the existing `tools/preview-worktree/preview_worktree.ps1 -Action update`; this is not part of stable remote promotion.
