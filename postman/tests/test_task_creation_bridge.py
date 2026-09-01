from pathlib import Path

import pytest

from postman.task_creation_bridge import create_task_file, render_task_file


REQUEST_ID = "REQ_20260901T120000Z_1234"
USER_INTENT = "Postman, создай простой калькулятор в древне-японском стиле."


def test_creates_intent_only_task_file(tmp_path: Path):
    result = create_task_file(
        tmp_path,
        REQUEST_ID,
        USER_INTENT,
        "AndrewVerhoturov1/dsh-workspace",
        "a" * 40,
    )

    assert result.path == tmp_path / f"{REQUEST_ID}.md"
    assert result.path.exists()
    assert result.content == (
        "# POSTMAN TASK\n\n"
        "user_intent:\n"
        f"{USER_INTENT}\n"
    )


def test_serializes_only_explicitly_confirmed_requirements(tmp_path: Path):
    result = create_task_file(
        tmp_path,
        REQUEST_ID,
        USER_INTENT,
        "repository-must-not-be-serialized",
        "b" * 40,
        confirmed_requirements=["Сохранить смысл запроса без изменений."],
    )

    assert result.content == (
        "# POSTMAN TASK\n\n"
        "user_intent:\n"
        f"{USER_INTENT}\n\n"
        "confirmed_requirements:\n"
        "- Сохранить смысл запроса без изменений.\n"
    )
    for transport_field in ("request_id", "repository", "base_commit", "expected_output", "constraints"):
        assert f"{transport_field}:" not in result.content


def test_rejects_empty_intent_and_invalid_request_id():
    with pytest.raises(ValueError, match="invalid request_id"):
        render_task_file("REQ_BAD", USER_INTENT)
    with pytest.raises(ValueError, match="user_intent"):
        render_task_file(REQUEST_ID, "   ")
