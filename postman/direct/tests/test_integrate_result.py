from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

DIRECT_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = DIRECT_DIR / "integrate_result.py"

spec = importlib.util.spec_from_file_location("integrate_result", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = module
spec.loader.exec_module(module)

IntegrationError = module.IntegrationError
integrate = module.integrate

REQUEST_ID = "REQ_20260902T120000Z_1234"
REPOSITORY = "AndrewVerhoturov1/dsh-workspace"


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def init_repo(root: Path, *, checkout_task: bool = True) -> tuple[Path, str]:
    repo = root / "repo"
    repo.mkdir()
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "postman-test@example.invalid")
    git(repo, "config", "user.name", "Postman Test")
    git(repo, "remote", "add", "origin", "https://github.com/AndrewVerhoturov1/dsh-workspace.git")
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    git(repo, "add", "README.md")
    git(repo, "commit", "-m", "base")
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "update-ref", "refs/remotes/origin/main", base)
    if checkout_task:
        git(repo, "checkout", "-b", "postman/test-integration")
    return repo, base


def commit_on_main(repo: Path, path: str, content: str, message: str) -> str:
    current = git(repo, "branch", "--show-current")
    if current != "main":
        git(repo, "checkout", "main")
    target = repo / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    git(repo, "add", path)
    git(repo, "commit", "-m", message)
    head = git(repo, "rev-parse", "HEAD")
    git(repo, "update-ref", "refs/remotes/origin/main", head)
    return head


def write_zip(
    root: Path,
    *,
    base_commit: str,
    result_type: str = "files",
    files: dict[str, bytes] | None = None,
    patch: str | None = None,
    manifest_overrides: dict | None = None,
    extra_members: dict[str, bytes] | None = None,
) -> Path:
    files = files or {}
    manifest = {
        "protocolVersion": 1,
        "requestId": REQUEST_ID,
        "repository": REPOSITORY,
        "baseCommit": base_commit,
        "resultType": result_type,
        "patch": "changes.patch" if patch is not None else None,
        "files": list(files),
    }
    if manifest_overrides:
        manifest.update(manifest_overrides)
    zip_path = root / "result.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        if patch is not None:
            zf.writestr("changes.patch", patch)
        for path, data in files.items():
            zf.writestr(f"files/{path}", data)
        for path, data in (extra_members or {}).items():
            zf.writestr(path, data)
    return zip_path


def write_result(root: Path, zip_path: Path, base_commit: str, *, sha: str | None = None, **overrides) -> Path:
    if sha is None:
        sha = hashlib.sha256(zip_path.read_bytes()).hexdigest()
    result = {
        "ok": True,
        "code": "RESULT_DURABLE",
        "state": "RESULT_DURABLE",
        "requestId": REQUEST_ID,
        "repository": REPOSITORY,
        "baseCommit": base_commit,
        "taskUrl": f"https://raw.githubusercontent.com/{REPOSITORY}/{base_commit}/{REQUEST_ID}.md",
        "expectedFilename": f"POSTMAN_{REQUEST_ID}_RESULT.zip",
        "resultZip": str(zip_path),
        "sha256": sha,
    }
    result.update(overrides)
    path = root / "result.json"
    path.write_text(json.dumps(result), encoding="utf-8")
    return path


class IntegrateResultTests(unittest.TestCase):
    def test_files_artifact_is_copied_as_exact_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root)
            payload = b"\x00exact\r\nbytes\xff"
            archive = write_zip(root, base_commit=base, files={"demo/output.bin": payload})
            result_json = write_result(root, archive, base)

            result = integrate(
                result_json=str(result_json),
                repo_root=repo,
                fetch=False,
            )

            self.assertTrue(result["ok"])
            self.assertEqual("READY_FOR_TEST", result["code"])
            self.assertEqual(["demo/output.bin"], result["changedFiles"])
            self.assertEqual(payload, (repo / "demo" / "output.bin").read_bytes())

    def test_sha_mismatch_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root)
            archive = write_zip(root, base_commit=base, files={"x.txt": b"x"})
            result_json = write_result(root, archive, base, sha="0" * 64)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("RESULT_SHA256_MISMATCH", ctx.exception.code)
            self.assertFalse((repo / "x.txt").exists())

    def test_manifest_identity_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root)
            archive = write_zip(
                root,
                base_commit=base,
                files={"x.txt": b"x"},
                manifest_overrides={"requestId": "REQ_20260902T120001Z_1234"},
            )
            result_json = write_result(root, archive, base)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("RESULT_MANIFEST_MISMATCH", ctx.exception.code)

    def test_diagnostic_only_result_is_not_treated_as_implementation(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root)
            archive = write_zip(
                root,
                base_commit=base,
                files={"diagnostics/blocked.txt": b"STATUS: BLOCKED\n"},
            )
            result_json = write_result(root, archive, base)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("RESULT_DIAGNOSTIC_ONLY", ctx.exception.code)
            self.assertIn("blocked.txt", json.dumps(ctx.exception.details))

    def test_manifest_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root)
            archive = write_zip(root, base_commit=base, files={"../escape.txt": b"no"})
            result_json = write_result(root, archive, base)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("RESULT_ZIP_UNSAFE", ctx.exception.code)
            self.assertFalse((root / "escape.txt").exists())

    def test_hybrid_overlap_is_rejected_before_application(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root)
            (repo / "same.txt").write_text("old\n", encoding="utf-8")
            git(repo, "add", "same.txt")
            git(repo, "commit", "-m", "add same")
            base = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", base)
            patch = """diff --git a/same.txt b/same.txt\n--- a/same.txt\n+++ b/same.txt\n@@ -1 +1 @@\n-old\n+patched\n"""
            archive = write_zip(
                root,
                base_commit=base,
                result_type="hybrid_patch",
                files={"same.txt": b"file\n"},
                patch=patch,
            )
            result_json = write_result(root, archive, base)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("RESULT_APPLICATION_AMBIGUOUS", ctx.exception.code)
            self.assertEqual("old\n", (repo / "same.txt").read_text(encoding="utf-8"))

    def test_patch_artifact_applies_after_git_apply_check(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, _ = init_repo(root, checkout_task=False)
            (repo / "existing.txt").write_text("old\n", encoding="utf-8")
            git(repo, "add", "existing.txt")
            git(repo, "commit", "-m", "existing")
            base = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", base)
            git(repo, "checkout", "-b", "postman/test-integration")
            patch = """diff --git a/existing.txt b/existing.txt\n--- a/existing.txt\n+++ b/existing.txt\n@@ -1 +1 @@\n-old\n+new\n"""
            archive = write_zip(root, base_commit=base, result_type="patch", patch=patch)
            result_json = write_result(root, archive, base)
            result = integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("READY_FOR_TEST", result["code"])
            self.assertEqual("new\n", (repo / "existing.txt").read_text(encoding="utf-8"))

    def test_dirty_integration_worktree_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root)
            (repo / "user-local.txt").write_text("dirty", encoding="utf-8")
            archive = write_zip(root, base_commit=base, files={"x.txt": b"x"})
            result_json = write_result(root, archive, base)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("INTEGRATION_WORKTREE_DIRTY", ctx.exception.code)

    def test_main_is_forbidden_for_production_application(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root, checkout_task=False)
            archive = write_zip(root, base_commit=base, files={"x.txt": b"x"})
            result_json = write_result(root, archive, base)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("INTEGRATION_MAIN_FORBIDDEN", ctx.exception.code)

    def test_overlapping_functional_main_advancement_is_stale(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root, checkout_task=False)
            (repo / "target.txt").write_text("base\n", encoding="utf-8")
            git(repo, "add", "target.txt")
            git(repo, "commit", "-m", "target base")
            base = git(repo, "rev-parse", "HEAD")
            advanced = commit_on_main(repo, "target.txt", "main changed\n", "main change")
            self.assertNotEqual(base, advanced)
            git(repo, "checkout", "-b", "postman/test-integration", advanced)
            archive = write_zip(root, base_commit=base, files={"target.txt": b"postman\n"})
            result_json = write_result(root, archive, base)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("RESULT_BASE_STALE", ctx.exception.code)

    def test_disjoint_functional_main_advancement_is_allowed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root, checkout_task=False)
            advanced = commit_on_main(repo, "other.txt", "main advance\n", "other change")
            git(repo, "checkout", "-b", "postman/test-integration", advanced)
            archive = write_zip(root, base_commit=base, files={"target.txt": b"postman\n"})
            result_json = write_result(root, archive, base)
            result = integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("READY_FOR_TEST", result["code"])
            self.assertEqual(["other.txt"], result["functionalAdvancement"])
            self.assertEqual(b"postman\n", (repo / "target.txt").read_bytes())

    def test_protected_path_is_rejected_even_if_artifact_was_prevalidated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo, base = init_repo(root)
            archive = write_zip(root, base_commit=base, files={"settings.yaml": b"bad"})
            result_json = write_result(root, archive, base)
            with self.assertRaises(IntegrationError) as ctx:
                integrate(result_json=str(result_json), repo_root=repo, fetch=False)
            self.assertEqual("RESULT_PROTECTED_PATH", ctx.exception.code)


if __name__ == "__main__":
    unittest.main()
