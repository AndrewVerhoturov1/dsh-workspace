#!/usr/bin/env python3
"""Remove one retained Direct Postman result worktree only after merge and Workspace unregister."""

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

CLEANUP_VERSION = 2


def _gh_api(repository: str, endpoint: str, *, gh_binary: str = "gh") -> Any:
    result = common.run_process([gh_binary, "api", endpoint])
    if result.returncode != 0:
        raise common.FinalizationError(
            "CLEANUP_GITHUB_FAILED",
            f"gh api failed for {endpoint}",
            details={"returncode": result.returncode, "stderr": result.stderr[-4000:]},
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise common.FinalizationError("CLEANUP_GITHUB_FAILED", "gh api returned invalid JSON") from exc


def _require_workspace_unregistered(published_json: Path, published: dict[str, Any]) -> None:
    workspace_json = published_json.parent / "result-workspace.json"
    if not workspace_json.exists():
        raise common.FinalizationError(
            "CLEANUP_WORKSPACE_RECEIPT_MISSING",
            "result Workspace must be registered and then explicitly unregistered before worktree cleanup",
            details={"workspaceJson": str(workspace_json)},
        )
    try:
        workspace = common.load_json_file(workspace_json)
    except Exception as exc:
        raise common.FinalizationError(
            "CLEANUP_WORKSPACE_RECEIPT_INVALID",
            "result Workspace receipt is invalid",
            details={"workspaceJson": str(workspace_json)},
        ) from exc
    if workspace.get("requestId") != published.get("requestId") or workspace.get("worktree") != published.get("worktree"):
        raise common.FinalizationError(
            "CLEANUP_WORKSPACE_RECEIPT_INVALID",
            "result Workspace receipt does not match published result",
        )
    if workspace.get("workspaceRemoved") is not True or workspace.get("status") != "RESULT_WORKSPACE_UNREGISTERED":
        raise common.FinalizationError(
            "CLEANUP_WORKSPACE_STILL_REGISTERED",
            "remove the Harness Result Workspace registration before deleting its worktree",
            details={"workspaceId": workspace.get("workspaceId"), "status": workspace.get("status")},
        )


def cleanup(
    *,
    published_json: Path,
    gh_binary: str = "gh",
    gh_api: Callable[..., Any] = _gh_api,
) -> dict[str, Any]:
    published = common.load_json_file(published_json)
    if published.get("ok") is not True or published.get("code") != "PUBLISHED":
        raise common.FinalizationError("CLEANUP_INVALID_RECEIPT", "receipt is not PUBLISHED")
    for key in ("repository", "prNumber", "commitSha", "branch", "worktree", "repoRoot"):
        if not published.get(key):
            raise common.FinalizationError("CLEANUP_INVALID_RECEIPT", f"published receipt is missing {key}")
    if published.get("worktreeRetained") is not True or published.get("worktreeRemoved") is not False:
        raise common.FinalizationError("CLEANUP_INVALID_RECEIPT", "published receipt is not a retained Result Workspace")

    repository = published["repository"]
    pr_number = int(published["prNumber"])
    pr = gh_api(repository, f"repos/{repository}/pulls/{pr_number}", gh_binary=gh_binary)
    if not isinstance(pr, dict):
        raise common.FinalizationError("CLEANUP_GITHUB_FAILED", "PR response is invalid")
    if pr.get("merged_at") in (None, ""):
        raise common.FinalizationError(
            "CLEANUP_PR_NOT_MERGED",
            "retained result worktree can be removed automatically only after merge",
            details={"prNumber": pr_number, "state": pr.get("state")},
        )

    head = pr.get("head") if isinstance(pr.get("head"), dict) else {}
    pr_head_sha = str(head.get("sha") or "").lower()
    commit_sha = str(published["commitSha"]).lower()
    if pr_head_sha and pr_head_sha != commit_sha:
        raise common.FinalizationError(
            "CLEANUP_PR_IDENTITY_MISMATCH",
            "merged PR head does not match published commit",
            details={"expected": commit_sha, "actual": pr_head_sha},
        )

    _require_workspace_unregistered(published_json, published)

    worktree = Path(published["worktree"]).resolve()
    repo_root = Path(published["repoRoot"]).resolve()
    if not worktree.exists():
        result = common.json_result(
            True,
            "RESULT_WORKTREE_ALREADY_ABSENT",
            cleanupVersion=CLEANUP_VERSION,
            requestId=published.get("requestId"),
            prNumber=pr_number,
            worktree=str(worktree),
            worktreeRemoved=False,
        )
        common.atomic_write_json(published_json.parent / "cleanup.json", result)
        return result

    status = common.run_git(worktree, "status", "--porcelain", "--untracked-files=all").stdout
    if status.strip():
        raise common.FinalizationError(
            "CLEANUP_WORKTREE_DIRTY",
            "retained result worktree has local changes and will not be removed",
            details={"status": status.splitlines()[:100]},
        )
    actual_sha = common.run_git(worktree, "rev-parse", "HEAD").stdout.strip().lower()
    if actual_sha != commit_sha:
        raise common.FinalizationError(
            "CLEANUP_HEAD_MISMATCH",
            "retained result worktree HEAD changed after publication",
            details={"expected": commit_sha, "actual": actual_sha},
        )

    removed = common.run_git(repo_root, "worktree", "remove", str(worktree), check=False)
    if removed.returncode != 0:
        raise common.FinalizationError(
            "CLEANUP_WORKTREE_REMOVE_FAILED",
            "git worktree remove failed",
            details={"stderr": removed.stderr[-2000:]},
        )

    result = common.json_result(
        True,
        "RESULT_WORKTREE_CLEANED",
        cleanupVersion=CLEANUP_VERSION,
        requestId=published.get("requestId"),
        prNumber=pr_number,
        commitSha=commit_sha,
        branch=published["branch"],
        worktree=str(worktree),
        worktreeRemoved=True,
        workspaceRegistrationRemoved=True,
        localBranchRemoved=False,
    )
    common.atomic_write_json(published_json.parent / "cleanup.json", result)
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Clean one merged retained Direct Postman result worktree")
    parser.add_argument("--published-json", required=True)
    parser.add_argument("--gh-binary", default="gh")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = cleanup(published_json=Path(args.published_json).resolve(), gh_binary=args.gh_binary)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except common.FinalizationError as exc:
        print(json.dumps(common.json_result(False, exc.code, error=str(exc), details=exc.details), ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as exc:
        print(json.dumps(common.json_result(False, "CLEANUP_INTERNAL_ERROR", error=str(exc)), ensure_ascii=False, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
