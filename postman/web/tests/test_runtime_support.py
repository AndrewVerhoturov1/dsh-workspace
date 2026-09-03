from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

WEB_DIR = Path(__file__).resolve().parents[1]
ROOT = Path(__file__).resolve().parents[3]
MODULE_PATH = WEB_DIR / "runtime_support.py"

spec = importlib.util.spec_from_file_location("runtime_support_wp018a_test", MODULE_PATH)
runtime = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(runtime)


class WP018AStorageQuietTests(unittest.TestCase):
    def test_env_override_and_localappdata_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            configured = root_path / "configured"
            self.assertEqual(
                runtime.default_result_root(
                    {
                        "DSH_POSTMAN_RESULT_ROOT": str(configured),
                        "LOCALAPPDATA": str(root_path / "local"),
                    }
                ),
                configured,
            )
            self.assertEqual(
                runtime.default_result_root({"LOCALAPPDATA": str(root_path / "local")}),
                root_path / "local" / "DSH" / "Postman" / "results",
            )

    def test_prepare_result_root_creates_and_removes_probe(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "new" / "results"
            ready = runtime.prepare_result_root(target)
            self.assertEqual(ready, target)
            self.assertTrue(target.is_dir())
            self.assertEqual(list(target.glob(".postman-write-probe-*.tmp")), [])

    def test_quiet_subprocess_flags_are_windows_only(self):
        with patch.object(runtime.os, "name", "posix"):
            self.assertEqual(runtime.quiet_subprocess_kwargs(), {})
        with patch.object(runtime.os, "name", "nt"), patch.object(
            runtime.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True
        ):
            self.assertEqual(
                runtime.quiet_subprocess_kwargs(),
                {"creationflags": 0x08000000},
            )

    def test_production_files_contain_wp018a_contract(self):
        ps1 = (ROOT / "postman" / "direct" / "postman.ps1").read_text(encoding="utf-8")
        direct = (ROOT / "postman" / "direct" / "postman_direct.py").read_text(encoding="utf-8")
        downloader = (ROOT / "postman" / "web" / "artifact_download.py").read_text(encoding="utf-8")
        skill = (
            ROOT / ".agents" / "skills" / "delegate-via-postman" / "SKILL.md"
        ).read_text(encoding="utf-8")

        self.assertIn(r"D:\Downloads_dsh_auto", ps1)
        self.assertIn("DSH_POSTMAN_RESULT_ROOT", ps1)
        self.assertIn("--result-root", direct)
        self.assertIn("DIRECT_RESULT_ROOT_UNAVAILABLE", direct)
        self.assertIn("runtime.prepare_result_root", direct)
        self.assertIn("result_root=self.result_root", direct)
        self.assertIn("quiet_subprocess_kwargs", direct)
        self.assertIn(r'DEFAULT_BROWSER_DOWNLOAD_DIR = r"D:\Downloads_dsh_auto"', downloader)
        self.assertIn("quiet_subprocess_kwargs", downloader)
        self.assertIn("DIRECT_POSTMAN_SKILL_VERSION: 7", skill)

        normal = skill.split("## 8. Единственный production-вызов", 1)[1].split(
            "## 9. Разбор JSON и минимальный transport gate", 1
        )[0]
        self.assertIn("$jsonText = & $bridge", normal)
        self.assertNotIn("$jsonText = & pwsh.exe", normal)


if __name__ == "__main__":
    unittest.main()
