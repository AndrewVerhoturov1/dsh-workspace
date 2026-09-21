from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
SKILL = ROOT / ".agents" / "skills" / "delegate-via-postman" / "SKILL.md"
AGENTS = ROOT / "AGENTS.md"
INDEX = ROOT / "plugins" / "dsh-postman-harness" / "lib" / "index.js"


class TrustedCurrentTurnContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = SKILL.read_text(encoding="utf-8")
        cls.agents = AGENTS.read_text(encoding="utf-8")
        cls.index = INDEX.read_text(encoding="utf-8")

    def test_skill_prioritizes_trusted_current_turn_boundary(self):
        self.assertIn("TRUSTED_CURRENT_TURN_BOUNDARY_VERSION: 1", self.skill)
        self.assertIn("postman_send_current_turn()", self.skill)
        self.assertIn("postman_current_turn_status()", self.skill)
        self.assertIn("postman_continue_last_request()", self.skill)
        self.assertIn("model-copy fallback запрещён", self.skill)

    def test_global_contract_forbids_llm_payload_reproduction(self):
        self.assertIn("postman_send_current_turn()", self.agents)
        self.assertIn("Luna не перепечатывает текущий user text", self.agents)
        self.assertIn("-TaskBase64", self.agents)

    def test_plugin_registers_trusted_empty_argument_tool_surface(self):
        self.assertIn("createDirectCurrentTurnToolConfigs", self.index)
        self.assertIn("for (const tool of currentTurnBridge.tools)", self.index)


if __name__ == "__main__":
    unittest.main()
