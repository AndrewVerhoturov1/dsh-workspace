#!/usr/bin/env python3
"""Canonical Web Postman request/artifact identity helpers."""

from __future__ import annotations

from datetime import datetime, timezone
import re

REQUEST_ID_RE = re.compile(
    r"^REQ_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_(\d{4})$"
)
ARTIFACT_FILENAME_RE = re.compile(
    r"^POSTMAN_(REQ_\d{8}T\d{6}Z_\d{4})_RESULT(?:-(\d{2}))?\.zip$"
)


def is_canonical_request_id(value: object) -> bool:
    if not isinstance(value, str):
        return False
    match = REQUEST_ID_RE.fullmatch(value)
    if match is None:
        return False
    year, month, day, hour, minute, second, _suffix = map(int, match.groups())
    try:
        parsed = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError:
        return False
    return parsed.strftime("REQ_%Y%m%dT%H%M%SZ_") == value[:-4]


def assert_canonical_request_id(value: str) -> str:
    if not is_canonical_request_id(value):
        raise ValueError("request_id must match REQ_YYYYMMDDTHHMMSSZ_NNNN with a valid UTC timestamp")
    return value


def message_id_for_request_id(request_id: str) -> str:
    assert_canonical_request_id(request_id)
    return "MSG_" + request_id[4:]


def expected_artifact_filename(request_id: str, ordinal: int | None = None) -> str:
    assert_canonical_request_id(request_id)
    if ordinal is None:
        return f"POSTMAN_{request_id}_RESULT.zip"
    if isinstance(ordinal, bool) or not isinstance(ordinal, int) or not (1 <= ordinal <= 99):
        raise ValueError("artifact ordinal must be an integer from 1 through 99")
    return f"POSTMAN_{request_id}_RESULT-{ordinal:02d}.zip"


def validate_expected_artifact_filename(request_id: str, filename: str) -> bool:
    if not is_canonical_request_id(request_id) or not isinstance(filename, str):
        return False
    match = ARTIFACT_FILENAME_RE.fullmatch(filename)
    if match is None or match.group(1) != request_id:
        return False
    ordinal = match.group(2)
    return ordinal is None or ordinal != "00"


def request_prompt_key_line(request_id: str) -> str:
    assert_canonical_request_id(request_id)
    return f"POSTMAN_REQUEST_ID: {request_id}"
