#!/usr/bin/env python3
"""Resume Direct Postman finalization from persisted exact receipts.

This module is deliberately local-only: it never creates a request and never
calls the Direct transport.  Existing valid receipts are the idempotency key.
"""
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
import prepare_result  # noqa: E402
import publish_result  # noqa: E402
import request_identity  # noqa: E402
import test_result  # noqa: E402


def _load_test_spec(path: Path) -> tuple[Path | None, list[str], list[str] | None]:
    """Load an argv-only test specification; never interpret shell text."""
    spec_path = path.resolve()
    try:
        value = json.loads(spec_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise common.FinalizationError("RESUME_TEST_SPEC_INVALID", "test spec is not valid UTF-8 JSON", details={"path": str(spec_path)}) from exc
    if not isinstance(value, dict):
        raise common.FinalizationError("RESUME_TEST_SPEC_INVALID", "test spec must be an object")
    args = value.get("args", [])
    if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
        raise common.FinalizationError("RESUME_TEST_SPEC_INVALID", "test spec args must be a string array")
    script_value = value.get("script")
    script = None
    if script_value is not None:
        if not isinstance(script_value, str) or not script_value.strip():
            raise common.FinalizationError("RESUME_TEST_SPEC_INVALID", "test spec script must be a non-empty path")
        script = (spec_path.parent / script_value).resolve() if not Path(script_value).is_absolute() else Path(script_value).resolve()
        if not script.is_file():
            raise common.FinalizationError("RESUME_TEST_SPEC_INVALID", "test spec script does not exist", details={"path": str(script)})
    command = value.get("command")
    if command is not None:
        if not isinstance(command, list) or not command or any(not isinstance(item, str) or not item for item in command):
            raise common.FinalizationError("RESUME_TEST_SPEC_INVALID", "test spec command must be a non-empty argv array")
    return script, list(args), list(command) if command is not None else None


def _exact(path: Path, *, code: str, request_id: str, repository: str) -> dict[str, Any]:
    """Read one receipt and reject malformed or cross-request data."""
    data = common.load_json_file(path)
    if data.get("ok") is not True or data.get("code") != code:
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", f"expected exact {code} receipt", details={"path": str(path)})
    if data.get("requestId") != request_id or data.get("repository") != repository:
        raise common.FinalizationError(
            "RESUME_RECEIPT_CROSS_REQUEST",
            "receipt identity does not match requested request",
            details={"path": str(path), "requestId": data.get("requestId"), "repository": data.get("repository")},
        )
    return data


def _ready(path: Path, request_id: str, repository: str) -> dict[str, Any]:
    data = common.validate_ready(_exact(path, code="READY_FOR_TEST", request_id=request_id, repository=repository))
    if Path(data.get("readyJson", "")).resolve() != path.resolve():
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", "READY receipt path is not exact")
    return data


def _test(path: Path, request_id: str, repository: str, ready: dict[str, Any]) -> dict[str, Any]:
    data = common.validate_test_receipt(_exact(path, code="TEST_PASSED", request_id=request_id, repository=repository))
    for key in ("branch", "worktree"):
        if data.get(key) != ready.get(key):
            raise common.FinalizationError("RESUME_RECEIPT_CROSS_REQUEST", f"test {key} does not match READY")
    if data.get("readyJson") and Path(data["readyJson"]).resolve() != Path(ready["readyJson"]).resolve():
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", "TEST receipt points to another READY receipt")
    test_json = data.get("testJson")
    if not isinstance(test_json, str) or not test_json.strip() or Path(test_json).resolve() != path.resolve() or not path.is_file():
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", "TEST receipt path is not exact or does not exist")
    return data


def _published(path: Path, request_id: str, repository: str, ready: dict[str, Any], test: dict[str, Any]) -> dict[str, Any]:
    data = _exact(path, code="PUBLISHED", request_id=request_id, repository=repository)
    published_json = data.get("publishedJson")
    if not isinstance(published_json, str) or not published_json.strip() or Path(published_json).resolve() != path.resolve() or not path.is_file():
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", "PUBLISHED receipt path is not exact or does not exist")
    for key in ("branch", "worktree"):
        if data.get(key) != ready.get(key) or data.get(key) != test.get(key):
            raise common.FinalizationError("RESUME_RECEIPT_CROSS_REQUEST", f"published {key} does not match prior receipt")
    if data.get("presentationStatus") == "RECEIPT_PRESENTED":
        raise common.FinalizationError("RESUME_PRESENTATION_INVALID", "receipt cannot claim host presentation without proof")
    data["presentationRequired"] = True
    data["presentationStatus"] = "PRESENTATION_PENDING"
    presentation_path = path.parent / "presentation.json"
    if presentation_path.is_file():
        presentation = common.load_json_file(presentation_path)
        if (
            presentation.get("requestId") != request_id
            or presentation.get("repository") != repository
            or Path(presentation.get("publishedJson", "")).resolve() != path.resolve()
            or presentation.get("status") not in {"PRESENTATION_PENDING", "PRESENTED", "UNREGISTERED"}
        ):
            raise common.FinalizationError("RESUME_PRESENTATION_INVALID", "presentation receipt identity is invalid")
        data["presentationStatus"] = presentation["status"]
    return data


def _already_applied(path: Path, request_id: str, repository: str) -> dict[str, Any]:
    data = _exact(path, code="ALREADY_APPLIED", request_id=request_id, repository=repository)
    terminal_json = data.get("terminalJson")
    if not isinstance(terminal_json, str) or Path(terminal_json).resolve() != path.resolve():
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", "ALREADY_APPLIED receipt path is not exact")
    if data.get("semanticTest") != "TEST_PASSED" or data.get("publicationSkipped") is not True:
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", "ALREADY_APPLIED terminal receipt is incomplete")
    return data


def _finalize_already_applied(
    *,
    path: Path,
    repo_root: Path,
    ready: dict[str, Any],
    test: dict[str, Any],
) -> dict[str, Any]:
    if ready.get("alreadyApplied") is not True or test.get("alreadyApplied") is not True:
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", "no-op finalization requires alreadyApplied=true in READY and TEST")
    if ready.get("changedFiles") or test.get("changedFiles"):
        raise common.FinalizationError("RESUME_RECEIPT_INVALID", "already-applied finalization must have no changed files")
    worktree = Path(ready["worktree"]).resolve()
    branch = ready["branch"]
    actual_branch = common.run_git(worktree, "branch", "--show-current").stdout.strip()
    head = common.run_git(worktree, "rev-parse", "HEAD").stdout.strip().lower()
    status = common.run_git(worktree, "status", "--porcelain", "--untracked-files=all").stdout
    if actual_branch != branch or head != ready["originMain"].lower() or status.strip():
        raise common.FinalizationError(
            "RESUME_ALREADY_APPLIED_WORKTREE_INVALID",
            "already-applied worktree changed after semantic test",
            details={"branch": actual_branch, "head": head, "status": status.splitlines()[:100]},
        )
    removed = common.run_git(repo_root, "worktree", "remove", str(worktree), check=False)
    if removed.returncode != 0:
        raise common.FinalizationError(
            "RESUME_ALREADY_APPLIED_CLEANUP_FAILED",
            "clean no-op worktree could not be removed",
            details={"stderr": removed.stderr[-2000:]},
        )
    branch_probe = common.run_git(repo_root, "rev-parse", f"refs/heads/{branch}", check=False)
    branch_head = branch_probe.stdout.strip().lower() if branch_probe.returncode == 0 else ""
    if branch_head != head:
        raise common.FinalizationError(
            "RESUME_ALREADY_APPLIED_CLEANUP_FAILED",
            "request branch moved before no-op cleanup",
            details={"expected": head, "actual": branch_head, "branch": branch},
        )
    deleted = common.run_git(repo_root, "update-ref", "-d", f"refs/heads/{branch}", head, check=False)
    if deleted.returncode != 0:
        raise common.FinalizationError(
            "RESUME_ALREADY_APPLIED_CLEANUP_FAILED",
            "exact request branch ref could not be deleted after worktree removal",
            details={"branch": branch, "head": head, "stderr": deleted.stderr[-2000:]},
        )
    common.run_git(repo_root, "worktree", "prune", check=False)
    cleanup = {"worktreeRemoved": True, "branchRemoved": True, "branchDeletionGuardSha": head}
    receipt = {
        "ok": True,
        "code": "ALREADY_APPLIED",
        "state": "ALREADY_APPLIED",
        "requestId": ready["requestId"],
        "repository": ready["repository"],
        "baseCommit": ready.get("baseCommit"),
        "originMain": ready["originMain"],
        "branch": branch,
        "worktree": str(worktree),
        "changedFiles": [],
        "readyJson": ready["readyJson"],
        "testJson": test["testJson"],
        "semanticTest": "TEST_PASSED",
        "publicationSkipped": True,
        "presentationRequired": False,
        "presentationStatus": "NOT_APPLICABLE",
        "cleanup": cleanup,
        "terminalJson": str(path.resolve()),
    }
    common.atomic_write_json(path, receipt)
    return _already_applied(path, ready["requestId"], ready["repository"])


def resume(
    *,
    request_id: str,
    repo_root: Path,
    expected_repository: str = common.DEFAULT_REPOSITORY,
    direct_root: Path | None = None,
    handoff_root: Path | None = None,
    worktree_root: Path | None = None,
    test_command: list[str] | None = None,
    test_script: Path | None = None,
    test_spec: Path | None = None,
    script_args: list[str] | None = None,
    timeout_seconds: int = 600,
    gh_binary: str = "gh",
    gh_api: Callable[..., Any] = publish_result._gh_api,
    integrator: Callable[..., dict[str, Any]] = prepare_result.integrate_result.integrate,
    test_runner: Callable[..., dict[str, Any]] = test_result.run_test,
    publisher: Callable[..., dict[str, Any]] = publish_result.publish,
) -> dict[str, Any]:
    try:
        request_identity.assert_canonical_request_id(request_id)
    except ValueError as exc:
        raise common.FinalizationError("RESUME_REQUEST_INVALID", "requestId is not canonical") from exc

    if test_script is not None and test_command:
        raise common.FinalizationError("RESUME_TEST_ARGUMENTS_AMBIGUOUS", "test script and test command cannot both be supplied")
    selected_args = list(script_args or [])
    selected_script = test_script.resolve() if test_script is not None else None
    selected_command = list(test_command) if test_command else None
    if test_spec is not None:
        spec_script, spec_args, spec_command = _load_test_spec(test_spec)
        if selected_script is None:
            selected_script = spec_script
        elif spec_script is not None and selected_script != spec_script:
            raise common.FinalizationError("RESUME_TEST_SPEC_MISMATCH", "test script differs from test spec")
        selected_args = [*spec_args, *selected_args]
        if selected_command is None:
            selected_command = spec_command
        elif spec_command is not None and selected_command != spec_command:
            raise common.FinalizationError("RESUME_TEST_SPEC_MISMATCH", "test command differs from test spec")
    if selected_script is not None and not selected_script.is_file():
        raise common.FinalizationError("RESUME_TEST_SCRIPT_MISSING", "test script does not exist", details={"path": str(selected_script)})
    root = (handoff_root or common.default_handoff_root()).resolve()
    stage = root / request_id
    ready_path, test_path, published_path = (stage / name for name in ("ready.json", "test.json", "published.json"))
    already_applied_path = stage / "already-applied.json"

    if already_applied_path.is_file():
        result = _already_applied(already_applied_path, request_id, expected_repository)
        return {"ok": True, "code": "ALREADY_APPLIED", "state": "ALREADY_APPLIED",
                "presentationRequired": False, "presentationStatus": "NOT_APPLICABLE",
                "semanticTest": "TEST_PASSED", "receipt": result}

    # Published is terminal and must be returned without repeating any stage.
    if published_path.is_file():
        ready = _ready(ready_path, request_id, expected_repository)
        test = _test(test_path, request_id, expected_repository, ready)
        result = _published(published_path, request_id, expected_repository, ready, test)
        return {"ok": True, "code": "PUBLISHED", "state": "PUBLISHED", "presentationRequired": True, "presentationStatus": result.get("presentationStatus", "PRESENTATION_PENDING"), "semanticTest": "TEST_PASSED", "receipt": result}

    if test_path.is_file():
        ready = _ready(ready_path, request_id, expected_repository)
        test = _test(test_path, request_id, expected_repository, ready)
    else:
        test = None
        if ready_path.is_file():
            ready = _ready(ready_path, request_id, expected_repository)
        else:
            ready = prepare_result.prepare_from_request_id(
                request_id=request_id, repo_root=repo_root, expected_repository=expected_repository,
                gh_binary=gh_binary, worktree_root=worktree_root, handoff_root=root,
                direct_root=direct_root, gh_api=prepare_result._gh_api, integrator=integrator,
            )
            ready = _ready(Path(ready["readyJson"]).resolve(), request_id, expected_repository)

        if selected_script is None and selected_command is None:
            return {"ok": True, "code": "READY_FOR_TEST", "state": "READY_FOR_TEST", "presentationRequired": False, "presentationStatus": "NOT_APPLICABLE", "semanticTest": "NOT_RUN", "receipt": ready}
        test = test_runner(ready_json=Path(ready["readyJson"]), test_command=selected_command,
                           test_script=selected_script, script_args=selected_args,
                           timeout_seconds=timeout_seconds)
        test = _test(test_path, request_id, expected_repository, ready)

    if test is None:
        raise common.FinalizationError("RESUME_TEST_RECEIPT_INVALID", "test receipt is unavailable")
    if ready.get("alreadyApplied") is True:
        result = _finalize_already_applied(path=already_applied_path, repo_root=repo_root, ready=ready, test=test)
        return {"ok": True, "code": "ALREADY_APPLIED", "state": "ALREADY_APPLIED",
                "presentationRequired": False, "presentationStatus": "NOT_APPLICABLE",
                "semanticTest": "TEST_PASSED", "receipt": result}
    if not published_path.is_file():
        publisher(ready_json=Path(ready["readyJson"]), test_json=Path(test["testJson"]), gh_binary=gh_binary, gh_api=gh_api)
    # Always return the exact persisted receipt, and verify its path/identity.
    result = _published(published_path, request_id, expected_repository, ready, test)
    return {"ok": True, "code": "PUBLISHED", "state": "PUBLISHED", "presentationRequired": True, "presentationStatus": result.get("presentationStatus", "PRESENTATION_PENDING"), "semanticTest": "TEST_PASSED", "receipt": result}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Resume local Direct Postman receipts without transport")
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--expected-repository", default=common.DEFAULT_REPOSITORY)
    parser.add_argument("--direct-root")
    parser.add_argument("--handoff-root")
    parser.add_argument("--worktree-root")
    parser.add_argument("--gh-binary", default="gh")
    parser.add_argument("--timeout-seconds", type=int, default=600)
    parser.add_argument("--test-script", type=Path)
    parser.add_argument("--test-spec", type=Path)
    parser.add_argument("--test-arg", action="append", default=[], dest="script_args")
    parser.add_argument("--test-command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.test_command
    if command and command[0] == "--":
        command = command[1:]
    try:
        result = resume(request_id=args.request_id, repo_root=Path(args.repo_root).resolve(), expected_repository=args.expected_repository,
                        direct_root=Path(args.direct_root).resolve() if args.direct_root else None,
                        handoff_root=Path(args.handoff_root).resolve() if args.handoff_root else None,
                        worktree_root=Path(args.worktree_root).resolve() if args.worktree_root else None,
                        gh_binary=args.gh_binary, test_command=command, test_script=args.test_script,
                        test_spec=args.test_spec, script_args=args.script_args)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except common.FinalizationError as exc:
        print(json.dumps(common.json_result(False, exc.code, error=str(exc), details=exc.details), ensure_ascii=False, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
