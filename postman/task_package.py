#!/usr/bin/env python3
"""Helpers for creating Web Postman task packages.

This module is deliberately transport-agnostic: it renders a task document and
builds the small prompt that points an external agent at published documents.
It does not write to GitHub, access the browser, or change Postman Runtime.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import PurePosixPath
import re
from urllib.parse import unquote, urlparse

try:
    from postman.web.request_identity import assert_canonical_request_id
except ModuleNotFoundError:  # pragma: no cover - supports direct module loading
    from web.request_identity import assert_canonical_request_id


SKILL_REPOSITORY_URL = (
    "https://raw.githubusercontent.com/AndrewVerhoturov1/"
    "agents-andrew-instructions/main/policies/postman-webchat-result-artifact.md"
)
_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")


class TaskPackageError(ValueError):
    """Raised when a task package would violate the protocol."""


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TaskPackageError(f"{field} must be a non-empty string")
    if "\r" in value or "\n" in value:
        raise TaskPackageError(f"{field} must be a single line")
    return value.strip()


def _document_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TaskPackageError(f"{field} must be a non-empty string")
    return value.strip()


def _https_url(value: object, field: str) -> str:
    text = _required_text(value, field)
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise TaskPackageError(f"{field} must be an absolute HTTP(S) URL")
    return text


def _documents(values: Iterable[str]) -> list[str]:
    if values is None or isinstance(values, (str, bytes)):
        raise TaskPackageError("required_documents must be an iterable of URLs")
    try:
        items = list(values)
    except TypeError as exc:
        raise TaskPackageError("required_documents must be an iterable of URLs") from exc
    result: list[str] = []
    for index, value in enumerate(items):
        result.append(_https_url(value, f"required_documents[{index}]"))
    if len(result) != len(set(result)):
        raise TaskPackageError("required_documents must not contain duplicates")
    if not result:
        raise TaskPackageError("required_documents must contain at least one URL")
    return result


def task_filename(request_id: str) -> str:
    """Return the safe GitHub filename for one canonical request."""

    try:
        assert_canonical_request_id(request_id)
    except (TypeError, ValueError) as exc:
        raise TaskPackageError(str(exc)) from exc
    return f"{request_id}.md"


def render_task_file(
    *,
    request_id: str,
    author: str,
    goal: str,
    repository: str,
    base_commit: str,
    required_documents: Iterable[str],
    task: str,
    expected_result: str,
    validation: str,
) -> str:
    """Render one UTF-8/LF Markdown task document.

    The returned text is content for a task file. Publishing it is intentionally
    left to the caller's normal GitHub branch/commit/PR flow.
    """

    try:
        assert_canonical_request_id(request_id)
    except (TypeError, ValueError) as exc:
        raise TaskPackageError(str(exc)) from exc

    author_value = _required_text(author, "author")
    goal_value = _document_text(goal, "goal")
    repository_value = _required_text(repository, "repository")
    base_commit_value = _required_text(base_commit, "base_commit")
    if not _SHA_RE.fullmatch(base_commit_value):
        raise TaskPackageError("base_commit must be a 40-character commit SHA")
    documents = _documents(required_documents)
    task_value = _document_text(task, "task")
    expected_value = _document_text(expected_result, "expected_result")
    validation_value = _document_text(validation, "validation")

    lines = [
        "# POSTMAN TASK",
        "",
        f"request_id: {request_id}",
        f"author: {author_value}",
        f"goal: {goal_value}",
        f"repository: {repository_value}",
        f"base_commit: {base_commit_value}",
        "required_documents:",
    ]
    lines.extend(f"- {document}" for document in documents)
    lines.extend(
        [
            "",
            "## Task",
            "",
            task_value,
            "",
            "## Expected result",
            "",
            expected_value,
            "",
            "## Validation",
            "",
            validation_value,
            "",
        ]
    )
    return "\n".join(lines)


def build_external_prompt(
    request_id: str,
    skill_repository_url: str,
    task_url: str,
) -> str:
    """Build a link-only prompt for the external agent.

    The prompt contains no task text, repository metadata, or transport details:
    only the immutable REQ and the two documents required by the protocol.
    """

    try:
        assert_canonical_request_id(request_id)
    except (TypeError, ValueError) as exc:
        raise TaskPackageError(str(exc)) from exc
    skill_url = _https_url(skill_repository_url, "skill_repository_url")
    published_task_url = _https_url(task_url, "task_url")
    task_path_name = unquote(urlparse(published_task_url).path.rstrip("/").rsplit("/", 1)[-1])
    if task_path_name != task_filename(request_id):
        raise TaskPackageError("task_url must point to the exact request task filename")
    return "\n".join(
        (
            f"POSTMAN_REQUEST_ID: {request_id}",
            f"skill_repository: {skill_url}",
            f"task_file: {published_task_url}",
        )
    )


def validate_task_path(path: str, request_id: str) -> bool:
    """Check that a published task path is exactly the request filename."""

    try:
        expected = task_filename(request_id)
    except TaskPackageError:
        return False
    candidate = PurePosixPath(path.replace("\\", "/"))
    return candidate.name == expected and str(candidate) == expected
