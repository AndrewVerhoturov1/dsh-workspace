from __future__ import annotations

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]


class ReminderContractDocsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = (ROOT / ".agents" / "skills" / "delegate-via-postman" / "SKILL.md").read_text(encoding="utf-8")
        cls.flow = (ROOT / "postman" / "POSTMAN_CURRENT_FLOW.md").read_text(encoding="utf-8")
        cls.bootstrap = (ROOT / "postman" / "web" / "browser_bootstrap.py").read_text(encoding="utf-8")
        cls.direct = (ROOT / "postman" / "direct" / "postman_direct.py").read_text(encoding="utf-8")

    def test_skill_uses_trusted_current_turn(self):
        self.assertIn("postman_send_current_turn()", self.skill)

    def test_flow_retains_machine_reminder_marker_and_neutral_page(self):
        self.assertIn("POSTMAN_TRANSPORT_CONTROL: REMINDER", self.flow)
        self.assertIn("about:blank", self.flow)

    def test_runtime_constants_match_documented_timing_and_neutral_start_page(self):
        self.assertIn('DEFAULT_STARTUP_URL = "about:blank"', self.bootstrap)
        self.assertIn("DEFAULT_ASSISTANT_TIMEOUT_MS = 45 * 60 * 1000", self.direct)


if __name__ == "__main__":
    unittest.main()
