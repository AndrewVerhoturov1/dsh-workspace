#!/usr/bin/env python3
"""Promote the exact current preview PR into main with a merge commit.

The executor accepts only base=main/head=preview and requires the explicit PR
body marker MAIN_GO_APPROVED_BY_USER: yes. It never deletes preview. After a
successful merge it may fast-forward remote preview to the merge commit using a
normal non-force push, but only if refs still prove that operation safe.
"""
from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any
from urllib.parse import urlparse

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
DEFAULT_REPO_ROOT = Path(r"C:\Users\andre\.dsh")
DEFAULT_PREVIEW_ROOT = Path(r"C:\Users\andre\.dsh-preview")
WINDOWS_GH_PROGRAM_FILES = Path(r"C:\Program Files\GitHub CLI\gh.exe")
GO_MARKER = re.compile(r"(?im)^\s*MAIN_GO_APPROVED_BY_USER:\s*yes\s*$")
GH_NOT_FOUND_HINT = "Установите GitHub CLI или задайте DSH_GH_PATH, указывающий на существующий gh.exe."


class PromotionError(RuntimeError):
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


def resolve_gh_executable(*, env: Mapping[str, str] | None = None, which: Callable[[str], str | None] | None = None) -> str:
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

    candidates = [WINDOWS_GH_PROGRAM_FILES]
    local_app_data = _env_value(environment, "LOCALAPPDATA")
    if local_app_data:
        candidates.append(Path(os.path.expandvars(local_app_data)) / "Programs" / "GitHub CLI" / "gh.exe")
    for candidate in candidates:
        attempts.append({"source": "standard Windows path", "path": str(candidate)})
        resolved = _existing_absolute_file(candidate)
        if resolved is not None:
            return str(resolved)

    raise PromotionError(
        "PROMOTE_GH_NOT_FOUND",
        f"GitHub CLI (gh.exe) не найден. {GH_NOT_FOUND_HINT}",
        details={"executable": "gh", "candidates": attempts, "hint": GH_NOT_FOUND_HINT},
    )


def run_process(args: list[str], *, cwd: Path | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
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
        raise PromotionError(
            "PROMOTE_EXECUTABLE_NOT_FOUND",
            f"Не найден исполняемый файл: {executable}",
            details={"executable": executable, "argv": list(args)},
        ) from exc


def _require_ok(cp: subprocess.CompletedProcess[str], code: str, message: str) -> subprocess.CompletedProcess[str]:
    if cp.returncode != 0:
        raise PromotionError(
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
        raise PromotionError(code, f"{message}: invalid JSON", details={"stdout": cp.stdout[-4000:]}) from exc
    if not isinstance(value, dict):
        raise PromotionError(code, f"{message}: JSON object expected")
    return value


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
    _require_ok(cp, "PROMOTE_ORIGIN_READ_FAILED", "cannot read origin URL")
    url = cp.stdout.strip()
    actual = normalize_github_repository_url(url)
    expected = repository.lower()
    if actual != expected:
        raise PromotionError(
            "PROMOTE_ORIGIN_REPOSITORY_MISMATCH",
            "origin does not point to the expected GitHub repository",
            details={"expectedRepository": repository, "actualRepository": actual, "originUrl": url},
        )
    return url

def gh_pr(repository: str, number: int, *, cwd: Path, gh_executable: str) -> dict[str, Any]:
    cp = run_process([gh_executable, "api", f"repos/{repository}/pulls/{number}"], cwd=cwd)
    return _json_from(cp, "PROMOTE_PR_READ_FAILED", f"cannot read PR #{number}")


def merge_commit(repository: str, number: int, *, cwd: Path, gh_executable: str) -> dict[str, Any]:
    cp = run_process(
        [gh_executable, "api", "-X", "PUT", f"repos/{repository}/pulls/{number}/merge", "-f", "merge_method=merge"],
        cwd=cwd,
        timeout=180,
    )
    data = _json_from(cp, "PROMOTE_MERGE_FAILED", f"merge failed for PR #{number}")
    if data.get("merged") is not True:
        raise PromotionError("PROMOTE_MERGE_REJECTED", f"GitHub did not merge PR #{number}", details={"response": data})
    return data


def remote_branch_sha(repo_root: Path, branch: str) -> str | None:
    cp = git(repo_root, "ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    if cp.returncode != 0:
        raise PromotionError(
            "PROMOTE_REMOTE_REF_READ_FAILED",
            f"cannot read origin/{branch}",
            details={"stderr": cp.stderr[-2000:]},
        )
    line = cp.stdout.strip()
    return line.split()[0].lower() if line else None


def tracked_ref_sha(repo_root: Path, branch: str) -> str | None:
    cp = git(repo_root, "rev-parse", f"refs/remotes/origin/{branch}")
    if cp.returncode != 0:
        return None
    value = cp.stdout.strip().lower()
    return value or None


def _warn(warnings: list[dict[str, Any]], code: str, message: str, **details: Any) -> None:
    warnings.append({"code": code, "message": message, **details})


def promote(
    *,
    repo_root: Path,
    preview_root: Path,
    repository: str,
    pr_number: int,
    dry_run: bool = False,
) -> dict[str, Any]:
    root = resolve_repo_root(repo_root)
    preview_path = preview_root.resolve()
    origin_url = assert_origin_repository(root, repository)
    gh = resolve_gh_executable()
    pr = gh_pr(repository, pr_number, cwd=root, gh_executable=gh)

    state = str(pr.get("state") or "").lower()
    merged_at = pr.get("merged_at")
    base_obj = pr.get("base") if isinstance(pr.get("base"), dict) else {}
    head_obj = pr.get("head") if isinstance(pr.get("head"), dict) else {}
    base = base_obj.get("ref")
    head = head_obj.get("ref")
    head_sha = str(head_obj.get("sha") or "").lower()
    head_repo_obj = head_obj.get("repo") if isinstance(head_obj.get("repo"), dict) else {}
    head_repo = head_repo_obj.get("full_name")
    body = str(pr.get("body") or "")

    if base != "main":
        raise PromotionError("PROMOTE_BASE_NOT_MAIN", f"PR #{pr_number} targets {base!r}, not main")
    if head != "preview":
        raise PromotionError("PROMOTE_HEAD_NOT_PREVIEW", f"PR #{pr_number} head is {head!r}, not preview")
    if head_repo != repository:
        raise PromotionError("PROMOTE_HEAD_REPOSITORY_MISMATCH", "promotion must use preview from the same repository")
    if not head_sha:
        raise PromotionError("PROMOTE_PR_IDENTITY_INVALID", f"PR #{pr_number} has incomplete preview head SHA")
    if not GO_MARKER.search(body):
        raise PromotionError(
            "PROMOTE_MAIN_GO_MARKER_MISSING",
            "PR body must contain MAIN_GO_APPROVED_BY_USER: yes",
        )

    already_merged = bool(merged_at)
    if not already_merged and state != "open":
        raise PromotionError("PROMOTE_PR_NOT_OPEN", f"PR #{pr_number} is {state or 'unknown'} and is not merged")

    remote_preview_before = remote_branch_sha(root, "preview")
    if remote_preview_before is None:
        raise PromotionError("PROMOTE_PREVIEW_MISSING", "origin/preview does not exist")

    if not already_merged and remote_preview_before != head_sha:
        raise PromotionError(
            "PROMOTE_PREVIEW_MOVED",
            "origin/preview no longer equals the exact PR head; create/update the promotion PR for the current preview",
            details={"prHead": head_sha, "originPreview": remote_preview_before},
        )

    merge_sha: str | None
    merged_now: bool
    if dry_run:
        merge_sha = None
        merged_now = not already_merged
    elif already_merged:
        merge_sha = str(pr.get("merge_commit_sha") or "").lower() or None
        if not merge_sha:
            raise PromotionError("PROMOTE_MERGED_PR_SHA_MISSING", "merged promotion PR has no merge_commit_sha")
        merged_now = False
    else:
        merged = merge_commit(repository, pr_number, cwd=root, gh_executable=gh)
        merge_sha = str(merged.get("sha") or "").lower() or None
        if not merge_sha:
            raise PromotionError("PROMOTE_MERGE_SHA_MISSING", "GitHub merged the PR but did not return a merge SHA")
        merged_now = True

    warnings: list[dict[str, Any]] = []
    preview_sync = "not-run" if dry_run else "pending"
    origin_main = None
    origin_preview = remote_preview_before

    if not dry_run:
        fetched = git(root, "fetch", "--prune", "origin", timeout=180)
        if fetched.returncode != 0:
            raise PromotionError(
                "PROMOTE_FETCH_AFTER_MERGE_FAILED",
                "promotion may have merged, but git fetch --prune failed; do not guess refs",
                details={"mergeSha": merge_sha, "stderr": fetched.stderr[-2000:]},
            )

        origin_main = tracked_ref_sha(root, "main")
        origin_preview = remote_branch_sha(root, "preview")

        if origin_main != merge_sha:
            preview_sync = "skipped-main-moved"
            _warn(
                warnings,
                "PROMOTE_MAIN_MOVED_AFTER_MERGE",
                "origin/main does not equal the promotion merge SHA; preview was not moved",
                mergeSha=merge_sha,
                originMain=origin_main,
            )
        elif origin_preview == merge_sha:
            preview_sync = "already-synced"
        elif origin_preview != head_sha:
            preview_sync = "skipped-preview-moved"
            _warn(
                warnings,
                "PROMOTE_PREVIEW_MOVED_AFTER_MERGE",
                "origin/preview moved after the checked PR head; preview was not rewritten",
                expectedHead=head_sha,
                originPreview=origin_preview,
            )
        else:
            pushed = git(root, "push", "origin", f"{merge_sha}:refs/heads/preview", timeout=180)
            if pushed.returncode != 0:
                preview_sync = "push-failed"
                _warn(
                    warnings,
                    "PROMOTE_PREVIEW_FAST_FORWARD_FAILED",
                    "main promotion succeeded but non-force preview fast-forward failed",
                    stderr=pushed.stderr[-2000:],
                )
            else:
                refetched = git(root, "fetch", "--prune", "origin", timeout=180)
                if refetched.returncode != 0:
                    preview_sync = "synced-fetch-warning"
                    _warn(
                        warnings,
                        "PROMOTE_FETCH_AFTER_PREVIEW_SYNC_WARNING",
                        "preview push succeeded but final fetch failed",
                        stderr=refetched.stderr[-2000:],
                    )
                else:
                    preview_sync = "synced"
                origin_preview = remote_branch_sha(root, "preview")
                origin_main = tracked_ref_sha(root, "main")

    code = "PREVIEW_PROMOTION_DRY_RUN" if dry_run else ("PREVIEW_PROMOTED_WITH_WARNINGS" if warnings else "PREVIEW_PROMOTED")
    return {
        "ok": True,
        "code": code,
        "repository": repository,
        "repoRoot": str(root),
        "previewRoot": str(preview_path),
        "originUrl": origin_url,
        "prNumber": pr_number,
        "url": pr.get("html_url"),
        "base": base,
        "head": head,
        "previewHeadSha": head_sha,
        "alreadyMerged": already_merged,
        "mergedNow": merged_now,
        "mergeMethod": "merge",
        "mergeSha": merge_sha,
        "previewSync": preview_sync,
        "originMain": origin_main,
        "originPreview": origin_preview,
        "warnings": warnings,
        "mainWorkingTreeTouched": False,
        "previewWorkingTreeTouched": False,
        "previewBranchDeleted": False,
    }


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Promote exact preview PR into main using a merge commit")
    p.add_argument("--pr", type=int, required=True)
    p.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT)
    p.add_argument("--preview-root", type=Path, default=DEFAULT_PREVIEW_ROOT)
    p.add_argument("--repository", default=DEFAULT_REPOSITORY)
    p.add_argument("--what-if", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = promote(
            repo_root=args.repo_root,
            preview_root=args.preview_root,
            repository=args.repository,
            pr_number=args.pr,
            dry_run=args.what_if,
        )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except PromotionError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "code": exc.code,
                    "error": str(exc),
                    "details": exc.details,
                    "mainWorkingTreeTouched": False,
                    "previewWorkingTreeTouched": False,
                    "previewBranchDeleted": False,
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
                    "code": "PROMOTE_INTERNAL_ERROR",
                    "error": str(exc),
                    "mainWorkingTreeTouched": False,
                    "previewWorkingTreeTouched": False,
                    "previewBranchDeleted": False,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
