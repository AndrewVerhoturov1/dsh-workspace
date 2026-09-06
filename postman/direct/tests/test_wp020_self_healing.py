from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

DIRECT_DIR = Path(__file__).resolve().parents[1]
if str(DIRECT_DIR) not in sys.path:
    sys.path.insert(0, str(DIRECT_DIR))

import finalization_common as common
import prepare_result

REPO = "AndrewVerhoturov1/dsh-workspace"
OLD_REQ = "REQ_20260904T020000Z_0001"
NEW_REQ = "REQ_20260904T020001Z_0002"
OLD_BRANCH = common.canonical_branch_name(OLD_REQ)


def git(cwd: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if check and result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


def init_repo(root: Path) -> tuple[Path, Path, str]:
    bare = root / "origin.git"
    primary = root / "primary"
    git(root, "init", "--bare", str(bare))
    git(root, "clone", str(bare), str(primary))
    git(primary, "config", "user.email", "wp020@example.invalid")
    git(primary, "config", "user.name", "WP-020 Tests")
    git(primary, "checkout", "-b", "main")
    (primary / "REPO_POLICY.md").write_text("# policy\n", encoding="utf-8")
    (primary / "base.txt").write_text("base\n", encoding="utf-8")
    git(primary, "add", "REPO_POLICY.md", "base.txt")
    git(primary, "commit", "-m", "base")
    git(primary, "push", "-u", "origin", "main")
    return bare, primary, git(primary, "rev-parse", "HEAD")


def old_result(root: Path, primary: Path, worktree: Path, commit: str) -> Path:
    handoff = root / "handoff" / OLD_REQ
    handoff.mkdir(parents=True)
    published = handoff / "published.json"
    common.atomic_write_json(
        published,
        {
            "ok": True,
            "code": "PUBLISHED",
            "requestId": OLD_REQ,
            "repository": REPO,
            "prNumber": 301,
            "commitSha": commit,
            "branch": OLD_BRANCH,
            "worktree": str(worktree.resolve()),
            "repoRoot": str(primary.resolve()),
            "worktreeRemoved": False,
            "worktreeRetained": True,
        },
    )
    common.atomic_write_json(
        handoff / "result-workspace.json",
        {
            "ok": True,
            "status": "RESULT_WORKSPACE_UNREGISTERED",
            "requestId": OLD_REQ,
            "workspaceId": "workspace-301",
            "worktree": str(worktree.resolve()),
            "workspaceRemoved": True,
            "resultSessionUsingWorktree": False,
        },
    )
    return published


def legacy_result(root: Path, *, retained_markers: dict | None = None) -> Path:
    handoff = root / "handoff" / OLD_REQ
    handoff.mkdir(parents=True)
    published = handoff / "published.json"
    data = {
        "ok": True,
        "code": "PUBLISHED",
        "requestId": OLD_REQ,
        "repository": REPO,
        "prNumber": 301,
        "commitSha": "a" * 40,
        "branch": OLD_BRANCH,
        "worktreeRemoved": True,
        "publishVersion": 1,
    }
    if retained_markers:
        data.update(retained_markers)
    common.atomic_write_json(published, data)
    return published


class FakeGitHub:
    def __init__(self, pr: dict | None = None, open_prs: list[dict] | None = None):
        self.pr = pr
        self.open_prs = open_prs or []

    def __call__(self, repository, endpoint, *, gh_binary="gh", method=None, payload=None):
        if endpoint.endswith("/pulls?state=open&per_page=100"):
            return list(self.open_prs)
        if "/pulls/" in endpoint:
            if self.pr is None:
                raise AssertionError("unexpected PR lookup")
            return dict(self.pr)
        raise AssertionError((repository, endpoint, method, payload))


def merged_pr(commit: str) -> dict:
    return {
        "number": 301,
        "state": "closed",
        "merged_at": "2026-09-04T02:00:00Z",
        "head": {"sha": commit, "ref": OLD_BRANCH},
        "base": {"ref": "main"},
    }


class WP020SelfHealingTests(unittest.TestCase):
    def test_maintenance_helper_still_can_cleanup_merged_owned_result(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, primary, _ = init_repo(root)
            old_worktree = root / "old-result"
            git(primary, "worktree", "add", "-b", OLD_BRANCH, str(old_worktree), "main")
            (old_worktree / "base.txt").write_text("old result\n", encoding="utf-8")
            git(old_worktree, "add", "base.txt")
            git(old_worktree, "commit", "-m", "old result")
            old_commit = git(old_worktree, "rev-parse", "HEAD")
            git(old_worktree, "push", "--set-upstream", "origin", OLD_BRANCH)
            old_result(root, primary, old_worktree, old_commit)
            api = FakeGitHub(merged_pr(old_commit))
            result = prepare_result._classify_and_self_heal(
                primary,
                repository=REPO,
                handoff_root=root / "handoff",
                gh_binary="gh",
                gh_api=api,
            )
            self.assertEqual("RESULT_WORKTREE_CLEANED", result[0]["code"])
            self.assertFalse(old_worktree.exists())

    def test_preflight_does_not_cleanup_or_block_unrelated_postman_resources(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, primary, _ = init_repo(root)
            extra = root / "unrelated"
            git(primary, "worktree", "add", "-b", OLD_BRANCH, str(extra), "main")
            with patch.object(common, "normalize_remote_repository", return_value=REPO):
                result = prepare_result.preflight_policy(primary, repository=REPO, handoff_root=root / "handoff", gh_api=FakeGitHub())
            self.assertEqual("permissive-v3", result["prepareMode"])
            self.assertEqual([], result["selfHealingCleanup"])
            self.assertTrue(result["selfHealingDeferred"])
            self.assertTrue(extra.exists())
            self.assertIn(OLD_BRANCH, result["localBranches"])

    def test_preflight_does_not_fast_forward_or_switch_dirty_primary(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bare, primary, local_main = init_repo(root)
            git(primary, "checkout", "-b", "user/local")
            (primary / "local.txt").write_text("dirty\n", encoding="utf-8")
            other = root / "other"
            git(root, "clone", str(bare), str(other))
            git(other, "checkout", "-b", "main", "origin/main")
            git(other, "config", "user.email", "wp020@example.invalid")
            git(other, "config", "user.name", "WP-020 Tests")
            (other / "remote.txt").write_text("remote\n", encoding="utf-8")
            git(other, "add", "remote.txt")
            git(other, "commit", "-m", "remote")
            git(other, "push", "origin", "main")
            with patch.object(common, "normalize_remote_repository", return_value=REPO):
                result = prepare_result.preflight_policy(primary, repository=REPO, handoff_root=root / "handoff", gh_api=FakeGitHub())
            self.assertEqual("user/local", git(primary, "branch", "--show-current"))
            self.assertEqual(local_main, git(primary, "rev-parse", "refs/heads/main"))
            self.assertFalse((primary / "remote.txt").exists())
            self.assertTrue((primary / "local.txt").exists())
            self.assertNotEqual(result["localMain"], result["originMain"])


if __name__ == "__main__":
    unittest.main()
