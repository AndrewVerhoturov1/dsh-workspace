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
    def __init__(
        self,
        root: Path,
        *,
        dirty=False,
        moved_local=False,
        moved_remote=False,
        already_merged=False,
        base="preview",
        head="feature/x",
        task_worktree_at_preview_root=False,
    ):
        self.root = root.resolve()
        self.preview_root = (root.parent / "preview-root").resolve()
        self.worktree = self.preview_root if task_worktree_at_preview_root else (root.parent / "task-worktree").resolve()
        self.dirty = dirty
        self.moved_local = moved_local
        self.moved_remote = moved_remote
        self.already_merged = already_merged
        self.base = base
        self.head = head
        self.calls = []
        self.head_sha = "a" * 40
        self.preview_sha = "b" * 40
        self.gh_path = str((root / "gh.exe").resolve())

    def __call__(self, args, *, cwd=None, timeout=120):
        self.calls.append(list(args))
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "--show-toplevel"]:
            return cp(args, out=str(self.root) + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["remote", "get-url", "origin"]:
            return cp(args, out="https://github.com/AndrewVerhoturov1/dsh-workspace.git\n")
        if args[:2] == [self.gh_path, "api"] and args[-1].endswith("/pulls/7"):
            data = {
                "state": "closed" if self.already_merged else "open",
                "merged_at": "2026-09-19T00:00:00Z" if self.already_merged else None,
                "merge_commit_sha": "c" * 40 if self.already_merged else None,
                "html_url": "https://example.invalid/pr/7",
                "base": {"ref": self.base},
                "head": {"ref": self.head, "sha": self.head_sha, "repo": {"full_name": mod.DEFAULT_REPOSITORY}},
            }
            return cp(args, out=json.dumps(data))
        if args[:4] == [self.gh_path, "api", "-X", "PUT"]:
            return cp(args, out=json.dumps({"merged": True, "sha": "c" * 40}))
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["fetch", "--prune", "origin"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["worktree", "list", "--porcelain"]:
            out = (
                f"worktree {self.root}\nHEAD {'d' * 40}\nbranch refs/heads/main\n\n"
                f"worktree {self.preview_root}\nHEAD {self.preview_sha}\nbranch refs/heads/preview\n\n"
            )
            if self.head not in mod.PERMANENT_BRANCHES:
                out += f"worktree {self.worktree}\nHEAD {self.head_sha}\nbranch refs/heads/{self.head}\n\n"
            return cp(args, out=out)
        if args[:3] == ["git", "-C", str(self.worktree)] and args[3:] == ["status", "--porcelain", "--untracked-files=all"]:
            return cp(args, out=" M file.txt\n" if self.dirty else "")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:5] == ["worktree", "remove"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["worktree", "prune"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["show-ref", "--verify", "--hash", f"refs/heads/{self.head}"]:
            return cp(args, out=(("e" * 40) if self.moved_local else self.head_sha) + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:5] == ["update-ref", "-d"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["ls-remote", "--heads", "origin", f"refs/heads/{self.head}"]:
            sha = "f" * 40 if self.moved_remote else self.head_sha
            return cp(args, out=f"{sha}\trefs/heads/{self.head}\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["push", "origin", "--delete", self.head]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "refs/remotes/origin/preview"]:
            return cp(args, out=self.preview_sha + "\n")
        raise AssertionError(f"unexpected argv: {args}")


class FinalizeTaskPrTests(unittest.TestCase):
    def run_finalize(self, fake, *, number=7):
        with patch.object(mod, "run_process", side_effect=fake), patch.object(
            mod, "resolve_gh_executable", return_value=fake.gh_path
        ):
            return mod.finalize_many(
                repo_root=fake.root,
                preview_root=fake.preview_root,
                repository=mod.DEFAULT_REPOSITORY,
                pr_numbers=[number],
            )

    def test_open_preview_pr_merges_and_cleans(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root)
            result = self.run_finalize(fake)
            self.assertTrue(result["ok"])
            self.assertEqual("TASK_PRS_FINALIZED", result["code"])
            self.assertEqual("preview", result["targetBranch"])
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
            result = self.run_finalize(fake)
            self.assertTrue(result["results"][0]["alreadyMerged"])
            self.assertFalse(any(call[:4] == [fake.gh_path, "api", "-X", "PUT"] for call in fake.calls))

    def test_dirty_worktree_is_warning_not_merge_failure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, dirty=True)
            result = self.run_finalize(fake)
            self.assertEqual("TASK_PRS_FINALIZED_WITH_WARNINGS", result["code"])
            codes = {w["code"] for w in result["warnings"]}
            self.assertIn("FINALIZE_DIRTY_WORKTREE_SKIPPED", codes)
            self.assertIn("FINALIZE_LOCAL_BRANCH_IN_USE", codes)
            self.assertTrue(result["results"][0]["cleanup"]["remoteBranchRemoved"])

    def test_moved_refs_are_left_untouched(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            fake = FakeCommands(root, moved_local=True, moved_remote=True)
            result = self.run_finalize(fake)
            codes = {w["code"] for w in result["warnings"]}
            self.assertIn("FINALIZE_LOCAL_BRANCH_MOVED", codes)
            self.assertIn("FINALIZE_REMOTE_BRANCH_MOVED", codes)
            self.assertFalse(any(call[3:5] == ["update-ref", "-d"] for call in fake.calls if call[:1] == ["git"]))
            self.assertFalse(any(call[3:] == ["push", "origin", "--delete", "feature/x"] for call in fake.calls if call[:1] == ["git"]))

    def test_main_base_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), base="main")
            with patch.object(mod, "run_process", side_effect=fake), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
                with self.assertRaises(mod.FinalizeError) as error:
                    mod.finalize_many(
                        repo_root=fake.root,
                        preview_root=fake.preview_root,
                        repository=mod.DEFAULT_REPOSITORY,
                        pr_numbers=[7],
                    )
            self.assertEqual("FINALIZE_BASE_NOT_PREVIEW", error.exception.code)

    def test_preview_head_is_rejected_as_permanent(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), head="preview")
            with patch.object(mod, "run_process", side_effect=fake), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
                with self.assertRaises(mod.FinalizeError) as error:
                    mod.finalize_many(
                        repo_root=fake.root,
                        preview_root=fake.preview_root,
                        repository=mod.DEFAULT_REPOSITORY,
                        pr_numbers=[7],
                    )
            self.assertEqual("FINALIZE_PERMANENT_BRANCH_PROTECTED", error.exception.code)

    def test_preview_root_is_never_removed_even_if_task_branch_is_there(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), task_worktree_at_preview_root=True)
            result = self.run_finalize(fake)
            codes = {w["code"] for w in result["warnings"]}
            self.assertIn("FINALIZE_PERMANENT_WORKTREE_PROTECTED", codes)
            self.assertIn("FINALIZE_LOCAL_BRANCH_IN_USE", codes)
            self.assertFalse(any(call[3:5] == ["worktree", "remove"] for call in fake.calls if call[:1] == ["git"]))

    def test_origin_repository_mismatch_is_rejected_before_pr_read(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve())
            original = fake.__call__

            def wrong_origin(args, *, cwd=None, timeout=120):
                if args[:3] == ["git", "-C", str(fake.root)] and args[3:] == ["remote", "get-url", "origin"]:
                    return cp(args, out="https://github.com/AndrewVerhoturov1/dsh-workspace-other.git\n")
                return original(args, cwd=cwd, timeout=timeout)

            with patch.object(mod, "run_process", side_effect=wrong_origin), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
                with self.assertRaises(mod.FinalizeError) as error:
                    mod.finalize_many(
                        repo_root=fake.root,
                        preview_root=fake.preview_root,
                        repository=mod.DEFAULT_REPOSITORY,
                        pr_numbers=[7],
                    )
            self.assertEqual("FINALIZE_ORIGIN_REPOSITORY_MISMATCH", error.exception.code)
            self.assertFalse(any(call[:2] == [fake.gh_path, "api"] for call in fake.calls))

    def test_origin_url_normalization_accepts_https_and_ssh_exact_only(self):
        expected = mod.DEFAULT_REPOSITORY.lower()
        self.assertEqual(expected, mod.normalize_github_repository_url("https://github.com/AndrewVerhoturov1/dsh-workspace.git"))
        self.assertEqual(expected, mod.normalize_github_repository_url("git@github.com:AndrewVerhoturov1/dsh-workspace.git"))
        self.assertNotEqual(expected, mod.normalize_github_repository_url("https://github.com/AndrewVerhoturov1/dsh-workspace-other.git"))

    def test_source_contains_no_review_gate_or_destructive_commands(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("gh pr checks", source)
        self.assertNotIn("pytest", source)
        self.assertNotIn("git diff --check", source)
        self.assertNotIn("reset --hard", source)
        self.assertNotIn("git clean", source)
        self.assertNotIn("git stash", source)
        self.assertNotIn("--force", source)


class GitHubCliResolverTests(unittest.TestCase):
    def test_dsh_gh_path_has_priority(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            configured = root / "configured-gh.exe"
            on_path = root / "path-gh.exe"
            configured.write_text("", encoding="utf-8")
            on_path.write_text("", encoding="utf-8")
            result = mod.resolve_gh_executable(
                env={"DSH_GH_PATH": str(configured), "LOCALAPPDATA": str(root / "local")},
                which=lambda _: str(on_path),
            )
            self.assertEqual(str(configured.resolve()), result)

    def test_shutil_which_result_is_used(self):
        with tempfile.TemporaryDirectory() as td:
            on_path = Path(td) / "gh.exe"
            on_path.write_text("", encoding="utf-8")
            with patch.object(mod.shutil, "which", return_value=str(on_path)) as which:
                result = mod.resolve_gh_executable(env={}, which=None)
            self.assertEqual(str(on_path.resolve()), result)
            which.assert_called_once_with("gh")

    def test_missing_gh_returns_specific_diagnostic(self):
        with patch.object(mod, "_existing_absolute_file", return_value=None):
            with self.assertRaises(mod.FinalizeError) as error:
                mod.resolve_gh_executable(env={"LOCALAPPDATA": r"C:\Users\Test\AppData\Local"}, which=lambda _: None)
        self.assertEqual("FINALIZE_GH_NOT_FOUND", error.exception.code)
        self.assertIn("DSH_GH_PATH", error.exception.details["hint"])

    def test_run_process_preserves_windows_no_window_flag(self):
        completed = cp(["git", "--version"])
        with patch.object(mod.subprocess, "run", return_value=completed) as run:
            result = mod.run_process(["git", "--version"])
        self.assertIs(result, completed)
        self.assertEqual(mod.CREATE_NO_WINDOW, run.call_args.kwargs["creationflags"])


if __name__ == "__main__":
    unittest.main()
