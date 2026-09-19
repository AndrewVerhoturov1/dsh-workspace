from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / ".agents" / "skills" / "promote-preview-to-main" / "SKILL.md"


class PromotePreviewSkillContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SKILL.read_text(encoding="utf-8")

    def test_frontmatter_and_version(self):
        self.assertTrue(self.text.startswith("---\n"))
        self.assertIn("name: promote-preview-to-main", self.text)
        self.assertIn("PROMOTE_PREVIEW_TO_MAIN_SKILL_VERSION: 1", self.text)

    def test_route_and_marker_are_explicit(self):
        self.assertIn("preview → main", self.text)
        self.assertIn("base = main", self.text)
        self.assertIn("head = preview", self.text)
        self.assertIn("MAIN_GO_APPROVED_BY_USER: yes", self.text)

    def test_merge_method_is_not_squash(self):
        self.assertIn("merge commit", self.text)
        self.assertIn("Squash для `preview → main` запрещён", self.text)

    def test_preview_is_protected(self):
        self.assertIn("удаление preview", self.text)
        self.assertIn(r"C:\Users\andre\.dsh-preview", self.text)
        self.assertIn("force push main/preview", self.text)

    def test_executor_path_is_explicit(self):
        self.assertIn(r"C:\Users\andre\.dsh\tools\promote-preview-to-main\promote_preview_to_main.ps1", self.text)
        self.assertIn("-PrNumber 123", self.text)


if __name__ == "__main__":
    unittest.main()
