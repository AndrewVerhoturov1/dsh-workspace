#!/usr/bin/env python3
"""Run exactly one task test and produce a deterministic receipt."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys
import time

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import finalization_common as common  # noqa: E402

TEST_VERSION = 2
TAIL_LIMIT = 8000


def _resolve_command(command: list[str]) -> list[str]:
    executable = shutil.which(command[0])
    return [executable, *command[1:]] if executable else command


def _script_argv(test_script: Path, script_args: list[str]) -> list[str]:
    """Build an argv list; never pass it through a shell or a command string."""
    exact_script = test_script.resolve()
    if not exact_script.is_file():
        raise common.FinalizationError("TEST_SCRIPT_MISSING", f"test script not found: {exact_script}")
    return [sys.executable, "-X", "utf8", str(exact_script), *script_args]


def write_task_test(handoff_dir: Path, content: str, filename: str = "task_test.py") -> Path:
    """Write a UTF-8 task script with no shell or quoting interpretation."""
    if not isinstance(content, str):
        raise common.FinalizationError("TEST_SCRIPT_INVALID", "task test content must be text")
    root = Path(handoff_dir).resolve()
    if Path(filename).name != filename or not filename.endswith(".py"):
        raise common.FinalizationError("TEST_SCRIPT_INVALID", "task test filename must be a simple .py name")
    destination = (root / filename).resolve()
    if destination.parent != root:
        raise common.FinalizationError("TEST_SCRIPT_INVALID", "task test path escaped handoff directory")
    root.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{filename}.", suffix=".tmp", dir=str(root))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            Path(temporary).unlink()
        except FileNotFoundError:
            pass
    return destination


def run_test(
    *,
    ready_json: Path,
    test_command: list[str] | None = None,
    test_script: Path | None = None,
    script_args: list[str] | None = None,
    timeout_seconds: int = 600,
) -> dict:
    """Run a Python test script (preferred) or the legacy arbitrary argv."""
    if test_script is not None and test_command:
        raise common.FinalizationError("TEST_ARGUMENTS_AMBIGUOUS", "use --test-script or legacy test command, not both")
    if test_script is None and not test_command:
        raise common.FinalizationError("TEST_COMMAND_MISSING", "test script or test command is required")

    ready_json = Path(ready_json).resolve()
    ready = common.validate_ready(common.load_json_file(ready_json))
    declared_ready = ready.get("readyJson")
    if declared_ready and Path(declared_ready).resolve() != ready_json:
        raise common.FinalizationError(
            "READY_JSON_IDENTITY_MISMATCH", "READY_FOR_TEST readyJson is not the exact input path",
            details={"expected": str(ready_json), "actual": str(Path(declared_ready).resolve())},
        )
    worktree = Path(ready["worktree"]).resolve()
    branch = common.run_git(worktree, "branch", "--show-current").stdout.strip()
    if branch != ready["branch"]:
        raise common.FinalizationError("TEST_WORKTREE_MISMATCH", "worktree branch no longer matches READY_FOR_TEST",
                                       details={"expected": ready["branch"], "actual": branch})
    head = common.run_git(worktree, "rev-parse", "HEAD").stdout.strip().lower()
    if head != ready["originMain"].lower():
        raise common.FinalizationError("TEST_WORKTREE_MISMATCH", "worktree HEAD changed before test",
                                       details={"expected": ready["originMain"], "actual": head})

    changed_before = common.changed_paths(worktree)
    if changed_before != sorted(ready["changedFiles"]):
        raise common.FinalizationError("TEST_CHANGED_FILES_MISMATCH", "worktree changed paths do not match READY_FOR_TEST",
                                       details={"expected": sorted(ready["changedFiles"]), "actual": changed_before})
    fingerprint_before, _ = common.fingerprint_paths(worktree, changed_before)

    script_path: Path | None = None
    script_hash: str | None = None
    if test_script is not None:
        script_path = Path(test_script).resolve()
        if script_path == worktree or worktree in script_path.parents:
            raise common.FinalizationError("TEST_SCRIPT_PATH_INVALID", "test script must be outside the implementation worktree")
        resolved = _script_argv(script_path, list(script_args or []))
        logical_command = [str(script_path), *list(script_args or [])]
        script_hash = common.sha256_file(script_path)
    else:
        logical_command = list(test_command or [])
        resolved = _resolve_command(logical_command)

    started = time.monotonic()
    try:
        completed = common.run_process(resolved, cwd=worktree, timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        raise common.FinalizationError("TEST_TIMEOUT", f"task-scoped test exceeded {timeout_seconds}s",
                                       details={"testCommand": logical_command, "resolvedArgv": resolved}) from exc
    duration_ms = round((time.monotonic() - started) * 1000)
    common_details = {
        "testCommand": logical_command,
        "resolvedArgv": resolved,
        "exitCode": completed.returncode,
        "durationMs": duration_ms,
        "stdoutTail": completed.stdout[-TAIL_LIMIT:],
        "stderrTail": completed.stderr[-TAIL_LIMIT:],
    }
    if completed.returncode != 0:
        raise common.FinalizationError("TEST_FAILED", "task-scoped test returned non-zero exit code", details=common_details)

    if script_path is not None and common.sha256_file(script_path) != script_hash:
        raise common.FinalizationError("TEST_SCRIPT_MUTATED", "test script changed while it was running",
                                       details={"testScript": str(script_path), "before": script_hash,
                                                "after": common.sha256_file(script_path)})
    changed_after = common.changed_paths(worktree)
    fingerprint_after, _ = common.fingerprint_paths(worktree, changed_after)
    if changed_after != changed_before or fingerprint_after != fingerprint_before:
        raise common.FinalizationError("TEST_MUTATED_WORKTREE", "task test modified implementation worktree",
                                       details={"beforePaths": changed_before, "afterPaths": changed_after,
                                                "beforeFingerprint": fingerprint_before, "afterFingerprint": fingerprint_after})

    test_path = ready_json.parent / "test.json"
    receipt = {
        "ok": True, "code": "TEST_PASSED", "testVersion": TEST_VERSION,
        "requestId": ready["requestId"], "repository": ready["repository"], "branch": ready["branch"],
        "worktree": ready["worktree"], "changedFiles": ready["changedFiles"],
        "readyJson": str(ready_json), "readyJsonSha256": common.sha256_file(ready_json),
        "worktreeFingerprint": fingerprint_after, "testCommand": logical_command,
        "resolvedCommand": resolved, "resolvedArgv": resolved,
        "testScript": str(script_path) if script_path is not None else None,
        "testScriptSha256": script_hash,
        **{k: common_details[k] for k in ("exitCode", "durationMs", "stdoutTail", "stderrTail")},
        "testJson": str(test_path.resolve()),
    }
    written = common.atomic_write_json(test_path, receipt)
    if written.resolve() != test_path.resolve() or not test_path.is_file():
        raise common.FinalizationError(
            "TEST_RECEIPT_NOT_PERSISTED",
            "TEST_PASSED receipt was not persisted at the returned path",
            details={"testJson": str(test_path.resolve())},
        )
    persisted = common.validate_test_receipt(common.load_json_file(test_path))
    if Path(persisted.get("testJson", "")).resolve() != test_path.resolve():
        raise common.FinalizationError(
            "TEST_RECEIPT_PATH_INVALID",
            "persisted TEST_PASSED receipt points to another path",
            details={"testJson": str(test_path.resolve()), "actual": persisted.get("testJson")},
        )
    return persisted


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one deterministic Postman task test")
    parser.add_argument("--ready-json", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=600)
    parser.add_argument("--test-script", type=Path)
    parser.add_argument("--test-arg", action="append", default=[], dest="script_args")
    parser.add_argument("test_command", nargs=argparse.REMAINDER)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    command = list(args.test_command)
    if command and command[0] == "--":
        command = command[1:]
    try:
        result = run_test(ready_json=Path(args.ready_json), test_command=None if args.test_script else command,
                          test_script=args.test_script, script_args=args.script_args, timeout_seconds=args.timeout_seconds)
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
