from __future__ import annotations

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]
AGENTS = ROOT / "AGENTS.md"
SKILL = ROOT / ".agents" / "skills" / "delegate-via-postman-ask" / "SKILL.md"
WRAPPER = ROOT / "postman" / "direct" / "postman-ask.ps1"
BRIDGE = ROOT / "postman" / "direct" / "postman_ask.py"
FLOW = ROOT / "postman" / "POSTMAN_ASK_FLOW.md"
HARNESS = ROOT / "plugins" / "dsh-postman-harness" / "lib" / "direct-current-turn.js"


class PostmanAskContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agents = AGENTS.read_text(encoding="utf-8")
        cls.skill = SKILL.read_text(encoding="utf-8")
        cls.wrapper = WRAPPER.read_text(encoding="utf-8")
        cls.bridge = BRIDGE.read_text(encoding="utf-8")
        cls.flow = FLOW.read_text(encoding="utf-8")
        cls.harness = HARNESS.read_text(encoding="utf-8")

    def test_exact_triggers_are_separate(self):
        ask = re.compile(r"^\s*@PostmanAsk(?:\s|$)")
        artifact = re.compile(r"^\s*@Postman(?:\s|$)")
        self.assertRegex("@PostmanAsk изучи вопрос", ask)
        self.assertNotRegex("@Postman изучи вопрос", ask)
        self.assertNotRegex("@PostmanAsk изучи вопрос", artifact)
        self.assertIn(r"^\s*@PostmanAsk(?:\s|$)", self.skill)

    def test_trusted_no_argument_boundary_is_preserved(self):
        self.assertIn("postman_send_current_turn()", self.skill)
        self.assertIn("без текстовых аргументов", self.skill)
        self.assertIn("PostmanAsk|Postman", self.harness)
        self.assertIn("postman-ask.ps1", self.harness)
        self.assertNotIn("TaskBase64", self.skill)

    def test_wrapper_forces_utf8_and_dedicated_bridge(self):
        self.assertIn("postman_ask.py", self.wrapper)
        self.assertEqual(1, self.wrapper.count("'-X' 'utf8'"))
        self.assertNotIn("AutomaticContinuation", self.wrapper)
        self.assertNotIn("BrowserSmoke", self.wrapper)

    def test_bridge_requires_reproved_no_artifact_then_exact_markers(self):
        self.assertIn("ASSISTANT_COMPLETED_NO_ARTIFACT", self.bridge)
        self.assertIn("parse_text_envelope", self.bridge)
        self.assertIn("TEXT_RESULT_DURABLE", self.bridge)
        self.assertIn("POSTMAN_ASK_RESULT_TRIGGER_INVALID", self.bridge)
        self.assertIn("10-second", self.flow)

    def test_exact_reply_validation_contract(self):
        self.assertIn("postman_ask_validate_reply", self.harness)
        self.assertIn("EXACT_REPLY_MATCH", self.harness)
        self.assertIn("EXACT_REPLY_MISMATCH", self.harness)
        self.assertIn("postman_ask_validate_reply", self.skill)
        self.assertIn("EXACT_REPLY_MATCH", self.skill)
        self.assertIn("прямое строковое сравнение", self.skill)
        self.assertIn("PostmanAsk exact final-reply invariant", self.agents)
        self.assertIn("postman_ask_validate_reply", self.agents)
        self.assertIn("EXACT_REPLY_MATCH", self.flow)

    def test_agents_declares_text_entrypoint(self):
        self.assertIn("POSTMAN_ASK_PRODUCTION_ENTRYPOINT", self.agents)
        self.assertIn("delegate-via-postman-ask", self.agents)
        self.assertIn("TEXT_RESULT_DURABLE", self.agents)


if __name__ == "__main__":
    unittest.main()
