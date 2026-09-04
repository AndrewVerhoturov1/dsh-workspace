#!/usr/bin/env python3
"""Canonical durable RESULT_DURABLE handoff and legacy-state recovery."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile
from typing import Any

import request_identity


RESULT_DURABLE = "RESULT_DURABLE"
HANDOFF_VERSION = 1
HANDOFF_DIRNAME = "results"
_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_ARTIFACT_SHA_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class DurableHandoffError(ValueError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


def handoff_path(direct_root: str | os.PathLike[str], request_id: str) -> Path:
    try:
        request_identity.assert_canonical_request_id(request_id)
    except ValueError as exc:
        raise DurableHandoffError("RESUME_REQUEST_INVALID", "requestId is not canonical") from exc
    return Path(direct_root) / HANDOFF_DIRNAME / f"{request_id}.json"


def state_path(direct_root: str | os.PathLike[str], request_id: str) -> Path:
    try:
        request_identity.assert_canonical_request_id(request_id)
    except ValueError as exc:
        raise DurableHandoffError("RESUME_REQUEST_INVALID", "requestId is not canonical") from exc
    return Path(direct_root) / "requests" / f"{request_id}.json"


def atomic_write_json(path: str | os.PathLike[str], value: dict[str, Any]) -> Path:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return destination


def _required_string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise DurableHandoffError("RESUME_INVALID", f"missing/empty field: {key}", details={"field": key})
    return value


def _commit(data: dict[str, Any], key: str) -> str:
    value = _required_string(data, key)
    if _SHA_RE.fullmatch(value) is None:
        raise DurableHandoffError("RESUME_INVALID", f"invalid commit SHA: {key}", details={"field": key})
    return value.lower()


def _artifact_sha(data: dict[str, Any], key: str = "sha256") -> str:
    value = _required_string(data, key)
    if _ARTIFACT_SHA_RE.fullmatch(value) is None:
        raise DurableHandoffError("RESUME_INVALID", "invalid artifact SHA-256", details={"field": key})
    return value.lower()


def _same_path(actual: str, expected: Path) -> bool:
    try:
        return Path(actual).resolve() == expected.resolve()
    except (OSError, RuntimeError):
        return False


def validate_terminal(
    data: dict[str, Any],
    *,
    expected_repository: str,
    request_id: str | None = None,
    expected_state_path: Path | None = None,
    expected_handoff_path: Path | None = None,
) -> dict[str, Any]:
    """Validate and normalize an exact persisted terminal RESULT_DURABLE object."""
    if data.get("ok") is not True or data.get("code") != RESULT_DURABLE or data.get("state") != RESULT_DURABLE:
        raise DurableHandoffError("RESUME_INVALID", "handoff is not exact RESULT_DURABLE")

    actual_request_id = _required_string(data, "requestId")
    try:
        request_identity.assert_canonical_request_id(actual_request_id)
    except ValueError as exc:
        raise DurableHandoffError("RESUME_REQUEST_INVALID", "requestId is not canonical") from exc
    if request_id is not None and actual_request_id != request_id:
        raise DurableHandoffError(
            "RESUME_REQUEST_MISMATCH",
            "handoff requestId does not match requested request",
            details={"expected": request_id, "actual": actual_request_id},
        )

    repository = _required_string(data, "repository")
    if repository != expected_repository:
        raise DurableHandoffError(
            "RESUME_REPOSITORY_MISMATCH",
            "handoff repository does not match expected repository",
            details={"expected": expected_repository, "actual": repository},
        )

    base_commit = _commit(data, "baseCommit")
    task_publication_commit = _commit(data, "taskPublicationCommit")
    expected_filename = _required_string(data, "expectedFilename")
    if expected_filename != request_identity.expected_artifact_filename(actual_request_id):
        raise DurableHandoffError(
            "RESUME_INVALID",
            "expectedFilename does not match requestId",
            details={"expected": request_identity.expected_artifact_filename(actual_request_id), "actual": expected_filename},
        )

    task_url = _required_string(data, "taskUrl")
    owner, repo = expected_repository.split("/", 1)
    expected_task_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{task_publication_commit}/{actual_request_id}.md"
    if task_url != expected_task_url:
        raise DurableHandoffError(
            "RESUME_INVALID",
            "taskUrl is not the canonical SHA-pinned task URL",
            details={"expected": expected_task_url, "actual": task_url},
        )

    result_zip = _required_string(data, "resultZip")
    result_root = _required_string(data, "resultRoot")
    sha256 = _artifact_sha(data)
    state = _required_string(data, "statePath")
    if expected_state_path is not None and not _same_path(state, expected_state_path):
        raise DurableHandoffError(
            "RESUME_INVALID",
            "statePath is not the deterministic request state path",
            details={"expected": str(expected_state_path.resolve()), "actual": state},
        )

    normalized = dict(data)
    normalized.update(
        {
            "ok": True,
            "code": RESULT_DURABLE,
            "state": RESULT_DURABLE,
            "requestId": actual_request_id,
            "repository": repository,
            "baseCommit": base_commit,
            "taskPublicationCommit": task_publication_commit,
            "expectedFilename": expected_filename,
            "taskUrl": task_url,
            "resultZip": result_zip,
            "resultRoot": result_root,
            "sha256": sha256,
            "statePath": state,
        }
    )
    if expected_handoff_path is not None:
        handoff = normalized.get("resultHandoffPath")
        if handoff is not None and (not isinstance(handoff, str) or not _same_path(handoff, expected_handoff_path)):
            raise DurableHandoffError(
                "RESUME_INVALID",
                "resultHandoffPath is not the deterministic handoff path",
                details={"expected": str(expected_handoff_path.resolve()), "actual": handoff},
            )
        normalized["resultHandoffPath"] = str(expected_handoff_path.resolve())
    normalized["artifactSha256"] = sha256
    return normalized


def recover_legacy_direct_state(
    data: dict[str, Any],
    *,
    request_id: str,
    expected_repository: str,
    direct_root: str | os.PathLike[str],
) -> dict[str, Any]:
    """Build a canonical handoff only from a complete RESULT_DURABLE direct state."""
    try:
        request_identity.assert_canonical_request_id(request_id)
    except ValueError as exc:
        raise DurableHandoffError("RESUME_REQUEST_INVALID", "requestId is not canonical") from exc
    if data.get("requestId") != request_id:
        raise DurableHandoffError(
            "RESUME_REQUEST_MISMATCH",
            "direct state requestId does not match requested request",
            details={"expected": request_id, "actual": data.get("requestId")},
        )
    if data.get("state") != RESULT_DURABLE:
        raise DurableHandoffError(
            "RESUME_NOT_DURABLE",
            "direct state is not RESULT_DURABLE",
            details={"state": data.get("state")},
        )
    if data.get("code") is not None or data.get("ok") is not None:
        raise DurableHandoffError("RESUME_INVALID", "direct state is not a legacy direct-state object")
    if data.get("failureCode") is not None or data.get("failureDetails") is not None:
        raise DurableHandoffError("RESUME_INVALID", "direct state contains failure information")
    if data.get("repository") != expected_repository:
        raise DurableHandoffError(
            "RESUME_REPOSITORY_MISMATCH",
            "direct state repository does not match expected repository",
            details={"expected": expected_repository, "actual": data.get("repository")},
        )

    direct = Path(direct_root)
    expected_state = state_path(direct, request_id)
    expected_handoff = handoff_path(direct, request_id)
    source = {
        "ok": True,
        "code": RESULT_DURABLE,
        "state": RESULT_DURABLE,
        "requestId": request_id,
        "repository": expected_repository,
        "baseCommit": data.get("baseCommit"),
        "taskPublicationCommit": data.get("taskPublicationCommit"),
        "taskUrl": data.get("taskUrl"),
        "expectedFilename": data.get("expectedFilename"),
        "resultZip": data.get("resultZip"),
        "sha256": data.get("artifactSha256"),
        "resultRoot": data.get("resultRoot"),
        "statePath": str(expected_state.resolve()),
        "resultHandoffPath": str(expected_handoff.resolve()),
        "handoffVersion": HANDOFF_VERSION,
        "recoveredFrom": "legacy-direct-state",
    }
    return validate_terminal(
        source,
        expected_repository=expected_repository,
        request_id=request_id,
        expected_state_path=expected_state,
        expected_handoff_path=expected_handoff,
    )
