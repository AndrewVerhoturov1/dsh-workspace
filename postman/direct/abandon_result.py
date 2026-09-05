#!/usr/bin/env python3
"""Safely abandon one unpublished Direct Postman result."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import finalization_common as common  # noqa: E402

ABANDON_VERSION = 1
_SHA_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)
_BRANCH_RE = re.compile(r"^postman/req-[a-z0-9-]+$")


def _sha(value: Any, field: str) -> str:
    if not isinstance(value, str) or _SHA_RE.fullmatch(value) is None:
        raise common.FinalizationError("ABANDON_IDENTITY_INVALID", f"{field} must be a full commit SHA")
    return value.lower()


def _gh_api(repository: str, endpoint: str, *, gh_binary: str = "gh") -> Any:
    result = common.run_process([gh_binary, "api", endpoint])
    if result.returncode != 0:
        raise common.FinalizationError("ABANDON_GITHUB_FAILED", f"gh api failed for {endpoint}", details={"stderr": result.stderr[-4000:]})
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise common.FinalizationError("ABANDON_GITHUB_FAILED", "gh api returned invalid JSON") from exc


def _remote_sha(root: Path, branch: str) -> str | None:
    result = common.run_git(root, "ls-remote", "--heads", "origin", f"refs/heads/{branch}", check=False)
    if result.returncode != 0:
        raise common.FinalizationError("ABANDON_GIT_STATE_FAILED", "cannot inspect remote branch", details={"stderr": result.stderr[-2000:]})
    if not result.stdout.strip():
        return None
    parts = result.stdout.splitlines()[0].split()
    if len(parts) < 2 or parts[1] != f"refs/heads/{branch}":
        raise common.FinalizationError("ABANDON_REMOTE_IDENTITY_MISMATCH", "remote branch response is invalid")
    return _sha(parts[0], "remote branch SHA")


def _local_sha(root: Path, branch: str) -> str | None:
    check = common.run_git(root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False)
    if check.returncode == 1:
        return None
    if check.returncode != 0:
        raise common.FinalizationError("ABANDON_GIT_STATE_FAILED", "cannot inspect local branch")
    return _sha(common.run_git(root, "rev-parse", f"refs/heads/{branch}").stdout.strip(), "local branch SHA")


def _workspace_proof(path: Path, published: dict[str, Any], worktree: Path) -> dict[str, Any]:
    proof_path = path.parent / "result-workspace.json"
    if not proof_path.exists():
        raise common.FinalizationError("ABANDON_UNREGISTER_PROOF_MISSING", "explicit workspace unregister proof is required")
    try:
        proof = common.load_json_file(proof_path)
    except common.FinalizationError as exc:
        raise common.FinalizationError("ABANDON_UNREGISTER_PROOF_INVALID", "workspace unregister proof is invalid") from exc
    if proof.get("requestId") != published["requestId"] or Path(str(proof.get("worktree", ""))).resolve() != worktree:
        raise common.FinalizationError("ABANDON_UNREGISTER_PROOF_INVALID", "workspace proof identity does not match published result")
    if proof.get("status") != "RESULT_WORKSPACE_UNREGISTERED" or proof.get("workspaceRemoved") is not True:
        raise common.FinalizationError("ABANDON_WORKSPACE_STILL_REGISTERED", "result workspace must be explicitly unregistered")
    for key in ("resultSessionUsingWorktree", "sessionUsingWorktree"):
        if proof.get(key) is True:
            raise common.FinalizationError("ABANDON_RESULT_SESSION_ACTIVE", "result session still uses worktree")
    if proof.get("sessionClosed") is False:
        raise common.FinalizationError("ABANDON_RESULT_SESSION_ACTIVE", "result session is not closed")
    return proof


def _already(path: Path, published: dict[str, Any], branch: str, commit: str) -> dict[str, Any] | None:
    receipt_path = path.parent / "abandoned.json"
    if not receipt_path.exists():
        # Read the pre-release name for compatibility, but always write the
        # canonical `abandoned.json` name for new operations.
        legacy_path = path.parent / "abandon.json"
        if legacy_path.exists():
            receipt_path = legacy_path
        else:
            return None
    receipt = common.load_json_file(receipt_path)
    if receipt.get("status") not in (None, "ABANDONED") or receipt.get("code") not in (None, "ABANDONED") or receipt.get("ok") not in (None, True):
        raise common.FinalizationError("ABANDON_RECEIPT_INVALID", "abandon receipt has unexpected status or code")
    if (receipt.get("requestId"), receipt.get("prNumber"), receipt.get("branch"), str(receipt.get("commitSha", "")).lower(), Path(str(receipt.get("worktree", ""))).resolve()) != (published.get("requestId"), published.get("prNumber"), branch, commit, Path(str(published["worktree"])).resolve()):
        raise common.FinalizationError("ABANDON_RECEIPT_INVALID", "ABANDONED receipt identity mismatch")
    return {**receipt, "ok": True, "code": "ALREADY_ABANDONED", "alreadyAbandoned": True}


def _validate(*, published_json: Path, discard: bool, gh_api: Callable[..., Any], gh_binary: str, repo_root: Path | None) -> dict[str, Any]:
    if not discard:
        raise common.FinalizationError("ABANDON_DISCARD_REQUIRED", "explicit discard confirmation is required")
    published = common.load_json_file(published_json)
    if published.get("ok") is not True or published.get("code") != "PUBLISHED":
        raise common.FinalizationError("ABANDON_INVALID_RECEIPT", "receipt is not PUBLISHED")
    required = ("requestId", "repository", "prNumber", "branch", "commitSha", "remoteSha", "worktree", "repoRoot")
    if any(not published.get(key) for key in required):
        raise common.FinalizationError("ABANDON_INVALID_RECEIPT", "published receipt is missing required identity")
    try:
        branch = common.canonical_branch_name(str(published["requestId"]))
    except common.FinalizationError as exc:
        raise common.FinalizationError("ABANDON_IDENTITY_INVALID", "requestId is not canonical") from exc
    if published["branch"] != branch or _BRANCH_RE.fullmatch(branch) is None:
        raise common.FinalizationError("ABANDON_BRANCH_MISMATCH", "published branch is not canonical")
    commit = _sha(published["commitSha"], "commitSha")
    if _sha(published["remoteSha"], "remoteSha") != commit:
        raise common.FinalizationError("ABANDON_REMOTE_SHA_MISMATCH", "published remoteSha does not match commitSha")
    root = (repo_root or Path(str(published["repoRoot"]))).resolve()
    if Path(str(published["repoRoot"])).resolve() != root:
        raise common.FinalizationError("ABANDON_REPO_ROOT_MISMATCH", "repository root identity mismatch")
    worktree = Path(str(published["worktree"])).resolve()
    if worktree == root:
        raise common.FinalizationError("ABANDON_WORKTREE_IDENTITY_MISMATCH", "worktree must not be repository root")
    already = _already(published_json, published, branch, commit)
    if already:
        _workspace_proof(published_json, published, worktree)
        if worktree.exists() or _local_sha(root, branch) is not None or _remote_sha(root, branch) is not None:
            raise common.FinalizationError("ABANDON_RECEIPT_INVALID", "ABANDONED receipt but resources still exist")
        return {"already": already, "published": published, "root": root, "worktree": worktree, "branch": branch, "commitSha": commit}
    pr_number = published["prNumber"]
    try:
        pr_number = int(pr_number)
    except (TypeError, ValueError) as exc:
        raise common.FinalizationError("ABANDON_PR_IDENTITY_MISMATCH", "invalid PR number") from exc
    pr = gh_api(published["repository"], f"repos/{published['repository']}/pulls/{pr_number}", gh_binary=gh_binary)
    if not isinstance(pr, dict) or pr.get("state") != "closed" or pr.get("merged_at") is not None:
        raise common.FinalizationError("ABANDON_PR_NOT_CLOSED_UNMERGED", "only a CLOSED unmerged PR may be abandoned")
    head = pr.get("head") if isinstance(pr.get("head"), dict) else {}
    base = pr.get("base") if isinstance(pr.get("base"), dict) else {}
    if pr.get("number") != pr_number or head.get("ref") != branch or _sha(head.get("sha"), "PR head SHA") != commit or base.get("ref") != "main":
        raise common.FinalizationError("ABANDON_PR_IDENTITY_MISMATCH", "PR identity does not match published result")
    origin = common.run_git(root, "remote", "get-url", "origin", check=False)
    if origin.returncode != 0 or common.normalize_remote_repository(origin.stdout) != published["repository"]:
        raise common.FinalizationError("ABANDON_REMOTE_IDENTITY_MISMATCH", "origin remote does not match repository")
    registered = common.registered_worktree_paths(root)
    if worktree not in registered or not worktree.exists():
        raise common.FinalizationError("ABANDON_WORKTREE_IDENTITY_MISMATCH", "published worktree is not a registered existing worktree")
    status = common.run_git(worktree, "status", "--porcelain", "--untracked-files=all")
    if status.stdout.strip():
        raise common.FinalizationError("ABANDON_WORKTREE_DIRTY", "worktree must be clean")
    if common.run_git(worktree, "branch", "--show-current").stdout.strip() != branch:
        raise common.FinalizationError("ABANDON_BRANCH_MISMATCH", "worktree branch does not match")
    if _sha(common.run_git(worktree, "rev-parse", "HEAD").stdout.strip(), "worktree HEAD") != commit:
        raise common.FinalizationError("ABANDON_HEAD_MISMATCH", "worktree HEAD does not match")
    local = _local_sha(root, branch)
    remote = _remote_sha(root, branch)
    if local != commit:
        raise common.FinalizationError("ABANDON_BRANCH_SHA_MISMATCH", "local branch does not match commit")
    if remote != commit:
        raise common.FinalizationError("ABANDON_REMOTE_SHA_MISMATCH", "remote branch does not match commit")
    _workspace_proof(published_json, published, worktree)
    return {"already": None, "published": published, "root": root, "worktree": worktree, "branch": branch, "commitSha": commit, "prNumber": pr_number}


def validate_abandon(*, published_json: Path, discard: bool = False, gh_binary: str = "gh", gh_api: Callable[..., Any] = _gh_api, repo_root: Path | None = None) -> dict[str, Any]:
    """Run all abandon preconditions without changing Git state."""
    return _validate(published_json=published_json, discard=discard, gh_api=gh_api, gh_binary=gh_binary, repo_root=repo_root)


def abandon(*, published_json: Path, discard: bool = False, reason: str = "explicit operator discard of a closed unmerged PR", gh_binary: str = "gh", gh_api: Callable[..., Any] = _gh_api, repo_root: Path | None = None) -> dict[str, Any]:
    if not reason.strip():
        raise common.FinalizationError("ABANDON_REASON_MISSING", "an explicit discard reason is required")
    context = _validate(published_json=published_json, discard=discard, gh_api=gh_api, gh_binary=gh_binary, repo_root=repo_root)
    if context["already"]:
        return context["already"]
    root, worktree, branch, commit = context["root"], context["worktree"], context["branch"], context["commitSha"]
    removed = common.run_git(root, "worktree", "remove", str(worktree), check=False)
    if removed.returncode != 0:
        raise common.FinalizationError("ABANDON_WORKTREE_REMOVE_FAILED", "worktree remove failed without force", details={"stderr": removed.stderr[-2000:]})
    if common.run_git(root, "worktree", "prune", check=False).returncode != 0:
        raise common.FinalizationError("ABANDON_WORKTREE_PRUNE_FAILED", "worktree prune failed")
    deleted = common.run_git(root, "branch", "-d", branch, check=False)
    if deleted.returncode != 0:
        deleted = common.run_git(root, "update-ref", "-d", f"refs/heads/{branch}", commit, check=False)
    if deleted.returncode != 0 or _local_sha(root, branch) is not None:
        raise common.FinalizationError("ABANDON_LOCAL_BRANCH_REMOVE_FAILED", "local branch removal failed")
    remote_delete = common.run_git(root, "push", "origin", "--delete", branch, check=False)
    if remote_delete.returncode != 0 or _remote_sha(root, branch) is not None:
        raise common.FinalizationError("ABANDON_REMOTE_BRANCH_REMOVE_FAILED", "remote branch removal failed without force", details={"stderr": remote_delete.stderr[-2000:]})
    receipt = {
        "ok": True,
        "code": "ABANDONED",
        "status": "ABANDONED",
        "abandonVersion": ABANDON_VERSION,
        "requestId": context["published"]["requestId"],
        "repository": context["published"]["repository"],
        "prNumber": context["prNumber"],
        "prUrl": context["published"].get("prUrl"),
        "branch": branch,
        "commitSha": commit,
        "remoteSha": commit,
        "repoRoot": str(root),
        "worktree": str(worktree),
        "reason": reason,
        "explicitDiscard": True,
        "discardConfirmed": True,
        "branchRemoved": True,
        "localBranchRemoved": True,
        "remoteBranchRemoved": True,
        "worktreeRemoved": True,
        "worktreePruned": True,
        "workspaceUnregistered": True,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    common.atomic_write_json(published_json.parent / "abandoned.json", receipt)
    return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--published-json", required=True)
    parser.add_argument("--discard", "--confirm-discard", dest="discard", action="store_true")
    parser.add_argument("--reason", default="explicit operator discard of a closed unmerged PR")
    parser.add_argument("--gh-binary", default="gh")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(abandon(published_json=Path(args.published_json).resolve(), discard=args.discard, reason=args.reason, gh_binary=args.gh_binary), ensure_ascii=False, separators=(",", ":")))
        return 0
    except common.FinalizationError as exc:
        print(json.dumps(common.json_result(False, exc.code, error=str(exc), details=exc.details), ensure_ascii=False, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
