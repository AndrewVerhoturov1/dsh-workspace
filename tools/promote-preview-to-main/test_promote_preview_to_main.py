from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("promote_preview_to_main.py")
spec = importlib.util.spec_from_file_location("promote_preview_to_main", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def cp(args, code=0, out="", err=""):
    return subprocess.CompletedProcess(args=args, returncode=code, stdout=out, stderr=err)


class FakeCommands:
    def __init__(self, root: Path, *, marker=True, base="main", head="preview", preview_moved=False, already_merged=False, push_fail=False, main_moved=False):
        self.root = root.resolve()
        self.preview_root = (root.parent / "preview-root").resolve()
        self.marker = marker
        self.base = base
        self.head = head
        self.preview_moved = preview_moved
        self.already_merged = already_merged
        self.push_fail = push_fail
        self.main_moved = main_moved
        self.calls = []
        self.head_sha = "a" * 40
        self.merge_sha = "c" * 40
        self.gh_path = str((root / "gh.exe").resolve())
        self.after_merge = False
        self.preview_synced = already_merged

    def __call__(self, args, *, cwd=None, timeout=120):
        self.calls.append(list(args))
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "--show-toplevel"]:
            return cp(args, out=str(self.root) + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["remote", "get-url", "origin"]:
            return cp(args, out="https://github.com/AndrewVerhoturov1/dsh-workspace.git\n")
        if args[:2] == [self.gh_path, "api"] and args[-1].endswith("/pulls/12"):
            body = "Release\n\nMAIN_GO_APPROVED_BY_USER: yes\n" if self.marker else "Release\n"
            return cp(args, out=json.dumps({
                "state": "closed" if self.already_merged else "open",
                "merged_at": "2026-09-19T00:00:00Z" if self.already_merged else None,
                "merge_commit_sha": self.merge_sha if self.already_merged else None,
                "body": body,
                "html_url": "https://example.invalid/pr/12",
                "base": {"ref": self.base},
                "head": {"ref": self.head, "sha": self.head_sha, "repo": {"full_name": mod.DEFAULT_REPOSITORY}},
            }))
        if args[:4] == [self.gh_path, "api", "-X", "PUT"]:
            self.after_merge = True
            return cp(args, out=json.dumps({"merged": True, "sha": self.merge_sha}))
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["ls-remote", "--heads", "origin", "refs/heads/preview"]:
            if self.preview_synced:
                sha = self.merge_sha
            elif self.preview_moved:
                sha = "d" * 40
            else:
                sha = self.head_sha
            return cp(args, out=f"{sha}\trefs/heads/preview\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["fetch", "--prune", "origin"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "refs/remotes/origin/main"]:
            return cp(args, out=(("e" * 40) if self.main_moved else self.merge_sha) + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["push", "origin", f"{self.merge_sha}:refs/heads/preview"]:
            if self.push_fail:
                return cp(args, code=1, err="rejected\n")
            self.preview_synced = True
            return cp(args)
        raise AssertionError(f"unexpected argv: {args}")


class PromotePreviewTests(unittest.TestCase):
    def run_promote(self, fake):
        with patch.object(mod, "run_process", side_effect=fake), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
            return mod.promote(
                repo_root=fake.root,
                preview_root=fake.preview_root,
                repository=mod.DEFAULT_REPOSITORY,
                pr_number=12,
            )

    def test_open_promotion_uses_merge_commit_and_fast_forwards_preview(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve())
            result = self.run_promote(fake)
            self.assertTrue(result["ok"])
            self.assertEqual("PREVIEW_PROMOTED", result["code"])
            self.assertEqual("merge", result["mergeMethod"])
            self.assertEqual("synced", result["previewSync"])
            self.assertEqual(fake.merge_sha, result["originMain"])
            self.assertEqual(fake.merge_sha, result["originPreview"])
            flat = [" ".join(c) for c in fake.calls]
            self.assertTrue(any("merge_method=merge" in c for c in flat))
            self.assertFalse(any("merge_method=squash" in c for c in flat))
            self.assertFalse(any("--force" in c or "reset --hard" in c or " clean" in c or " stash" in c for c in flat))

    def test_missing_user_go_marker_is_rejected_before_merge(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), marker=False)
            with patch.object(mod, "run_process", side_effect=fake), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
                with self.assertRaises(mod.PromotionError) as error:
                    mod.promote(repo_root=fake.root, preview_root=fake.preview_root, repository=mod.DEFAULT_REPOSITORY, pr_number=12)
            self.assertEqual("PROMOTE_MAIN_GO_MARKER_MISSING", error.exception.code)
            self.assertFalse(any(call[:4] == [fake.gh_path, "api", "-X", "PUT"] for call in fake.calls))

    def test_wrong_base_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), base="preview")
            with patch.object(mod, "run_process", side_effect=fake), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
                with self.assertRaises(mod.PromotionError) as error:
                    mod.promote(repo_root=fake.root, preview_root=fake.preview_root, repository=mod.DEFAULT_REPOSITORY, pr_number=12)
            self.assertEqual("PROMOTE_BASE_NOT_MAIN", error.exception.code)

    def test_wrong_head_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), head="feature/x")
            with patch.object(mod, "run_process", side_effect=fake), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
                with self.assertRaises(mod.PromotionError) as error:
                    mod.promote(repo_root=fake.root, preview_root=fake.preview_root, repository=mod.DEFAULT_REPOSITORY, pr_number=12)
            self.assertEqual("PROMOTE_HEAD_NOT_PREVIEW", error.exception.code)

    def test_preview_moved_before_merge_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), preview_moved=True)
            with patch.object(mod, "run_process", side_effect=fake), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
                with self.assertRaises(mod.PromotionError) as error:
                    mod.promote(repo_root=fake.root, preview_root=fake.preview_root, repository=mod.DEFAULT_REPOSITORY, pr_number=12)
            self.assertEqual("PROMOTE_PREVIEW_MOVED", error.exception.code)

    def test_main_move_after_merge_skips_preview_sync_without_force(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), main_moved=True)
            result = self.run_promote(fake)
            self.assertEqual("PREVIEW_PROMOTED_WITH_WARNINGS", result["code"])
            self.assertEqual("skipped-main-moved", result["previewSync"])
            self.assertIn("PROMOTE_MAIN_MOVED_AFTER_MERGE", {w["code"] for w in result["warnings"]})
            self.assertFalse(any(call[3:5] == ["push", "origin"] for call in fake.calls if call[:1] == ["git"]))

    def test_preview_fast_forward_failure_is_warning_not_force_retry(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), push_fail=True)
            result = self.run_promote(fake)
            self.assertEqual("PREVIEW_PROMOTED_WITH_WARNINGS", result["code"])
            self.assertEqual("push-failed", result["previewSync"])
            pushes = [call for call in fake.calls if call[:3] == ["git", "-C", str(fake.root)] and call[3:5] == ["push", "origin"]]
            self.assertEqual(1, len(pushes))
            self.assertNotIn("--force", pushes[0])

    def test_already_merged_and_synced_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve(), already_merged=True)
            result = self.run_promote(fake)
            self.assertTrue(result["alreadyMerged"])
            self.assertFalse(result["mergedNow"])
            self.assertEqual("already-synced", result["previewSync"])
            self.assertFalse(any(call[:4] == [fake.gh_path, "api", "-X", "PUT"] for call in fake.calls))

    def test_origin_repository_mismatch_is_rejected_before_pr_read(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeCommands(Path(td).resolve())
            original = fake.__call__

            def wrong_origin(args, *, cwd=None, timeout=120):
                if args[:3] == ["git", "-C", str(fake.root)] and args[3:] == ["remote", "get-url", "origin"]:
                    return cp(args, out="git@github.com:AndrewVerhoturov1/dsh-workspace-other.git\n")
                return original(args, cwd=cwd, timeout=timeout)

            with patch.object(mod, "run_process", side_effect=wrong_origin), patch.object(mod, "resolve_gh_executable", return_value=fake.gh_path):
                with self.assertRaises(mod.PromotionError) as error:
                    mod.promote(repo_root=fake.root, preview_root=fake.preview_root, repository=mod.DEFAULT_REPOSITORY, pr_number=12)
            self.assertEqual("PROMOTE_ORIGIN_REPOSITORY_MISMATCH", error.exception.code)
            self.assertFalse(any(call[:2] == [fake.gh_path, "api"] for call in fake.calls))

    def test_origin_url_normalization_accepts_https_and_ssh_exact_only(self):
        expected = mod.DEFAULT_REPOSITORY.lower()
        self.assertEqual(expected, mod.normalize_github_repository_url("https://github.com/AndrewVerhoturov1/dsh-workspace.git"))
        self.assertEqual(expected, mod.normalize_github_repository_url("git@github.com:AndrewVerhoturov1/dsh-workspace.git"))
        self.assertNotEqual(expected, mod.normalize_github_repository_url("https://github.com/AndrewVerhoturov1/dsh-workspace-other.git"))

    def test_source_has_no_delete_preview_or_destructive_git(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("--delete\", \"preview", source)
        self.assertNotIn("reset --hard", source)
        self.assertNotIn("git clean", source)
        self.assertNotIn("git stash", source)
        self.assertNotIn("--force", source)


if __name__ == "__main__":
    unittest.main()
