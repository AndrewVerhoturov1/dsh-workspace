#!/usr/bin/env python3
"""Run exactly one Luna-selected task test and produce a deterministic receipt."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import finalization_common as common  # noqa: E402

TEST_VERSION = 1


def _resolve_command(command: list[str]) -> list[str]:
    executable = shutil.which(command[0])
    if executable:
        return [executable, *command[1:]]
    return command


def run_test(
    *,
    ready_json: Path,
    test_command: list[str],
    timeout_seconds: int = 600,
) -> dict:
    if not test_command:
        raise common.FinalizationError("TEST_COMMAND_MISSING", "test command is required")
    ready = common.validate_ready(common.load_json_file(ready_json))
    worktree = Path(ready["worktree"]).resolve()
    branch = common.run_git(worktree, "branch", "--show-current").stdout.strip()
    if branch != ready["branch"]:
        raise common.FinalizationError(
            "TEST_WORKTREE_MISMATCH",
            "worktree branch no longer matches READY_FOR_TEST",
            details={"expected": ready["branch"], "actual": branch},
        )
    head = common.run_git(worktree, "rev-parse", "HEAD").stdout.strip().lower()
    if head != ready["originMain"].lower():
        raise common.FinalizationError(
            "TEST_WORKTREE_MISMATCH",
            "worktree HEAD changed before test",
            details={"expected": ready["originMain"], "actual": head},
        )

    changed_before = common.changed_paths(worktree)
    if changed_before != sorted(ready["changedFiles"]):
        raise common.FinalizationError(
            "TEST_CHANGED_FILES_MISMATCH",
            "worktree changed paths do not match READY_FOR_TEST",
            details={"expected": sorted(ready["changedFiles"]), "actual": changed_before},
        )
    fingerprint_before, _ = common.fingerprint_paths(worktree, changed_before)

    resolved = _resolve_command(test_command)
    started = time.monotonic()
    try:
        completed = common.run_process(resolved, cwd=worktree, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        raise common.FinalizationError(
            "TEST_TIMEOUT",
            f"task-scoped test exceeded {timeout_seconds}s",
            details={"testCommand": test_command},
        ) from exc
    duration_ms = round((time.monotonic() - started) * 1000)

    if completed.returncode != 0:
        raise common.FinalizationError(
            "TEST_FAILED",
            "task-scoped test returned non-zero exit code",
            details={
                "testCommand": test_command,
                "resolvedCommand": resolved,
                "exitCode": completed.returncode,
                "durationMs": duration_ms,
                "stdoutTail": completed.stdout[-8000:],
                "stderrTail": completed.stderr[-8000:],
            },
        )

    changed_after = common.changed_paths(worktree)
    fingerprint_after, _ = common.fingerprint_paths(worktree, changed_after)
    if changed_after != changed_before or fingerprint_after != fingerprint_before:
        raise common.FinalizationError(
            "TEST_MUTATED_WORKTREE",
            "task test modified implementation worktree",
            details={
                "beforePaths": changed_before,
                "afterPaths": changed_after,
                "beforeFingerprint": fingerprint_before,
                "afterFingerprint": fingerprint_after,
            },
        )

    test_path = ready_json.parent / "test.json"
    receipt = {
        "ok": True,
        "code": "TEST_PASSED",
        "testVersion": TEST_VERSION,
        "requestId": ready["requestId"],
        "repository": ready["repository"],
        "branch": ready["branch"],
        "worktree": ready["worktree"],
        "changedFiles": ready["changedFiles"],
        "readyJson": str(ready_json.resolve()),
        "readyJsonSha256": common.sha256_file(ready_json),
        "worktreeFingerprint": fingerprint_after,
        "testCommand": test_command,
        "resolvedCommand": resolved,
        "exitCode": completed.returncode,
        "durationMs": duration_ms,
        "stdoutTail": completed.stdout[-8000:],
        "stderrTail": completed.stderr[-8000:],
        "testJson": str(test_path),
    }
    common.atomic_write_json(test_path, receipt)
    return receipt


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one deterministic Postman task test")
    parser.add_argument("--ready-json", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=600)
    parser.add_argument("test_command", nargs=argparse.REMAINDER)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    command = list(args.test_command)
    if command and command[0] == "--":
        command = command[1:]
    try:
        result = run_test(
            ready_json=Path(args.ready_json).resolve(),
            test_command=command,
            timeout_seconds=args.timeout_seconds,
        )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except common.FinalizationError as exc:
        print(json.dumps(common.json_result(False, exc.code, error=str(exc), details=exc.details), ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as exc:
        print(json.dumps(common.json_result(False, "TEST_INTERNAL_ERROR", error=str(exc)), ensure_ascii=False, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
