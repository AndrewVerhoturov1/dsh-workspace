from pathlib import Path
from postman.task_creation_bridge import create_task_file


def test_creates_task_file(tmp_path):
    result = create_task_file(
        tmp_path,
        "REQ_20260901T120000Z_1234",
        "Create Japanese style calculator",
        "repo/test",
        "abc123",
    )

    assert result.path.exists()
    assert "Create Japanese style calculator" in result.content
