#!/usr/bin/env python3
"""Persist host presentation status separately from semantic test results."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import finalization_common as common  # noqa: E402

PRESENTATION_VERSION = 1
ALLOWED_STATUS = {"PRESENTATION_PENDING", "PRESENTED", "UNREGISTERED"}


def record_presentation(
    *,
    published_json: Path,
    status: str,
    workspace_id: str | None = None,
    session_id: str | None = None,
    session_closed: bool | None = None,
) -> dict[str, Any]:
    published_path = published_json.resolve()
    published = common.load_json_file(published_path)
    if published.get("ok") is not True or published.get("code") != "PUBLISHED":
        raise common.FinalizationError("PRESENTATION_INVALID_RECEIPT", "presentation requires a PUBLISHED receipt")
    request_id = published.get("requestId")
    if not isinstance(request_id, str) or published_path.parent.name != request_id:
        raise common.FinalizationError("PRESENTATION_REQUEST_INVALID", "published receipt is not in its exact request handoff directory")
    try:
        common.canonical_branch_name(request_id)
    except common.FinalizationError as exc:
        raise common.FinalizationError("PRESENTATION_REQUEST_INVALID", "published requestId is not canonical") from exc
    if not isinstance(status, str) or status not in ALLOWED_STATUS:
        raise common.FinalizationError("PRESENTATION_STATUS_INVALID", "unknown presentation status")
    declared = published.get("publishedJson")
    if not isinstance(declared, str) or Path(declared).resolve() != published_path:
        raise common.FinalizationError("PRESENTATION_PATH_INVALID", "publishedJson is not the exact input path")
    if status == "PRESENTED" and (not isinstance(workspace_id, str) or not workspace_id.strip()):
        raise common.FinalizationError("PRESENTATION_WORKSPACE_MISSING", "PRESENTED requires a workspace id")
    if session_closed is False and status in {"UNREGISTERED"}:
        raise common.FinalizationError("PRESENTATION_SESSION_ACTIVE", "an active session cannot be unregistered")
    receipt_path = published_path.parent / "presentation.json"
    receipt = {
        "ok": True,
        "code": "RESULT_PRESENTED" if status == "PRESENTED" else "PRESENTATION_STATUS",
        "presentationVersion": PRESENTATION_VERSION,
        "status": status,
        "requestId": published["requestId"],
        "repository": published["repository"],
        "publishedJson": str(published_path),
        "publishedJsonSha256": common.sha256_file(published_path),
        "worktree": published.get("worktree"),
        "workspaceId": workspace_id,
        "sessionId": session_id,
        "sessionClosed": session_closed,
        "userVisualAcceptance": "PENDING",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "presentationJson": str(receipt_path.resolve()),
    }
    common.atomic_write_json(receipt_path, receipt)
    persisted = common.load_json_file(receipt_path)
    if persisted.get("code") != receipt["code"] or Path(persisted.get("presentationJson", "")).resolve() != receipt_path.resolve():
        raise common.FinalizationError("PRESENTATION_RECEIPT_INVALID", "presentation receipt did not persist correctly")
    return persisted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Record host presentation status for a PUBLISHED result")
    parser.add_argument("--published-json", required=True)
    parser.add_argument("--status", required=True, choices=sorted(ALLOWED_STATUS))
    parser.add_argument("--workspace-id")
    parser.add_argument("--session-id")
    parser.add_argument("--session-closed", action=argparse.BooleanOptionalAction)
    args = parser.parse_args(argv)
    try:
        result = record_presentation(
            published_json=Path(args.published_json),
            status=args.status,
            workspace_id=args.workspace_id,
            session_id=args.session_id,
            session_closed=args.session_closed,
        )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except common.FinalizationError as exc:
        print(json.dumps(common.json_result(False, exc.code, error=str(exc), details=exc.details), ensure_ascii=False, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
