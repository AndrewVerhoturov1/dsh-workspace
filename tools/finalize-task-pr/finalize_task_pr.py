#!/usr/bin/env python3
"""Squash-merge already-reviewed task PRs into preview and clean temp resources.

This executor is deliberately not a reviewer. It does not run tests, inspect PR
Diffs, re-check CI, or rebuild the user's merge decision. It only accepts PRs
whose base is the permanent integration branch ``preview`` and it protects both
permanent local worktrees from cleanup.
"""
from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping
import json
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any
from urllib.parse import urlparse

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
DEFAULT_REPO_ROOT = Path(r"C:\Users\andre\.dsh")
DEFAULT_PREVIEW_ROOT = Path(r"C:\Users\andre\.dsh-preview")
WINDOWS_GH_PROGRAM_FILES = Path(r"C:\Program Files\GitHub CLI\gh.exe")
GH_NOT_FOUND_HINT = "Установите GitHub CLI или задайте DSH_GH_PATH, указывающий на существующий gh.exe."
PERMANENT_BRANCHES = {"main", "preview"}


class FinalizeError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _existing_absolute_file(value: str | os.PathLike[str]) -> Path | None:
    try:
        candidate = Path(os.path.expandvars(os.fspath(value))).expanduser().resolve()
        return candidate if candidate.is_file() else None
    except (OSError, RuntimeError, TypeError):
        return None


def _env_value(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    if value is not None:
        return value
    for key, candidate in env.items():
        if key.casefold() == name.casefold():
            return candidate
    return None


def _windows_gh_candidates(env: Mapping[str, str]) -> list[Path]:
    candidates = [WINDOWS_GH_PROGRAM_FILES]
    local_app_data = _env_value(env, "LOCALAPPDATA")
    if local_app_data:
        candidates.append(Path(os.path.expandvars(local_app_data)) / "Programs" / "GitHub CLI" / "gh.exe")
    return candidates


def resolve_gh_executable(
    *,
    env: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] | None = None,
) -> str:
    """Resolve an existing absolute GitHub CLI executable in a stable order."""
    environment = os.environ if env is None else env
    attempts: list[dict[str, str]] = []

    configured = _env_value(environment, "DSH_GH_PATH")
    if configured and configured.strip():
        configured_path = configured.strip().strip('"')
        attempts.append({"source": "DSH_GH_PATH", "path": os.path.expandvars(configured_path)})
        resolved = _existing_absolute_file(configured_path)
        if resolved is not None:
            return str(resolved)

    which_fn = shutil.which if which is None else which
    try:
        which_result = which_fn("gh")
    except OSError as exc:
        which_result = None
        attempts.append({"source": "shutil.which", "path": f"<ошибка: {exc}>"})
    if which_result:
        attempts.append({"source": "shutil.which", "path": which_result})
        resolved = _existing_absolute_file(which_result)
        if resolved is not None:
            return str(resolved)

    for candidate in _windows_gh_candidates(environment):
        attempts.append({"source": "standard Windows path", "path": str(candidate)})
        resolved = _existing_absolute_file(candidate)
        if resolved is not None:
            return str(resolved)

    raise FinalizeError(
        "FINALIZE_GH_NOT_FOUND",
        f"GitHub CLI (gh.exe) не найден. {GH_NOT_FOUND_HINT}",
        details={"executable": "gh", "candidates": attempts, "hint": GH_NOT_FOUND_HINT},
    )


def run_process(args: list[str], *, cwd: Path | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    """Run argv directly, without shell and without a visible console window."""
    try:
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
    except FileNotFoundError as exc:
        executable = args[0] if args else ""
        raise FinalizeError(
            "FINALIZE_EXECUTABLE_NOT_FOUND",
            f"Не найден исполняемый файл: {executable}",
            details={"executable": executable, "argv": list(args)},
        ) from exc


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


def gh_pr(repository: str, number: int, *, cwd: Path, gh_executable: str) -> dict[str, Any]:
    cp = run_process([gh_executable, "api", f"repos/{repository}/pulls/{number}"], cwd=cwd)
    return _json_from(cp, "FINALIZE_PR_READ_FAILED", f"cannot read PR #{number}")


def merge_squash(repository: str, number: int, *, cwd: Path, gh_executable: str) -> dict[str, Any]:
    cp = run_process(
        [gh_executable, "api", "-X", "PUT", f"repos/{repository}/pulls/{number}/merge", "-f", "merge_method=squash"],
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
    _require_ok(cp, "FINALIZE_ORIGIN_READ_FAILED", "cannot read origin URL")
    url = cp.stdout.strip()
    actual = normalize_github_repository_url(url)
    expected = repository.lower()
    if actual != expected:
        raise FinalizeError(
            "FINALIZE_ORIGIN_REPOSITORY_MISMATCH",
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


def origin_preview_sha(repo_root: Path) -> str | None:
    cp = git(repo_root, "rev-parse", "refs/remotes/origin/preview")
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
    protected_worktrees: set[Path],
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
        resolved_path = path.resolve()
        if resolved_path in protected_worktrees:
            remaining_worktree = True
            _warn(
                warnings,
                "FINALIZE_PERMANENT_WORKTREE_PROTECTED",
                "permanent repository worktree is never removed",
                path=str(resolved_path),
            )
            continue
        status = git(resolved_path, "status", "--porcelain", "--untracked-files=all")
        if status.returncode != 0:
            remaining_worktree = True
            _warn(warnings, "FINALIZE_WORKTREE_STATUS_UNKNOWN", "could not inspect worktree; leaving it untouched", path=str(resolved_path))
            continue
        if status.stdout.strip():
            remaining_worktree = True
            _warn(warnings, "FINALIZE_DIRTY_WORKTREE_SKIPPED", "dirty worktree left untouched", path=str(resolved_path))
            continue
        if dry_run:
            result["worktreesRemoved"].append(str(resolved_path))
            continue
        removed = git(repo_root, "worktree", "remove", str(resolved_path))
        if removed.returncode == 0:
            result["worktreesRemoved"].append(str(resolved_path))
        else:
            remaining_worktree = True
            _warn(
                warnings,
                "FINALIZE_WORKTREE_REMOVE_FAILED",
                "clean worktree could not be removed; continuing best-effort cleanup",
                path=str(resolved_path),
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
    preview_root: Path,
    repository: str,
    number: int,
    *,
    dry_run: bool = False,
    gh_executable: str | None = None,
) -> dict[str, Any]:
    resolved_gh = resolve_gh_executable() if gh_executable is None else gh_executable
    pr = gh_pr(repository, number, cwd=repo_root, gh_executable=resolved_gh)
    state = str(pr.get("state") or "").lower()
    merged_at = pr.get("merged_at")
    base = ((pr.get("base") or {}).get("ref") if isinstance(pr.get("base"), dict) else None)
    head_obj = pr.get("head") if isinstance(pr.get("head"), dict) else {}
    head = head_obj.get("ref")
    head_sha = str(head_obj.get("sha") or "").lower()
    head_repo_obj = head_obj.get("repo") if isinstance(head_obj.get("repo"), dict) else {}
    head_repo = head_repo_obj.get("full_name")

    if base != "preview":
        raise FinalizeError("FINALIZE_BASE_NOT_PREVIEW", f"PR #{number} targets {base!r}, not preview")
    if not isinstance(head, str) or not head or not head_sha:
        raise FinalizeError("FINALIZE_PR_IDENTITY_INVALID", f"PR #{number} has incomplete head identity")
    if head in PERMANENT_BRANCHES:
        raise FinalizeError(
            "FINALIZE_PERMANENT_BRANCH_PROTECTED",
            f"refusing to treat permanent branch {head!r} as a temporary task PR branch",
        )

    already_merged = bool(merged_at)
    if not already_merged and state != "open":
        raise FinalizeError("FINALIZE_PR_NOT_OPEN", f"PR #{number} is {state or 'unknown'} and is not merged")

    merge_sha: str | None = None
    if dry_run:
        merged_now = not already_merged
    elif already_merged:
        merged_now = False
        merge_sha = str(pr.get("merge_commit_sha") or "").lower() or None
    else:
        merged = merge_squash(repository, number, cwd=repo_root, gh_executable=resolved_gh)
        merged_now = True
        merge_sha = str(merged.get("sha") or "").lower() or None

    fetch_warning: dict[str, Any] | None = None
    if not dry_run:
        fetched = git(repo_root, "fetch", "--prune", "origin", timeout=180)
        if fetched.returncode != 0:
            fetch_warning = {
                "code": "FINALIZE_FETCH_WARNING",
                "message": "merge succeeded but fetch --prune failed; cleanup will continue best-effort",
                "stderr": fetched.stderr[-2000:],
            }

    protected_worktrees = {repo_root.resolve(), preview_root.resolve()}
    cleanup = cleanup_branch_resources(
        repo_root,
        branch=head,
        expected_head=head_sha,
        same_repository=(head_repo == repository),
        dry_run=dry_run,
        protected_worktrees=protected_worktrees,
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
        "originPreview": None if dry_run else origin_preview_sha(repo_root),
    }


def finalize_many(
    *,
    repo_root: Path,
    preview_root: Path,
    repository: str,
    pr_numbers: list[int],
    dry_run: bool = False,
) -> dict[str, Any]:
    root = resolve_repo_root(repo_root)
    preview = preview_root.resolve()
    origin_url = assert_origin_repository(root, repository)
    gh_executable = resolve_gh_executable()
    results: list[dict[str, Any]] = []
    for number in pr_numbers:
        results.append(
            finalize_one(
                root,
                preview,
                repository,
                number,
                dry_run=dry_run,
                gh_executable=gh_executable,
            )
        )

    warnings = [warning for item in results for warning in item["cleanup"]["warnings"]]
    code = "TASK_PRS_DRY_RUN" if dry_run else ("TASK_PRS_FINALIZED_WITH_WARNINGS" if warnings else "TASK_PRS_FINALIZED")
    return {
        "ok": True,
        "code": code,
        "repository": repository,
        "repoRoot": str(root),
        "previewRoot": str(preview),
        "originUrl": origin_url,
        "targetBranch": "preview",
        "mergeMethod": "squash",
        "prNumbers": pr_numbers,
        "results": results,
        "warnings": warnings,
        "mainWorkingTreeTouched": False,
        "previewWorkingTreeTouched": False,
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Squash-merge already-reviewed task PRs into preview and clean temporary Git resources")
    p.add_argument("--pr", type=int, action="append", required=True, dest="prs", help="PR number; repeat for multiple PRs")
    p.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT)
    p.add_argument("--preview-root", type=Path, default=DEFAULT_PREVIEW_ROOT)
    p.add_argument("--repository", default=DEFAULT_REPOSITORY)
    p.add_argument("--what-if", action="store_true", help="show intended actions without merge/delete")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = finalize_many(
            repo_root=args.repo_root,
            preview_root=args.preview_root,
            repository=args.repository,
            pr_numbers=args.prs,
            dry_run=args.what_if,
        )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except FinalizeError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "code": exc.code,
                    "error": str(exc),
                    "details": exc.details,
                    "mainWorkingTreeTouched": False,
                    "previewWorkingTreeTouched": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 2
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "code": "FINALIZE_INTERNAL_ERROR",
                    "error": str(exc),
                    "mainWorkingTreeTouched": False,
                    "previewWorkingTreeTouched": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
