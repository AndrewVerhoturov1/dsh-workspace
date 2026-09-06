from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

DIRECT_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = DIRECT_DIR.parent / "web"
for item in (str(DIRECT_DIR), str(WEB_DIR)):
    if item not in sys.path:
        sys.path.insert(0, item)

import finalization_common as common
import integrate_result
import prepare_result
import resume_request
import test_result

REQ = "REQ_20260906T120000Z_4321"
REPO = "AndrewVerhoturov1/dsh-workspace"
BRANCH = common.canonical_branch_name(REQ)


def git(cwd: Path, *args: str, check: bool = True) -> str:
    cp = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True,
        encoding="utf-8", errors="replace"
    )
    if check and cp.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {cp.stderr}")
    return cp.stdout.strip()


def init_direct_repo(root: Path, *, content: str = "one\ntwo\n") -> tuple[Path, str]:
    repo = root / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "v3@example.invalid")
    git(repo, "config", "user.name", "Prepare V3")
    git(repo, "remote", "add", "origin", "https://github.com/AndrewVerhoturov1/dsh-workspace.git")
    (repo / "target.txt").write_text(content, encoding="utf-8")
    git(repo, "add", "target.txt")
    git(repo, "commit", "-m", "base")
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "update-ref", "refs/remotes/origin/main", base)
    git(repo, "checkout", "-b", BRANCH)
    return repo, base


def advance_origin(repo: Path, path: str, content: str) -> str:
    git(repo, "checkout", "main")
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    git(repo, "add", path)
    git(repo, "commit", "-m", "advance")
    head = git(repo, "rev-parse", "HEAD")
    git(repo, "update-ref", "refs/remotes/origin/main", head)
    git(repo, "checkout", "-B", BRANCH, head)
    return head


def artifact(root: Path, base: str, *, result_type: str, patch_text: str | None = None,
             files: dict[str, bytes] | None = None) -> Path:
    files = files or {}
    manifest = {
        "protocolVersion": 1,
        "requestId": REQ,
        "repository": REPO,
        "baseCommit": base,
        "resultType": result_type,
        "patch": "changes.patch" if patch_text is not None else None,
        "files": list(files),
    }
    zpath = root / "result.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest))
        if patch_text is not None:
            zf.writestr("changes.patch", patch_text)
        for rel, data in files.items():
            zf.writestr(f"files/{rel}", data)
    result = {
        "ok": True, "code": "RESULT_DURABLE", "state": "RESULT_DURABLE",
        "requestId": REQ, "repository": REPO, "baseCommit": base,
        "expectedFilename": f"POSTMAN_{REQ}_RESULT.zip",
        "resultZip": str(zpath),
        "sha256": hashlib.sha256(zpath.read_bytes()).hexdigest(),
    }
    rpath = root / "result.json"
    rpath.write_text(json.dumps(result), encoding="utf-8")
    return rpath


class PrepareV3PermissiveTests(unittest.TestCase):
    def test_traditional_unified_diff_without_diff_git_is_accepted(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_direct_repo(root)
            patch_text = """--- a/target.txt\n+++ b/target.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n"""
            result_json = artifact(root, base, result_type="patch", patch_text=patch_text)
            result = integrate_result.integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("READY_FOR_TEST", result["code"])
            self.assertEqual(["target.txt"], result["changedFiles"])
            self.assertEqual("ONE\ntwo\n", (repo / "target.txt").read_text(encoding="utf-8"))

    def test_patch_overlap_with_main_advancement_uses_real_apply_not_name_blocker(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_direct_repo(root)
            advanced = advance_origin(repo, "target.txt", "one\nTWO\n")
            self.assertNotEqual(base, advanced)
            patch_text = """--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-one\n+ONE\n"""
            result_json = artifact(root, base, result_type="patch", patch_text=patch_text)
            result = integrate_result.integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("READY_FOR_TEST", result["code"])
            self.assertEqual(["target.txt"], result["patchAdvancementOverlap"])
            self.assertEqual("ONE\nTWO\n", (repo / "target.txt").read_text(encoding="utf-8"))

    def test_exact_file_overlap_with_main_advancement_remains_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_direct_repo(root)
            advance_origin(repo, "target.txt", "main changed\n")
            result_json = artifact(root, base, result_type="files", files={"target.txt": b"replacement\n"})
            with self.assertRaises(integrate_result.IntegrationError) as ctx:
                integrate_result.integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("RESULT_BASE_STALE", ctx.exception.code)

    def test_exact_file_overlap_is_noop_when_current_bytes_already_match_payload(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_direct_repo(root)
            git(repo, "checkout", "main")
            (repo / "target.txt").write_text("temporary\n", encoding="utf-8")
            git(repo, "add", "target.txt")
            git(repo, "commit", "-m", "temporary change")
            (repo / "target.txt").write_text("one\ntwo\n", encoding="utf-8")
            git(repo, "add", "target.txt")
            git(repo, "commit", "-m", "restore bytes")
            advanced = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", advanced)
            git(repo, "checkout", "-B", "postman/test-v3", advanced)
            result_json = artifact(root, base, result_type="files", files={"target.txt": b"one\ntwo\n"})
            result = integrate_result.integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("READY_FOR_TEST", result["code"])
            self.assertTrue(result["alreadyApplied"])
            self.assertEqual(["target.txt"], result["fileAdvancementOverlap"])
            self.assertEqual([], result["changedFiles"])

    def test_diff_check_is_warning_in_prepare_not_application_blocker(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_direct_repo(root)
            result_json = artifact(root, base, result_type="files", files={"new.txt": b"trailing-space \n"})
            result = integrate_result.integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("READY_FOR_TEST", result["code"])
            self.assertEqual("WARNING", result["application"]["diffCheck"]["status"])

    def test_already_present_files_result_becomes_noop_ready(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_direct_repo(root)
            result_json = artifact(root, base, result_type="files", files={"target.txt": b"one\ntwo\n"})
            result = integrate_result.integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("READY_FOR_TEST", result["code"])
            self.assertTrue(result["alreadyApplied"])
            self.assertEqual([], result["changedFiles"])
            ready = {
                **result,
                "repoRoot": str(repo), "worktree": str(repo),
                "readyJson": str(root / "ready.json"),
            }
            common.atomic_write_json(root / "ready.json", ready)
            normalized = common.validate_ready(common.load_json_file(root / "ready.json"))
            self.assertEqual([], normalized["changedFiles"])

    def test_preflight_allows_unrelated_branch_worktree_and_dirty_primary_without_mutation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bare = root / "origin.git"
            primary = root / "primary"
            git(root, "init", "--bare", str(bare))
            git(root, "clone", str(bare), str(primary))
            git(primary, "config", "user.email", "v3@example.invalid")
            git(primary, "config", "user.name", "Prepare V3")
            git(primary, "checkout", "-b", "main")
            (primary / "base.txt").write_text("base\n", encoding="utf-8")
            git(primary, "add", "base.txt")
            git(primary, "commit", "-m", "base")
            git(primary, "push", "-u", "origin", "main")
            main_before = git(primary, "rev-parse", "main")
            unrelated = root / "unrelated"
            git(primary, "worktree", "add", "-b", "feature/unrelated", str(unrelated), "main")
            git(primary, "checkout", "-b", "user/local")
            (primary / "dirty.txt").write_text("dirty\n", encoding="utf-8")

            with patch.object(common, "normalize_remote_repository", return_value=REPO):
                result = prepare_result.preflight_policy(primary, repository=REPO, handoff_root=root / "handoff")
            self.assertEqual("permissive-v3", result["prepareMode"])
            self.assertEqual("user/local", git(primary, "branch", "--show-current"))
            self.assertEqual(main_before, git(primary, "rev-parse", "main"))
            self.assertTrue(unrelated.exists())
            self.assertTrue((primary / "dirty.txt").exists())

    def test_current_request_clean_worktree_can_be_reused(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bare = root / "origin.git"
            primary = root / "primary"
            git(root, "init", "--bare", str(bare))
            git(root, "clone", str(bare), str(primary))
            git(primary, "config", "user.email", "v3@example.invalid")
            git(primary, "config", "user.name", "Prepare V3")
            git(primary, "checkout", "-b", "main")
            (primary / "base.txt").write_text("base\n", encoding="utf-8")
            git(primary, "add", "base.txt")
            git(primary, "commit", "-m", "base")
            git(primary, "push", "-u", "origin", "main")
            base = git(primary, "rev-parse", "HEAD")
            branch = common.canonical_branch_name(REQ)
            worktree = root / "request-worktree"
            git(primary, "worktree", "add", "-b", branch, str(worktree), "main")
            mode = prepare_result._request_resource_mode(primary, branch, worktree.resolve(), base)
            self.assertEqual("reuse", mode)
            self.assertTrue(worktree.exists())

    def test_already_applied_resume_is_terminal_without_publish(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            bare = root / "origin.git"
            primary = root / "primary"
            git(root, "init", "--bare", str(bare))
            git(root, "clone", str(bare), str(primary))
            git(primary, "config", "user.email", "v3@example.invalid")
            git(primary, "config", "user.name", "Prepare V3")
            git(primary, "checkout", "-b", "main")
            (primary / "base.txt").write_text("base\n", encoding="utf-8")
            git(primary, "add", "base.txt")
            git(primary, "commit", "-m", "base")
            git(primary, "push", "-u", "origin", "main")
            base = git(primary, "rev-parse", "HEAD")
            branch = common.canonical_branch_name(REQ)
            worktree = root / "task"
            git(primary, "worktree", "add", "-b", branch, str(worktree), "main")
            handoff = root / "handoff" / REQ
            ready_path = handoff / "ready.json"
            ready = {
                "ok": True, "code": "READY_FOR_TEST", "requestId": REQ, "repository": REPO,
                "baseCommit": base, "originMain": base, "branch": branch,
                "artifactSha256": "a" * 64, "resultType": "files",
                "changedFiles": [], "payloadPaths": ["base.txt"], "alreadyApplied": True,
                "repoRoot": str(primary), "worktree": str(worktree), "readyJson": str(ready_path),
            }
            common.atomic_write_json(ready_path, ready)
            test = test_result.run_test(
                ready_json=ready_path,
                test_command=[sys.executable, "-c", "from pathlib import Path; assert Path('base.txt').read_text() == 'base\\n'"],
            )
            self.assertTrue(test["alreadyApplied"])

            def forbidden_publisher(**kwargs):
                raise AssertionError("publisher must not run for already-applied result")

            result = resume_request.resume(
                request_id=REQ, repo_root=primary, handoff_root=root / "handoff",
                publisher=forbidden_publisher,
            )
            self.assertEqual("ALREADY_APPLIED", result["code"])
            self.assertFalse(worktree.exists())
            self.assertNotIn(branch, git(primary, "branch", "--format=%(refname:short)").splitlines())
            repeated = resume_request.resume(
                request_id=REQ, repo_root=primary, handoff_root=root / "handoff",
                publisher=forbidden_publisher,
            )
            self.assertEqual("ALREADY_APPLIED", repeated["code"])


    def test_exact_file_payload_comparison_uses_git_normalization_not_raw_worktree_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, _ = init_direct_repo(root)
            # Simulate a Windows-style checkout representation. The HEAD blob is
            # LF-normalized, while the worktree bytes are deliberately CRLF.
            (repo / "target.txt").write_bytes(b"one\r\ntwo\r\n")
            self.assertNotEqual((repo / "target.txt").read_bytes(), b"one\ntwo\n")
            self.assertTrue(
                integrate_result._payload_matches_head(
                    repo,
                    "target.txt",
                    b"one\ntwo\n",
                )
            )


if __name__ == "__main__":
    unittest.main()
