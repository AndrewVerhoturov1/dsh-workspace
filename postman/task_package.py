#!/usr/bin/env python3
"""Helpers for creating Web Postman task packages.

This module is deliberately transport-agnostic: it renders WP-009-compatible
or WP-010 intent-preserving task documents and builds the small prompt that
points an external agent at published documents. It does not write to GitHub,
access the browser, or change Postman Runtime.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import PurePosixPath
import json
import re
from urllib.parse import unquote, urlparse

try:
    from postman.web.request_identity import (
        assert_canonical_request_id,
        validate_expected_artifact_filename,
    )
except ModuleNotFoundError:  # pragma: no cover - supports direct module loading
    from web.request_identity import (
        assert_canonical_request_id,
        validate_expected_artifact_filename,
    )


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


def _intent_items(values: Iterable[str] | None, field: str, *, required: bool) -> list[str]:
    """Validate explicit intent data without inventing defaults or reordering it."""

    if values is None:
        if required:
            raise TaskPackageError(f"{field} must contain at least one confirmed item")
        return []
    if isinstance(values, (str, bytes)):
        raise TaskPackageError(f"{field} must be an iterable of text items")
    try:
        items = list(values)
    except TypeError as exc:
        raise TaskPackageError(f"{field} must be an iterable of text items") from exc

    result = [_required_text(value, f"{field}[{index}]") for index, value in enumerate(items)]
    if required and not result:
        raise TaskPackageError(f"{field} must contain at least one confirmed item")
    return result


def _intent_section(field: str, values: list[str]) -> list[str]:
    lines = [f"{field}:"]
    lines.extend(f"- {value}" for value in values)
    return lines


def _path_items(values: Iterable[str], field: str) -> list[str]:
    if values is None or isinstance(values, (str, bytes)):
        raise TaskPackageError(f"{field} must be an iterable of repository paths")
    try:
        items = list(values)
    except TypeError as exc:
        raise TaskPackageError(f"{field} must be an iterable of repository paths") from exc
    result = [_required_text(value, f"{field}[{index}]") for index, value in enumerate(items)]
    if not result:
        raise TaskPackageError(f"{field} must contain at least one path")
    if len(result) != len(set(result)):
        raise TaskPackageError(f"{field} must not contain duplicates")
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


def render_intent_task_file(
    *,
    request_id: str,
    user_intent: str,
    confirmed_requirements: Iterable[str],
    required_documents: Iterable[str],
    repository: str,
    base_commit: str,
    expected_output: str,
    validation: str,
    clarifications: Iterable[str] | None = None,
    constraints: Iterable[str] | None = None,
) -> str:
    """Render a task file containing only explicitly supplied intent data.

    This is the WP-010 entry point. It performs validation and formatting only:
    it never answers a clarification, infers a requirement, or designs a
    solution on behalf of the external agent.
    """

    try:
        assert_canonical_request_id(request_id)
    except (TypeError, ValueError) as exc:
        raise TaskPackageError(str(exc)) from exc

    intent_value = _document_text(user_intent, "user_intent")
    confirmed_values = _intent_items(
        confirmed_requirements, "confirmed_requirements", required=True
    )
    clarification_values = _intent_items(clarifications, "clarifications", required=False)
    constraint_values = _intent_items(constraints, "constraints", required=False)
    documents = _documents(required_documents)
    repository_value = _required_text(repository, "repository")
    base_commit_value = _required_text(base_commit, "base_commit")
    if not _SHA_RE.fullmatch(base_commit_value):
        raise TaskPackageError("base_commit must be a 40-character commit SHA")
    expected_value = _document_text(expected_output, "expected_output")
    validation_value = _document_text(validation, "validation")

    lines = [
        "# POSTMAN TASK",
        "",
        f"request_id: {request_id}",
        "user_intent:",
        intent_value,
    ]
    for field, values in (
        ("confirmed_requirements", confirmed_values),
        ("clarifications", clarification_values),
        ("constraints", constraint_values),
    ):
        lines.extend(("", *_intent_section(field, values)))
    lines.extend(
        (
            "",
            "required_documents:",
            *(f"- {document}" for document in documents),
            "",
            f"repository: {repository_value}",
            f"base_commit: {base_commit_value}",
            "",
            "expected_output:",
            expected_value,
            "",
            "validation:",
            validation_value,
            "",
        )
    )
    return "\n".join(lines)


def render_direct_task_manifest(
    *,
    request_id: str,
    user_intent: str,
    repository: str,
    base_commit: str,
    expected_filename: str,
    allowed_paths: Iterable[str],
    forbidden_paths: Iterable[str],
) -> str:
    """Render the self-contained task document used by Direct Web Postman.

    `base_commit` is the implementation snapshot from immediately BEFORE the
    transport-only REQ file is published. The publication commit is intentionally
    not embedded here because doing so would create a self-referential commit hash.
    """

    try:
        assert_canonical_request_id(request_id)
    except (TypeError, ValueError) as exc:
        raise TaskPackageError(str(exc)) from exc

    if not isinstance(user_intent, str) or not user_intent.strip():
        raise TaskPackageError("user_intent must be a non-empty string")
    intent_value = user_intent.replace("\r\n", "\n").replace("\r", "\n")

    repository_value = _required_text(repository, "repository")
    base_commit_value = _required_text(base_commit, "base_commit").lower()
    if not _SHA_RE.fullmatch(base_commit_value):
        raise TaskPackageError("base_commit must be a 40-character commit SHA")

    expected_value = _required_text(expected_filename, "expected_filename")
    if not validate_expected_artifact_filename(request_id, expected_value):
        raise TaskPackageError("expected_filename does not match request_id")

    allowed = _path_items(allowed_paths, "allowed_paths")
    forbidden = _path_items(forbidden_paths, "forbidden_paths")

    lines = [
        "# POSTMAN TASK",
        "",
        "protocol_version: 1",
        f"request_id: {request_id}",
        f"repository: {repository_value}",
        f"base_commit: {base_commit_value}",
        f"expected_filename: {expected_value}",
        "allowed_paths_json: " + json.dumps(allowed, ensure_ascii=False, separators=(",", ":")),
        "forbidden_paths_json: " + json.dumps(forbidden, ensure_ascii=False, separators=(",", ":")),
        "",
        "## User intent",
        "",
        intent_value,
        "",
        "## Execution contract",
        "",
        "- Сначала прочитать policy по ссылке `policy:` из transport prompt.",
        "- `User intent` выше является авторитетным пользовательским намерением; не заменять его догадками transport-слоя.",
        "- GitHub использовать только как READ source: не commit, не push, не открывать PR/issues и не изменять GitHub.",
        "- Реализацию готовить против точного `base_commit` из этого task-файла.",
        "- Не писать вне `allowed_paths_json` и никогда не писать внутри `forbidden_paths_json`.",
        "- Архитектуру, реализацию, необходимые тесты и документацию Ч1 выбирает самостоятельно в рамках user intent.",
        "",
        "## Result contract",
        "",
        "- Создать ровно один реальный downloadable ZIP implementation artifact по policy contract.",
        "- Root `manifest.json` ZIP должен exact-match `requestId`, `repository` и `baseCommit` из этого task-файла.",
        f"- Имя ZIP должно быть ровно `{expected_value}`.",
        "- Финальный ответ Ч1 должен содержать ровно три непустые видимые строки и ничего больше:",
        "",
        f"<<<POSTMAN_RESULT_BEGIN:{request_id}>>>",
        expected_value,
        f"<<<POSTMAN_RESULT_END:{request_id}>>>",
        "",
        f"- Средняя строка должна быть реальным downloadable ZIP attachment/control с visible filename `{expected_value}`, а не plain text.",
        "",
    ]
    return "\n".join(lines)


def build_external_prompt(
    request_id: str,
    skill_repository_url: str,
    task_url: str,
) -> str:
    """Build the canonical three-line link-only prompt for the external agent.

    The prompt contains no task text, repository metadata, artifact metadata,
    path scope, result markers, or implementation instructions. All request-
    specific details live in the published task file.
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
            f"policy: {skill_url}",
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
