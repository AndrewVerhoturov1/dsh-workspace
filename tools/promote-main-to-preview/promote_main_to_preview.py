#!/usr/bin/env python3
"""Fast-forward origin/preview to an explicitly approved, exact origin/main SHA.

This executor does not grant approval or coordinate other Git writers. The caller
must have a CURRENT, separate human GO for the exact SHA and serialize release
with other Git writers. No permanent branch or worktree is checked out/reset.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any
from urllib.parse import urlparse

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
DEFAULT_REPO_ROOT = Path(r"C:\Users\andre\.dsh")
FULL_SHA = re.compile(r"[0-9a-fA-F]{40}\Z")


class PromotionError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def run_process(args: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            args,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout,
            creationflags=CREATE_NO_WINDOW,
            check=False,
        )
    except FileNotFoundError as exc:
        raise PromotionError(
            "PROMOTE_EXECUTABLE_NOT_FOUND",
            f"Не найден исполняемый файл: {args[0]}",
            details={"argv": list(args)},
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise PromotionError(
            "PROMOTE_COMMAND_TIMEOUT",
            "Git command timed out; no automatic retry is permitted",
            details={"argv": list(args)},
        ) from exc


def _require_ok(cp: subprocess.CompletedProcess[str], code: str, message: str) -> subprocess.CompletedProcess[str]:
    if cp.returncode != 0:
        raise PromotionError(
            code,
            message,
            details={"argv": cp.args, "stdout": cp.stdout[-4000:], "stderr": cp.stderr[-4000:], "exitCode": cp.returncode},
        )
    return cp


def git(repo_root: Path, *args: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run_process(["git", "-C", str(repo_root), *args], timeout=timeout)


def resolve_repo_root(repo_root: Path) -> Path:
    root = repo_root.resolve()
    cp = git(root, "rev-parse", "--show-toplevel")
    _require_ok(cp, "PROMOTE_REPO_INVALID", f"not a Git repository: {root}")
    actual = Path(cp.stdout.strip()).resolve()
    if actual != root:
        raise PromotionError(
            "PROMOTE_REPO_ROOT_MISMATCH",
            "RepoRoot must be the repository top-level directory",
            details={"requested": str(root), "actual": str(actual)},
        )
    return root


def normalize_github_repository_url(url: str) -> str | None:
    value = url.strip().replace("\\", "/").rstrip("/")
    if value.lower().endswith(".git"):
        value = value[:-4]
    if value.lower().startswith("git@github.com:"):
        repo_path = value.split(":", 1)[1]
    else:
        parsed = urlparse(value)
        if (parsed.hostname or "").lower() != "github.com":
            return None
        repo_path = parsed.path.lstrip("/")
    normalized = repo_path.strip("/").lower()
    parts = normalized.split("/")
    return normalized if len(parts) == 2 and all(parts) else None


def assert_origin_repository(repo_root: Path) -> str:
    cp = git(repo_root, "remote", "get-url", "origin")
    _require_ok(cp, "PROMOTE_ORIGIN_READ_FAILED", "cannot read origin URL")
    url = cp.stdout.strip()
    actual = normalize_github_repository_url(url)
    if actual != DEFAULT_REPOSITORY.lower():
        raise PromotionError(
            "PROMOTE_ORIGIN_REPOSITORY_MISMATCH",
            "origin does not point to the expected GitHub repository",
            details={"expectedRepository": DEFAULT_REPOSITORY, "actualRepository": actual, "originUrl": url},
        )
    return url


def remote_branch_shas(repo_root: Path) -> tuple[str, str]:
    """Read ACTUAL remote main and preview in one ls-remote request."""
    cp = git(repo_root, "ls-remote", "--heads", "origin", "refs/heads/main", "refs/heads/preview")
    _require_ok(cp, "PROMOTE_REMOTE_REF_READ_FAILED", "cannot read origin main/preview refs")
    found: dict[str, str] = {}
    for line in cp.stdout.splitlines():
        fields = line.split()
        if len(fields) != 2 or fields[1] not in ("refs/heads/main", "refs/heads/preview") or not FULL_SHA.fullmatch(fields[0]):
            raise PromotionError("PROMOTE_REMOTE_REF_INVALID", "unexpected origin ref response")
        if fields[1] in found:
            raise PromotionError("PROMOTE_REMOTE_REF_INVALID", "duplicate origin ref response")
        found[fields[1]] = fields[0].lower()
    if "refs/heads/main" not in found or "refs/heads/preview" not in found:
        raise PromotionError(
            "PROMOTE_REMOTE_REF_MISSING",
            "both origin/main and origin/preview must exist",
            details={"availableRefs": sorted(found)},
        )
    return found["refs/heads/main"], found["refs/heads/preview"]


def tracked_ref_sha(repo_root: Path, branch: str) -> str:
    cp = git(repo_root, "rev-parse", "--verify", f"refs/remotes/origin/{branch}")
    _require_ok(cp, "PROMOTE_FETCHED_REF_MISSING", f"origin/{branch} is unavailable after fetch")
    sha = cp.stdout.strip().lower()
    if not FULL_SHA.fullmatch(sha):
        raise PromotionError("PROMOTE_FETCHED_REF_INVALID", f"invalid fetched origin/{branch} SHA")
    return sha


def promote(*, repo_root: Path, approved_main_sha: str | None, user_go: bool = False) -> dict[str, Any]:
    # Reject missing/invalid authorization parameters BEFORE git fetch or any other mutation.
    if not isinstance(approved_main_sha, str) or not FULL_SHA.fullmatch(approved_main_sha):
        raise PromotionError("PROMOTE_APPROVED_SHA_INVALID", "--approved-main-sha requires an exact full 40-hex SHA")
    if not user_go:
        raise PromotionError("PROMOTE_USER_GO_REQUIRED", "--user-go is required; separate CURRENT human GO for this SHA must already exist")

    approved = approved_main_sha.lower()
    root = resolve_repo_root(repo_root)
    origin_url = assert_origin_repository(root)

    _require_ok(
        git(root, "fetch", "--no-tags", "origin", timeout=180),
        "PROMOTE_FETCH_FAILED",
        "cannot freshly fetch origin; no promotion was attempted",
    )
    remote_main, preview_before = remote_branch_shas(root)
    if remote_main != approved:
        raise PromotionError(
            "PROMOTE_MAIN_SHA_MISMATCH",
            "actual origin/main no longer equals the approved SHA",
            details={"approvedMainSha": approved, "originMain": remote_main},
        )
    # Object graph checks are based on the exact actual remote SHAs, not stale refs.
    fetched_main = tracked_ref_sha(root, "main")
    fetched_preview = tracked_ref_sha(root, "preview")
    if (fetched_main, fetched_preview) != (remote_main, preview_before):
        raise PromotionError(
            "PROMOTE_FETCHED_REFS_STALE",
            "fetched tracking refs do not match actual remote refs; stop without retry",
            details={"originMain": remote_main, "originPreview": preview_before,
                     "fetchedMain": fetched_main, "fetchedPreview": fetched_preview},
        )

    if preview_before != approved:
        ancestor = git(root, "merge-base", "--is-ancestor", preview_before, approved)
        if ancestor.returncode == 1:
            raise PromotionError(
                "PROMOTE_PREVIEW_DIVERGED",
                "origin/preview is not an ancestor of the approved main SHA; fast-forward forbidden",
                details={"originPreview": preview_before, "approvedMainSha": approved},
            )
        _require_ok(ancestor, "PROMOTE_ANCESTRY_CHECK_FAILED", "cannot verify preview -> approved main ancestry")

    # Recheck BOTH actual remote refs immediately before push (or verified no-op).
    checked_main, checked_preview = remote_branch_shas(root)
    if checked_main != approved:
        raise PromotionError(
            "PROMOTE_MAIN_MOVED_BEFORE_PUSH", "origin/main moved before promotion; no push",
            details={"approvedMainSha": approved, "originMain": checked_main},
        )
    if checked_preview != preview_before:
        raise PromotionError(
            "PROMOTE_PREVIEW_MOVED_BEFORE_PUSH", "origin/preview moved before promotion; no push",
            details={"expectedPreview": preview_before, "originPreview": checked_preview},
        )

    if preview_before == approved:
        return {
            "ok": True, "code": "PREVIEW_ALREADY_AT_APPROVED_MAIN",
            "repository": DEFAULT_REPOSITORY, "repoRoot": str(root), "originUrl": origin_url,
            "approvedMainSha": approved, "previewBefore": preview_before,
            "originMain": checked_main, "originPreview": checked_preview,
            "pushPerformed": False, "mainMovedAfterPush": False, "warnings": [],
            "mainWorkingTreeTouched": False, "previewWorkingTreeTouched": False, "previewBranchDeleted": False,
        }

    # Only one non-force push of the literal approved SHA; never PR/merge/squash/force.
    _require_ok(
        git(root, "push", "origin", f"{approved}:refs/heads/preview", timeout=180),
        "PROMOTE_PUSH_FAILED",
        "non-force preview fast-forward failed; no retry or bypass permitted",
    )

    # Push success is not enough: verify the actual server-side preview ref.
    final_main, final_preview = remote_branch_shas(root)
    if final_preview != approved:
        raise PromotionError(
            "PROMOTE_FINAL_PREVIEW_MISMATCH",
            "push returned success but actual origin/preview is not the approved SHA",
            details={"approvedMainSha": approved, "originMain": final_main, "originPreview": final_preview},
        )
    main_moved = final_main != approved
    warnings = ([{"code": "PROMOTE_MAIN_MOVED_AFTER_PUSH",
                  "message": "origin/main moved after the approved SHA was pushed; new main HEAD was not promoted",
                  "approvedMainSha": approved, "originMain": final_main}] if main_moved else [])
    return {
        "ok": True, "code": "PREVIEW_PROMOTED_MAIN_MOVED" if main_moved else "PREVIEW_PROMOTED",
        "repository": DEFAULT_REPOSITORY, "repoRoot": str(root), "originUrl": origin_url,
        "approvedMainSha": approved, "previewBefore": preview_before,
        "originMain": final_main, "originPreview": final_preview,
        "pushPerformed": True, "mainMovedAfterPush": main_moved, "warnings": warnings,
        "mainWorkingTreeTouched": False, "previewWorkingTreeTouched": False, "previewBranchDeleted": False,
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Non-force stable FF: exact approved origin/main SHA -> origin/preview")
    p.add_argument("--approved-main-sha", required=True)
    p.add_argument("--user-go", action="store_true", help="Assertion of separate current human GO for the exact SHA")
    p.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = promote(repo_root=args.repo_root, approved_main_sha=args.approved_main_sha, user_go=args.user_go)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except PromotionError as exc:
        print(json.dumps({"ok": False, "code": exc.code, "error": str(exc), "details": exc.details,
                          "mainWorkingTreeTouched": False, "previewWorkingTreeTouched": False,
                          "previewBranchDeleted": False}, ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as exc:
        print(json.dumps({"ok": False, "code": "PROMOTE_INTERNAL_ERROR", "error": str(exc),
                          "mainWorkingTreeTouched": False, "previewWorkingTreeTouched": False,
                          "previewBranchDeleted": False}, ensure_ascii=False, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
