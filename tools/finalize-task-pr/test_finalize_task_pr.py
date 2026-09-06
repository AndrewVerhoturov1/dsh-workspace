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


class FakeCommands:
    def __init__(self, root: Path, *, dirty=False, moved_local=False, moved_remote=False, already_merged=False):
        self.root = root.resolve()
        self.worktree = (root.parent / "task-worktree").resolve()
        self.dirty = dirty
        self.moved_local = moved_local
        self.moved_remote = moved_remote
        self.already_merged = already_merged
        self.calls = []
        self.head_sha = "a" * 40
        self.main_sha = "b" * 40

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
            return cp(args, out=json.dumps({"merged": True, "sha": "c" * 40}))
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["fetch", "--prune", "origin"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["worktree", "list", "--porcelain"]:
            out = (
                f"worktree {self.root}\nHEAD {self.main_sha}\nbranch refs/heads/main\n\n"
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
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "refs/remotes/origin/main"]:
            return cp(args, out=self.main_sha + "\n")
        raise AssertionError(f"unexpected argv: {args}")


class FinalizeTaskPrTests(unittest.TestCase):
    def test_open_pr_merges_and_cleans(self):
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
            flat = [" ".join(call) for call in fake.calls]
            self.assertTrue(any("merge_method=squash" in call for call in flat))
            self.assertFalse(any("reset --hard" in call or " stash" in call or " clean" in call for call in flat))

    def test_already_merged_skips_merge_api_but_cleans(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, already_merged=True)
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.finalize_many(repo_root=root, repository=mod.DEFAULT_REPOSITORY, pr_numbers=[7])
            self.assertTrue(result["results"][0]["alreadyMerged"])
            self.assertFalse(any(call[:4] == ["gh", "api", "-X", "PUT"] for call in fake.calls))

    def test_dirty_worktree_is_warning_not_merge_failure(self):
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
