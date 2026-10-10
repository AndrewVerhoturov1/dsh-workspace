from pathlib import Path
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
        self.assertIn("FINALIZE_TASK_PR_SKILL_VERSION: 3", self.text)

    def test_canonical_executor_is_explicit(self):
        self.assertIn(r"C:\Users\andre\.dsh\tools\finalize-task-pr\finalize_task_pr.ps1", self.text)
        self.assertIn("-PrNumber", self.text)

    def test_targets_main_with_separate_preview_promotion(self):
        self.assertIn("base=main", self.text)
        self.assertIn("main → preview", self.text)
        self.assertIn("promote-main-to-preview", self.text)
        self.assertIn("promote_main_to_preview.ps1", self.text)
        self.assertNotIn("base=preview", self.text)

    def test_skill_is_executor_not_reviewer(self):
        self.assertIn("не повторять", self.text.lower())

    def test_permanent_worktrees_are_protected(self):
        self.assertIn(r"C:\Users\andre\.dsh", self.text)
        self.assertIn(r"C:\Users\andre\.dsh-preview", self.text)

    def test_cleanup_is_best_effort(self):
        self.assertIn("best effort", self.text.lower())
        self.assertIn("TASK_PRS_FINALIZED_WITH_WARNINGS", self.text)

    def test_destructive_fallbacks_are_forbidden(self):
        for marker in ("git reset --hard", "git clean", "automatic stash", "force push"):
            self.assertIn(marker, self.text)

    def test_what_if_is_not_mandatory(self):
        self.assertIn("-WhatIf", self.text)

    def test_no_automatic_permanent_worktree_sync_after_merge(self):
        self.assertIn("не запускает автоматическую синхронизацию", self.text)
        self.assertIn("нет автоматического обновления permanent", self.text)
        self.assertNotIn("preview_worktree.ps1", self.text)
        self.assertNotIn("$previewText", self.text)
        self.assertNotIn("$previewResult", self.text)
        self.assertIn("TASK_PRS_FINALIZED_WITH_WARNINGS", self.text)
        self.assertIn("mainWorkingTreeTouched=false", self.text)
        self.assertIn("previewWorkingTreeTouched=false", self.text)


if __name__ == "__main__":
    unittest.main()
