#!/usr/bin/env python3
"""REQ-bound text result envelope for PostmanAsk."""

from __future__ import annotations

import hashlib
from typing import Any

import request_identity

TEXT_RESULT_CONFIRMED = "TEXT_RESULT_CONFIRMED"
TEXT_RESULT_MARKERS_MISSING = "TEXT_RESULT_MARKERS_MISSING"
TEXT_RESULT_MARKERS_AMBIGUOUS = "TEXT_RESULT_MARKERS_AMBIGUOUS"
TEXT_RESULT_MARKER_ORDER_INVALID = "TEXT_RESULT_MARKER_ORDER_INVALID"
TEXT_RESULT_EXTRA_TEXT = "TEXT_RESULT_EXTRA_TEXT"
TEXT_RESULT_EMPTY = "TEXT_RESULT_EMPTY"


def begin_marker(request_id: str) -> str:
    request_identity.assert_canonical_request_id(request_id)
    return f"<<<POSTMAN_ASK_BEGIN:{request_id}>>>"


def end_marker(request_id: str) -> str:
    request_identity.assert_canonical_request_id(request_id)
    return f"<<<POSTMAN_ASK_END:{request_id}>>>"


def _normalize(value: object) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _result(code: str, *, ok: bool, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"ok": ok, "code": code, "details": dict(details or {})}


def parse_text_envelope(assistant_text: object, request_id: str) -> dict[str, Any]:
    """Accept exactly one REQ-bound BEGIN/body/END envelope and return body text."""

    request_identity.assert_canonical_request_id(request_id)
    text = _normalize(assistant_text)
    lines = text.split("\n")
    begin = begin_marker(request_id)
    end = end_marker(request_id)

    begin_indexes = [index for index, line in enumerate(lines) if line.strip() == begin]
    end_indexes = [index for index, line in enumerate(lines) if line.strip() == end]

    if not begin_indexes or not end_indexes:
        return _result(
            TEXT_RESULT_MARKERS_MISSING,
            ok=False,
            details={"beginCount": len(begin_indexes), "endCount": len(end_indexes)},
        )
    if len(begin_indexes) != 1 or len(end_indexes) != 1:
        return _result(
            TEXT_RESULT_MARKERS_AMBIGUOUS,
            ok=False,
            details={"beginCount": len(begin_indexes), "endCount": len(end_indexes)},
        )

    begin_index = begin_indexes[0]
    end_index = end_indexes[0]
    if begin_index >= end_index:
        return _result(
            TEXT_RESULT_MARKER_ORDER_INVALID,
            ok=False,
            details={"beginLine": begin_index, "endLine": end_index},
        )

    before = "\n".join(lines[:begin_index]).strip()
    after = "\n".join(lines[end_index + 1 :]).strip()
    if before or after:
        return _result(
            TEXT_RESULT_EXTRA_TEXT,
            ok=False,
            details={"hasTextBeforeBegin": bool(before), "hasTextAfterEnd": bool(after)},
        )

    body = "\n".join(lines[begin_index + 1 : end_index]).strip()
    if not body:
        return _result(
            TEXT_RESULT_EMPTY,
            ok=False,
            details={"beginLine": begin_index, "endLine": end_index},
        )

    return _result(
        TEXT_RESULT_CONFIRMED,
        ok=True,
        details={
            "assistantText": body,
            "assistantTextSha256": _sha256(body),
            "beginLine": begin_index,
            "endLine": end_index,
        },
    )
