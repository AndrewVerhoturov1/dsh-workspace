from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DIRECT = Path(__file__).resolve().parents[1]
if str(DIRECT) not in sys.path:
    sys.path.insert(0, str(DIRECT))

import finalization_common as common
import test_result


class TestResultScriptTests(unittest.TestCase):
    def _ready(self, root: Path, worktree: Path) -> Path:
        path = root / "folder with 'quotes'" / "готово ready.json"
        common.atomic_write_json(path, {
            "ok": True, "code": "READY_FOR_TEST", "requestId": "REQ_20260903T010203Z_1234",
            "repository": "AndrewVerhoturov1/dsh-workspace", "branch": "postman/req-20260903t010203z-1234",
            "originMain": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=worktree, text=True).strip(),
            "changedFiles": ["sample.txt"], "repoRoot": str(worktree), "worktree": str(worktree),
            "readyJson": str(path),
        })
        return path

    def _repo(self, root: Path) -> Path:
        repo = root / "repo [x]" / "back\\slash"
        repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
        subprocess.run(["git", "config", "user.name", "Tests"], cwd=repo, check=True)
        (repo / "sample.txt").write_text("before\n", encoding="utf-8")
        subprocess.run(["git", "add", "sample.txt"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "base"], cwd=repo, check=True, capture_output=True)
        subprocess.run(["git", "checkout", "-b", "postman/req-20260903t010203z-1234"], cwd=repo, check=True, capture_output=True)
        (repo / "sample.txt").write_text("changed\n", encoding="utf-8")
        return repo

    def test_script_mode_preserves_unicode_quotes_backslashes_and_hash(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = self._repo(root)
            script = root / "тест script 'x'" / "safe.py"
            script.parent.mkdir(parents=True)
            script.write_text(
                "import json, pathlib, sys\n"
                "assert pathlib.Path('sample.txt').read_text(encoding='utf-8') == 'changed\\n'\n"
                "print(json.dumps(sys.argv[1:], ensure_ascii=False))\n",
                encoding="utf-8",
            )
            ready = self._ready(root, repo)
            receipt = test_result.run_test(ready_json=ready, test_script=script,
                                          script_args=['Юникод "кавычки"', r'C:\temp\x'])
            self.assertEqual(str(script.resolve()), receipt["testScript"])
            self.assertEqual(common.sha256_file(script), receipt["testScriptSha256"])
            self.assertEqual([sys.executable, "-X", "utf8", str(script.resolve()), 'Юникод "кавычки"', r'C:\temp\x'], receipt["resolvedArgv"])
            self.assertEqual(str(ready.resolve()), receipt["readyJson"])
            self.assertEqual(str((ready.parent / "test.json").resolve()), receipt["testJson"])
            self.assertIn("кавычки", receipt["stdoutTail"])

    def test_cli_cross_process_reads_exact_ready_path_without_shell_quoting(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = self._repo(root)
            script = root / "check.py"
            script.write_text("from pathlib import Path; assert Path('sample.txt').read_text() == 'changed\\n'\n", encoding="utf-8")
            ready = self._ready(root, repo)
            result = subprocess.run([sys.executable, "-X", "utf8", str(DIRECT / "test_result.py"), "--ready-json", str(ready),
                                     "--test-script", str(script)], cwd=repo, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertEqual(str(ready.resolve()), json.loads(result.stdout)["readyJson"])

    def test_script_mutation_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            repo = self._repo(root)
            script = root / "mutate.py"
            script.write_text("from pathlib import Path; Path(__file__).write_text('changed', encoding='utf-8')\n", encoding="utf-8")
            ready = self._ready(root, repo)
            with self.assertRaises(common.FinalizationError) as ctx:
                test_result.run_test(ready_json=ready, test_script=script)
            self.assertEqual("TEST_SCRIPT_MUTATED", ctx.exception.code)

    def test_write_task_test_uses_utf8_and_exact_filename(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "handoff with spaces"
            content = "# проверка\nprint('кавычки: \\\" и путь C:\\\\temp')\n"
            script = test_result.write_task_test(root, content)
            self.assertEqual(root / "task_test.py", script)
            self.assertEqual(content, script.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
