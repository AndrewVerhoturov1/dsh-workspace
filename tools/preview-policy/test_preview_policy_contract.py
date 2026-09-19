from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "preview-policy.yml"
POLICY = ROOT / "REPO_POLICY.md"
AGENTS = ROOT / "AGENTS.md"
IMPL = ROOT / "system" / "implementation-package-workflow.md"
WORKFLOW_DOC = ROOT / "docs" / "workflow" / "PREVIEW_BRANCH_WORKFLOW.md"


class PreviewPolicyContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.policy = POLICY.read_text(encoding="utf-8")
        cls.agents = AGENTS.read_text(encoding="utf-8")
        cls.impl = IMPL.read_text(encoding="utf-8")
        cls.doc = WORKFLOW_DOC.read_text(encoding="utf-8")

    def test_workflow_has_only_canonical_routes(self):
        self.assertIn('BASE_BRANCH" == "preview"', self.workflow)
        self.assertIn('BASE_BRANCH" == "main"', self.workflow)
        self.assertIn('HEAD_BRANCH" != "preview"', self.workflow)
        self.assertIn("MAIN_GO_APPROVED_BY_USER", self.workflow)
        self.assertIn("unsupported PR base", self.workflow)

    def test_workflow_permissions_are_read_only(self):
        self.assertIn("permissions:\n  contents: read", self.workflow)
        for forbidden in ("contents: write", "pull-requests: write", "actions: write"):
            self.assertNotIn(forbidden, self.workflow)

    def test_repository_policy_declares_two_permanent_branches(self):
        self.assertIn("## 1. Две постоянные ветки", self.policy)
        self.assertIn("`main` — стабильное", self.policy)
        self.assertIn("`preview` — постоянная интеграционная", self.policy)
        self.assertIn("preview → main", self.policy)
        self.assertIn("merge commit", self.policy)

    def test_agents_default_task_route_is_preview(self):
        self.assertIn("origin/preview", self.agents)
        self.assertIn("base должен быть `preview`", self.agents)
        self.assertIn("promote-preview-to-main", self.agents)
        self.assertIn(r"C:\Users\andre\.dsh-preview", self.agents)

    def test_implementation_packages_default_to_preview(self):
        self.assertIn('"baseBranch": "preview"', self.impl)
        self.assertIn('"prBase": "preview"', self.impl)
        self.assertIn("PR в preview", self.impl)
        self.assertIn("migration/bootstrap", self.impl)

    def test_workflow_document_version_and_paths(self):
        self.assertIn("PREVIEW_BRANCH_WORKFLOW_VERSION: 1", self.doc)
        self.assertIn(r"C:\Users\andre\.dsh", self.doc)
        self.assertIn(r"C:\Users\andre\.dsh-preview", self.doc)
        self.assertIn("preview_worktree.ps1' -Action bootstrap", self.doc)
        self.assertIn("promote_preview_to_main.ps1", self.doc)


if __name__ == "__main__":
    unittest.main()
