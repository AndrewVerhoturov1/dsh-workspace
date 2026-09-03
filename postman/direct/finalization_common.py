#!/usr/bin/env python3
"""Shared deterministic helpers for the WP-018B local finalization pipeline."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
from typing import Any, Iterable

SCRIPT_DIR = Path(__file__).resolve().parent
WEB_DIR = SCRIPT_DIR.parent / "web"
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import request_identity  # noqa: E402
import runtime_support as runtime  # noqa: E402

DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
DEFAULT_ORIGIN_REF = "origin/main"


class FinalizationError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


def json_result(ok: bool, code: str, **fields: Any) -> dict[str, Any]:
    return {"ok": ok, "code": code, **fields}


def load_json_file(path: str | os.PathLike[str]) -> dict[str, Any]:
    source = Path(path)
    try:
        value = json.loads(source.read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise FinalizationError("FINALIZATION_JSON_UNREADABLE", f"cannot read JSON: {source}") from exc
    except json.JSONDecodeError as exc:
        raise FinalizationError("FINALIZATION_JSON_INVALID", f"invalid JSON: {source}") from exc
    if not isinstance(value, dict):
        raise FinalizationError("FINALIZATION_JSON_INVALID", "JSON root must be an object")
    return value


def atomic_write_json(path: str | os.PathLike[str], value: dict[str, Any]) -> Path:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, destination)
    finally:
        try:
            Path(temp_name).unlink()
        except FileNotFoundError:
            pass
    return destination


def sha256_file(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def default_postman_root(env: dict[str, str] | None = None) -> Path:
    source = os.environ if env is None else env
    local = source.get("LOCALAPPDATA")
    if not local:
        raise FinalizationError("POSTMAN_LOCAL_ROOT_UNAVAILABLE", "LOCALAPPDATA is required")
    return Path(local) / "DSH" / "Postman"


def default_handoff_root(env: dict[str, str] | None = None) -> Path:
    return default_postman_root(env) / "handoff"


def default_worktree_root(env: dict[str, str] | None = None) -> Path:
    return default_postman_root(env) / "worktrees"


def canonical_branch_name(request_id: str) -> str:
    try:
        request_identity.assert_canonical_request_id(request_id)
    except ValueError as exc:
        raise FinalizationError("FINALIZATION_REQUEST_INVALID", "requestId is not canonical") from exc
    suffix = request_id[len("REQ_") :].lower().replace("_", "-")
    return f"postman/req-{suffix}"


def require_repo_path(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise FinalizationError("FINALIZATION_PATH_INVALID", f"{field} contains an empty path")
    raw = value.strip()
    if "\\" in raw or raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise FinalizationError("FINALIZATION_PATH_INVALID", f"{field} is not a repository-relative POSIX path")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise FinalizationError("FINALIZATION_PATH_INVALID", f"{field} is unsafe: {raw!r}")
    return path.as_posix()


def require_string(mapping: dict[str, Any], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value:
        raise FinalizationError("FINALIZATION_JSON_INVALID", f"missing/empty field: {key}")
    return value


def validate_ready(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("ok") is not True or data.get("code") != "READY_FOR_TEST":
        raise FinalizationError("READY_JSON_INVALID", "expected exact READY_FOR_TEST JSON")
    request_id = require_string(data, "requestId")
    expected_branch = canonical_branch_name(request_id)
    if require_string(data, "branch") != expected_branch:
        raise FinalizationError(
            "READY_BRANCH_MISMATCH",
            "READY_FOR_TEST branch is not the deterministic request branch",
            details={"expected": expected_branch, "actual": data.get("branch")},
        )
    changed = data.get("changedFiles")
    if not isinstance(changed, list) or not changed:
        raise FinalizationError("READY_JSON_INVALID", "changedFiles must be a non-empty array")
    normalized = [require_repo_path(item, field="changedFiles") for item in changed]
    if len(set(normalized)) != len(normalized):
        raise FinalizationError("READY_JSON_INVALID", "changedFiles contains duplicates")
    result = dict(data)
    result["changedFiles"] = normalized
    require_string(result, "worktree")
    require_string(result, "repoRoot")
    require_string(result, "originMain")
    return result


def validate_test_receipt(data: dict[str, Any]) -> dict[str, Any]:
    if data.get("ok") is not True or data.get("code") != "TEST_PASSED":
        raise FinalizationError("TEST_RECEIPT_INVALID", "expected exact TEST_PASSED JSON")
    require_string(data, "requestId")
    require_string(data, "branch")
    require_string(data, "worktree")
    require_string(data, "readyJsonSha256")
    require_string(data, "worktreeFingerprint")
    command = data.get("testCommand")
    if not isinstance(command, list) or not command or any(not isinstance(x, str) or not x for x in command):
        raise FinalizationError("TEST_RECEIPT_INVALID", "testCommand must be a non-empty string array")
    return dict(data)


def run_process(
    command: list[str],
    *,
    cwd: str | os.PathLike[str] | None = None,
    input_text: str | None = None,
    timeout: int | float | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            **runtime.quiet_subprocess_kwargs(),
        )
    except FileNotFoundError as exc:
        raise FinalizationError("FINALIZATION_EXECUTABLE_MISSING", f"executable not found: {command[0]}") from exc


def run_git(
    repo_root: str | os.PathLike[str],
    *args: str,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = run_process(["git", *args], cwd=repo_root)
    if check and result.returncode != 0:
        raise FinalizationError(
            "GIT_COMMAND_FAILED",
            f"git {' '.join(args)} failed",
            details={"returncode": result.returncode, "stdout": result.stdout[-4000:], "stderr": result.stderr[-4000:]},
        )
    return result


def normalize_remote_repository(url: str) -> str | None:
    value = url.strip().replace("\\", "/")
    if value.startswith("git@github.com:"):
        value = value[len("git@github.com:") :]
    else:
        marker = "github.com/"
        index = value.lower().find(marker)
        if index < 0:
            return None
        value = value[index + len(marker) :]
    value = value.strip("/")
    if value.endswith(".git"):
        value = value[:-4]
    parts = value.split("/")
    if len(parts) < 2:
        return None
    return f"{parts[0]}/{parts[1]}"


def changed_paths(repo_root: str | os.PathLike[str]) -> list[str]:
    root = Path(repo_root)
    paths = set(
        x
        for x in run_git(root, "diff", "--name-only", "--no-renames").stdout.splitlines()
        if x
    )
    paths.update(
        x
        for x in run_git(root, "diff", "--cached", "--name-only", "--no-renames").stdout.splitlines()
        if x
    )
    paths.update(
        x
        for x in run_git(root, "ls-files", "--others", "--exclude-standard").stdout.splitlines()
        if x
    )
    return sorted(paths)


def fingerprint_paths(repo_root: str | os.PathLike[str], paths: Iterable[str]) -> tuple[str, dict[str, str]]:
    root = Path(repo_root)
    mapping: dict[str, str] = {}
    for rel in sorted(set(paths)):
        safe = require_repo_path(rel, field="fingerprint")
        path = root.joinpath(*PurePosixPath(safe).parts)
        if path.is_file():
            mapping[safe] = f"file:{sha256_file(path)}"
        elif path.exists():
            mapping[safe] = "other"
        else:
            mapping[safe] = "deleted"
    encoded = json.dumps(mapping, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256_bytes(encoded), mapping


def registered_worktree_paths(repo_root: str | os.PathLike[str]) -> list[Path]:
    text = run_git(repo_root, "worktree", "list", "--porcelain").stdout
    paths: list[Path] = []
    for line in text.splitlines():
        if line.startswith("worktree "):
            paths.append(Path(line[len("worktree ") :]).resolve())
    return paths
