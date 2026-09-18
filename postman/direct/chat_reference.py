#!/usr/bin/env python3
"""Resolve an existing ChatGPT conversation from a prior durable Postman REQ.

This is intentionally local-only. It never searches ChatGPT UI and never sends a
prompt. A prior REQ is only a lookup key for a previously observed /c/... URL.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlparse

import request_identity

RESULT_DURABLE = "RESULT_DURABLE"
_CHAT_PATH_RE = re.compile(r"^/c/([A-Za-z0-9_-]+)$")


class ChatReferenceError(ValueError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


@dataclass(frozen=True)
class ChatReference:
    request_id: str
    conversation_id: str
    conversation_url: str
    source: str


def normalize_conversation_url(value: object) -> tuple[str, str]:
    if not isinstance(value, str) or not value.strip():
        raise ChatReferenceError("DIRECT_CHAT_REFERENCE_UNAVAILABLE", "conversation URL is missing")
    parsed = urlparse(value.strip())
    if parsed.scheme.lower() != "https" or (parsed.hostname or "").lower() not in {"chatgpt.com", "www.chatgpt.com"}:
        raise ChatReferenceError("DIRECT_CHAT_REFERENCE_INVALID", "conversation URL is not a ChatGPT HTTPS URL")
    match = _CHAT_PATH_RE.fullmatch(parsed.path or "")
    if match is None:
        raise ChatReferenceError("DIRECT_CHAT_REFERENCE_INVALID", "conversation URL is not a /c/<conversation-id> URL")
    conversation_id = match.group(1)
    return conversation_id, f"https://chatgpt.com/c/{conversation_id}"


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _nested_chat_url(value: dict[str, Any]) -> object:
    direct = value.get("conversationUrl")
    if direct:
        return direct
    worker = value.get("workerDetails")
    if isinstance(worker, dict):
        direct = worker.get("conversationUrl")
        if direct:
            return direct
        submit = worker.get("submitProof")
        if isinstance(submit, dict):
            details = submit.get("details")
            if isinstance(details, dict) and details.get("chatUrl"):
                return details.get("chatUrl")
    submit = value.get("submitProof")
    if isinstance(submit, dict):
        details = submit.get("details")
        if isinstance(details, dict) and details.get("chatUrl"):
            return details.get("chatUrl")
    return None


def _eligible(value: dict[str, Any], *, request_id: str, expected_repository: str) -> bool:
    if value.get("requestId") != request_id:
        return False
    if value.get("repository") not in {None, expected_repository}:
        return False
    state = value.get("state")
    code = value.get("code")
    if state != RESULT_DURABLE:
        return False
    if code not in {None, RESULT_DURABLE}:
        return False
    if value.get("ok") is False:
        return False
    return True


def resolve_chat_reference(
    direct_root: str | os.PathLike[str],
    request_id: str,
    *,
    expected_repository: str,
) -> ChatReference:
    try:
        request_identity.assert_canonical_request_id(request_id)
    except (TypeError, ValueError) as exc:
        raise ChatReferenceError("DIRECT_CHAT_REFERENCE_INVALID", "chat request id is not canonical") from exc

    root = Path(direct_root)
    candidates = (
        ("durable_handoff", root / "results" / f"{request_id}.json"),
        ("direct_state", root / "requests" / f"{request_id}.json"),
        ("worker_state", root.parent / "workers" / f"{request_id}.json"),
    )
    seen_sources: list[str] = []
    invalid_urls: list[str] = []
    for source, path in candidates:
        value = _read_json(path)
        if value is None or not _eligible(value, request_id=request_id, expected_repository=expected_repository):
            continue
        seen_sources.append(source)
        raw_url = _nested_chat_url(value)
        if raw_url is None:
            continue
        try:
            conversation_id, conversation_url = normalize_conversation_url(raw_url)
        except ChatReferenceError:
            invalid_urls.append(source)
            continue
        return ChatReference(
            request_id=request_id,
            conversation_id=conversation_id,
            conversation_url=conversation_url,
            source=source,
        )

    raise ChatReferenceError(
        "DIRECT_CHAT_REFERENCE_UNAVAILABLE",
        f"no stored ChatGPT conversation URL is available for {request_id}",
        details={
            "chatRequestId": request_id,
            "checkedSources": [source for source, _ in candidates],
            "durableSourcesFound": seen_sources,
            "invalidConversationUrlSources": invalid_urls,
            "uiSearchAttempted": False,
        },
    )


__all__ = [
    "ChatReference",
    "ChatReferenceError",
    "normalize_conversation_url",
    "resolve_chat_reference",
]
