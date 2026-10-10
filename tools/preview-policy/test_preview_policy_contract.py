"""Contract checks for the task→main and independent main→preview routes.

The complete test requires integrated G1 finalizer and G2 promotion files; it is
not an isolated G3 test before the three migration parts are combined.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "preview-policy.yml"
POLICY = ROOT / "REPO_POLICY.md"
AGENTS = ROOT / "AGENTS.md"
IMPL = ROOT / "system" / "implementation-package-workflow.md"
WORKFLOW_DOC = ROOT / "docs" / "workflow" / "PREVIEW_BRANCH_WORKFLOW.md"
SCHEMA = ROOT / "system" / "implementation_package_schema.json"
FINALIZER = ROOT / "tools" / "finalize-task-pr" / "finalize_task_pr.py"  # G1
PROMOTION_PY = ROOT / "tools" / "promote-main-to-preview" / "promote_main_to_preview.py"  # G2
PROMOTION_PS = ROOT / "tools" / "promote-main-to-preview" / "promote_main_to_preview.ps1"  # G2


class PreviewPolicyContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_pull_request_job_identity_and_read_only_permission(self):
        self.assertIn("name: Preview Branch Policy", self.workflow)
        self.assertIn("on:\n  pull_request:", self.workflow)
        self.assertIn("types: [opened, synchronize, reopened, edited, ready_for_review]", self.workflow)
        self.assertNotIn("pull_request_target", self.workflow)
        self.assertIn("permissions:\n  contents: read", self.workflow)
        self.assertIn("jobs:\n  preview-branch-policy:", self.workflow)
        self.assertIn("- name: Validate PR branch route", self.workflow)
        for forbidden in ("contents: write", "pull-requests: write", "actions: write"):
            self.assertNotIn(forbidden, self.workflow)
        self.assertNotIn("MAIN_GO_APPROVED_BY_USER", self.workflow)
        self.assertNotIn("PR_BODY", self.workflow)

    def test_real_guard_script_allows_only_temporary_heads_into_main(self):
        # Run the *actual* CI step body, not a restatement of its branching logic.
        self.assertEqual(self.workflow.count("        run: |"), 1)
        script = textwrap.dedent(self.workflow.split("        run: |", 1)[1]).strip() + "\n"
        bash = shutil.which("bash")
        if bash is None and os.name == "nt":
            git_bash = Path("C:/Program Files/Git/usr/bin/bash.exe")
            if git_bash.is_file():
                bash = str(git_bash)
        if bash is None:
            self.fail("Bash executable unavailable: PATH lookup failed and the standard Git for Windows path is not a file.")
        routes = {
            ("main", "feature/new-task"): True,
            ("main", "fix/correct-guard"): True,
            ("main", "postman/REQ-test"): True,
            ("main", "main"): False,
            ("main", "preview"): False,
            ("preview", "feature/legacy-task"): False,
            ("preview", "main"): False,
            ("preview", "preview"): False,
            ("release", "feature/task"): False,
        }
        for (base, head), permitted in routes.items():
            with self.subTest(base=base, head=head):
                result = subprocess.run(
                    [bash, "-e"],
                    input=script,
                    text=True,
                    capture_output=True,
                    env={**os.environ, "BASE_BRANCH": base, "HEAD_BRANCH": head},
                    check=False,
                )
                self.assertEqual(result.returncode == 0, permitted, result.stdout + result.stderr)
                self.assertIn("PASS:" if permitted else "FAIL:", result.stdout + result.stderr)

    def test_policy_and_schema_default_to_main_without_breaking_packagebase(self):
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(schema["properties"]["schemaVersion"]["const"], 1)
        self.assertEqual(schema["properties"]["baseBranch"], {"type": "string", "default": "main"})
        self.assertEqual(schema["properties"]["prBase"], {"type": "string", "default": "main"})
        self.assertNotIn("packageBase", schema["required"])
        self.assertEqual(schema["properties"]["tests"]["items"]["properties"]["command"]["type"], "array")
        policy = POLICY.read_text(encoding="utf-8")
        agents = AGENTS.read_text(encoding="utf-8")
        impl = IMPL.read_text(encoding="utf-8")
        doc = WORKFLOW_DOC.read_text(encoding="utf-8")
        self.assertIn("exact current `origin/main`", policy)
        self.assertIn("`preview`", policy)
        self.assertIn("promote-main-to-preview", policy)
        self.assertIn("GitHub READ ONLY", policy)
        self.assertIn("packageBase", policy)
        self.assertIn("PR в `main`", agents)
        self.assertIn('"baseBranch": "main"', impl)
        self.assertIn('"prBase": "main"', impl)
        self.assertIn('`baseBranch="preview"`', impl)  # documented one-time migration exception
        self.assertIn("PREVIEW_BRANCH_WORKFLOW_VERSION: 2", doc)
        self.assertIn(r"C:\Users\andre\.dsh-preview", doc)
        self.assertIn("promote_main_to_preview.ps1", doc)

    def test_integrated_g1_finalizer_routes_task_squash_to_main(self):
        # Available only after G1+G2+G3 integration, not in the partial G3 ZIP.
        source = FINALIZER.read_text(encoding="utf-8")
        self.assertIn('if base != "main":', source)
        self.assertIn('"targetBranch": "main"', source)
        self.assertIn("merge_method=squash", source)
        self.assertIn('PERMANENT_BRANCHES = {"main", "preview"}', source)

    def test_integrated_g2_has_exact_sha_go_without_release_pr(self):
        python_source = PROMOTION_PY.read_text(encoding="utf-8")
        powershell_source = PROMOTION_PS.read_text(encoding="utf-8")
        self.assertIn("--approved-main-sha", python_source)
        self.assertIn("--user-go", python_source)
        self.assertIn("$ApprovedMainSha", powershell_source)
        self.assertIn("$UserGo", powershell_source)
        for source in (python_source, powershell_source):
            self.assertNotIn("MAIN_GO_APPROVED_BY_USER", source)
            self.assertNotIn("promote_preview_to_main", source)


if __name__ == "__main__":
    unittest.main()
