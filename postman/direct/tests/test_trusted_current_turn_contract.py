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

    def test_skill_declares_trusted_current_turn_boundary(self):
        self.assertIn("TRUSTED_CURRENT_TURN_BOUNDARY_VERSION: 1", self.skill)
        for tool in ("postman_send_current_turn()", "postman_current_turn_status()", "postman_continue_last_request()"):
            self.assertIn(tool, self.skill)
        self.assertIn("model-copy fallback запрещён", self.skill)

    def test_global_document_routes_to_skill(self):
        self.assertIn("delegate-via-postman", self.agents)

    def test_plugin_registers_trusted_tool_surface(self):
        self.assertIn("createDirectCurrentTurnToolConfigs", self.index)
        self.assertIn("for (const tool of currentTurnBridge.tools)", self.index)


if __name__ == "__main__":
    unittest.main()
