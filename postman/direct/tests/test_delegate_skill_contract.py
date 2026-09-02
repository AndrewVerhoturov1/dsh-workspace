from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]
SKILL = ROOT / ".agents" / "skills" / "delegate-via-postman" / "SKILL.md"
AGENTS = ROOT / "AGENTS.md"

class DelegateViaPostmanSkillContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = SKILL.read_text(encoding="utf-8")
        cls.agents = AGENTS.read_text(encoding="utf-8")

    def test_version_and_entrypoint(self):
        self.assertIn("DIRECT_POSTMAN_SKILL_VERSION: 3", self.skill)
        self.assertIn(r"C:\Users\andre\.dsh\postman\direct\postman.ps1", self.skill)

    def test_old_callable_path_is_not_present(self):
        # Mentioning the legacy token in a prohibition is allowed; an actual
        # callable-looking normal-path invocation must not return.
        self.assertNotIn("postman_async_send(", self.skill)
        self.assertNotIn("postman_runtime_accept_request(", self.skill)
        self.assertNotIn("postman_runtime_deliver_ready(", self.skill)

    def test_golden_path_is_explicit(self):
        for marker in (
            "## 0. Золотой путь",
            "## 8. Единственный production-вызов",
            "## 9. Разбор JSON и success gate",
            "## 13. Не создавать Git branch до RESULT_DURABLE только ради transport",
            "## 16. Применение ZIP",
            "## 20. Критические инварианты",
        ):
            self.assertIn(marker, self.skill)

    def test_normal_smoke_is_forbidden(self):
        self.assertIn("BrowserSmoke не является normal preflight", self.skill)
        self.assertIn("Smoke не является частью обычного golden path", self.skill)

    def test_failure_is_fail_closed(self):
        self.assertIn("Не создавать автоматически второй REQ", self.skill)
        self.assertIn("Новая отправка возможна только после нового явного пользовательского разрешения", self.skill)

    def test_agents_global_invariant(self):
        self.assertIn(
            r"POSTMAN_PRODUCTION_ENTRYPOINT: C:\Users\andre\.dsh\postman\direct\postman.ps1",
            self.agents,
        )
        self.assertIn("postman_async_send", self.agents)
        self.assertIn("считать его устаревшим", self.agents)

if __name__ == "__main__":
    unittest.main()
