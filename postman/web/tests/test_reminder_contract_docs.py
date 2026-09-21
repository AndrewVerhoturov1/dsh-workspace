from __future__ import annotations

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]


class ReminderContractDocsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = (ROOT / ".agents" / "skills" / "delegate-via-postman" / "SKILL.md").read_text(encoding="utf-8")
        cls.flow = (ROOT / "postman" / "POSTMAN_CURRENT_FLOW.md").read_text(encoding="utf-8")
        cls.contract = (ROOT / "docs" / "web-postman-artifact-contract.md").read_text(encoding="utf-8")
        cls.intent = (ROOT / "docs" / "intent-preservation-rules.md").read_text(encoding="utf-8")
        cls.bootstrap = (ROOT / "postman" / "web" / "browser_bootstrap.py").read_text(encoding="utf-8")
        cls.direct = (ROOT / "postman" / "direct" / "postman_direct.py").read_text(encoding="utf-8")

    def test_skill_version_and_fixed_timing_contract(self):
        self.assertIn("DIRECT_POSTMAN_SKILL_VERSION: 20", self.skill)
        for marker in ("10 минут", "20 минут", "30 минут", "45 минут"):
            self.assertIn(marker, self.skill)
        self.assertIn("timeoutMs: 3000000", self.skill)

    def test_flow_documents_same_req_reminders_and_page_cleanup(self):
        self.assertIn("POSTMAN_TRANSPORT_CONTROL: REMINDER", self.flow)
        self.assertIn("новый REQ не создаётся", self.flow)
        for marker in ("10-я", "20-я", "30-я"):
            self.assertIn(marker, self.flow)
        self.assertIn("about:blank", self.flow)
        self.assertIn("закрывает принадлежащую", self.flow)
        self.assertIn("ему рабочую вкладку", self.flow)

    def test_artifact_contract_allows_only_authorized_reminder_anchor(self):
        self.assertIn("служебное напоминание Direct Postman", self.contract)
        self.assertIn("произвольный новый user turn", self.contract.casefold())
        self.assertIn("до трёх", self.contract)

    def test_intent_rules_say_reminders_do_not_change_user_intent(self):
        self.assertIn("## Служебные напоминания", self.intent)
        self.assertIn("не является новым semantic intent", self.intent)
        self.assertIn("не создаёт новый REQ", self.intent)

    def test_runtime_constants_match_documented_timing_and_neutral_start_page(self):
        self.assertIn('DEFAULT_STARTUP_URL = "about:blank"', self.bootstrap)
        self.assertIn("DEFAULT_ASSISTANT_TIMEOUT_MS = 45 * 60 * 1000", self.direct)


if __name__ == "__main__":
    unittest.main()
