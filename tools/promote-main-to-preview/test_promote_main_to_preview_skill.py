from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / ".agents" / "skills" / "promote-main-to-preview" / "SKILL.md"
PS1 = Path(__file__).with_name("promote_main_to_preview.ps1")


class PromoteMainToPreviewSkillContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SKILL.read_text(encoding="utf-8")
        cls.wrapper = PS1.read_text(encoding="utf-8")

    def test_frontmatter_and_version(self):
        self.assertTrue(self.text.startswith("---\n"))
        self.assertIn("name: promote-main-to-preview", self.text)
        self.assertIn("PROMOTE_MAIN_TO_PREVIEW_SKILL_VERSION: 1", self.text)

    def test_exact_main_to_preview_route_and_current_human_go(self):
        self.assertIn("main = everyday integration", self.text)
        self.assertIn("preview = last explicitly verified stable", self.text)
        self.assertIn("main SHA A → preview", self.text)
        self.assertIn("CURRENT human instruction", self.text)
        self.assertIn("exact full 40-hex main SHA A", self.text)
        self.assertIn("or treat an executor switch as a replacement", self.text)
        self.assertIn("Coordinate/serialize promotion", self.text)

    def test_executor_invocation_only_new_name_and_required_parameters(self):
        self.assertIn(r"C:\Users\andre\.dsh\tools\promote-main-to-preview\promote_main_to_preview.ps1", self.text)
        self.assertIn("-ApprovedMainSha", self.text)
        self.assertIn("-UserGo", self.text)
        self.assertIn("--approved-main-sha", self.text)
        self.assertIn("--user-go", self.text)
        self.assertIn("[Parameter(Mandatory = $true)]", self.wrapper)
        self.assertIn("[switch]$UserGo", self.wrapper)
        self.assertIn("promote_main_to_preview.py", self.wrapper)
        self.assertNotIn("promote-preview-to-main", self.text + self.wrapper)
        self.assertNotIn("-PrNumber", self.text + self.wrapper)

    def test_no_pr_merge_force_or_permanent_tree_mutation(self):
        self.assertIn("not atomic CAS", self.text)
        self.assertIn("git push origin A:refs/heads/preview", self.text)
        self.assertIn("no force/lease", self.text)
        self.assertIn("without bypass/retry", self.text)
        self.assertIn("never checks out, resets, stashes, cleans, deletes", self.text)
        self.assertIn("-Action update", self.text)
        self.assertIn("Only **after verified remote success**", self.text)


if __name__ == "__main__":
    unittest.main()
