from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).with_name("promote_main_to_preview.py")
spec = importlib.util.spec_from_file_location("promote_main_to_preview", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

APPROVED = "a" * 40
PREVIEW = "b" * 40
MOVED = "c" * 40
ORIGIN_URL = "git@github.com:AndrewVerhoturov1/dsh-workspace.git"


def cp(args, code=0, out="", err=""):
    return subprocess.CompletedProcess(args=args, returncode=code, stdout=out, stderr=err)


class FakeGit:
    """Strict fake of git argv, with distinct actual remote reads and fetched refs."""

    def __init__(self, root: Path, *, remote_reads=None, origin_url=ORIGIN_URL,
                 fetched_main=APPROVED, fetched_preview=PREVIEW, ancestor_code=0,
                 fetch_fail=False, push_fail=False, remote_fail_at=None, actual_root=None):
        self.root = root.resolve()
        self.origin_url = origin_url
        self.fetched_main = fetched_main
        self.fetched_preview = fetched_preview
        self.ancestor_code = ancestor_code
        self.fetch_fail = fetch_fail
        self.push_fail = push_fail
        self.remote_fail_at = remote_fail_at
        self.actual_root = actual_root or self.root
        self.remote_reads = remote_reads or [(APPROVED, PREVIEW), (APPROVED, PREVIEW), (APPROVED, APPROVED)]
        self.read_count = 0
        self.calls: list[list[str]] = []

    def __call__(self, args, *, timeout=120):
        args = list(args)
        self.calls.append(args)
        prefix = ["git", "-C", str(self.root)]
        if args[:3] != prefix:
            raise AssertionError(f"Unexpected non-git execution: {args}")
        tail = args[3:]
        if tail == ["rev-parse", "--show-toplevel"]:
            return cp(args, out=str(self.actual_root) + "\n")
        if tail == ["remote", "get-url", "origin"]:
            return cp(args, out=self.origin_url + "\n")
        if tail == ["fetch", "--no-tags", "origin"]:
            return cp(args, code=128 if self.fetch_fail else 0, err="fetch denied" if self.fetch_fail else "")
        if tail == ["ls-remote", "--heads", "origin", "refs/heads/main", "refs/heads/preview"]:
            self.read_count += 1
            if self.remote_fail_at == self.read_count:
                return cp(args, code=128, err="remote permission denied")
            if self.read_count > len(self.remote_reads):
                raise AssertionError("Unexpected extra remote ref read")
            main, preview = self.remote_reads[self.read_count - 1]
            lines = []
            if main is not None:
                lines.append(f"{main}\trefs/heads/main")
            if preview is not None:
                lines.append(f"{preview}\trefs/heads/preview")
            return cp(args, out="\n".join(lines) + "\n")
        if tail == ["rev-parse", "--verify", "refs/remotes/origin/main"]:
            return cp(args, out=self.fetched_main + "\n")
        if tail == ["rev-parse", "--verify", "refs/remotes/origin/preview"]:
            return cp(args, out=self.fetched_preview + "\n")
        if tail == ["merge-base", "--is-ancestor", PREVIEW, APPROVED]:
            return cp(args, code=self.ancestor_code, err="bad graph" if self.ancestor_code == 128 else "")
        if tail == ["push", "origin", f"{APPROVED}:refs/heads/preview"]:
            return cp(args, code=1 if self.push_fail else 0, err="non-fast-forward or permissions" if self.push_fail else "")
        raise AssertionError(f"Unexpected git command: {args}")

    def git_calls(self, command: str) -> list[list[str]]:
        return [call for call in self.calls if call[3:4] == [command]]


class PromoteMainToPreviewTests(unittest.TestCase):
    def run_promote(self, fake: FakeGit, *, sha=APPROVED, go=True):
        with patch.object(mod, "run_process", side_effect=fake):
            return mod.promote(repo_root=fake.root, approved_main_sha=sha, user_go=go)

    def assert_blocked(self, fake: FakeGit, expected_code: str):
        with self.assertRaises(mod.PromotionError) as caught:
            self.run_promote(fake)
        self.assertEqual(expected_code, caught.exception.code)
        self.assertFalse(fake.git_calls("push"))

    def test_requires_full40_sha_and_explicit_go_before_any_git_call(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td))
            for sha, go, error in [
                (None, True, "PROMOTE_APPROVED_SHA_INVALID"),
                ("abc", True, "PROMOTE_APPROVED_SHA_INVALID"),
                ("z" * 40, True, "PROMOTE_APPROVED_SHA_INVALID"),
                (APPROVED, False, "PROMOTE_USER_GO_REQUIRED"),
            ]:
                with self.subTest(sha=sha, go=go):
                    with self.assertRaises(mod.PromotionError) as caught:
                        self.run_promote(fake, sha=sha, go=go)
                    self.assertEqual(error, caught.exception.code)
            self.assertEqual([], fake.calls)

    def test_cli_rejects_missing_go_and_missing_sha_without_git(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td))
            with patch.object(mod, "run_process", side_effect=fake):
                out = io.StringIO()
                with redirect_stdout(out):
                    code = mod.main(["--repo-root", str(fake.root), "--approved-main-sha", APPROVED])
                self.assertEqual(2, code)
                self.assertEqual("PROMOTE_USER_GO_REQUIRED", json.loads(out.getvalue())["code"])
                with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as missing:
                    mod.main(["--repo-root", str(fake.root), "--user-go"])
                self.assertNotEqual(0, missing.exception.code)
            self.assertEqual([], fake.calls)

    def test_wrong_repository_and_non_top_level_repo_block_before_fetch(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            fake = FakeGit(root, origin_url="https://github.com/AndrewVerhoturov1/other.git")
            self.assert_blocked(fake, "PROMOTE_ORIGIN_REPOSITORY_MISMATCH")
            self.assertFalse(fake.git_calls("fetch"))
            fake = FakeGit(root, actual_root=root / "other")
            self.assert_blocked(fake, "PROMOTE_REPO_ROOT_MISMATCH")
            self.assertFalse(fake.git_calls("fetch"))

    def test_origin_identity_accepts_https_and_ssh_but_not_lookalikes(self):
        expected = mod.DEFAULT_REPOSITORY.lower()
        self.assertEqual(expected, mod.normalize_github_repository_url(ORIGIN_URL))
        self.assertEqual(expected, mod.normalize_github_repository_url("https://github.com/AndrewVerhoturov1/dsh-workspace.git"))
        self.assertIsNone(mod.normalize_github_repository_url("https://evil.github.com/AndrewVerhoturov1/dsh-workspace"))
        self.assertNotEqual(expected, mod.normalize_github_repository_url("https://github.com/AndrewVerhoturov1/dsh-workspace-other"))

    def test_exact_sha_non_force_ff_push_and_final_verification(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td))
            result = self.run_promote(fake, sha=APPROVED.upper())
            self.assertTrue(result["ok"])
            self.assertEqual("PREVIEW_PROMOTED", result["code"])
            self.assertEqual(APPROVED, result["approvedMainSha"])
            self.assertEqual(PREVIEW, result["previewBefore"])
            self.assertEqual(APPROVED, result["originMain"])
            self.assertEqual(APPROVED, result["originPreview"])
            self.assertTrue(result["pushPerformed"])
            self.assertEqual(3, fake.read_count)  # initial / pre-push / final actual remote
            self.assertEqual([["git", "-C", str(fake.root), "push", "origin", f"{APPROVED}:refs/heads/preview"]], fake.git_calls("push"))
            self.assertEqual(1, len(fake.git_calls("fetch")))
            self.assertEqual(1, len(fake.git_calls("merge-base")))
            self.assertTrue(fake.calls.index(fake.git_calls("merge-base")[0]) < fake.calls.index(fake.git_calls("push")[0]))
            self.assertTrue(all(result[field] is False for field in ("mainWorkingTreeTouched", "previewWorkingTreeTouched", "previewBranchDeleted")))
            forbidden_git_ops = {"worktree", "checkout", "reset", "clean", "stash", "merge", "branch", "update-ref"}
            self.assertFalse(any(call[3] in forbidden_git_ops for call in fake.calls))
            self.assertFalse(any(arg.startswith("--force") or arg in ("-f", "--force-with-lease") for call in fake.calls for arg in call))

    def test_verified_noop_when_preview_equals_approved(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td), fetched_preview=APPROVED, remote_reads=[(APPROVED, APPROVED), (APPROVED, APPROVED)])
            result = self.run_promote(fake)
            self.assertEqual("PREVIEW_ALREADY_AT_APPROVED_MAIN", result["code"])
            self.assertEqual(APPROVED, result["originPreview"])
            self.assertFalse(result["pushPerformed"])
            self.assertEqual(2, fake.read_count)
            self.assertFalse(fake.git_calls("push"))
            self.assertFalse(fake.git_calls("merge-base"))

    def test_actual_main_must_equal_approved_sha(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td), remote_reads=[(MOVED, PREVIEW)])
            self.assert_blocked(fake, "PROMOTE_MAIN_SHA_MISMATCH")

    def test_both_fetched_refs_must_match_actual_remote_refs(self):
        with tempfile.TemporaryDirectory() as td:
            for main, preview in [(MOVED, PREVIEW), (APPROVED, MOVED)]:
                with self.subTest(main=main, preview=preview):
                    fake = FakeGit(Path(td), fetched_main=main, fetched_preview=preview)
                    self.assert_blocked(fake, "PROMOTE_FETCHED_REFS_STALE")

    def test_preview_divergence_and_unknown_ancestry_are_blockers(self):
        with tempfile.TemporaryDirectory() as td:
            for rc, code in [(1, "PROMOTE_PREVIEW_DIVERGED"), (128, "PROMOTE_ANCESTRY_CHECK_FAILED")]:
                with self.subTest(rc=rc):
                    fake = FakeGit(Path(td), ancestor_code=rc)
                    self.assert_blocked(fake, code)

    def test_movement_of_main_or_preview_before_push_blocks_without_retry(self):
        with tempfile.TemporaryDirectory() as td:
            for remote_reads, code in [
                ([(APPROVED, PREVIEW), (MOVED, PREVIEW)], "PROMOTE_MAIN_MOVED_BEFORE_PUSH"),
                ([(APPROVED, PREVIEW), (APPROVED, MOVED)], "PROMOTE_PREVIEW_MOVED_BEFORE_PUSH"),
            ]:
                with self.subTest(code=code):
                    fake = FakeGit(Path(td), remote_reads=remote_reads)
                    self.assert_blocked(fake, code)
                    self.assertEqual(2, fake.read_count)

    def test_verified_noop_also_blocks_ref_movement(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td), fetched_preview=APPROVED, remote_reads=[(APPROVED, APPROVED), (MOVED, APPROVED)])
            self.assert_blocked(fake, "PROMOTE_MAIN_MOVED_BEFORE_PUSH")

    def test_push_failure_blocker_no_force_no_retry(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td), push_fail=True, remote_reads=[(APPROVED, PREVIEW), (APPROVED, PREVIEW)])
            with self.assertRaises(mod.PromotionError) as caught:
                self.run_promote(fake)
            self.assertEqual("PROMOTE_PUSH_FAILED", caught.exception.code)
            self.assertEqual(1, len(fake.git_calls("push")))
            self.assertFalse(any("force" in arg for call in fake.calls for arg in call))

    def test_final_preview_must_equal_literal_approved_sha(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td), remote_reads=[(APPROVED, PREVIEW), (APPROVED, PREVIEW), (APPROVED, MOVED)])
            with self.assertRaises(mod.PromotionError) as caught:
                self.run_promote(fake)
            self.assertEqual("PROMOTE_FINAL_PREVIEW_MISMATCH", caught.exception.code)
            self.assertEqual(1, len(fake.git_calls("push")))

    def test_main_movement_after_push_is_reported_not_promoted(self):
        with tempfile.TemporaryDirectory() as td:
            fake = FakeGit(Path(td), remote_reads=[(APPROVED, PREVIEW), (APPROVED, PREVIEW), (MOVED, APPROVED)])
            result = self.run_promote(fake)
            self.assertEqual("PREVIEW_PROMOTED_MAIN_MOVED", result["code"])
            self.assertTrue(result["mainMovedAfterPush"])
            self.assertEqual(MOVED, result["originMain"])
            self.assertEqual(APPROVED, result["originPreview"])
            self.assertEqual("PROMOTE_MAIN_MOVED_AFTER_PUSH", result["warnings"][0]["code"])
            self.assertEqual(1, len(fake.git_calls("push")))

    def test_ref_read_and_fetch_failures_block(self):
        with tempfile.TemporaryDirectory() as td:
            for kwargs, code in [
                ({"fetch_fail": True}, "PROMOTE_FETCH_FAILED"),
                ({"remote_fail_at": 1}, "PROMOTE_REMOTE_REF_READ_FAILED"),
                ({"remote_reads": [(APPROVED, None)]}, "PROMOTE_REMOTE_REF_MISSING"),
                ({"remote_fail_at": 2}, "PROMOTE_REMOTE_REF_READ_FAILED"),
            ]:
                with self.subTest(code=code, kwargs=kwargs):
                    fake = FakeGit(Path(td), **kwargs)
                    self.assert_blocked(fake, code)
            fake = FakeGit(Path(td), remote_fail_at=3)
            with self.assertRaises(mod.PromotionError) as caught:
                self.run_promote(fake)
            self.assertEqual("PROMOTE_REMOTE_REF_READ_FAILED", caught.exception.code)
            self.assertEqual(1, len(fake.git_calls("push")))  # push may have succeeded; no retry


if __name__ == "__main__":
    unittest.main()
