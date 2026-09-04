#!/usr/bin/env python3
"""Safely clean one merged Direct Postman result and its temporary refs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import finalization_common as common  # noqa: E402

CLEANUP_VERSION = 3
_SHA_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
_TASK_BRANCH_RE = re.compile(r"^postman/req-[a-z0-9-]+$")


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


def _strict_sha(value: Any, *, field: str) -> str:
    if not isinstance(value, str) or _SHA_RE.fullmatch(value) is None:
        raise common.FinalizationError("CLEANUP_IDENTITY_INVALID", f"{field} must be a full commit SHA")
    return value.lower()


def _require_workspace_unregistered(published_json: Path, published: dict[str, Any], worktree: Path) -> dict[str, Any]:
    workspace_json = published_json.parent / "result-workspace.json"
    if not workspace_json.exists():
        raise common.FinalizationError(
            "CLEANUP_WORKSPACE_RECEIPT_MISSING",
            "result Workspace must be explicitly unregistered before worktree cleanup",
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
    if (
        workspace.get("requestId") != published.get("requestId")
        or Path(str(workspace.get("worktree", ""))).resolve() != worktree
    ):
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

    # New host integrations may provide an explicit session-detachment proof.
    # Legacy WP-019 receipts have no such field; unregistering the Workspace is
    # the compatibility proof for those receipts.
    for key in ("resultSessionUsingWorktree", "sessionUsingWorktree", "sessionActive"):
        if workspace.get(key) is True:
            raise common.FinalizationError(
                "CLEANUP_RESULT_SESSION_ACTIVE",
                "Result Session still uses the retained worktree",
                details={"field": key, "worktree": str(worktree)},
            )
    if workspace.get("sessionClosed") is False:
        raise common.FinalizationError(
            "CLEANUP_RESULT_SESSION_ACTIVE",
            "Result Session is not closed or archived",
            details={"worktree": str(worktree)},
        )
    if workspace.get("sessionWorktree") and workspace.get("sessionClosed") is not True:
        raise common.FinalizationError(
            "CLEANUP_RESULT_SESSION_ACTIVE",
            "Result Session worktree has not been detached",
            details={"worktree": str(worktree)},
        )
    return workspace


def _exact_remote_sha(repo_root: Path, branch: str) -> str | None:
    result = common.run_git(repo_root, "ls-remote", "--heads", "origin", f"refs/heads/{branch}", check=False)
    if result.returncode != 0:
        raise common.FinalizationError(
            "CLEANUP_GIT_STATE_FAILED",
            "cannot inspect the remote task branch",
            details={"stderr": result.stderr[-2000:]},
        )
    if not result.stdout.strip():
        return None
    parts = result.stdout.splitlines()[0].split()
    if len(parts) < 2:
        raise common.FinalizationError("CLEANUP_GIT_STATE_FAILED", "remote branch response is invalid")
    return _strict_sha(parts[0], field="remote branch SHA")


def _local_branch_sha(repo_root: Path, branch: str) -> str | None:
    ref = common.run_git(repo_root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False)
    if ref.returncode == 1:
        return None
    if ref.returncode != 0:
        raise common.FinalizationError("CLEANUP_GIT_STATE_FAILED", "cannot inspect the local task branch")
    return _strict_sha(common.run_git(repo_root, "rev-parse", f"refs/heads/{branch}").stdout.strip(), field="local branch SHA")


def _load_already_cleaned(published_json: Path, published: dict[str, Any], expected_branch: str, commit_sha: str) -> dict[str, Any] | None:
    receipt_path = published_json.parent / "cleanup.json"
    if not receipt_path.exists():
        return None
    try:
        receipt = common.load_json_file(receipt_path)
    except Exception as exc:
        raise common.FinalizationError("CLEANUP_RECEIPT_INVALID", "cleanup receipt is invalid") from exc
    if receipt.get("status") != "CLEANED":
        return None
    if (
        receipt.get("requestId") != published.get("requestId")
        or receipt.get("branch") != expected_branch
        or str(receipt.get("commitSha", "")).lower() != commit_sha
        or Path(str(receipt.get("worktree", ""))).resolve() != Path(str(published["worktree"])).resolve()
    ):
        raise common.FinalizationError("CLEANUP_RECEIPT_INVALID", "CLEANED receipt identity does not match published result")
    return {
        **receipt,
        "ok": True,
        "code": "ALREADY_CLEANED",
        "status": "CLEANED",
        "alreadyCleaned": True,
    }


def _validate(
    *,
    published_json: Path,
    gh_binary: str,
    gh_api: Callable[..., Any],
    repo_root: Path | None,
) -> dict[str, Any]:
    published = common.load_json_file(published_json)
    if published.get("ok") is not True or published.get("code") != "PUBLISHED":
        raise common.FinalizationError("CLEANUP_INVALID_RECEIPT", "receipt is not PUBLISHED")
    for key in ("repository", "prNumber", "commitSha", "branch", "worktree", "repoRoot", "requestId"):
        if not published.get(key):
            raise common.FinalizationError("CLEANUP_INVALID_RECEIPT", f"published receipt is missing {key}")
    if published.get("worktreeRetained") is not True or published.get("worktreeRemoved") is not False:
        raise common.FinalizationError("CLEANUP_INVALID_RECEIPT", "published receipt is not a retained Result Workspace")

    try:
        expected_branch = common.canonical_branch_name(str(published["requestId"]))
    except common.FinalizationError as exc:
        raise common.FinalizationError("CLEANUP_IDENTITY_INVALID", "requestId is not canonical") from exc
    if expected_branch != published["branch"] or _TASK_BRANCH_RE.fullmatch(str(published["branch"])) is None:
        raise common.FinalizationError(
            "CLEANUP_BRANCH_MISMATCH",
            "published branch is not the canonical Postman task branch",
            details={"expected": expected_branch, "actual": published.get("branch")},
        )
    commit_sha = _strict_sha(published["commitSha"], field="published commitSha")
    try:
        pr_number = int(published["prNumber"])
    except (TypeError, ValueError) as exc:
        raise common.FinalizationError("CLEANUP_PR_IDENTITY_MISMATCH", "published PR number is invalid") from exc
    if pr_number <= 0:
        raise common.FinalizationError("CLEANUP_PR_IDENTITY_MISMATCH", "published PR number is invalid")

    published_root = Path(str(published["repoRoot"])).resolve()
    root = (repo_root or published_root).resolve()
    if published_root != root:
        raise common.FinalizationError(
            "CLEANUP_REPO_ROOT_MISMATCH",
            "published result belongs to a different repository root",
            details={"expected": str(root), "actual": str(published_root)},
        )
    worktree = Path(str(published["worktree"])).resolve()
    if worktree == root:
        raise common.FinalizationError("CLEANUP_WORKTREE_IDENTITY_MISMATCH", "published worktree path is the primary repository")

    already = _load_already_cleaned(published_json, published, expected_branch, commit_sha)
    if already is not None:
        _require_workspace_unregistered(published_json, published, worktree)
        registered = common.registered_worktree_paths(root)
        if root not in registered or worktree in registered or worktree.exists():
            raise common.FinalizationError("CLEANUP_RECEIPT_INVALID", "CLEANED receipt still has a registered retained worktree")
        extra = [str(path) for path in registered if path != root]
        if extra:
            raise common.FinalizationError("CLEANUP_UNKNOWN_WORKTREE", "unknown additional worktree exists", details={"worktrees": extra})
        if _local_branch_sha(root, expected_branch) is not None or _exact_remote_sha(root, expected_branch) is not None:
            raise common.FinalizationError("CLEANUP_RECEIPT_INVALID", "CLEANED receipt still has a task branch")
        return {"already": already, "published": published, "root": root, "worktree": worktree, "branch": expected_branch, "commitSha": commit_sha}

    pr = gh_api(published["repository"], f"repos/{published['repository']}/pulls/{pr_number}", gh_binary=gh_binary)
    if not isinstance(pr, dict):
        raise common.FinalizationError("CLEANUP_GITHUB_FAILED", "PR response is invalid")
    state = str(pr.get("state") or "").lower()
    merged_at = pr.get("merged_at")
    if not merged_at:
        code = "CLEANUP_PR_NOT_MERGED" if state in {"open", "closed"} else "CLEANUP_PR_STATE_AMBIGUOUS"
        raise common.FinalizationError(
            code,
            "retained result worktree can be removed only after a confirmed merge",
            details={"prNumber": pr_number, "state": pr.get("state")},
        )
    if state != "closed":
        raise common.FinalizationError(
            "CLEANUP_PR_STATE_AMBIGUOUS",
            "PR has merged_at but is not closed",
            details={"prNumber": pr_number, "state": pr.get("state")},
        )
    head = pr.get("head") if isinstance(pr.get("head"), dict) else {}
    base = pr.get("base") if isinstance(pr.get("base"), dict) else {}
    pr_head_sha = _strict_sha(head.get("sha"), field="merged PR head SHA")
    if pr_head_sha != commit_sha or head.get("ref") != expected_branch or base.get("ref") != "main":
        raise common.FinalizationError(
            "CLEANUP_PR_IDENTITY_MISMATCH",
            "merged PR identity does not match the published task",
            details={
                "expectedSha": commit_sha,
                "actualSha": pr_head_sha,
                "expectedBranch": expected_branch,
                "actualBranch": head.get("ref"),
                "base": base.get("ref"),
            },
        )

    _require_workspace_unregistered(published_json, published, worktree)
    registered = common.registered_worktree_paths(root)
    if root not in registered:
        raise common.FinalizationError("CLEANUP_GIT_STATE_FAILED", "primary repository worktree is not registered")
    if worktree.exists():
        if worktree not in registered:
            raise common.FinalizationError("CLEANUP_WORKTREE_NOT_REGISTERED", "retained worktree is not registered in repoRoot")
        extra = [str(path) for path in registered if path not in {root, worktree}]
        if extra:
            raise common.FinalizationError("CLEANUP_UNKNOWN_WORKTREE", "unknown additional worktree exists", details={"worktrees": extra})
        status = common.run_git(worktree, "status", "--porcelain", "--untracked-files=all", check=False)
        if status.returncode != 0:
            raise common.FinalizationError("CLEANUP_GIT_STATE_FAILED", "cannot inspect retained worktree", details={"stderr": status.stderr[-2000:]})
        if status.stdout.strip():
            raise common.FinalizationError(
                "CLEANUP_WORKTREE_DIRTY",
                "retained result worktree has local changes and will not be removed",
                details={"status": status.stdout.splitlines()[:100]},
            )
        actual_branch = common.run_git(worktree, "branch", "--show-current").stdout.strip()
        if actual_branch != expected_branch:
            raise common.FinalizationError(
                "CLEANUP_BRANCH_MISMATCH",
                "retained worktree is on an unexpected branch",
                details={"expected": expected_branch, "actual": actual_branch},
            )
        actual_sha = _strict_sha(common.run_git(worktree, "rev-parse", "HEAD").stdout.strip(), field="retained worktree HEAD")
        if actual_sha != commit_sha:
            raise common.FinalizationError(
                "CLEANUP_HEAD_MISMATCH",
                "retained result worktree HEAD changed after publication",
                details={"expected": commit_sha, "actual": actual_sha},
            )
    else:
        if worktree in registered:
            raise common.FinalizationError("CLEANUP_WORKTREE_REGISTRATION_STALE", "missing worktree still has a Git registration")
        extra = [str(path) for path in registered if path != root]
        if extra:
            raise common.FinalizationError("CLEANUP_UNKNOWN_WORKTREE", "unknown additional worktree exists", details={"worktrees": extra})

    local_sha = _local_branch_sha(root, expected_branch)
    if local_sha is not None and local_sha != commit_sha:
        raise common.FinalizationError(
            "CLEANUP_BRANCH_SHA_MISMATCH",
            "local task branch does not point to the published commit",
            details={"expected": commit_sha, "actual": local_sha},
        )
    remote_sha = _exact_remote_sha(root, expected_branch)
    if remote_sha is not None and remote_sha != commit_sha:
        raise common.FinalizationError(
            "CLEANUP_REMOTE_SHA_MISMATCH",
            "remote task branch does not point to the published commit",
            details={"expected": commit_sha, "actual": remote_sha},
        )
    return {
        "already": None,
        "published": published,
        "root": root,
        "worktree": worktree,
        "branch": expected_branch,
        "commitSha": commit_sha,
        "prNumber": pr_number,
        "worktreeExists": worktree.exists(),
        "localBranchExists": local_sha is not None,
        "remoteBranchExists": remote_sha is not None,
    }


def validate_cleanup(
    *,
    published_json: Path,
    gh_binary: str = "gh",
    gh_api: Callable[..., Any] = _gh_api,
    repo_root: Path | None = None,
) -> dict[str, Any]:
    """Run every destructive-action precondition without changing the repository."""
    return _validate(
        published_json=published_json,
        gh_binary=gh_binary,
        gh_api=gh_api,
        repo_root=repo_root,
    )


def cleanup(
    *,
    published_json: Path,
    gh_binary: str = "gh",
    gh_api: Callable[..., Any] = _gh_api,
    repo_root: Path | None = None,
) -> dict[str, Any]:
    context = _validate(
        published_json=published_json,
        gh_binary=gh_binary,
        gh_api=gh_api,
        repo_root=repo_root,
    )
    if context["already"] is not None:
        common.atomic_write_json(published_json.parent / "cleanup.json", context["already"])
        return context["already"]

    root = context["root"]
    worktree = context["worktree"]
    branch = context["branch"]
    commit_sha = context["commitSha"]
    progress: dict[str, Any] = {
        "ok": False,
        "code": "CLEANUP_IN_PROGRESS",
        "status": "IN_PROGRESS",
        "cleanupVersion": CLEANUP_VERSION,
        "requestId": context["published"].get("requestId"),
        "prNumber": context["prNumber"],
        "commitSha": commit_sha,
        "branch": branch,
        "worktree": str(worktree),
        "worktreeRemoved": False,
        "localBranchRemoved": False,
        "remoteBranchRemoved": False,
        "worktreePruned": False,
        "remoteFetched": False,
    }
    receipt_path = published_json.parent / "cleanup.json"

    def save_progress() -> None:
        common.atomic_write_json(receipt_path, progress)

    try:
        if context["worktreeExists"]:
            removed = common.run_git(root, "worktree", "remove", str(worktree), check=False)
            if removed.returncode != 0:
                raise common.FinalizationError(
                    "CLEANUP_WORKTREE_REMOVE_FAILED",
                    "git worktree remove failed without --force",
                    details={"stderr": removed.stderr[-2000:]},
                )
            progress["worktreeRemoved"] = True
            save_progress()

        pruned = common.run_git(root, "worktree", "prune", check=False)
        if pruned.returncode != 0:
            raise common.FinalizationError("CLEANUP_WORKTREE_PRUNE_FAILED", "git worktree prune failed", details={"stderr": pruned.stderr[-2000:]})
        progress["worktreePruned"] = True
        save_progress()

        if context["localBranchExists"]:
            deleted = common.run_git(root, "branch", "-d", branch, check=False)
            if deleted.returncode != 0:
                # A squash merge makes the published head non-ancestor of main.
                # The exact-commit compare-and-delete is still non-force and safe
                # because all identity checks above already passed.
                current_sha = _local_branch_sha(root, branch)
                if current_sha != commit_sha:
                    raise common.FinalizationError("CLEANUP_BRANCH_SHA_MISMATCH", "local task branch changed before deletion")
                deleted = common.run_git(root, "update-ref", "-d", f"refs/heads/{branch}", commit_sha, check=False)
                if deleted.returncode != 0:
                    raise common.FinalizationError("CLEANUP_LOCAL_BRANCH_REMOVE_FAILED", "local task branch deletion failed", details={"stderr": deleted.stderr[-2000:]})
            if _local_branch_sha(root, branch) is not None:
                raise common.FinalizationError("CLEANUP_LOCAL_BRANCH_REMOVE_FAILED", "local task branch still exists")
            progress["localBranchRemoved"] = True
            save_progress()

        if context["remoteBranchExists"]:
            deleted_remote = common.run_git(root, "push", "origin", "--delete", branch, check=False)
            if deleted_remote.returncode != 0:
                raise common.FinalizationError(
                    "CLEANUP_REMOTE_BRANCH_REMOVE_FAILED",
                    "remote task branch deletion failed without force",
                    details={"stderr": deleted_remote.stderr[-2000:]},
                )
            if _exact_remote_sha(root, branch) is not None:
                raise common.FinalizationError("CLEANUP_REMOTE_BRANCH_REMOVE_FAILED", "remote task branch still exists")
            progress["remoteBranchRemoved"] = True
            save_progress()

        fetched = common.run_git(root, "fetch", "--prune", "origin", check=False)
        if fetched.returncode != 0:
            raise common.FinalizationError("CLEANUP_FETCH_FAILED", "git fetch --prune origin failed", details={"stderr": fetched.stderr[-2000:]})
        progress["remoteFetched"] = True

        result = {
            **progress,
            "ok": True,
            "code": "RESULT_WORKTREE_CLEANED",
            "status": "CLEANED",
            "workspaceRegistrationRemoved": True,
            "alreadyCleaned": False,
        }
        common.atomic_write_json(receipt_path, result)
        return result
    except common.FinalizationError as exc:
        progress["error"] = str(exc)
        progress["errorCode"] = exc.code
        if any(progress[key] for key in ("worktreeRemoved", "worktreePruned", "localBranchRemoved", "remoteBranchRemoved", "remoteFetched")):
            progress["status"] = "NOT_CLEANED"
            save_progress()
        raise


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
