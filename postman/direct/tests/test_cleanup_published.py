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

REQ = "REQ_20260904T000000Z_0001"
REPO = "AndrewVerhoturov1/dsh-workspace"


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def fixture(root: Path):
    bare = root / "origin.git"
    primary = root / "primary"
    git(root, "init", "--bare", str(bare))
    git(root, "clone", str(bare), str(primary))
    git(primary, "config", "user.email", "postman-tests@example.invalid")
    git(primary, "config", "user.name", "Postman Tests")
    git(primary, "checkout", "-b", "main")
    (primary / "sample.txt").write_text("base\n", encoding="utf-8")
    git(primary, "add", "sample.txt")
    git(primary, "commit", "-m", "base")
    git(primary, "push", "-u", "origin", "main")
    branch = "postman/req-20260904t000000z-0001"
    worktree = root / "result"
    git(primary, "worktree", "add", "-b", branch, str(worktree), "main")
    (worktree / "sample.txt").write_text("result\n", encoding="utf-8")
    git(worktree, "add", "sample.txt")
    git(worktree, "commit", "-m", "result")
    commit = git(worktree, "rev-parse", "HEAD")
    handoff = root / "handoff" / REQ
    handoff.mkdir(parents=True)
    published = handoff / "published.json"
    common.atomic_write_json(
        published,
        {
            "ok": True,
            "code": "PUBLISHED",
            "requestId": REQ,
            "repository": REPO,
            "prNumber": 91,
            "commitSha": commit,
            "branch": branch,
            "worktree": str(worktree.resolve()),
            "repoRoot": str(primary.resolve()),
            "worktreeRemoved": False,
            "worktreeRetained": True,
        },
    )
    return primary, worktree, published, commit


def merged_pr(commit: str):
    return {
        "number": 91,
        "state": "closed",
        "merged_at": "2026-09-04T00:00:00Z",
        "head": {"sha": commit},
    }


class CleanupPublishedTests(unittest.TestCase):
    def test_requires_workspace_unregister_before_removing_worktree(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, worktree, published, commit = fixture(root)
            common.atomic_write_json(
                published.parent / "result-workspace.json",
                {
                    "status": "RESULT_WORKSPACE_REGISTERED",
                    "requestId": REQ,
                    "workspaceId": "workspace-91",
                    "worktree": str(worktree.resolve()),
                    "workspaceRemoved": False,
                },
            )
            with self.assertRaises(common.FinalizationError) as ctx:
                cleanup_published.cleanup(
                    published_json=published,
                    gh_api=lambda *args, **kwargs: merged_pr(commit),
                )
            self.assertEqual("CLEANUP_WORKSPACE_STILL_REGISTERED", ctx.exception.code)
            self.assertTrue(worktree.exists())

    def test_removes_clean_worktree_after_merge_and_workspace_unregister(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, worktree, published, commit = fixture(root)
            common.atomic_write_json(
                published.parent / "result-workspace.json",
                {
                    "status": "RESULT_WORKSPACE_UNREGISTERED",
                    "requestId": REQ,
                    "workspaceId": "workspace-91",
                    "worktree": str(worktree.resolve()),
                    "workspaceRemoved": True,
                },
            )
            result = cleanup_published.cleanup(
                published_json=published,
                gh_api=lambda *args, **kwargs: merged_pr(commit),
            )
            self.assertEqual("RESULT_WORKTREE_CLEANED", result["code"])
            self.assertTrue(result["workspaceRegistrationRemoved"])
            self.assertFalse(worktree.exists())

    def test_rejects_cleanup_before_merge(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, worktree, published, commit = fixture(root)
            common.atomic_write_json(
                published.parent / "result-workspace.json",
                {
                    "status": "RESULT_WORKSPACE_UNREGISTERED",
                    "requestId": REQ,
                    "workspaceId": "workspace-91",
                    "worktree": str(worktree.resolve()),
                    "workspaceRemoved": True,
                },
            )
            with self.assertRaises(common.FinalizationError) as ctx:
                cleanup_published.cleanup(
                    published_json=published,
                    gh_api=lambda *args, **kwargs: {
                        "number": 91, "state": "open", "merged_at": None, "head": {"sha": commit}
                    },
                )
            self.assertEqual("CLEANUP_PR_NOT_MERGED", ctx.exception.code)
            self.assertTrue(worktree.exists())

    def test_rejects_dirty_worktree(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, worktree, published, commit = fixture(root)
            common.atomic_write_json(
                published.parent / "result-workspace.json",
                {
                    "status": "RESULT_WORKSPACE_UNREGISTERED",
                    "requestId": REQ,
                    "workspaceId": "workspace-91",
                    "worktree": str(worktree.resolve()),
                    "workspaceRemoved": True,
                },
            )
            (worktree / "local.txt").write_text("dirty\n", encoding="utf-8")
            with self.assertRaises(common.FinalizationError) as ctx:
                cleanup_published.cleanup(
                    published_json=published,
                    gh_api=lambda *args, **kwargs: merged_pr(commit),
                )
            self.assertEqual("CLEANUP_WORKTREE_DIRTY", ctx.exception.code)
            self.assertTrue(worktree.exists())


if __name__ == "__main__":
    unittest.main()
