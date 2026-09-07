from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("finalize_task_pr.py")
spec = importlib.util.spec_from_file_location("finalize_task_pr", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def cp(args, code=0, out="", err=""):
    return subprocess.CompletedProcess(args=args, returncode=code, stdout=out, stderr=err)


def real_git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


class FakeCommands:
    def __init__(
        self,
        root: Path,
        *,
        dirty=False,
        moved_local=False,
        moved_remote=False,
        already_merged=False,
        primary_branch="main",
        primary_sync_fails=False,
        primary_diverged=False,
        fetch_fails=False,
    ):
        self.root = root.resolve()
        self.worktree = (root.parent / "task-worktree").resolve()
        self.dirty = dirty
        self.moved_local = moved_local
        self.moved_remote = moved_remote
        self.already_merged = already_merged
        self.primary_branch = primary_branch
        self.primary_sync_fails = primary_sync_fails
        self.primary_diverged = primary_diverged
        self.fetch_fails = fetch_fails
        self.calls = []
        self.head_sha = "a" * 40
        self.primary_head = "b" * 40
        self.origin_main = "c" * 40

    def __call__(self, args, *, cwd=None, timeout=120):
        self.calls.append(list(args))
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "--show-toplevel"]:
            return cp(args, out=str(self.root) + "\n")
        if args[:2] == ["gh", "api"] and args[-1].endswith("/pulls/7"):
            data = {
                "state": "closed" if self.already_merged else "open",
                "merged_at": "2026-09-06T00:00:00Z" if self.already_merged else None,
                "html_url": "https://example.invalid/pr/7",
                "base": {"ref": "main"},
                "head": {"ref": "feature/x", "sha": self.head_sha, "repo": {"full_name": mod.DEFAULT_REPOSITORY}},
            }
            return cp(args, out=json.dumps(data))
        if args[:4] == ["gh", "api", "-X", "PUT"]:
            return cp(args, out=json.dumps({"merged": True, "sha": self.origin_main}))
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["fetch", "--prune", "origin"]:
            return cp(args, code=1, err="fetch failed") if self.fetch_fails else cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["worktree", "list", "--porcelain"]:
            out = (
                f"worktree {self.root}\nHEAD {self.primary_head}\nbranch refs/heads/{self.primary_branch}\n\n"
                f"worktree {self.worktree}\nHEAD {self.head_sha}\nbranch refs/heads/feature/x\n\n"
            )
            return cp(args, out=out)
        if args[:3] == ["git", "-C", str(self.worktree)] and args[3:] == ["status", "--porcelain", "--untracked-files=all"]:
            return cp(args, out=" M file.txt\n" if self.dirty else "")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:5] == ["worktree", "remove"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["worktree", "prune"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["show-ref", "--verify", "--hash", "refs/heads/feature/x"]:
            return cp(args, out=(("d" * 40) if self.moved_local else self.head_sha) + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:5] == ["update-ref", "-d"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["ls-remote", "--heads", "origin", "refs/heads/feature/x"]:
            sha = "e" * 40 if self.moved_remote else self.head_sha
            return cp(args, out=f"{sha}\trefs/heads/feature/x\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["push", "origin", "--delete", "feature/x"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["branch", "--show-current"]:
            return cp(args, out=self.primary_branch + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "HEAD"]:
            return cp(args, out=self.primary_head + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "refs/remotes/origin/main"]:
            return cp(args, out=self.origin_main + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == [
            "merge-base", "--is-ancestor", self.primary_head, "refs/remotes/origin/main"
        ]:
            return cp(args, code=1 if self.primary_diverged else 0)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == [
            "merge", "--ff-only", "refs/remotes/origin/main"
        ]:
            if self.primary_sync_fails:
                return cp(args, code=1, err="local changes would be overwritten")
            self.primary_head = self.origin_main
            return cp(args, out="Fast-forward\n")
        raise AssertionError(f"unexpected argv: {args}")


class FinalizeTaskPrTests(unittest.TestCase):
    def test_open_pr_merges_cleans_and_updates_primary_main(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root)
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertTrue(result["ok"])
            self.assertEqual("TASK_PRS_FINALIZED", result["code"])
            item = result["results"][0]
            self.assertTrue(item["mergedNow"])
            self.assertTrue(item["cleanup"]["localBranchRemoved"])
            self.assertTrue(item["cleanup"]["remoteBranchRemoved"])
            self.assertEqual("UPDATED", result["primaryMainSync"]["status"])
            self.assertTrue(result["mainWorkingTreeTouched"])
            flat = [" ".join(call) for call in fake.calls]
            self.assertTrue(any("merge_method=squash" in call for call in flat))
            self.assertTrue(any("merge --ff-only refs/remotes/origin/main" in call for call in flat))
            self.assertFalse(any("reset --hard" in call or " stash" in call or " clean" in call for call in flat))

    def test_already_merged_skips_merge_api_but_cleans_and_syncs(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, already_merged=True)
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertTrue(result["results"][0]["alreadyMerged"])
            self.assertEqual("UPDATED", result["primaryMainSync"]["status"])
            self.assertFalse(any(call[:4] == ["gh", "api", "-X", "PUT"] for call in fake.calls))

    def test_dirty_secondary_worktree_is_warning_not_merge_failure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, dirty=True)
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertEqual("TASK_PRS_FINALIZED_WITH_WARNINGS", result["code"])
            codes = {w["code"] for w in result["warnings"]}
            self.assertIn("FINALIZE_DIRTY_WORKTREE_SKIPPED", codes)
            self.assertIn("FINALIZE_LOCAL_BRANCH_IN_USE", codes)
            self.assertTrue(result["results"][0]["cleanup"]["remoteBranchRemoved"])
            self.assertTrue(result["mainWorkingTreeTouched"])

    def test_moved_refs_are_left_untouched(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, moved_local=True, moved_remote=True)
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            codes = {w["code"] for w in result["warnings"]}
            self.assertIn("FINALIZE_LOCAL_BRANCH_MOVED", codes)
            self.assertIn("FINALIZE_REMOTE_BRANCH_MOVED", codes)
            self.assertFalse(any(call[3:5] == ["update-ref", "-d"] for call in fake.calls if call[:1] == ["git"]))
            self.assertFalse(any(call[3:] == ["push", "origin", "--delete", "feature/x"] for call in fake.calls if call[:1] == ["git"]))

    def test_primary_not_main_is_warning_and_is_not_switched(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, primary_branch="implementation/agent-team-mvp-v1")
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertEqual("TASK_PRS_FINALIZED_WITH_WARNINGS", result["code"])
            self.assertEqual("SKIPPED_NOT_MAIN", result["primaryMainSync"]["status"])
            self.assertFalse(result["mainWorkingTreeTouched"])
            codes = {w["code"] for w in result["warnings"]}
            self.assertIn("FINALIZE_PRIMARY_NOT_MAIN", codes)
            flat = [" ".join(call) for call in fake.calls]
            self.assertFalse(any("merge --ff-only refs/remotes/origin/main" in call for call in flat))

    def test_primary_fast_forward_failure_is_warning_not_merge_failure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, primary_sync_fails=True)
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertEqual("TASK_PRS_FINALIZED_WITH_WARNINGS", result["code"])
            self.assertTrue(result["results"][0]["mergedNow"])
            self.assertEqual("SKIPPED_FF_FAILED", result["primaryMainSync"]["status"])
            self.assertFalse(result["mainWorkingTreeTouched"])
            self.assertIn("FINALIZE_PRIMARY_MAIN_SYNC_SKIPPED", {w["code"] for w in result["warnings"]})

    def test_primary_diverged_is_warning_without_fast_forward_attempt(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, primary_diverged=True)
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertEqual("SKIPPED_DIVERGED", result["primaryMainSync"]["status"])
            self.assertFalse(result["primaryMainSync"]["attempted"])
            self.assertIn("FINALIZE_PRIMARY_MAIN_DIVERGED", {w["code"] for w in result["warnings"]})

    def test_fetch_failure_skips_primary_sync(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, fetch_fails=True)
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertEqual("SKIPPED_STALE_REMOTE_REFS", result["primaryMainSync"]["status"])
            codes = {w["code"] for w in result["warnings"]}
            self.assertIn("FINALIZE_FETCH_WARNING", codes)
            self.assertIn("FINALIZE_PRIMARY_SYNC_SKIPPED_STALE_REFS", codes)

    def test_sync_primary_main_preserves_unrelated_dirty_file(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td, "repo").resolve()
            root.mkdir()
            self.assertEqual(0, real_git(root, "init").returncode)
            self.assertEqual(0, real_git(root, "config", "user.email", "test@example.invalid").returncode)
            self.assertEqual(0, real_git(root, "config", "user.name", "Test").returncode)
            self.assertEqual(0, real_git(root, "branch", "-M", "main").returncode)

            (root / "app.txt").write_text("v1\n", encoding="utf-8")
            (root / "runtime.txt").write_text("clean\n", encoding="utf-8")
            self.assertEqual(0, real_git(root, "add", ".").returncode)
            self.assertEqual(0, real_git(root, "commit", "-m", "base").returncode)
            base = real_git(root, "rev-parse", "HEAD").stdout.strip()

            (root / "app.txt").write_text("v2\n", encoding="utf-8")
            self.assertEqual(0, real_git(root, "add", "app.txt").returncode)
            self.assertEqual(0, real_git(root, "commit", "-m", "incoming").returncode)
            incoming = real_git(root, "rev-parse", "HEAD").stdout.strip()
            self.assertEqual(0, real_git(root, "update-ref", "refs/remotes/origin/main", incoming).returncode)
            self.assertEqual(0, real_git(root, "reset", "--hard", base).returncode)

            (root / "runtime.txt").write_text("local dirty\n", encoding="utf-8")
            result = mod.sync_primary_main(root, dry_run=False)

            self.assertEqual("UPDATED", result["status"])
            self.assertTrue(result["updated"])
            self.assertEqual(incoming, real_git(root, "rev-parse", "HEAD").stdout.strip())
            self.assertEqual("v2\n", (root / "app.txt").read_text(encoding="utf-8"))
            self.assertEqual("local dirty\n", (root / "runtime.txt").read_text(encoding="utf-8"))
            self.assertIn("runtime.txt", real_git(root, "status", "--short").stdout)

    def test_wrong_base_fails_before_merge(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()

            def fake(args, *, cwd=None, timeout=120):
                if args[:3] == ["git", "-C", str(root)] and args[3:] == ["rev-parse", "--show-toplevel"]:
                    return cp(args, out=str(root) + "\n")
                if args[:2] == ["gh", "api"]:
                    return cp(args, out=json.dumps({
                        "state": "open", "merged_at": None, "base": {"ref": "release"},
                        "head": {"ref": "feature/x", "sha": "a" * 40, "repo": {"full_name": mod.DEFAULT_REPOSITORY}},
                    }))
                raise AssertionError(args)

            with patch.object(mod, "run_process", side_effect=fake):
                with self.assertRaises(mod.FinalizeError) as error:
                    mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertEqual("FINALIZE_BASE_NOT_MAIN", error.exception.code)

    def test_source_contains_no_review_gate_commands(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("gh pr checks", source)
        self.assertNotIn("pytest", source)
        self.assertNotIn("git diff --check", source)
        self.assertNotIn("reset --hard", source)
        self.assertNotIn("git clean", source)
        self.assertNotIn("git stash", source)


if __name__ == "__main__":
    unittest.main()
