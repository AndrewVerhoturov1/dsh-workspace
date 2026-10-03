from __future__ import annotations

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]
AGENTS = ROOT / "AGENTS.md"
SKILL = ROOT / ".agents" / "skills" / "delegate-via-postman-ask" / "SKILL.md"
WRAPPER = ROOT / "postman" / "direct" / "postman-ask.ps1"
BRIDGE = ROOT / "postman" / "direct" / "postman_ask.py"
HARNESS = ROOT / "plugins" / "dsh-postman-harness" / "lib" / "direct-current-turn.js"


class PostmanAskContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agents = AGENTS.read_text(encoding="utf-8")
        cls.skill = SKILL.read_text(encoding="utf-8")
        cls.wrapper = WRAPPER.read_text(encoding="utf-8")
        cls.bridge = BRIDGE.read_text(encoding="utf-8")
        cls.harness = HARNESS.read_text(encoding="utf-8")

    def test_exact_triggers_are_separate(self):
        ask = re.compile(r"^\s*@PostmanAsk(?:\s|$)")
        artifact = re.compile(r"^\s*@Postman(?:\s|$)")
        self.assertRegex("@PostmanAsk изучи вопрос", ask)
        self.assertNotRegex("@Postman изучи вопрос", ask)
        self.assertNotRegex("@PostmanAsk изучи вопрос", artifact)
        self.assertIn(ask.pattern, self.skill)

    def test_trusted_no_argument_boundary_is_preserved(self):
        self.assertIn("postman_send_current_turn()", self.skill)
        self.assertIn("без текстовых аргументов", self.skill)
        self.assertIn("PostmanAsk|Postman", self.harness)
        self.assertIn("postman-ask.ps1", self.harness)

    def test_input_zip_preserves_text_result_contract(self):
        self.assertIn("DIRECT_POSTMAN_ASK_SKILL_VERSION: 4", self.skill)
        for invariant in ("text-result Direct Postman", "parent Host/Leader", "Bridge child их не изменяет",
                          "не меняет text result contract", "manual upload/path operations child не выполняет"):
            self.assertIn(invariant, self.skill)
        self.assertNotIn("text-only Direct Postman", self.skill)
        self.assertNotIn("Direct text transport", self.skill)

    def test_wrapper_forces_utf8_and_dedicated_bridge(self):
        self.assertIn("postman_ask.py", self.wrapper)
        self.assertEqual(1, self.wrapper.count("'-X' 'utf8'"))
        self.assertIn("AutomaticContinuation", self.wrapper)

    def test_bridge_requires_exact_markers(self):
        for marker in ("ASSISTANT_COMPLETED_NO_ARTIFACT", "parse_text_envelope", "TEXT_RESULT_DURABLE", "POSTMAN_ASK_RESULT_TRIGGER_INVALID"):
            self.assertIn(marker, self.bridge)

    def test_exact_reply_validation_contract(self):
        for marker in ("postman_ask_validate_reply", "EXACT_REPLY_MATCH", "EXACT_REPLY_MISMATCH"):
            self.assertIn(marker, self.harness)
        self.assertIn("postman_ask_validate_reply", self.skill)
        self.assertIn("EXACT_REPLY_MATCH", self.skill)

    def test_global_document_routes_to_text_skill(self):
        self.assertIn("delegate-via-postman-ask", self.agents)


if __name__ == "__main__":
    unittest.main()
