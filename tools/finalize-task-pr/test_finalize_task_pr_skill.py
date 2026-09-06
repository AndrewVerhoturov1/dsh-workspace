from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / ".agents" / "skills" / "finalize-task-pr" / "SKILL.md"


class FinalizeTaskPrSkillContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SKILL.read_text(encoding="utf-8")

    def test_frontmatter_and_version(self):
        self.assertTrue(self.text.startswith("---\n"))
        self.assertIn("name: finalize-task-pr", self.text)
        self.assertIn("FINALIZE_TASK_PR_SKILL_VERSION: 1", self.text)

    def test_canonical_executor_is_explicit(self):
        self.assertIn(
            r"C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1",
            self.text,
        )
        self.assertIn("-PrNumber 99", self.text)
        self.assertIn("-PrNumber 97,98", self.text)

    def test_skill_is_executor_not_reviewer(self):
        self.assertIn("исполнитель уже принятого решения", self.text)
        for marker in ("тесты", "CI/checks", "diff review", "scope review"):
            self.assertIn(marker, self.text)
        self.assertRegex(self.text, re.compile(r"не повторять", re.I))

    def test_cleanup_is_best_effort(self):
        self.assertIn("best effort", self.text.lower())
        self.assertIn("Dirty secondary worktree", self.text)
        self.assertIn("TASK_PRS_FINALIZED_WITH_WARNINGS", self.text)
        self.assertIn("Cleanup warning не превращает уже успешный merge в failure", self.text)

    def test_destructive_fallbacks_are_forbidden(self):
        for marker in ("git reset --hard", "git clean", "automatic stash", "force push"):
            self.assertIn(marker, self.text)

    def test_what_if_is_not_mandatory(self):
        self.assertIn("`-WhatIf` использовать только если пользователь явно просит", self.text)
        self.assertIn("Это не обязательный шаг", self.text)


if __name__ == "__main__":
    unittest.main()
