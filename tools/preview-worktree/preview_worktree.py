#!/usr/bin/env python3
"""Manage the permanent local preview worktree safely.

Actions:
- bootstrap: after migration is merged into main, create remote preview exactly
  at origin/main when it does not exist, then create the permanent worktree.
- setup: create the permanent worktree for an already-existing origin/preview.
- update: fast-forward the clean local preview worktree to origin/preview.
- status: read-only state report.

No action uses reset, stash, clean, force push, or deletion of unknown folders.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
from typing import Any
from urllib.parse import urlparse

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULT_REPO_ROOT = Path(r"C:\Users\andre\.dsh")
DEFAULT_PREVIEW_ROOT = Path(r"C:\Users\andre\.dsh-preview")
DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
PREVIEW_BRANCH = "preview"
MIGRATION_MARKER_PATH = "docs/workflow/PREVIEW_BRANCH_WORKFLOW.md"
MIGRATION_MARKER = "PREVIEW_BRANCH_WORKFLOW_VERSION: 1"


class PreviewWorktreeError(RuntimeError):
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
        executable = args[0] if args else ""
        raise PreviewWorktreeError(
            "PREVIEW_EXECUTABLE_NOT_FOUND",
            f"Не найден исполняемый файл: {executable}",
            details={"executable": executable, "argv": list(args)},
        ) from exc


def git(repo_root: Path, *args: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run_process(["git", "-C", str(repo_root), *args], timeout=timeout)


def require_ok(cp: subprocess.CompletedProcess[str], code: str, message: str) -> subprocess.CompletedProcess[str]:
    if cp.returncode != 0:
        raise PreviewWorktreeError(
            code,
            message,
            details={"argv": cp.args, "stdout": cp.stdout[-4000:], "stderr": cp.stderr[-4000:], "exitCode": cp.returncode},
        )
    return cp


def resolve_repo_root(repo_root: Path) -> Path:
    root = repo_root.resolve()
    cp = git(root, "rev-parse", "--show-toplevel")
    require_ok(cp, "PREVIEW_REPO_INVALID", f"not a Git repository: {root}")
    actual = Path(cp.stdout.strip()).resolve()
    if actual != root:
        raise PreviewWorktreeError(
            "PREVIEW_REPO_ROOT_MISMATCH",
            "RepoRoot must be the repository top-level directory",
            details={"requested": str(root), "actual": str(actual)},
        )
    return root


def normalize_github_repository_url(url: str) -> str | None:
    value = url.strip().replace("\\", "/").rstrip("/")
    if value.lower().endswith(".git"):
        value = value[:-4]
    lower = value.lower()
    if lower.startswith("git@github.com:"):
        repo_path = value.split(":", 1)[1]
    else:
        parsed = urlparse(value)
        if (parsed.hostname or "").lower() != "github.com":
            return None
        repo_path = parsed.path.lstrip("/")
    normalized = repo_path.strip("/").lower()
    parts = normalized.split("/")
    if len(parts) != 2 or not all(parts):
        return None
    return normalized


def assert_origin_repository(repo_root: Path, repository: str) -> str:
    cp = git(repo_root, "remote", "get-url", "origin")
    require_ok(cp, "PREVIEW_ORIGIN_READ_FAILED", "cannot read origin URL")
    url = cp.stdout.strip()
    actual = normalize_github_repository_url(url)
    expected = repository.lower()
    if actual != expected:
        raise PreviewWorktreeError(
            "PREVIEW_ORIGIN_REPOSITORY_MISMATCH",
            "origin does not point to the expected GitHub repository",
            details={"expectedRepository": repository, "actualRepository": actual, "originUrl": url},
        )
    return url


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


def list_worktrees(repo_root: Path) -> list[dict[str, str]]:
    cp = git(repo_root, "worktree", "list", "--porcelain")
    require_ok(cp, "PREVIEW_WORKTREE_LIST_FAILED", "cannot list Git worktrees")
    return parse_worktrees(cp.stdout)


def remote_branch_sha(repo_root: Path, branch: str) -> str | None:
    cp = git(repo_root, "ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    require_ok(cp, "PREVIEW_REMOTE_REF_READ_FAILED", f"cannot read origin/{branch}")
    line = cp.stdout.strip()
    return line.split()[0].lower() if line else None


def local_branch_sha(repo_root: Path, branch: str) -> str | None:
    cp = git(repo_root, "show-ref", "--verify", "--hash", f"refs/heads/{branch}")
    if cp.returncode != 0:
        return None
    value = cp.stdout.strip().lower()
    return value or None


def tracked_branch_sha(repo_root: Path, branch: str) -> str | None:
    cp = git(repo_root, "rev-parse", f"refs/remotes/origin/{branch}")
    if cp.returncode != 0:
        return None
    value = cp.stdout.strip().lower()
    return value or None


def branch_at_path(worktrees: list[dict[str, str]], path: Path) -> str | None:
    target = path.resolve()
    for item in worktrees:
        if not item.get("worktree"):
            continue
        try:
            candidate = Path(item["worktree"]).resolve()
        except OSError:
            continue
        if candidate == target:
            ref = item.get("branch") or ""
            return ref.removeprefix("refs/heads/") or None
    return None


def paths_for_branch(worktrees: list[dict[str, str]], branch: str) -> list[Path]:
    ref = f"refs/heads/{branch}"
    result: list[Path] = []
    for item in worktrees:
        if item.get("branch") == ref and item.get("worktree"):
            result.append(Path(item["worktree"]).resolve())
    return result


def require_migration_merged(repo_root: Path) -> str:
    main_sha = tracked_branch_sha(repo_root, "main")
    if not main_sha:
        raise PreviewWorktreeError("PREVIEW_ORIGIN_MAIN_MISSING", "origin/main is unavailable after fetch")
    cp = git(repo_root, "show", f"refs/remotes/origin/main:{MIGRATION_MARKER_PATH}")
    require_ok(cp, "PREVIEW_MIGRATION_NOT_MERGED", "preview workflow marker is not present in origin/main")
    if MIGRATION_MARKER not in cp.stdout:
        raise PreviewWorktreeError(
            "PREVIEW_MIGRATION_MARKER_MISMATCH",
            "origin/main does not contain the expected preview workflow version",
            details={"expected": MIGRATION_MARKER},
        )
    return main_sha


def inspect_preview_root(repo_root: Path, preview_root: Path) -> dict[str, Any]:
    worktrees = list_worktrees(repo_root)
    branch = branch_at_path(worktrees, preview_root)
    exists = preview_root.exists()
    result: dict[str, Any] = {"exists": exists, "registeredBranch": branch}
    if branch is not None:
        cp_head = git(preview_root, "rev-parse", "HEAD")
        cp_status = git(preview_root, "status", "--porcelain", "--untracked-files=all")
        cp_top = git(preview_root, "rev-parse", "--show-toplevel")
        result.update(
            {
                "head": cp_head.stdout.strip().lower() if cp_head.returncode == 0 else None,
                "clean": cp_status.returncode == 0 and not cp_status.stdout.strip(),
                "topLevel": cp_top.stdout.strip() if cp_top.returncode == 0 else None,
            }
        )
    return result


def preflight_setup(repo_root: Path, preview_root: Path, remote_preview_sha: str) -> tuple[list[dict[str, str]], str | None]:
    worktrees = list_worktrees(repo_root)
    at_target = branch_at_path(worktrees, preview_root)
    existing_preview_paths = paths_for_branch(worktrees, PREVIEW_BRANCH)

    if at_target is not None:
        if at_target != PREVIEW_BRANCH:
            raise PreviewWorktreeError(
                "PREVIEW_ROOT_REGISTERED_WRONG_BRANCH",
                "preview root is already a worktree for another branch",
                details={"previewRoot": str(preview_root), "actualBranch": at_target},
            )
        return worktrees, local_branch_sha(repo_root, PREVIEW_BRANCH)

    if preview_root.exists():
        raise PreviewWorktreeError(
            "PREVIEW_ROOT_EXISTS_UNMANAGED",
            "preview root already exists but is not the expected registered worktree; nothing was deleted",
            details={"previewRoot": str(preview_root)},
        )

    if existing_preview_paths:
        raise PreviewWorktreeError(
            "PREVIEW_BRANCH_ALREADY_IN_OTHER_WORKTREE",
            "local preview branch is already checked out in another worktree",
            details={"paths": [str(p) for p in existing_preview_paths]},
        )

    local_sha = local_branch_sha(repo_root, PREVIEW_BRANCH)
    if local_sha is not None and local_sha != remote_preview_sha:
        raise PreviewWorktreeError(
            "PREVIEW_LOCAL_BRANCH_DIVERGED",
            "local preview branch exists on a different SHA; refusing to move it automatically",
            details={"localPreview": local_sha, "originPreview": remote_preview_sha},
        )
    return worktrees, local_sha


def setup_worktree(repo_root: Path, preview_root: Path, remote_preview_sha: str) -> dict[str, Any]:
    _, local_sha = preflight_setup(repo_root, preview_root, remote_preview_sha)
    current = inspect_preview_root(repo_root, preview_root)
    if current.get("registeredBranch") == PREVIEW_BRANCH:
        if current.get("head") != remote_preview_sha:
            raise PreviewWorktreeError(
                "PREVIEW_EXISTING_WORKTREE_NOT_AT_REMOTE",
                "existing preview worktree is not at origin/preview; use update if it is clean",
                details={"head": current.get("head"), "originPreview": remote_preview_sha},
            )
        if current.get("clean") is not True:
            raise PreviewWorktreeError(
                "PREVIEW_EXISTING_WORKTREE_DIRTY",
                "existing preview worktree has local changes; refusing to report it ready",
                details={"state": current},
            )
        return {"created": False, "idempotent": True, "state": current}

    preview_root.parent.mkdir(parents=True, exist_ok=True)
    if local_sha is None:
        cp = git(repo_root, "worktree", "add", "--track", "-b", PREVIEW_BRANCH, str(preview_root), "origin/preview", timeout=180)
    else:
        cp = git(repo_root, "worktree", "add", str(preview_root), PREVIEW_BRANCH, timeout=180)
    require_ok(cp, "PREVIEW_WORKTREE_ADD_FAILED", "cannot create permanent preview worktree")

    state = inspect_preview_root(repo_root, preview_root)
    if state.get("registeredBranch") != PREVIEW_BRANCH or state.get("head") != remote_preview_sha or state.get("clean") is not True:
        raise PreviewWorktreeError(
            "PREVIEW_WORKTREE_VERIFY_FAILED",
            "preview worktree was created but verification failed; do not delete it automatically",
            details={"state": state, "originPreview": remote_preview_sha},
        )
    return {"created": True, "idempotent": False, "state": state}


def action_bootstrap(repo_root: Path, preview_root: Path, repository: str) -> dict[str, Any]:
    root = resolve_repo_root(repo_root)
    origin_url = assert_origin_repository(root, repository)
    fetched = git(root, "fetch", "--prune", "origin", timeout=180)
    require_ok(fetched, "PREVIEW_FETCH_FAILED", "git fetch --prune origin failed")
    main_sha = require_migration_merged(root)

    existing_preview = remote_branch_sha(root, PREVIEW_BRANCH)
    if existing_preview is not None and existing_preview != main_sha:
        raise PreviewWorktreeError(
            "PREVIEW_REMOTE_ALREADY_INITIALIZED_DIFFERENT_SHA",
            "origin/preview already exists and differs from current origin/main; bootstrap will not rewrite it",
            details={"originMain": main_sha, "originPreview": existing_preview},
        )

    # Perform all local path/branch guards before creating the remote branch.
    preflight_setup(root, preview_root, existing_preview or main_sha)

    created_remote = False
    if existing_preview is None:
        pushed = git(root, "push", "origin", f"{main_sha}:refs/heads/{PREVIEW_BRANCH}", timeout=180)
        require_ok(pushed, "PREVIEW_REMOTE_CREATE_FAILED", "cannot create origin/preview from exact origin/main")
        created_remote = True

    fetched_preview = git(root, "fetch", "origin", f"{PREVIEW_BRANCH}:refs/remotes/origin/{PREVIEW_BRANCH}", timeout=180)
    require_ok(fetched_preview, "PREVIEW_FETCH_BRANCH_FAILED", "cannot fetch origin/preview after bootstrap")
    remote_preview = remote_branch_sha(root, PREVIEW_BRANCH)
    if remote_preview != main_sha:
        raise PreviewWorktreeError(
            "PREVIEW_REMOTE_VERIFY_FAILED",
            "origin/preview does not equal bootstrap origin/main SHA after creation",
            details={"originMain": main_sha, "originPreview": remote_preview},
        )

    worktree_result = setup_worktree(root, preview_root, remote_preview)
    return {
        "ok": True,
        "code": "PREVIEW_BOOTSTRAPPED",
        "repository": repository,
        "originUrl": origin_url,
        "repoRoot": str(root),
        "previewRoot": str(preview_root.resolve()),
        "originMain": main_sha,
        "originPreview": remote_preview,
        "remotePreviewCreated": created_remote,
        "worktree": worktree_result,
        "destructiveOperationsUsed": False,
    }


def action_setup(repo_root: Path, preview_root: Path, repository: str) -> dict[str, Any]:
    root = resolve_repo_root(repo_root)
    origin_url = assert_origin_repository(root, repository)
    fetched = git(root, "fetch", "--prune", "origin", timeout=180)
    require_ok(fetched, "PREVIEW_FETCH_FAILED", "git fetch --prune origin failed")
    remote_preview = remote_branch_sha(root, PREVIEW_BRANCH)
    if remote_preview is None:
        raise PreviewWorktreeError("PREVIEW_REMOTE_MISSING", "origin/preview does not exist; use bootstrap after migration merge")
    worktree_result = setup_worktree(root, preview_root, remote_preview)
    return {
        "ok": True,
        "code": "PREVIEW_WORKTREE_READY",
        "repository": repository,
        "originUrl": origin_url,
        "repoRoot": str(root),
        "previewRoot": str(preview_root.resolve()),
        "originPreview": remote_preview,
        "worktree": worktree_result,
        "destructiveOperationsUsed": False,
    }


def require_expected_preview_worktree(repo_root: Path, preview_root: Path) -> dict[str, Any]:
    state = inspect_preview_root(repo_root, preview_root)
    if state.get("registeredBranch") != PREVIEW_BRANCH:
        raise PreviewWorktreeError(
            "PREVIEW_WORKTREE_NOT_CONFIGURED",
            "preview root is not a registered worktree on branch preview",
            details={"state": state},
        )
    if state.get("clean") is not True:
        raise PreviewWorktreeError(
            "PREVIEW_WORKTREE_DIRTY",
            "preview worktree has local changes; refusing automatic update",
            details={"state": state},
        )
    return state


def action_update(repo_root: Path, preview_root: Path, repository: str) -> dict[str, Any]:
    root = resolve_repo_root(repo_root)
    origin_url = assert_origin_repository(root, repository)
    before = require_expected_preview_worktree(root, preview_root)
    fetched = git(root, "fetch", "--prune", "origin", timeout=180)
    require_ok(fetched, "PREVIEW_FETCH_FAILED", "git fetch --prune origin failed")
    remote_preview = tracked_branch_sha(root, PREVIEW_BRANCH)
    if remote_preview is None:
        raise PreviewWorktreeError("PREVIEW_REMOTE_MISSING", "origin/preview is unavailable after fetch")
    merged = git(preview_root, "merge", "--ff-only", "origin/preview", timeout=180)
    require_ok(merged, "PREVIEW_FAST_FORWARD_FAILED", "preview worktree cannot fast-forward to origin/preview")
    after = require_expected_preview_worktree(root, preview_root)
    if after.get("head") != remote_preview:
        raise PreviewWorktreeError(
            "PREVIEW_UPDATE_VERIFY_FAILED",
            "preview worktree HEAD does not equal origin/preview after ff-only update",
            details={"head": after.get("head"), "originPreview": remote_preview},
        )
    return {
        "ok": True,
        "code": "PREVIEW_WORKTREE_UPDATED",
        "repository": repository,
        "originUrl": origin_url,
        "repoRoot": str(root),
        "previewRoot": str(preview_root.resolve()),
        "before": before,
        "after": after,
        "originPreview": remote_preview,
        "destructiveOperationsUsed": False,
    }


def action_status(repo_root: Path, preview_root: Path, repository: str) -> dict[str, Any]:
    root = resolve_repo_root(repo_root)
    origin_url = assert_origin_repository(root, repository)
    return {
        "ok": True,
        "code": "PREVIEW_WORKTREE_STATUS",
        "repository": repository,
        "originUrl": origin_url,
        "repoRoot": str(root),
        "previewRoot": str(preview_root.resolve()),
        "originMain": remote_branch_sha(root, "main"),
        "originPreview": remote_branch_sha(root, PREVIEW_BRANCH),
        "localPreview": local_branch_sha(root, PREVIEW_BRANCH),
        "worktree": inspect_preview_root(root, preview_root),
        "destructiveOperationsUsed": False,
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Safely manage the permanent dsh preview worktree")
    p.add_argument("action", choices=("bootstrap", "setup", "update", "status"))
    p.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT)
    p.add_argument("--preview-root", type=Path, default=DEFAULT_PREVIEW_ROOT)
    p.add_argument("--repository", default=DEFAULT_REPOSITORY)
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        action_map = {
            "bootstrap": action_bootstrap,
            "setup": action_setup,
            "update": action_update,
            "status": action_status,
        }
        result = action_map[args.action](args.repo_root, args.preview_root, args.repository)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except PreviewWorktreeError as exc:
        print(
            json.dumps(
                {"ok": False, "code": exc.code, "error": str(exc), "details": exc.details, "destructiveOperationsUsed": False},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 2
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "code": "PREVIEW_WORKTREE_INTERNAL_ERROR", "error": str(exc), "destructiveOperationsUsed": False},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
