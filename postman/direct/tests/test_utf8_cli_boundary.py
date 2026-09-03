from __future__ import annotations

from pathlib import Path
import json
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]


class PostmanUtf8CliBoundaryTests(unittest.TestCase):
    def test_canonical_wrappers_force_python_utf8_mode(self):
        expected = {
            "postman/direct/postman.ps1": 2,
            "postman/direct/integrate_result.ps1": 1,
            "postman/direct/prepare_result.ps1": 1,
            "postman/direct/test_result.ps1": 1,
            "postman/direct/publish_result.ps1": 1,
        }
        for rel, count in expected.items():
            text = (ROOT / rel).read_text(encoding="utf-8")
            self.assertEqual(
                count,
                text.count("'-X' 'utf8'"),
                f"{rel} must force Python UTF-8 mode on every canonical invocation",
            )

    def test_utf8_mode_can_emit_non_cp1251_json(self):
        payload = {"ok": False, "error": "日本 → Проверить"}
        code = (
            "import json,sys;"
            f"payload={payload!r};"
            "assert sys.flags.utf8_mode == 1;"
            "print(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))"
        )
        result = subprocess.run(
            [sys.executable, "-X", "utf8", "-c", code],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertEqual(payload, json.loads(result.stdout))

    def test_agents_contract_mentions_failure_path(self):
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn("Postman UTF-8 CLI boundary invariant.", agents)
        self.assertIn("`-X utf8`", agents)
        self.assertIn("failure-path", agents)
        self.assertIn("UnicodeEncodeError", agents)


if __name__ == "__main__":
    unittest.main()
