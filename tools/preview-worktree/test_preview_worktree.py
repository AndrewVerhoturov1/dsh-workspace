from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("preview_worktree.py")
spec = importlib.util.spec_from_file_location("preview_worktree", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)


def cp(args, code=0, out="", err=""):
    return subprocess.CompletedProcess(args=args, returncode=code, stdout=out, stderr=err)


class FakeGit:
    def __init__(self, root: Path, preview_root: Path, *, remote_preview=None, root_exists_unmanaged=False, dirty=False, preview_moved=False):
        self.root = root.resolve()
        self.preview_root = preview_root.resolve()
        self.remote_preview = remote_preview
        self.root_exists_unmanaged = root_exists_unmanaged
        self.dirty = dirty
        self.preview_moved = preview_moved
        self.main_sha = "a" * 40
        self.local_preview = None
        self.preview_registered = False
        self.preview_head = None
        self.calls = []

    def __call__(self, args, *, timeout=120):
        self.calls.append(list(args))
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "--show-toplevel"]:
            return cp(args, out=str(self.root) + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["remote", "get-url", "origin"]:
            return cp(args, out="https://github.com/AndrewVerhoturov1/dsh-workspace.git\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["fetch", "--prune", "origin"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "refs/remotes/origin/main"]:
            return cp(args, out=self.main_sha + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["show", "refs/remotes/origin/main:docs/workflow/PREVIEW_BRANCH_WORKFLOW.md"]:
            return cp(args, out="# Preview\nPREVIEW_BRANCH_WORKFLOW_VERSION: 1\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["ls-remote", "--heads", "origin", "refs/heads/preview"]:
            if self.remote_preview is None:
                return cp(args, out="")
            return cp(args, out=f"{self.remote_preview}\trefs/heads/preview\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["ls-remote", "--heads", "origin", "refs/heads/main"]:
            return cp(args, out=f"{self.main_sha}\trefs/heads/main\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["worktree", "list", "--porcelain"]:
            out = f"worktree {self.root}\nHEAD {self.main_sha}\nbranch refs/heads/main\n\n"
            if self.preview_registered:
                out += f"worktree {self.preview_root}\nHEAD {self.preview_head}\nbranch refs/heads/preview\n\n"
            return cp(args, out=out)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["show-ref", "--verify", "--hash", "refs/heads/preview"]:
            if self.local_preview is None:
                return cp(args, code=1)
            return cp(args, out=self.local_preview + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["push", "origin", f"{self.main_sha}:refs/heads/preview"]:
            self.remote_preview = self.main_sha
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["fetch", "origin", "preview:refs/remotes/origin/preview"]:
            return cp(args)
        if args[:3] == ["git", "-C", str(self.root)] and args[3:7] == ["worktree", "add", "--track", "-b"]:
            self.local_preview = self.remote_preview
            self.preview_registered = True
            self.preview_head = self.remote_preview
            return cp(args)
        if args[:3] == ["git", "-C", str(self.preview_root)] and args[3:] == ["rev-parse", "HEAD"]:
            return cp(args, out=(self.preview_head or "") + "\n")
        if args[:3] == ["git", "-C", str(self.preview_root)] and args[3:] == ["status", "--porcelain", "--untracked-files=all"]:
            return cp(args, out=" M local.txt\n" if self.dirty else "")
        if args[:3] == ["git", "-C", str(self.preview_root)] and args[3:] == ["rev-parse", "--show-toplevel"]:
            return cp(args, out=str(self.preview_root) + "\n")
        if args[:3] == ["git", "-C", str(self.root)] and args[3:] == ["rev-parse", "refs/remotes/origin/preview"]:
            if self.remote_preview is None:
                return cp(args, code=1)
            return cp(args, out=self.remote_preview + "\n")
        if args[:3] == ["git", "-C", str(self.preview_root)] and args[3:] == ["merge", "--ff-only", "origin/preview"]:
            if self.preview_moved:
                self.preview_head = self.remote_preview
            return cp(args)
        raise AssertionError(f"unexpected argv: {args}")


class PreviewWorktreeTests(unittest.TestCase):
    def test_bootstrap_creates_remote_preview_and_worktree_at_main(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            preview = Path(td) / "preview"
            root.mkdir()
            fake = FakeGit(root, preview)
            with patch.object(mod, "run_process", side_effect=fake), patch.object(Path, "exists", autospec=True) as exists:
                def exists_side(path):
                    p = Path(path).resolve()
                    if p == preview.resolve():
                        return fake.preview_registered or fake.root_exists_unmanaged
                    return True
                exists.side_effect = exists_side
                result = mod.action_bootstrap(root, preview, mod.DEFAULT_REPOSITORY)
            self.assertEqual("PREVIEW_BOOTSTRAPPED", result["code"])
            self.assertTrue(result["remotePreviewCreated"])
            self.assertEqual(fake.main_sha, result["originPreview"])
            self.assertTrue(result["worktree"]["created"])
            flat = [" ".join(c) for c in fake.calls]
            self.assertTrue(any(f"{fake.main_sha}:refs/heads/preview" in c for c in flat))
            self.assertFalse(any("--force" in c or "reset --hard" in c or " stash" in c or " clean" in c for c in flat))

    def test_bootstrap_refuses_existing_remote_preview_on_other_sha(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            preview = Path(td) / "preview"
            root.mkdir()
            fake = FakeGit(root, preview, remote_preview="b" * 40)
            with patch.object(mod, "run_process", side_effect=fake):
                with self.assertRaises(mod.PreviewWorktreeError) as error:
                    mod.action_bootstrap(root, preview, mod.DEFAULT_REPOSITORY)
            self.assertEqual("PREVIEW_REMOTE_ALREADY_INITIALIZED_DIFFERENT_SHA", error.exception.code)
            self.assertFalse(any(call[3:5] == ["push", "origin"] for call in fake.calls if call[:1] == ["git"]))

    def test_setup_refuses_unmanaged_existing_directory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            preview = Path(td) / "preview"
            root.mkdir()
            preview.mkdir()
            fake = FakeGit(root, preview, remote_preview="a" * 40, root_exists_unmanaged=True)
            with patch.object(mod, "run_process", side_effect=fake):
                with self.assertRaises(mod.PreviewWorktreeError) as error:
                    mod.action_setup(root, preview, mod.DEFAULT_REPOSITORY)
            self.assertEqual("PREVIEW_ROOT_EXISTS_UNMANAGED", error.exception.code)

    def test_update_refuses_dirty_preview(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            preview = Path(td) / "preview"
            root.mkdir()
            fake = FakeGit(root, preview, remote_preview="a" * 40, dirty=True)
            fake.local_preview = "a" * 40
            fake.preview_registered = True
            fake.preview_head = "a" * 40
            with patch.object(mod, "run_process", side_effect=fake):
                with self.assertRaises(mod.PreviewWorktreeError) as error:
                    mod.action_update(root, preview, mod.DEFAULT_REPOSITORY)
            self.assertEqual("PREVIEW_WORKTREE_DIRTY", error.exception.code)
            self.assertFalse(any(call[3:5] == ["merge", "--ff-only"] for call in fake.calls if call[:1] == ["git"]))

    def test_update_uses_ff_only(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            preview = Path(td) / "preview"
            root.mkdir()
            old = "a" * 40
            new = "b" * 40
            fake = FakeGit(root, preview, remote_preview=new, preview_moved=True)
            fake.local_preview = old
            fake.preview_registered = True
            fake.preview_head = old
            with patch.object(mod, "run_process", side_effect=fake):
                result = mod.action_update(root, preview, mod.DEFAULT_REPOSITORY)
            self.assertEqual("PREVIEW_WORKTREE_UPDATED", result["code"])
            self.assertEqual(new, result["after"]["head"])
            flat = [" ".join(c) for c in fake.calls]
            self.assertTrue(any("merge --ff-only origin/preview" in c for c in flat))

    def test_setup_refuses_dirty_existing_preview_worktree(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "repo"
            preview = Path(td) / "preview"
            root.mkdir()
            fake = FakeGit(root, preview, remote_preview="a" * 40, dirty=True)
            fake.local_preview = "a" * 40
            fake.preview_registered = True
            fake.preview_head = "a" * 40
            with patch.object(mod, "run_process", side_effect=fake):
                with self.assertRaises(mod.PreviewWorktreeError) as error:
                    mod.action_setup(root, preview, mod.DEFAULT_REPOSITORY)
            self.assertEqual("PREVIEW_EXISTING_WORKTREE_DIRTY", error.exception.code)

    def test_origin_url_normalization_is_exact(self):
        expected = mod.DEFAULT_REPOSITORY.lower()
        self.assertEqual(expected, mod.normalize_github_repository_url("https://github.com/AndrewVerhoturov1/dsh-workspace.git"))
        self.assertEqual(expected, mod.normalize_github_repository_url("git@github.com:AndrewVerhoturov1/dsh-workspace.git"))
        self.assertNotEqual(expected, mod.normalize_github_repository_url("https://github.com/AndrewVerhoturov1/dsh-workspace-other.git"))

    def test_source_forbids_destructive_operations(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("reset --hard", source)
        self.assertNotIn("git clean", source)
        self.assertNotIn("git stash", source)
        self.assertNotIn("--force", source)
        self.assertNotIn("rmtree", source)
        self.assertNotIn("unlink(", source)


if __name__ == "__main__":
    unittest.main()
