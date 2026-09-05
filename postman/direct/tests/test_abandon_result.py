from __future__ import annotations

import tempfile
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

DIRECT_DIR = Path(__file__).resolve().parents[1]
if str(DIRECT_DIR) not in sys.path:
    sys.path.insert(0, str(DIRECT_DIR))

import abandon_result
import finalization_common as common

REQ = "REQ_20260904T000000Z_0001"
BRANCH = "postman/req-20260904t000000z-0001"
SHA = "a" * 40


def published(root: Path) -> Path:
    handoff = root / "handoff"
    handoff.mkdir()
    path = handoff / "published.json"
    common.atomic_write_json(path, {
        "ok": True, "code": "PUBLISHED", "requestId": REQ,
        "repository": "owner/repo", "prNumber": 12, "branch": BRANCH,
        "commitSha": SHA, "remoteSha": SHA, "repoRoot": str(root),
        "worktree": str(root / "result"), "worktreeRetained": True,
        "worktreeRemoved": False,
    })
    common.atomic_write_json(handoff / "result-workspace.json", {
        "status": "RESULT_WORKSPACE_UNREGISTERED", "workspaceRemoved": True,
        "requestId": REQ, "worktree": str(root / "result"),
    })
    return path


class AbandonResultTests(unittest.TestCase):
    def test_requires_explicit_discard_before_any_lookup(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(common.FinalizationError) as error:
                abandon_result.abandon(published_json=Path(td) / "missing.json")
            self.assertEqual(error.exception.code, "ABANDON_DISCARD_REQUIRED")

    def test_rejects_open_or_merged_pr(self):
        with tempfile.TemporaryDirectory() as td:
            path = published(Path(td))
            with patch.object(abandon_result, "_gh_api", return_value={"state": "closed", "merged_at": "2026-09-05T00:00:00Z"}):
                with self.assertRaises(common.FinalizationError) as error:
                    abandon_result.abandon(published_json=path, discard=True, gh_api=lambda *args, **kwargs: {"state": "closed", "merged_at": "2026-09-05T00:00:00Z"})
            self.assertEqual(error.exception.code, "ABANDON_PR_NOT_CLOSED_UNMERGED")

    def test_requires_unregister_proof_and_clean_worktree(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = published(root)
            (root / "result").mkdir()
            with patch.object(abandon_result, "_gh_api", return_value={
                "number": 12, "state": "closed", "merged_at": None,
                "head": {"ref": BRANCH, "sha": SHA}, "base": {"ref": "main"},
            }), patch.object(common, "normalize_remote_repository", return_value="owner/repo"), patch.object(common, "registered_worktree_paths", return_value=[root, root / "result"]), patch.object(common, "run_git") as run_git:
                run_git.side_effect = lambda cwd, *args, **kwargs: type("R", (), {"returncode": 0, "stdout": ("git@github.com:owner/repo.git\n" if args[0] == "remote" else (BRANCH if args[:2] == ("branch", "--show-current") else "")), "stderr": ""})()
                with self.assertRaises(common.FinalizationError) as error:
                    abandon_result.abandon(published_json=path, discard=True, gh_api=lambda *args, **kwargs: {
                        "number": 12, "state": "closed", "merged_at": None,
                        "head": {"ref": BRANCH, "sha": SHA}, "base": {"ref": "main"},
                    })
            self.assertEqual(error.exception.code, "ABANDON_IDENTITY_INVALID")

    def test_already_abandoned_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            path = published(root)
            common.atomic_write_json(path.parent / "abandon.json", {
                "status": "ABANDONED", "requestId": REQ, "prNumber": 12,
                "branch": BRANCH, "commitSha": SHA, "worktree": str(root / "result"),
            })
            with patch.object(abandon_result, "_local_sha", return_value=None), patch.object(abandon_result, "_remote_sha", return_value=None):
                result = abandon_result.abandon(published_json=path, discard=True, repo_root=root)
            self.assertEqual(result["code"], "ALREADY_ABANDONED")
            self.assertTrue(result["alreadyAbandoned"])


if __name__ == "__main__":
    unittest.main()
