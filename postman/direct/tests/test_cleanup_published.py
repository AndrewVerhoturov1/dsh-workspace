from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DIRECT_DIR = Path(__file__).resolve().parents[1]
if str(DIRECT_DIR) not in sys.path:
    sys.path.insert(0, str(DIRECT_DIR))

import cleanup_published
import finalization_common as common


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class CleanupPublishedTests(unittest.TestCase):
    def fixture(self, root: Path):
        primary = root / "primary"
        primary.mkdir()
        git(primary, "init", "-b", "main")
        git(primary, "config", "user.email", "postman-tests@example.invalid")
        git(primary, "config", "user.name", "Postman Tests")
        (primary / "sample.txt").write_text("base\n", encoding="utf-8")
        git(primary, "add", "sample.txt")
        git(primary, "commit", "-m", "base")
        worktree = root / "task"
        git(primary, "worktree", "add", "-b", "postman/req-test", str(worktree), "main")
        (worktree / "sample.txt").write_text("result\n", encoding="utf-8")
        git(worktree, "add", "sample.txt")
        git(worktree, "commit", "-m", "result")
        commit = git(worktree, "rev-parse", "HEAD")
        receipt = root / "handoff" / "REQ_TEST" / "published.json"
        receipt.parent.mkdir(parents=True)
        common.atomic_write_json(receipt, {
            "ok": True,
            "code": "PUBLISHED",
            "requestId": "REQ_TEST",
            "repository": "owner/repo",
            "prNumber": 81,
            "commitSha": commit,
            "branch": "postman/req-test",
            "worktree": str(worktree),
            "repoRoot": str(primary),
            "worktreeRemoved": False,
            "worktreeRetained": True,
        })
        return primary, worktree, receipt, commit

    def test_cleanup_requires_merge(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, worktree, receipt, commit = self.fixture(root)
            with self.assertRaises(common.FinalizationError) as ctx:
                cleanup_published.cleanup(
                    published_json=receipt,
                    gh_api=lambda *args, **kwargs: {"state": "open", "merged_at": None, "head": {"sha": commit}},
                )
            self.assertEqual("CLEANUP_PR_NOT_MERGED", ctx.exception.code)
            self.assertTrue(worktree.exists())

    def test_cleanup_removes_clean_exact_worktree_after_merge(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, worktree, receipt, commit = self.fixture(root)
            result = cleanup_published.cleanup(
                published_json=receipt,
                gh_api=lambda *args, **kwargs: {"state": "closed", "merged_at": "2026-09-03T00:00:00Z", "head": {"sha": commit}},
            )
            self.assertEqual("RESULT_WORKTREE_CLEANED", result["code"])
            self.assertFalse(worktree.exists())
            self.assertTrue((receipt.parent / "cleanup.json").is_file())


if __name__ == "__main__":
    unittest.main()
