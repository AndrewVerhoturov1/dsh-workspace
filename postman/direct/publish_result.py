#!/usr/bin/env python3
"""Deterministic TEST_PASSED -> commit/push/PR publisher."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import finalization_common as common  # noqa: E402

PUBLISH_VERSION = 1


def _gh_api(
    repository: str,
    endpoint: str,
    *,
    gh_binary: str = "gh",
    method: str | None = None,
    payload: dict[str, Any] | None = None,
) -> Any:
    command = [gh_binary, "api", endpoint]
    if method:
        command += ["--method", method]
    input_text = None
    if payload is not None:
        command += ["--input", "-"]
        input_text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    result = common.run_process(command, input_text=input_text)
    if result.returncode != 0:
        raise common.FinalizationError(
            "PUBLISH_GITHUB_FAILED",
            f"gh api failed for {endpoint}",
            details={"returncode": result.returncode, "stderr": result.stderr[-4000:]},
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise common.FinalizationError("PUBLISH_GITHUB_FAILED", "gh api returned invalid JSON") from exc


def _exact_remote_sha(repo_root: Path, branch: str) -> str | None:
    result = common.run_git(
        repo_root,
        "ls-remote",
        "--heads",
        "origin",
        f"refs/heads/{branch}",
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    first = result.stdout.splitlines()[0].split()
    return first[0].lower() if first else None


def _open_pr_for_branch(
    repository: str,
    branch: str,
    *,
    gh_binary: str,
    gh_api: Callable[..., Any],
) -> dict[str, Any] | None:
    value = gh_api(repository, f"repos/{repository}/pulls?state=open&per_page=100", gh_binary=gh_binary)
    if not isinstance(value, list):
        raise common.FinalizationError("PUBLISH_GITHUB_FAILED", "open PR response must be an array")
    matches = [
        item
        for item in value
        if isinstance(item, dict)
        and isinstance(item.get("head"), dict)
        and item["head"].get("ref") == branch
    ]
    if len(matches) > 1:
        raise common.FinalizationError(
            "PUBLISH_PR_IDENTITY_MISMATCH",
            "multiple open PRs exist for task branch",
            details={"branch": branch, "count": len(matches)},
        )
    return matches[0] if matches else None


def publish(
    *,
    ready_json: Path,
    test_json: Path,
    gh_binary: str = "gh",
    commit_message: str | None = None,
    pr_title: str | None = None,
    gh_api: Callable[..., Any] = _gh_api,
) -> dict[str, Any]:
    ready = common.validate_ready(common.load_json_file(ready_json))
    test = common.validate_test_receipt(common.load_json_file(test_json))

    for key in ("requestId", "branch", "worktree"):
        if test.get(key) != ready.get(key):
            raise common.FinalizationError(
                "PUBLISH_TEST_RECEIPT_MISMATCH",
                f"test receipt {key} does not match READY_FOR_TEST",
            )
    if sorted(test.get("changedFiles", [])) != sorted(ready["changedFiles"]):
        raise common.FinalizationError("PUBLISH_TEST_RECEIPT_MISMATCH", "changedFiles mismatch")
    if test["readyJsonSha256"] != common.sha256_file(ready_json):
        raise common.FinalizationError("PUBLISH_TEST_RECEIPT_MISMATCH", "READY_FOR_TEST JSON changed after test")

    worktree = Path(ready["worktree"]).resolve()
    repo_root = Path(ready["repoRoot"]).resolve()
    branch = ready["branch"]
    request_id = ready["requestId"]
    repository = ready["repository"]

    actual_branch = common.run_git(worktree, "branch", "--show-current").stdout.strip()
    if actual_branch != branch:
        raise common.FinalizationError(
            "PUBLISH_BRANCH_MISMATCH",
            "worktree branch changed after test",
            details={"expected": branch, "actual": actual_branch},
        )
    head_before = common.run_git(worktree, "rev-parse", "HEAD").stdout.strip().lower()
    if head_before != ready["originMain"].lower():
        raise common.FinalizationError(
            "PUBLISH_HEAD_MISMATCH",
            "worktree HEAD changed after test",
            details={"expected": ready["originMain"], "actual": head_before},
        )

    paths = common.changed_paths(worktree)
    if paths != sorted(ready["changedFiles"]):
        raise common.FinalizationError(
            "PUBLISH_CHANGED_FILES_MISMATCH",
            "worktree paths differ from READY_FOR_TEST",
            details={"expected": sorted(ready["changedFiles"]), "actual": paths},
        )
    fingerprint, _ = common.fingerprint_paths(worktree, paths)
    if fingerprint != test["worktreeFingerprint"]:
        raise common.FinalizationError(
            "PUBLISH_TEST_RECEIPT_MISMATCH",
            "implementation bytes changed after TEST_PASSED",
            details={"expected": test["worktreeFingerprint"], "actual": fingerprint},
        )

    diff_check = common.run_git(worktree, "diff", "--check", check=False)
    if diff_check.returncode != 0:
        raise common.FinalizationError(
            "PUBLISH_DIFF_CHECK_FAILED",
            "git diff --check failed",
            details={"stdout": diff_check.stdout, "stderr": diff_check.stderr},
        )

    staged_before = common.run_git(worktree, "diff", "--cached", "--name-only", "--no-renames").stdout.splitlines()
    if [x for x in staged_before if x]:
        raise common.FinalizationError(
            "PUBLISH_INDEX_DIRTY",
            "index already contains staged changes before deterministic publication",
            details={"staged": staged_before},
        )

    common.run_git(worktree, "add", "--", *paths)
    staged = sorted(
        x
        for x in common.run_git(worktree, "diff", "--cached", "--name-only", "--no-renames").stdout.splitlines()
        if x
    )
    if staged != sorted(paths):
        raise common.FinalizationError(
            "PUBLISH_CHANGED_FILES_MISMATCH",
            "staged paths differ from READY_FOR_TEST",
            details={"expected": sorted(paths), "actual": staged},
        )

    unstaged = [x for x in common.run_git(worktree, "diff", "--name-only", "--no-renames").stdout.splitlines() if x]
    untracked = [x for x in common.run_git(worktree, "ls-files", "--others", "--exclude-standard").stdout.splitlines() if x]
    if unstaged or untracked:
        raise common.FinalizationError(
            "PUBLISH_UNEXPECTED_PATH",
            "unpublished unstaged/untracked paths remain after exact staging",
            details={"unstaged": unstaged, "untracked": untracked},
        )

    message = commit_message or f"postman: apply {request_id}"
    commit = common.run_git(worktree, "commit", "-m", message, check=False)
    if commit.returncode != 0:
        raise common.FinalizationError(
            "PUBLISH_COMMIT_FAILED",
            "git commit failed",
            details={"stdout": commit.stdout[-4000:], "stderr": commit.stderr[-4000:]},
        )
    commit_sha = common.run_git(worktree, "rev-parse", "HEAD").stdout.strip().lower()

    status = common.run_git(worktree, "status", "--porcelain", "--untracked-files=all").stdout
    if status.strip():
        raise common.FinalizationError(
            "PUBLISH_WORKTREE_NOT_CLEAN",
            "worktree is not clean after commit",
            details={"status": status.splitlines()[:100]},
        )

    push = common.run_git(worktree, "push", "--set-upstream", "origin", branch, check=False)
    if push.returncode != 0:
        raise common.FinalizationError(
            "PUBLISH_PUSH_FAILED",
            "git push failed",
            details={"stdout": push.stdout[-4000:], "stderr": push.stderr[-4000:], "commitSha": commit_sha},
        )

    remote_sha = _exact_remote_sha(worktree, branch)
    if remote_sha != commit_sha:
        raise common.FinalizationError(
            "PUBLISH_REMOTE_SHA_MISMATCH",
            "remote branch SHA does not match local commit",
            details={"local": commit_sha, "remote": remote_sha},
        )

    existing = _open_pr_for_branch(repository, branch, gh_binary=gh_binary, gh_api=gh_api)
    title = pr_title or f"Postman: {request_id}"
    body = (
        f"## Direct Postman implementation\n\n"
        f"- request: `{request_id}`\n"
        f"- artifact SHA-256: `{ready.get('artifactSha256', '')}`\n"
        f"- changed files: {len(paths)}\n"
        f"- task test: `{' '.join(test['testCommand'])}`\n"
        f"- test duration: {test.get('durationMs', 0)} ms\n\n"
        "Merge не выполнялся автоматически."
    )

    if existing is None:
        pr = gh_api(
            repository,
            f"repos/{repository}/pulls",
            gh_binary=gh_binary,
            method="POST",
            payload={"title": title, "head": branch, "base": "main", "body": body},
        )
    else:
        pr = existing

    if not isinstance(pr, dict) or not isinstance(pr.get("number"), int):
        raise common.FinalizationError("PUBLISH_PR_FAILED", "GitHub did not return a pull request number")
    pr_number = pr["number"]
    verified = gh_api(repository, f"repos/{repository}/pulls/{pr_number}", gh_binary=gh_binary)
    if not isinstance(verified, dict):
        raise common.FinalizationError("PUBLISH_PR_IDENTITY_MISMATCH", "PR verification response is invalid")

    base_ref = (verified.get("base") or {}).get("ref") if isinstance(verified.get("base"), dict) else None
    head_ref = (verified.get("head") or {}).get("ref") if isinstance(verified.get("head"), dict) else None
    head_sha = ((verified.get("head") or {}).get("sha") or "").lower() if isinstance(verified.get("head"), dict) else ""
    state = verified.get("state")
    if base_ref != "main" or head_ref != branch or head_sha != commit_sha or state != "open":
        raise common.FinalizationError(
            "PUBLISH_PR_IDENTITY_MISMATCH",
            "verified PR identity does not match publication",
            details={
                "base": base_ref,
                "head": head_ref,
                "headSha": head_sha,
                "expectedSha": commit_sha,
                "state": state,
            },
        )

    removed = common.run_git(repo_root, "worktree", "remove", str(worktree), check=False)
    if removed.returncode != 0:
        raise common.FinalizationError(
            "PUBLISH_CLEANUP_FAILED",
            "PR is published, but local task worktree cleanup failed",
            details={
                "published": True,
                "commitSha": commit_sha,
                "remoteSha": remote_sha,
                "prNumber": pr_number,
                "prUrl": verified.get("html_url"),
                "worktree": str(worktree),
                "stderr": removed.stderr[-2000:],
            },
        )

    published_path = ready_json.parent / "published.json"
    result = {
        "ok": True,
        "code": "PUBLISHED",
        "publishVersion": PUBLISH_VERSION,
        "requestId": request_id,
        "repository": repository,
        "branch": branch,
        "commitSha": commit_sha,
        "remoteSha": remote_sha,
        "remoteVerified": True,
        "prNumber": pr_number,
        "prUrl": verified.get("html_url"),
        "base": "main",
        "head": branch,
        "changedFiles": paths,
        "testCommand": test["testCommand"],
        "testDurationMs": test.get("durationMs"),
        "worktreeRemoved": True,
        "localBranchRetainedUntilMerge": True,
        "mergePerformed": False,
        "publishedJson": str(published_path),
    }
    common.atomic_write_json(published_path, result)
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Publish one tested Direct Postman implementation")
    parser.add_argument("--ready-json", required=True)
    parser.add_argument("--test-json", required=True)
    parser.add_argument("--gh-binary", default="gh")
    parser.add_argument("--commit-message")
    parser.add_argument("--pr-title")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = publish(
            ready_json=Path(args.ready_json).resolve(),
            test_json=Path(args.test_json).resolve(),
            gh_binary=args.gh_binary,
            commit_message=args.commit_message,
            pr_title=args.pr_title,
        )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except common.FinalizationError as exc:
        print(json.dumps(common.json_result(False, exc.code, error=str(exc), details=exc.details), ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as exc:
        print(json.dumps(common.json_result(False, "PUBLISH_INTERNAL_ERROR", error=str(exc)), ensure_ascii=False, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
