#!/usr/bin/env python3
"""Self-contained task renderer for text-only Direct PostmanAsk requests."""

from __future__ import annotations

import re

try:
    from postman.web.request_identity import assert_canonical_request_id
except ModuleNotFoundError:  # pragma: no cover - direct module loading
    from web.request_identity import assert_canonical_request_id

_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")


class TextTaskPackageError(ValueError):
    pass


def render_direct_text_task_manifest(
    *,
    request_id: str,
    user_intent: str,
    repository: str,
    base_commit: str,
) -> str:
    try:
        assert_canonical_request_id(request_id)
    except (TypeError, ValueError) as exc:
        raise TextTaskPackageError(str(exc)) from exc
    if not isinstance(user_intent, str) or not user_intent.strip():
        raise TextTaskPackageError("user_intent must be a non-empty string")
    if not isinstance(repository, str) or not repository.strip() or "\n" in repository or "\r" in repository:
        raise TextTaskPackageError("repository must be a non-empty single-line string")
    if not isinstance(base_commit, str) or not _SHA_RE.fullmatch(base_commit.strip()):
        raise TextTaskPackageError("base_commit must be a 40-character commit SHA")

    intent = user_intent.replace("\r\n", "\n").replace("\r", "\n")
    base = base_commit.strip().lower()
    begin = f"<<<POSTMAN_ASK_BEGIN:{request_id}>>>"
    end = f"<<<POSTMAN_ASK_END:{request_id}>>>"
    lines = [
        "# POSTMAN ASK TASK",
        "",
        "protocol_version: 1",
        f"request_id: {request_id}",
        "result_mode: text",
        f"repository: {repository.strip()}",
        f"base_commit: {base}",
        "",
        "## User intent",
        "",
        intent,
        "",
        "## Execution contract",
        "",
        "- Этот task-файл self-contained; выполнить `User intent` буквально.",
        "- `repository` и `base_commit` — только transport/correlation metadata.",
        "- GitHub использовать только как READ source, если он действительно нужен для user intent.",
        "- Не commit, не push, не открывать PR/issues и не изменять GitHub.",
        "- PostmanAsk ожидает текстовый transport result; ZIP/attachment не нужен.",
        "",
        "## Result contract",
        "",
        "- Сначала полностью выполнить задачу и подготовить итоговый непустой текст.",
        "- Финальный assistant response должен содержать ровно один BEGIN marker и один END marker текущего request_id.",
        "- До BEGIN и после END не должно быть другого видимого текста.",
        "- Между markers поместить весь итоговый ответ; Markdown и code blocks внутри разрешены.",
        "- Не повторять transport markers внутри тела ответа.",
        "",
        begin,
        "<итоговый непустой текст>",
        end,
        "",
    ]
    return "\n".join(lines)
