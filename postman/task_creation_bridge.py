from dataclasses import dataclass
from pathlib import Path
from datetime import datetime, timezone
import re


@dataclass
class TaskPackage:
    request_id: str
    path: Path
    content: str


REQ_PATTERN = re.compile(r"^REQ_\d{8}T\d{6}Z_\d{4}$")


def validate_request_id(request_id: str) -> bool:
    return bool(REQ_PATTERN.match(request_id))


def render_task_file(
    request_id: str,
    user_intent: str,
    repository: str,
    base_commit: str,
    expected_output: str = "ZIP artifact",
) -> str:
    if not validate_request_id(request_id):
        raise ValueError("invalid request_id")

    return f"""# POSTMAN TASK

request_id:
{request_id}

repository:
{repository}

base_commit:
{base_commit}

user_intent:
{user_intent}

confirmed_requirements:
{{}}

constraints:
{{}}

expected_output:
{expected_output}
"""


def create_task_file(
    tasks_dir: Path,
    request_id: str,
    user_intent: str,
    repository: str,
    base_commit: str,
) -> TaskPackage:
    tasks_dir.mkdir(parents=True, exist_ok=True)
    path = tasks_dir / f"{request_id}.md"
    content = render_task_file(
        request_id,
        user_intent,
        repository,
        base_commit,
    )
    path.write_text(content, encoding="utf-8")
    return TaskPackage(request_id, path, content)
