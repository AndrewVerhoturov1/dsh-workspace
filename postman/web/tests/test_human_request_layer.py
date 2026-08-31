from __future__ import annotations

import re
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
DOCS = {
    ROOT / "README.md",
    ROOT / "LUNA_IMPLEMENTATION_PROMPT.md",
    ROOT / "docs" / "agent-workflow.md",
    ROOT / "docs" / "human-request-template.md",
    ROOT / "docs" / "request-identity-rules.md",
    ROOT / "examples" / "example-request.md",
}
CANONICAL_REQ = re.compile(r"^REQ_\d{8}T\d{6}Z_\d{4}$")


class HumanRequestLayerTests(unittest.TestCase):
    def test_document_set_is_utf8_and_markdown_is_structurally_valid(self):
        markdown_docs = DOCS - {ROOT / "LUNA_IMPLEMENTATION_PROMPT.md"}
        for path in DOCS:
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("\x00", text, path.name)
            self.assertTrue(text.endswith("\n"), path.name)
        for path in markdown_docs:
            text = path.read_text(encoding="utf-8")
            self.assertTrue(text.lstrip().startswith("# "), path.name)
            self.assertEqual(text.count("```"), 0, path.name)

    def test_request_id_format_is_canonical_and_human_facing(self):
        example = "REQ_20260901T015200Z_4821"
        self.assertRegex(example, CANONICAL_REQ)
        self.assertNotRegex("REQ_20260901T015200Z_482", CANONICAL_REQ)
        self.assertNotRegex("REQ_20260901T015200Z_ABCD", CANONICAL_REQ)

        template = (ROOT / "docs" / "human-request-template.md").read_text(encoding="utf-8")
        self.assertIn("POSTMAN_REQUEST_ID: REQ_YYYYMMDDTHHMMSSZ_XXXX", template)
        self.assertLess(template.index("Правила выполнения:"), template.index("Задание:"))
        self.assertLess(template.index("Задание:"), template.index("Цель:"))

    def test_req_is_only_a_correlation_key_not_a_memory_instruction(self):
        identity = (ROOT / "docs" / "request-identity-rules.md").read_text(encoding="utf-8")
        workflow = (ROOT / "docs" / "agent-workflow.md").read_text(encoding="utf-8")
        template = (ROOT / "docs" / "human-request-template.md").read_text(encoding="utf-8")

        self.assertIn("Runtime использует его для корреляции.", identity)
        self.assertIn("REQ не сохраняется как пользовательская память.", identity)
        self.assertIn("Использовать его только в текущем процессе.", workflow)
        self.assertIn("записывать REQ в память", workflow)
        self.assertIn("ключом только текущего задания", template)
        self.assertIn("не является командой на запись в память или профиль", template)
        self.assertNotIn("сохранить REQ в память", workflow)

    def test_human_request_contains_no_internal_technical_contract(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("POSTMAN_REQUEST_ID", readme)
        self.assertIn("ссылки на правила и задачу", readme)
        self.assertNotIn("manifest.json", readme)
        self.assertNotIn("changes.patch", readme)
        self.assertNotIn("Runtime", readme)


if __name__ == "__main__":
    unittest.main()
