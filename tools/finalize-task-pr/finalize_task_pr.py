#!/usr/bin/env python3
"""Merge already-reviewed task PRs and perform lightweight best-effort cleanup.

This is deliberately an executor, not a reviewer. It does not run tests, inspect
PR diffs, re-check CI, or rebuild the user's merge decision. It performs squash
merge for PRs that the caller has already approved, then cleans the matching
worktree/branches when doing so is obviously safe.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
DEFAULT_REPO_ROOT = Path(r"C:\Users\andre\.dsh")


class FinalizeError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def run_process(args: list[str], *, cwd: Path | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    """Run argv directly, without a shell and without a visible console window."""
    return subprocess.run(
        args,
        cwd=str(cwd) if cwd else None,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        timeout=timeout,
        creationflags=CREATE_NO_WINDOW,
        check=False,
    )


def _require_ok(cp: subprocess.CompletedProcess[str], code: str, message: str) -> subprocess.CompletedProcess[str]:
    if cp.returncode != 0:
        raise FinalizeError(
            code,
            message,
            details={"argv": cp.args, "stdout": cp.stdout[-4000:], "stderr": cp.stderr[-4000:], "exitCode": cp.returncode},
        )
    return cp


def _json_from(cp: subprocess.CompletedProcess[str], code: str, message: str) -> dict[str, Any]:
    _require_ok(cp, code, message)
    try:
        value = json.loads(cp.stdout)
    except json.JSONDecodeError as exc:
        raise FinalizeError(code, f"{message}: invalid JSON", details={"stdout": cp.stdout[-4000:]}) from exc
    if not isinstance(value, dict):
        raise FinalizeError(code, f"{message}: JSON object expected")
    return value


def gh_pr(repository: str, number: int, *, cwd: Path) -> dict[str, Any]:
    cp = run_process(["gh", "api", f"repos/{repository}/pulls/{number}"], cwd=cwd)
    return _json_from(cp, "FINALIZE_PR_READ_FAILED", f"cannot read PR #{number}")


def merge_squash(repository: str, number: int, *, cwd: Path) -> dict[str, Any]:
    cp = run_process(
        ["gh", "api", "-X", "PUT", f"repos/{repository}/pulls/{number}/merge", "-f", "merge_method=squash"],
        cwd=cwd,
        timeout=180,
    )
    data = _json_from(cp, "FINALIZE_MERGE_FAILED", f"squash merge failed for PR #{number}")
    if data.get("merged") is not True:
        raise FinalizeError(
            "FINALIZE_MERGE_REJECTED",
            f"GitHub did not merge PR #{number}",
            details={"response": data},
        )
    return data


def git(repo_root: Path, *args: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run_process(["git", "-C", str(repo_root), *args], timeout=timeout)


def resolve_repo_root(repo_root: Path) -> Path:
    root = repo_root.resolve()
    cp = git(root, "rev-parse", "--show-toplevel")
    _require_ok(cp, "FINALIZE_REPO_INVALID", f"not a Git repository: {root}")
    actual = Path(cp.stdout.strip()).resolve()
    if actual != root:
        raise FinalizeError(
            "FINALIZE_REPO_ROOT_MISMATCH",
            "RepoRoot must be the repository top-level directory",
            details={"requested": str(root), "actual": str(actual)},
        )
    return root


def parse_worktrees(text: str) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for raw in text.splitlines() + [""]:
        line = raw.rstrip("\r\n")
        if not line:
            if current:
                result.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value
    return result


def worktrees_for_branch(repo_root: Path, branch: str) -> list[Path]:
    cp = git(repo_root, "worktree", "list", "--porcelain")
    _require_ok(cp, "FINALIZE_WORKTREE_LIST_FAILED", "cannot list Git worktrees")
    ref = f"refs/heads/{branch}"
    paths: list[Path] = []
    for item in parse_worktrees(cp.stdout):
        if item.get("branch") == ref and item.get("worktree"):
            paths.append(Path(item["worktree"]).resolve())
    return paths


def branch_sha(repo_root: Path, branch: str) -> str | None:
    cp = git(repo_root, "show-ref", "--verify", "--hash", f"refs/heads/{branch}")
    if cp.returncode != 0:
        return None
    value = cp.stdout.strip().lower()
    return value or None


def remote_branch_sha(repo_root: Path, branch: str) -> str | None:
    cp = git(repo_root, "ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    if cp.returncode != 0:
        return None
    line = cp.stdout.strip()
    if not line:
        return None
    return line.split()[0].lower()


def origin_main_sha(repo_root: Path) -> str | None:
    cp = git(repo_root, "rev-parse", "refs/remotes/origin/main")
    if cp.returncode != 0:
        return None
    value = cp.stdout.strip().lower()
    return value or None


def _warn(warnings: list[dict[str, Any]], code: str, message: str, **details: Any) -> None:
    warnings.append({"code": code, "message": message, **details})


def cleanup_branch_resources(
    repo_root: Path,
    *,
    branch: str,
    expected_head: str,
    same_repository: bool,
    dry_run: bool,
) -> dict[str, Any]:
    warnings: list[dict[str, Any]] = []
    result: dict[str, Any] = {
        "worktreesRemoved": [],
        "localBranchRemoved": False,
        "remoteBranchRemoved": False,
        "warnings": warnings,
    }

    if not same_repository:
        _warn(warnings, "FINALIZE_FORK_CLEANUP_SKIPPED", "head branch belongs to another repository; branch cleanup skipped")
        return result

    paths = worktrees_for_branch(repo_root, branch)
    remaining_worktree = False
    for path in paths:
        if path == repo_root:
            remaining_worktree = True
            _warn(warnings, "FINALIZE_PRIMARY_WORKTREE_PROTECTED", "primary repository worktree is never removed", path=str(path))
            continue
        status = git(path, "status", "--porcelain", "--untracked-files=all")
        if status.returncode != 0:
            remaining_worktree = True
            _warn(warnings, "FINALIZE_WORKTREE_STATUS_UNKNOWN", "could not inspect worktree; leaving it untouched", path=str(path))
            continue
        if status.stdout.strip():
            remaining_worktree = True
            _warn(warnings, "FINALIZE_DIRTY_WORKTREE_SKIPPED", "dirty worktree left untouched", path=str(path))
            continue
        if dry_run:
            result["worktreesRemoved"].append(str(path))
            continue
        removed = git(repo_root, "worktree", "remove", str(path))
        if removed.returncode == 0:
            result["worktreesRemoved"].append(str(path))
        else:
            remaining_worktree = True
            _warn(
                warnings,
                "FINALIZE_WORKTREE_REMOVE_FAILED",
                "clean worktree could not be removed; continuing best-effort cleanup",
                path=str(path),
                stderr=removed.stderr[-2000:],
            )

    if not dry_run:
        git(repo_root, "worktree", "prune")

    local_sha = branch_sha(repo_root, branch)
    if local_sha is None:
        result["localBranchRemoved"] = True
    elif remaining_worktree:
        _warn(warnings, "FINALIZE_LOCAL_BRANCH_IN_USE", "local branch kept because a worktree still uses it", branch=branch)
    elif local_sha != expected_head.lower():
        _warn(
            warnings,
            "FINALIZE_LOCAL_BRANCH_MOVED",
            "local branch no longer points to the PR head; leaving it untouched",
            branch=branch,
            expected=expected_head.lower(),
            actual=local_sha,
        )
    elif dry_run:
        result["localBranchRemoved"] = True
    else:
        deleted = git(repo_root, "update-ref", "-d", f"refs/heads/{branch}", expected_head.lower())
        if deleted.returncode == 0:
            result["localBranchRemoved"] = True
        else:
            _warn(warnings, "FINALIZE_LOCAL_BRANCH_DELETE_FAILED", "local branch deletion failed", branch=branch, stderr=deleted.stderr[-2000:])

    remote_sha = remote_branch_sha(repo_root, branch)
    if remote_sha is None:
        result["remoteBranchRemoved"] = True
    elif remote_sha != expected_head.lower():
        _warn(
            warnings,
            "FINALIZE_REMOTE_BRANCH_MOVED",
            "remote branch no longer points to the merged PR head; leaving it untouched",
            branch=branch,
            expected=expected_head.lower(),
            actual=remote_sha,
        )
    elif dry_run:
        result["remoteBranchRemoved"] = True
    else:
        deleted = git(repo_root, "push", "origin", "--delete", branch, timeout=180)
        if deleted.returncode == 0:
            result["remoteBranchRemoved"] = True
        else:
            _warn(warnings, "FINALIZE_REMOTE_BRANCH_DELETE_FAILED", "remote branch deletion failed", branch=branch, stderr=deleted.stderr[-2000:])

    return result


def finalize_one(
    repo_root: Path,
    repository: str,
    number: int,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    pr = gh_pr(repository, number, cwd=repo_root)
    state = str(pr.get("state") or "").lower()
    merged_at = pr.get("merged_at")
    base = ((pr.get("base") or {}).get("ref") if isinstance(pr.get("base"), dict) else None)
    head_obj = pr.get("head") if isinstance(pr.get("head"), dict) else {}
    head = head_obj.get("ref")
    head_sha = str(head_obj.get("sha") or "").lower()
    head_repo_obj = head_obj.get("repo") if isinstance(head_obj.get("repo"), dict) else {}
    head_repo = head_repo_obj.get("full_name")

    if base != "main":
        raise FinalizeError("FINALIZE_BASE_NOT_MAIN", f"PR #{number} targets {base!r}, not main")
    if not isinstance(head, str) or not head or not head_sha:
        raise FinalizeError("FINALIZE_PR_IDENTITY_INVALID", f"PR #{number} has incomplete head identity")
    if head == "main":
        raise FinalizeError("FINALIZE_MAIN_BRANCH_PROTECTED", "refusing to treat main as a temporary PR branch")

    already_merged = bool(merged_at)
    if not already_merged and state != "open":
        raise FinalizeError("FINALIZE_PR_NOT_OPEN", f"PR #{number} is {state or 'unknown'} and is not merged")

    merge_sha: str | None = None
    if dry_run:
        merged_now = not already_merged
    elif already_merged:
        merged_now = False
    else:
        merged = merge_squash(repository, number, cwd=repo_root)
        merged_now = True
        merge_sha = str(merged.get("sha") or "").lower() or None

    # Refresh only refs; never checkout/reset/stash/clean the user's primary worktree.
    fetch_warning: dict[str, Any] | None = None
    if not dry_run:
        fetched = git(repo_root, "fetch", "--prune", "origin", timeout=180)
        if fetched.returncode != 0:
            fetch_warning = {
                "code": "FINALIZE_FETCH_WARNING",
                "message": "merge succeeded but fetch --prune failed; cleanup will continue best-effort",
                "stderr": fetched.stderr[-2000:],
            }

    cleanup = cleanup_branch_resources(
        repo_root,
        branch=head,
        expected_head=head_sha,
        same_repository=(head_repo == repository),
        dry_run=dry_run,
    )
    if fetch_warning:
        cleanup["warnings"].insert(0, fetch_warning)

    return {
        "prNumber": number,
        "url": pr.get("html_url"),
        "base": base,
        "head": head,
        "headSha": head_sha,
        "alreadyMerged": already_merged,
        "mergedNow": merged_now,
        "mergeSha": merge_sha,
        "cleanup": cleanup,
        "originMain": None if dry_run else origin_main_sha(repo_root),
    }


def finalize_many(
    *,
    repo_root: Path,
    repository: str,
    pr_numbers: list[int],
    dry_run: bool = False,
) -> dict[str, Any]:
    root = resolve_repo_root(repo_root)
    results: list[dict[str, Any]] = []
    for number in pr_numbers:
        # Each PR is re-read after the previous merge/fetch. No stale batch snapshot.
        results.append(finalize_one(root, repository, number, dry_run=dry_run))

    warnings = [warning for item in results for warning in item["cleanup"]["warnings"]]
    code = "TASK_PRS_DRY_RUN" if dry_run else ("TASK_PRS_FINALIZED_WITH_WARNINGS" if warnings else "TASK_PRS_FINALIZED")
    return {
        "ok": True,
        "code": code,
        "repository": repository,
        "repoRoot": str(root),
        "mergeMethod": "squash",
        "prNumbers": pr_numbers,
        "results": results,
        "warnings": warnings,
        "mainWorkingTreeTouched": False,
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Squash-merge already-reviewed PRs and clean their temporary Git resources")
    p.add_argument("--pr", type=int, action="append", required=True, dest="prs", help="PR number; repeat for multiple PRs")
    p.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT)
    p.add_argument("--repository", default=DEFAULT_REPOSITORY)
    p.add_argument("--what-if", action="store_true", help="show intended actions without merge/delete")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = finalize_many(repo_root=args.repo_root, repository=args.repository, pr_numbers=args.prs, dry_run=args.what_if)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except FinalizeError as exc:
        print(
            json.dumps(
                {"ok": False, "code": exc.code, "error": str(exc), "details": exc.details, "mainWorkingTreeTouched": False},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 2
    except Exception as exc:
        print(json.dumps({"ok": False, "code": "FINALIZE_INTERNAL_ERROR", "error": str(exc), "mainWorkingTreeTouched": False}, ensure_ascii=False, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
