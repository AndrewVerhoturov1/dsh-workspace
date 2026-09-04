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
    def test_self_heals_merged_stale_result_and_continues_prepare(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, primary, base = init_repo(root)
            old_worktree = root / "old-result"
            git(primary, "worktree", "add", "-b", OLD_BRANCH, str(old_worktree), "main")
            (old_worktree / "base.txt").write_text("old result\n", encoding="utf-8")
            git(old_worktree, "add", "base.txt")
            git(old_worktree, "commit", "-m", "old result")
            old_commit = git(old_worktree, "rev-parse", "HEAD")
            git(old_worktree, "push", "--set-upstream", "origin", OLD_BRANCH)
            published = old_result(root, primary, old_worktree, old_commit)
            result_json = root / "new-result.json"
            result_json.write_text(json.dumps({
                "ok": True,
                "code": "RESULT_DURABLE",
                "state": "RESULT_DURABLE",
                "requestId": NEW_REQ,
                "repository": REPO,
            }), encoding="utf-8")

            def integrator(**kwargs):
                worktree = Path(kwargs["repo_root"])
                (worktree / "new.txt").write_text("new\n", encoding="utf-8")
                return {
                    "ok": True,
                    "code": "READY_FOR_TEST",
                    "requestId": NEW_REQ,
                    "repository": REPO,
                    "baseCommit": base,
                    "originMain": base,
                    "branch": common.canonical_branch_name(NEW_REQ),
                    "artifactSha256": "a" * 64,
                    "resultType": "files",
                    "changedFiles": ["new.txt"],
                }

            api = FakeGitHub(merged_pr(old_commit))
            with patch.object(common, "normalize_remote_repository", return_value=REPO):
                ready = prepare_result.prepare(
                    result_json=str(result_json),
                    repo_root=primary,
                    worktree_root=root / "worktrees",
                    handoff_root=root / "handoff",
                    gh_api=api,
                    integrator=integrator,
                )

            self.assertEqual("READY_FOR_TEST", ready["code"])
            self.assertEqual("RESULT_WORKTREE_CLEANED", ready["policyPreflight"]["selfHealingCleanup"][0]["code"])
            self.assertFalse(old_worktree.exists())
            self.assertNotIn(OLD_BRANCH, git(primary, "branch", "--format=%(refname:short)").splitlines())
            self.assertIn(common.canonical_branch_name(NEW_REQ), git(primary, "branch", "--format=%(refname:short)"))
            self.assertTrue(published.exists())

    def test_open_pr_blocks_preflight(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, primary, _ = init_repo(root)
            with self.assertRaises(common.FinalizationError) as ctx:
                with patch.object(common, "normalize_remote_repository", return_value=REPO):
                    prepare_result.preflight_policy(
                        primary,
                        repository=REPO,
                        handoff_root=root / "handoff",
                        gh_api=FakeGitHub(open_prs=[{"number": 7, "head": {"ref": OLD_BRANCH}}]),
                    )
            self.assertEqual("PREPARE_STALE_PR_OPEN", ctx.exception.code)

    def test_unknown_worktree_blocks_without_removal(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, primary, _ = init_repo(root)
            extra = root / "unknown"
            git(primary, "worktree", "add", "--detach", str(extra), "main")
            with self.assertRaises(common.FinalizationError) as ctx:
                with patch.object(common, "normalize_remote_repository", return_value=REPO):
                    prepare_result.preflight_policy(
                        primary,
                        repository=REPO,
                        handoff_root=root / "handoff",
                        gh_api=FakeGitHub(),
                    )
            self.assertEqual("PREPARE_UNKNOWN_POSTMAN_RESOURCE", ctx.exception.code)
            self.assertTrue(extra.exists())

    def test_dirty_main_is_preserved_across_ff_only_sync(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bare, primary, _ = init_repo(root)
            (primary / "local.txt").write_bytes("dirty bytes\n".encode("utf-8"))
            before = (primary / "local.txt").read_bytes()
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
                result = prepare_result.preflight_policy(
                    primary,
                    repository=REPO,
                    handoff_root=root / "handoff",
                    gh_api=FakeGitHub(),
                )
            self.assertEqual((primary / "local.txt").read_bytes(), before)
            self.assertTrue((primary / "remote.txt").exists())
            self.assertEqual(result["localMain"], result["originMain"])


if __name__ == "__main__":
    unittest.main()
