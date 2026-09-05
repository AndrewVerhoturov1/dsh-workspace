from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
import sys

DIRECT = Path(__file__).resolve().parents[1]
if str(DIRECT) not in sys.path:
    sys.path.insert(0, str(DIRECT))

import finalization_common as common
import presentation_status


class PresentationStatusTests(unittest.TestCase):
    def test_presented_is_separate_from_user_acceptance(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            published = root / "REQ_20260903T010203Z_1234" / "published.json"
            common.atomic_write_json(published, {
                "ok": True, "code": "PUBLISHED", "requestId": "REQ_20260903T010203Z_1234",
                "repository": "owner/repo", "publishedJson": str(published),
                "worktree": str(root / "worktree"),
            })
            result = presentation_status.record_presentation(
                published_json=published,
                status="PRESENTED",
                workspace_id="workspace-1",
                session_id="session-1",
                session_closed=True,
            )
            self.assertEqual("RESULT_PRESENTED", result["code"])
            self.assertEqual("PRESENTED", result["status"])
            self.assertEqual("PENDING", result["userVisualAcceptance"])
            self.assertTrue((published.parent / "presentation.json").is_file())


if __name__ == "__main__":
    unittest.main()
