from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
import re


@dataclass
class TaskPackage:
    request_id: str
    path: Path
    content: str


REQ_PATTERN = re.compile(r"^REQ_\d{8}T\d{6}Z_\d{4}$")


def validate_request_id(request_id: str) -> bool:
    return bool(REQ_PATTERN.fullmatch(request_id))


def _intent_text(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _confirmed_requirements(values: Iterable[str] | None) -> list[str]:
    if values is None:
        return []
    if isinstance(values, (str, bytes)):
        raise ValueError("confirmed_requirements must be an iterable of text items")
    try:
        items = list(values)
    except TypeError as exc:
        raise ValueError("confirmed_requirements must be an iterable of text items") from exc

    result = []
    for index, value in enumerate(items):
        result.append(_intent_text(value, f"confirmed_requirements[{index}]").strip())
    return result


def render_task_file(
    request_id: str,
    user_intent: str,
    repository: str | None = None,
    base_commit: str | None = None,
    expected_output: str | None = None,
    confirmed_requirements: Iterable[str] | None = None,
) -> str:
    """Render only user intent and explicitly confirmed requirements.

    Legacy transport arguments remain accepted for compatibility but are never
    serialized into the task file.
    """
    if not validate_request_id(request_id):
        raise ValueError("invalid request_id")

    intent = _intent_text(user_intent, "user_intent")
    requirements = _confirmed_requirements(confirmed_requirements)
    content = f"""# POSTMAN TASK

user_intent:
{intent}
"""
    if requirements:
        content += "\nconfirmed_requirements:\n"
        content += "\n".join(f"- {requirement}" for requirement in requirements)
        content += "\n"
    return content


def create_task_file(
    tasks_dir: Path,
    request_id: str,
    user_intent: str,
    repository: str | None = None,
    base_commit: str | None = None,
    confirmed_requirements: Iterable[str] | None = None,
) -> TaskPackage:
    tasks_dir.mkdir(parents=True, exist_ok=True)
    path = tasks_dir / f"{request_id}.md"
    content = render_task_file(
        request_id,
        user_intent,
        repository,
        base_commit,
        confirmed_requirements=confirmed_requirements,
    )
    path.write_text(content, encoding="utf-8", newline="\n")
    return TaskPackage(request_id, path, content)
