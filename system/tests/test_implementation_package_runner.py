from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
RUNNER_PATH = ROOT / "system" / "implementation_package_runner.py"
SPEC = importlib.util.spec_from_file_location("implementation_package_runner", RUNNER_PATH)
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)

REPOSITORY = "AndrewVerhoturov1/dsh-workspace"


def command(argv, cwd):
    return subprocess.run(argv, cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8")


def init_repo(root: Path, branch: str = "feature/package-test") -> None:
    command(["git", "init", "-q", "-b", branch], root)
    command(["git", "config", "user.email", "test@example.com"], root)
    command(["git", "config", "user.name", "Package Runner Test"], root)
    command(["git", "remote", "add", "origin", f"https://github.com/{REPOSITORY}.git"], root)
    (root / "hello.txt").write_text("old\n", encoding="utf-8")
    command(["git", "add", "hello.txt"], root)
    command(["git", "commit", "-qm", "initial"], root)


def package_zip(root: Path, patch: str, *, tests=None, package_base="informational-old-sha") -> Path:
    package = root / "package.zip"
    manifest = {
        "schemaVersion": 1,
        "package": "test-package",
        "repository": REPOSITORY,
        "baseBranch": "preview",
        "prBase": "preview",
        "packageBase": package_base,
        "patch": "changes.patch",
        "tests": [] if tests is None else tests,
    }
    with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
        zf.writestr("changes.patch", patch)
    return package


PATCH_TRACKED_AND_NEW = """diff --git a/hello.txt b/hello.txt
--- a/hello.txt
+++ b/hello.txt
@@ -1 +1 @@
-old
+new
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+new file
"""


class ImplementationPackageRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="impl-runner-test-")
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        init_repo(self.repo)
        self.diag = self.base / "diagnostics"

    def tearDown(self):
        self.temp.cleanup()

    def test_apply_handles_tracked_and_new_untracked_files_without_inventory_gate(self):
        package = package_zip(
            self.base,
            PATCH_TRACKED_AND_NEW,
            tests=[{
                "name": "verify files",
                "command": [sys.executable, "-c", "from pathlib import Path; assert Path('hello.txt').read_text() == 'new\\n'; assert Path('new.txt').read_text() == 'new file\\n'"],
                "timeoutSeconds": 30,
            }],
        )
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertTrue(result["ok"], result)
        self.assertEqual((self.repo / "hello.txt").read_text(encoding="utf-8"), "new\n")
        self.assertEqual((self.repo / "new.txt").read_text(encoding="utf-8"), "new file\n")
        self.assertIn("?? new.txt", result["gitStatus"])

    def test_apply_returns_only_patch_paths_when_test_creates_untracked_file(self):
        generated = self.repo / "test-generated.txt"
        package = package_zip(
            self.base,
            PATCH_TRACKED_AND_NEW,
            tests=[{
                "name": "create unrelated file",
                "command": [sys.executable, "-c", "from pathlib import Path; Path('test-generated.txt').write_text('generated\\n', encoding='utf-8')"],
                "timeoutSeconds": 30,
            }],
        )
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["affectedPaths"], ["hello.txt", "new.txt"])
        self.assertTrue(generated.is_file())
        self.assertNotIn("test-generated.txt", result["affectedPaths"])
        self.assertIn("?? test-generated.txt", result["gitStatus"])

    def test_new_ignored_file_blocks_before_targeted_tests(self):
        (self.repo / ".gitignore").write_text("**/lib/\n", encoding="utf-8")
        command(["git", "add", ".gitignore"], self.repo)
        command(["git", "commit", "-qm", "ignore lib"], self.repo)
        marker = self.base / "targeted-test-ran.txt"
        patch = """diff --git a/plugin/lib/new.js b/plugin/lib/new.js
new file mode 100644
--- /dev/null
+++ b/plugin/lib/new.js
@@ -0,0 +1 @@
+console.log('new');
"""
        package = package_zip(
            self.base,
            patch,
            tests=[{
                "name": "must not run",
                "command": [sys.executable, "-c", "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('ran')", str(marker)],
                "timeoutSeconds": 30,
            }],
        )
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PATCH_CREATES_IGNORED_FILE")
        self.assertEqual(result["stage"], "apply")
        self.assertIn("plugin/lib/new.js", result["message"])
        self.assertFalse(marker.exists())

    def test_patch_gitignore_exception_allows_new_file(self):
        (self.repo / ".gitignore").write_text("**/lib/\n", encoding="utf-8")
        command(["git", "add", ".gitignore"], self.repo)
        command(["git", "commit", "-qm", "ignore lib"], self.repo)
        patch = """diff --git a/.gitignore b/.gitignore
--- a/.gitignore
+++ b/.gitignore
@@ -1 +1,3 @@
 **/lib/
+!plugin/lib/
+!plugin/lib/**
diff --git a/plugin/lib/new.js b/plugin/lib/new.js
new file mode 100644
--- /dev/null
+++ b/plugin/lib/new.js
@@ -0,0 +1 @@
+console.log('new');
"""
        package = package_zip(self.base, patch)
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertTrue(result["ok"], result)
        self.assertTrue((self.repo / "plugin" / "lib" / "new.js").is_file())

    def test_tracked_file_matching_ignore_pattern_does_not_fail(self):
        tracked = self.repo / "plugin" / "lib" / "existing.js"
        tracked.parent.mkdir(parents=True)
        tracked.write_text("old\n", encoding="utf-8")
        command(["git", "add", "plugin/lib/existing.js"], self.repo)
        command(["git", "commit", "-qm", "add tracked lib file"], self.repo)
        (self.repo / ".gitignore").write_text("**/lib/\n", encoding="utf-8")
        command(["git", "add", ".gitignore"], self.repo)
        command(["git", "commit", "-qm", "ignore lib after tracking"], self.repo)
        patch = """diff --git a/plugin/lib/existing.js b/plugin/lib/existing.js
--- a/plugin/lib/existing.js
+++ b/plugin/lib/existing.js
@@ -1 +1 @@
-old
+new
"""
        package = package_zip(self.base, patch)
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertTrue(result["ok"], result)
        self.assertEqual(tracked.read_text(encoding="utf-8"), "new\n")

    def test_package_base_is_informational_not_a_hard_gate(self):
        package = package_zip(self.base, PATCH_TRACKED_AND_NEW, package_base="definitely-not-current-head")
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertTrue(result["ok"], result)

    def test_dirty_worktree_is_rejected_before_apply(self):
        (self.repo / "local.txt").write_text("user data\n", encoding="utf-8")
        package = package_zip(self.base, PATCH_TRACKED_AND_NEW)
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "WORKTREE_NOT_CLEAN")
        self.assertEqual((self.repo / "hello.txt").read_text(encoding="utf-8"), "old\n")
        self.assertTrue(Path(result["diagnosticsZip"]).is_file())

    def test_protected_branch_is_rejected(self):
        command(["git", "branch", "-M", "preview"], self.repo)
        package = package_zip(self.base, PATCH_TRACKED_AND_NEW)
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PROTECTED_BRANCH")

    def test_protected_local_data_path_is_rejected(self):
        patch = """diff --git a/settings.yaml b/settings.yaml
new file mode 100644
--- /dev/null
+++ b/settings.yaml
@@ -0,0 +1 @@
+secret: nope
"""
        package = package_zip(self.base, patch)
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PROTECTED_PATH")
        self.assertFalse((self.repo / "settings.yaml").exists())

    def test_dot_git_and_root_dot_env_are_protected(self):
        self.assertTrue(runner.is_protected_repo_path(".git/config"))
        self.assertTrue(runner.is_protected_repo_path(".env"))
        self.assertTrue(runner.is_protected_repo_path("./.env"))
        self.assertFalse(runner.is_protected_repo_path(".env.example"))

    def test_real_patch_conflict_is_a_hard_failure(self):
        bad_patch = PATCH_TRACKED_AND_NEW.replace("-old", "-different-source")
        package = package_zip(self.base, bad_patch)
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PATCH_NOT_APPLICABLE")
        self.assertEqual((self.repo / "hello.txt").read_text(encoding="utf-8"), "old\n")

    def test_targeted_test_failure_creates_compact_diagnostics(self):
        package = package_zip(
            self.base,
            PATCH_TRACKED_AND_NEW,
            tests=[{
                "name": "intentional failure",
                "command": [sys.executable, "-c", "import sys; print('TEST-BOOM'); sys.exit(7)"],
                "timeoutSeconds": 30,
            }],
        )
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "TARGETED_TEST_FAILED")
        diagnostics = Path(result["diagnosticsZip"])
        with zipfile.ZipFile(diagnostics, "r") as zf:
            self.assertEqual(
                set(zf.namelist()),
                {
                    "failure.json",
                    "stdout.txt",
                    "stderr.txt",
                    "git-status.txt",
                    "git-diff-stat.txt",
                    "git-diff-check.txt",
                    "runner-log.txt",
                },
            )
            failure = json.loads(zf.read("failure.json"))
            self.assertEqual(failure["stage"], "test:intentional failure")
            self.assertIn("TEST-BOOM", zf.read("stdout.txt").decode("utf-8"))

    def test_git_diff_check_is_warning_not_hard_failure(self):
        patch = """diff --git a/hello.txt b/hello.txt
--- a/hello.txt
+++ b/hello.txt
@@ -1 +1 @@
-old
+new with trailing whitespace   
"""
        package = package_zip(self.base, patch)
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertTrue(result["ok"], result)
        self.assertTrue(any(item["code"] == "GIT_DIFF_CHECK_WARNING" for item in result["warnings"]))

    def test_check_mode_does_not_modify_repository(self):
        package = package_zip(self.base, PATCH_TRACKED_AND_NEW)
        result = runner.execute("check", package, self.repo, self.diag)
        self.assertTrue(result["ok"], result)
        self.assertEqual((self.repo / "hello.txt").read_text(encoding="utf-8"), "old\n")
        self.assertFalse((self.repo / "new.txt").exists())
        self.assertEqual(command(["git", "status", "--porcelain"], self.repo).stdout, "")

    def test_wrong_repository_is_rejected(self):
        command(["git", "remote", "set-url", "origin", "https://github.com/example/other.git"], self.repo)
        package = package_zip(self.base, PATCH_TRACKED_AND_NEW)
        result = runner.execute("apply", package, self.repo, self.diag)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "REPOSITORY_MISMATCH")


if __name__ == "__main__":
    unittest.main()
