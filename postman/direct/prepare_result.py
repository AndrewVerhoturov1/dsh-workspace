#!/usr/bin/env python3
"""Deterministic RESULT_DURABLE -> READY_FOR_TEST coordinator."""

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

import cleanup_published  # noqa: E402
import durable_handoff  # noqa: E402
import finalization_common as common  # noqa: E402
import integrate_result  # noqa: E402
import request_identity  # noqa: E402

PREPARE_VERSION = 2


def _load_terminal_json(path: str) -> dict[str, Any]:
    return common.load_json_file(path)


def _minimal_terminal_identity(data: dict[str, Any], expected_repository: str) -> tuple[str, str]:
    if data.get("ok") is not True or data.get("code") != "RESULT_DURABLE" or data.get("state") != "RESULT_DURABLE":
        raise common.FinalizationError("PREPARE_RESULT_INVALID", "terminal JSON is not exact RESULT_DURABLE")
    request_id = common.require_string(data, "requestId")
    try:
        request_identity.assert_canonical_request_id(request_id)
    except ValueError as exc:
        raise common.FinalizationError("PREPARE_RESULT_INVALID", "requestId is not canonical") from exc
    repository = common.require_string(data, "repository")
    if repository != expected_repository:
        raise common.FinalizationError(
            "PREPARE_REPOSITORY_MISMATCH",
            "terminal repository does not match expected repository",
            details={"expected": expected_repository, "actual": repository},
        )
    return request_id, repository


def _gh_api(repository: str, endpoint: str, *, gh_binary: str = "gh") -> Any:
    result = common.run_process([gh_binary, "api", endpoint])
    if result.returncode != 0:
        raise common.FinalizationError(
            "PREPARE_GITHUB_FAILED",
            f"gh api failed for {endpoint}",
            details={"returncode": result.returncode, "stderr": result.stderr[-4000:]},
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise common.FinalizationError("PREPARE_GITHUB_FAILED", "gh api returned invalid JSON") from exc


def _local_branches(repo_root: Path) -> list[str]:
    return [
        x
        for x in common.run_git(repo_root, "for-each-ref", "refs/heads", "--format=%(refname:short)").stdout.splitlines()
        if x
    ]


def _remote_branches(repo_root: Path) -> list[str]:
    lines = common.run_git(repo_root, "ls-remote", "--heads", "origin").stdout.splitlines()
    branches: list[str] = []
    for line in lines:
        parts = line.split()
        if len(parts) != 2 or not parts[1].startswith("refs/heads/"):
            continue
        branches.append(parts[1][len("refs/heads/") :])
    return sorted(branches)


def _task_branch(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("postman/req-")


def _published_receipts(handoff_root: Path | None) -> list[Path]:
    if handoff_root is None or not handoff_root.is_dir():
        return []
    return sorted(path for path in handoff_root.glob("*/published.json") if path.is_file())


def _is_legacy_published_receipt(published: dict[str, Any]) -> bool:
    """Identify pre-retained-workspace receipts without weakening live-resource checks."""
    if published.get("code") != "PUBLISHED":
        return False
    if published.get("worktree") or published.get("repoRoot"):
        return False
    retained_markers = (
        published.get("worktreeRetained") is True,
        published.get("worktreeRemoved") is False,
        published.get("resultWorkspaceRegistrationRequired") is True,
        published.get("cleanupAfterMergeRequired") is True,
    )
    return not any(retained_markers)


def _is_valid_abandoned_receipt(published_path: Path, published: dict[str, Any]) -> bool:
    """Return true only for a complete, matching explicit-discard receipt."""
    abandoned_path = published_path.parent / "abandoned.json"
    if not abandoned_path.is_file():
        return False
    try:
        abandoned = common.load_json_file(abandoned_path)
        expected_branch = common.canonical_branch_name(str(published["requestId"]))
    except (common.FinalizationError, KeyError):
        raise common.FinalizationError(
            "PREPARE_STALE_RESOURCE_AMBIGUOUS",
            "abandoned receipt cannot be classified",
            details={"receipt": str(abandoned_path)},
        )
    if (
        abandoned.get("ok") is not True
        or abandoned.get("code") != "ABANDONED"
        or abandoned.get("status") != "ABANDONED"
        or abandoned.get("explicitDiscard") is not True
        or abandoned.get("requestId") != published.get("requestId")
        or abandoned.get("repository") != published.get("repository")
        or abandoned.get("prNumber") != published.get("prNumber")
        or abandoned.get("branch") != expected_branch
        or str(abandoned.get("commitSha", "")).lower() != str(published.get("commitSha", "")).lower()
        or abandoned.get("worktreeRemoved") is not True
        or abandoned.get("branchRemoved") is not True
        or abandoned.get("remoteBranchRemoved") is not True
    ):
        raise common.FinalizationError(
            "PREPARE_STALE_RESOURCE_AMBIGUOUS",
            "abandoned receipt identity or cleanup proof is invalid",
            details={"receipt": str(abandoned_path)},
        )
    return True


def _historical_receipt_audit(receipt_path: Path, *, reason: str) -> dict[str, Any]:
    """Describe an inert historical receipt without turning it into a blocker."""
    return {
        "ok": True,
        "code": "PREPARE_HISTORICAL_RECEIPT_IGNORED",
        "receipt": str(receipt_path),
        "reason": reason,
        "liveResource": False,
    }


def _sync_main_without_overwriting_dirty(repo_root: Path, origin_main: str) -> tuple[str, list[str]]:
    local_main = common.run_git(repo_root, "rev-parse", "refs/heads/main").stdout.strip().lower()
    if re.fullmatch(r"[0-9a-f]{40}", local_main) is None or re.fullmatch(r"[0-9a-f]{40}", origin_main) is None:
        raise common.FinalizationError("PREPARE_GIT_STATE_INVALID", "main refs must be full commit SHAs")
    ancestry = common.run_git(repo_root, "merge-base", "--is-ancestor", local_main, origin_main, check=False)
    if ancestry.returncode != 0:
        raise common.FinalizationError(
            "PREPARE_LOCAL_MAIN_DIVERGED",
            "local main is ahead/diverged from origin/main; refusing automatic branch creation",
            details={"localMain": local_main, "originMain": origin_main},
        )
    incoming = [path for path in common.run_git(repo_root, "diff", "--name-only", f"{local_main}..{origin_main}").stdout.splitlines() if path]
    dirty = common.changed_paths(repo_root)
    overlap = sorted(set(incoming).intersection(dirty))
    if overlap:
        raise common.FinalizationError(
            "PREPARE_LOCAL_MAIN_OVERLAP",
            "dirty main overlaps incoming origin/main changes; refusing ff-only synchronization",
            details={"overlap": overlap, "localMain": local_main, "originMain": origin_main},
        )
    if local_main != origin_main:
        ff = common.run_git(repo_root, "merge", "--ff-only", "origin/main", check=False)
        if ff.returncode != 0:
            raise common.FinalizationError(
                "PREPARE_LOCAL_MAIN_SYNC_FAILED",
                "safe ff-only synchronization of main failed",
                details={"stdout": ff.stdout[-2000:], "stderr": ff.stderr[-2000:]},
            )
    return origin_main, overlap


def _classify_and_self_heal(
    repo_root: Path,
    *,
    repository: str,
    handoff_root: Path | None,
    gh_binary: str,
    gh_api: Callable[..., Any],
) -> list[dict[str, Any]]:
    local_branches = _local_branches(repo_root)
    remote_branches = _remote_branches(repo_root)
    task_local = {branch for branch in local_branches if _task_branch(branch)}
    task_remote = {branch for branch in remote_branches if _task_branch(branch)}
    worktrees = common.registered_worktree_paths(repo_root)
    other_worktrees = {path for path in worktrees if path != repo_root.resolve()}

    open_prs = gh_api(repository, f"repos/{repository}/pulls?state=open&per_page=100", gh_binary=gh_binary)
    if not isinstance(open_prs, list):
        raise common.FinalizationError("PREPARE_GITHUB_FAILED", "open PR response must be an array")
    open_task_prs = [
        pr for pr in open_prs
        if isinstance(pr, dict) and isinstance(pr.get("head"), dict) and _task_branch(pr["head"].get("ref"))
    ]
    if open_task_prs:
        raise common.FinalizationError(
            "PREPARE_STALE_PR_OPEN",
            "an open Postman implementation PR must be resolved before PREPARE",
            details={"pullRequests": [pr.get("number") for pr in open_task_prs]},
        )

    candidates: list[tuple[Path, dict[str, Any]]] = []
    audits: list[dict[str, Any]] = []
    for receipt_path in _published_receipts(handoff_root):
        try:
            published = common.load_json_file(receipt_path)
        except common.FinalizationError:
            # Historical receipt bytes are not authority over current Git state.
            # If a live Postman branch/worktree exists it will be rejected below
            # as an unknown live resource; otherwise the broken receipt is inert.
            audits.append(_historical_receipt_audit(receipt_path, reason="historical published receipt is unreadable"))
            continue
        if published.get("ok") is not True or published.get("code") != "PUBLISHED" or not _task_branch(published.get("branch")):
            audits.append(_historical_receipt_audit(receipt_path, reason="historical published receipt cannot be classified"))
            continue

        receipt_branch = str(published["branch"])
        receipt_worktree = None
        if published.get("worktree"):
            try:
                receipt_worktree = Path(str(published["worktree"])).resolve()
            except (OSError, RuntimeError):
                receipt_worktree = None
        branch_live = receipt_branch in task_local or receipt_branch in task_remote
        worktree_live = receipt_worktree in other_worktrees if receipt_worktree is not None else False

        if not branch_live and not worktree_live:
            # A terminal receipt with no registered/local/remote live resource is
            # audit history only. Do not re-prove every historical cleanup on
            # every future PREPARE. Open task PRs were already checked above.
            reason = "terminal historical receipt has no live Postman branch or registered worktree"
            if (receipt_path.parent / "abandoned.json").is_file():
                reason = "abandoned historical receipt has no live Postman branch or registered worktree"
            audits.append(_historical_receipt_audit(receipt_path, reason=reason))
            continue

        if _is_valid_abandoned_receipt(receipt_path, published):
            # ABANDONED claims these resources were removed. Seeing them live is
            # contradictory and must remain fail-closed.
            raise common.FinalizationError(
                "PREPARE_STALE_RESOURCE_AMBIGUOUS",
                "ABANDONED receipt claims cleanup but a live Postman resource still exists",
                details={
                    "receipt": str(receipt_path.parent / "abandoned.json"),
                    "branchLive": branch_live,
                    "worktreeLive": worktree_live,
                },
            )
        if _is_legacy_published_receipt(published):
            continue
        try:
            pr_number = int(published["prNumber"])
        except (KeyError, TypeError, ValueError) as exc:
            raise common.FinalizationError("PREPARE_STALE_RESOURCE_AMBIGUOUS", "old receipt has no valid PR number", details={"receipt": str(receipt_path)}) from exc
        pr = gh_api(repository, f"repos/{repository}/pulls/{pr_number}", gh_binary=gh_binary)
        if not isinstance(pr, dict):
            raise common.FinalizationError("PREPARE_STALE_RESOURCE_AMBIGUOUS", "old PR response is invalid", details={"prNumber": pr_number})
        state = str(pr.get("state") or "").lower()
        if state == "open":
            raise common.FinalizationError("PREPARE_STALE_PR_OPEN", "old Postman PR is still open", details={"prNumber": pr_number})
        if not pr.get("merged_at"):
            if state == "closed":
                raise common.FinalizationError("PREPARE_STALE_PR_CLOSED_UNMERGED", "old Postman PR was closed without merge", details={"prNumber": pr_number})
            raise common.FinalizationError("PREPARE_STALE_RESOURCE_AMBIGUOUS", "old Postman PR state is ambiguous", details={"prNumber": pr_number, "state": pr.get("state")})
        if state != "closed":
            raise common.FinalizationError("PREPARE_STALE_RESOURCE_AMBIGUOUS", "merged Postman PR has an ambiguous state", details={"prNumber": pr_number, "state": pr.get("state")})
        candidates.append((receipt_path, published))

    candidate_branches = {str(published["branch"]) for _, published in candidates}
    candidate_worktrees = {Path(str(published["worktree"])).resolve() for _, published in candidates if published.get("worktree")}
    unknown_local = sorted(task_local - candidate_branches)
    unknown_remote = sorted(task_remote - candidate_branches)
    unknown_worktrees = sorted(str(path) for path in other_worktrees - candidate_worktrees)
    if unknown_local or unknown_remote or unknown_worktrees:
        raise common.FinalizationError(
            "PREPARE_UNKNOWN_POSTMAN_RESOURCE",
            "unknown Postman branch or worktree exists; nothing will be deleted",
            details={"localBranches": unknown_local, "remoteBranches": unknown_remote, "worktrees": unknown_worktrees},
        )

    # Validate every candidate before mutating any of them, preventing partial cleanup.
    contexts = [
        cleanup_published.validate_cleanup(
            published_json=receipt_path,
            gh_binary=gh_binary,
            gh_api=gh_api,
            repo_root=repo_root,
        )
        for receipt_path, _ in candidates
    ]
    results: list[dict[str, Any]] = list(audits)
    for (receipt_path, _), context in zip(candidates, contexts):
        if context.get("already") is not None:
            results.append(context["already"])
        else:
            results.append(cleanup_published.cleanup(
                published_json=receipt_path,
                gh_binary=gh_binary,
                gh_api=gh_api,
                repo_root=repo_root,
            ))
    return results


def preflight_policy(
    repo_root: Path,
    *,
    repository: str,
    gh_binary: str = "gh",
    gh_api: Callable[..., Any] = _gh_api,
    handoff_root: Path | None = None,
) -> dict[str, Any]:
    if not (repo_root / "REPO_POLICY.md").is_file():
        raise common.FinalizationError("PREPARE_POLICY_MISSING", "REPO_POLICY.md is required")

    top = Path(common.run_git(repo_root, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    if top != repo_root.resolve():
        raise common.FinalizationError(
            "PREPARE_REPO_ROOT_MISMATCH",
            "--repo-root must be the primary repository root",
            details={"expected": str(repo_root.resolve()), "actual": str(top)},
        )

    remote_url = common.run_git(repo_root, "remote", "get-url", "origin").stdout.strip()
    actual_repository = common.normalize_remote_repository(remote_url)
    if actual_repository != repository:
        raise common.FinalizationError(
            "PREPARE_REMOTE_MISMATCH",
            "origin does not match expected repository",
            details={"expected": repository, "actual": actual_repository, "remote": remote_url},
        )

    current_branch = common.run_git(repo_root, "branch", "--show-current").stdout.strip()
    if current_branch != "main":
        raise common.FinalizationError(
            "PREPARE_POLICY_BLOCKED",
            "primary runtime repository must be on main before finalization",
            details={"currentBranch": current_branch},
        )

    common.run_git(repo_root, "fetch", "--quiet", "origin")
    origin_main = common.run_git(repo_root, "rev-parse", "origin/main").stdout.strip().lower()
    local_main, _ = _sync_main_without_overwriting_dirty(repo_root, origin_main)
    self_healing = _classify_and_self_heal(
        repo_root,
        repository=repository,
        handoff_root=handoff_root,
        gh_binary=gh_binary,
        gh_api=gh_api,
    )

    local_branches = _local_branches(repo_root)
    remote_branches = _remote_branches(repo_root)
    non_main_local = [x for x in local_branches if x != "main"]
    non_main_remote = [x for x in remote_branches if x != "main"]
    if non_main_local or non_main_remote:
        raise common.FinalizationError(
            "PREPARE_POLICY_BLOCKED",
            "unclassified temporary branch exists; repository policy forbids creating another",
            details={"localBranches": non_main_local, "remoteBranches": non_main_remote},
        )

    open_prs = gh_api(repository, f"repos/{repository}/pulls?state=open&per_page=100", gh_binary=gh_binary)
    if not isinstance(open_prs, list):
        raise common.FinalizationError("PREPARE_GITHUB_FAILED", "open PR response must be an array")
    if open_prs:
        raise common.FinalizationError(
            "PREPARE_POLICY_BLOCKED",
            "open pull request exists; repository policy forbids starting a new implementation branch",
            details={"pullRequests": [p.get("number") for p in open_prs if isinstance(p, dict)]},
        )

    worktrees = common.registered_worktree_paths(repo_root)
    other_worktrees = [str(p) for p in worktrees if p != repo_root.resolve()]
    if other_worktrees:
        raise common.FinalizationError(
            "PREPARE_POLICY_BLOCKED",
            "additional Git worktree exists; resolve it before creating a Postman task worktree",
            details={"worktrees": other_worktrees},
        )

    dirty = common.run_git(repo_root, "status", "--porcelain", "--untracked-files=all").stdout.splitlines()
    policy_sha = common.sha256_file(repo_root / "REPO_POLICY.md")
    return {
        "originMain": origin_main,
        "localMain": local_main,
        "localMainBehindAllowed": False,
        "primaryDirty": dirty[:100],
        "policySha256": policy_sha,
        "localBranches": local_branches,
        "remoteBranches": remote_branches,
        "openPullRequests": [],
        "worktrees": [str(p) for p in worktrees],
        "selfHealingCleanup": self_healing,
    }


def _cleanup_owned_clean_worktree(repo_root: Path, worktree: Path, branch: str) -> dict[str, Any]:
    details = {"attempted": False, "worktreeRemoved": False, "branchRemoved": False}
    if not worktree.exists():
        return details
    details["attempted"] = True
    status = common.run_git(worktree, "status", "--porcelain", "--untracked-files=all", check=False)
    if status.returncode != 0 or status.stdout.strip():
        details["preservedReason"] = "owned worktree is dirty after failure"
        return details
    removed = common.run_git(repo_root, "worktree", "remove", str(worktree), check=False)
    if removed.returncode == 0:
        details["worktreeRemoved"] = True
        deleted = common.run_git(repo_root, "branch", "-d", branch, check=False)
        details["branchRemoved"] = deleted.returncode == 0
    else:
        details["preservedReason"] = removed.stderr[-1000:]
    return details


def _resume_error(exc: durable_handoff.DurableHandoffError, source: Path) -> common.FinalizationError:
    code = f"PREPARE_{exc.code}" if exc.code.startswith("RESUME_") else "PREPARE_RESUME_INVALID"
    details = {"source": str(source), **exc.details}
    return common.FinalizationError(code, str(exc), details=details)


def _load_resume_handoff(
    *,
    request_id: str,
    expected_repository: str,
    direct_root: Path | None = None,
) -> Path:
    try:
        request_identity.assert_canonical_request_id(request_id)
    except ValueError as exc:
        raise common.FinalizationError("PREPARE_RESUME_REQUEST_INVALID", "requestId is not canonical") from exc

    root = (direct_root or (common.default_postman_root() / "direct")).resolve()
    persisted = durable_handoff.handoff_path(root, request_id)
    state = durable_handoff.state_path(root, request_id)

    if persisted.is_file():
        try:
            data = common.load_json_file(persisted)
            durable_handoff.validate_terminal(
                data,
                expected_repository=expected_repository,
                request_id=request_id,
                expected_state_path=state,
                expected_handoff_path=persisted,
            )
        except durable_handoff.DurableHandoffError as exc:
            raise _resume_error(exc, persisted) from exc
        except common.FinalizationError as exc:
            raise common.FinalizationError(
                "PREPARE_RESUME_INVALID",
                "durable result handoff is unreadable",
                details={"source": str(persisted), "error": str(exc)},
            ) from exc
        return persisted

    if not state.is_file():
        raise common.FinalizationError(
            "PREPARE_RESUME_NOT_FOUND",
            "no canonical durable handoff or direct state exists for request",
            details={"requestId": request_id, "handoffPath": str(persisted), "statePath": str(state)},
        )

    try:
        direct_state = common.load_json_file(state)
        normalized = durable_handoff.recover_legacy_direct_state(
            direct_state,
            request_id=request_id,
            expected_repository=expected_repository,
            direct_root=root,
        )
    except durable_handoff.DurableHandoffError as exc:
        raise _resume_error(exc, state) from exc
    except common.FinalizationError as exc:
        raise common.FinalizationError(
            "PREPARE_RESUME_INVALID",
            "legacy direct state is unreadable",
            details={"source": str(state), "error": str(exc)},
        ) from exc

    try:
        durable_handoff.atomic_write_json(persisted, normalized)
    except OSError as exc:
        raise common.FinalizationError(
            "PREPARE_RESUME_HANDOFF_WRITE_FAILED",
            "could not persist recovered durable result handoff",
            details={"handoffPath": str(persisted), "reason": str(exc)},
        ) from exc
    return persisted


def prepare_from_request_id(
    *,
    request_id: str,
    repo_root: Path,
    expected_repository: str = common.DEFAULT_REPOSITORY,
    gh_binary: str = "gh",
    worktree_root: Path | None = None,
    handoff_root: Path | None = None,
    direct_root: Path | None = None,
    gh_api: Callable[..., Any] = _gh_api,
    integrator: Callable[..., dict[str, Any]] = integrate_result.integrate,
) -> dict[str, Any]:
    normalized = _load_resume_handoff(
        request_id=request_id,
        expected_repository=expected_repository,
        direct_root=direct_root,
    )
    return prepare(
        # _load_resume_handoff returns the canonical receipt path, not its JSON object.
        result_json=str(normalized),
        repo_root=repo_root,
        expected_repository=expected_repository,
        gh_binary=gh_binary,
        worktree_root=worktree_root,
        handoff_root=handoff_root,
        gh_api=gh_api,
        integrator=integrator,
    )


def prepare(
    *,
    result_json: str,
    repo_root: Path,
    expected_repository: str = common.DEFAULT_REPOSITORY,
    gh_binary: str = "gh",
    worktree_root: Path | None = None,
    handoff_root: Path | None = None,
    gh_api: Callable[..., Any] = _gh_api,
    integrator: Callable[..., dict[str, Any]] = integrate_result.integrate,
) -> dict[str, Any]:
    terminal = _load_terminal_json(result_json)
    request_id, repository = _minimal_terminal_identity(terminal, expected_repository)

    root = handoff_root or common.default_handoff_root()
    policy = preflight_policy(
        repo_root,
        repository=repository,
        gh_binary=gh_binary,
        gh_api=gh_api,
        handoff_root=root,
    )
    branch = common.canonical_branch_name(request_id)
    worktree_parent = worktree_root or common.default_worktree_root()
    worktree = (worktree_parent / request_id).resolve()
    if worktree.exists():
        raise common.FinalizationError(
            "PREPARE_WORKTREE_EXISTS",
            "request worktree path already exists",
            details={"worktree": str(worktree)},
        )

    worktree_parent.mkdir(parents=True, exist_ok=True)
    added = common.run_git(
        repo_root,
        "worktree",
        "add",
        "--quiet",
        "-b",
        branch,
        str(worktree),
        "origin/main",
        check=False,
    )
    if added.returncode != 0:
        raise common.FinalizationError(
            "PREPARE_WORKTREE_FAILED",
            "git worktree add failed",
            details={"stdout": added.stdout[-2000:], "stderr": added.stderr[-2000:]},
        )

    try:
        ready = integrator(
            result_json=result_json,
            repo_root=worktree,
            expected_repository=expected_repository,
            origin_ref="origin/main",
            fetch=False,
            allow_main=False,
        )
        if not isinstance(ready, dict) or ready.get("ok") is not True or ready.get("code") != "READY_FOR_TEST":
            raise common.FinalizationError(
                "PREPARE_APPLICATOR_FAILED",
                "integrator did not return exact READY_FOR_TEST",
                details={"integratorResult": ready},
            )

        ready = {
            **ready,
            "prepareVersion": PREPARE_VERSION,
            "repoRoot": str(repo_root.resolve()),
            "worktree": str(worktree),
            "branch": branch,
            "policyPreflight": policy,
        }
        root = handoff_root or common.default_handoff_root()
        ready_path = root / request_id / "ready.json"
        ready["readyJson"] = str(ready_path.resolve())
        written = common.atomic_write_json(ready_path, ready)
        if written.resolve() != ready_path.resolve() or not ready_path.is_file():
            raise common.FinalizationError(
                "PREPARE_RECEIPT_NOT_PERSISTED",
                "READY_FOR_TEST receipt was not persisted at the returned path",
                details={"readyJson": str(ready_path.resolve())},
            )
        persisted = common.validate_ready(common.load_json_file(ready_path))
        if Path(persisted.get("readyJson", "")).resolve() != ready_path.resolve():
            raise common.FinalizationError(
                "PREPARE_RECEIPT_PATH_INVALID",
                "persisted READY_FOR_TEST receipt points to another path",
                details={"readyJson": str(ready_path.resolve()), "actual": persisted.get("readyJson")},
            )
        persisted["readyJsonSha256"] = common.sha256_file(ready_path)
        return persisted
    except integrate_result.IntegrationError as exc:
        cleanup = _cleanup_owned_clean_worktree(repo_root, worktree, branch)
        code = "PREPARE_DIAGNOSTIC_ONLY" if exc.code == "RESULT_DIAGNOSTIC_ONLY" else "PREPARE_APPLICATOR_FAILED"
        raise common.FinalizationError(
            code,
            str(exc),
            details={"innerCode": exc.code, "innerDetails": exc.details, "cleanup": cleanup},
        ) from exc
    except Exception:
        _cleanup_owned_clean_worktree(repo_root, worktree, branch)
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Deterministic Postman PREPARE coordinator")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--result-json")
    source.add_argument("--request-id", help="resume from the canonical durable direct handoff")
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--expected-repository", default=common.DEFAULT_REPOSITORY)
    parser.add_argument("--gh-binary", default="gh")
    parser.add_argument("--worktree-root")
    parser.add_argument("--handoff-root")
    parser.add_argument("--direct-root")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        repo_root = Path(args.repo_root).resolve()
        worktree_root = Path(args.worktree_root).resolve() if args.worktree_root else None
        handoff_root = Path(args.handoff_root).resolve() if args.handoff_root else None
        if args.request_id:
            result = prepare_from_request_id(
                request_id=args.request_id,
                repo_root=repo_root,
                expected_repository=args.expected_repository,
                gh_binary=args.gh_binary,
                worktree_root=worktree_root,
                handoff_root=handoff_root,
                direct_root=Path(args.direct_root).resolve() if args.direct_root else None,
            )
        else:
            result = prepare(
                result_json=args.result_json,
                repo_root=repo_root,
                expected_repository=args.expected_repository,
                gh_binary=args.gh_binary,
                worktree_root=worktree_root,
                handoff_root=handoff_root,
            )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except common.FinalizationError as exc:
        print(json.dumps(common.json_result(False, exc.code, error=str(exc), details=exc.details), ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as exc:
        print(json.dumps(common.json_result(False, "PREPARE_INTERNAL_ERROR", error=str(exc)), ensure_ascii=False, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
