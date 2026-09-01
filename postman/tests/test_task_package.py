from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "postman" / "task_package.py"
spec = importlib.util.spec_from_file_location("task_package", MODULE_PATH)
task_package = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(task_package)


REQ = "REQ_20260831T043812Z_4827"
BASE_COMMIT = "a" * 40
SKILL_URL = task_package.SKILL_REPOSITORY_URL
TASK_URL = "https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/REQ_20260831T043812Z_4827.md"


class TaskPackageTests(unittest.TestCase):
    def render(self, **overrides):
        values = {
            "request_id": REQ,
            "author": "Luna",
            "goal": "Implement the bounded task package protocol.",
            "repository": "AndrewVerhoturov1/dsh-workspace",
            "base_commit": BASE_COMMIT,
            "required_documents": [SKILL_URL, "https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/REPO_POLICY.md"],
            "task": "Apply only the task-specific implementation.\nKeep the runtime unchanged.",
            "expected_result": "A reviewed implementation published through one pull request.",
            "validation": "Run unit tests and git diff --check.",
        }
        values.update(overrides)
        return task_package.render_task_file(**values)

    def render_intent(self, **overrides):
        values = {
            "request_id": REQ,
            "user_intent": "Preserve the user's request while sending it to the external agent.",
            "confirmed_requirements": ["Keep the request meaning unchanged."],
            "clarifications": ["Which repository should be changed? — Confirmed: dsh-workspace."],
            "constraints": ["Do not design the solution locally."],
            "required_documents": [SKILL_URL, "https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/REPO_POLICY.md"],
            "repository": "AndrewVerhoturov1/dsh-workspace",
            "base_commit": BASE_COMMIT,
            "expected_output": "A task file for the external agent.",
            "validation": "Run unit tests and git diff --check.",
        }
        values.update(overrides)
        return task_package.render_intent_task_file(**values)

    def test_task_filename_uses_exact_canonical_request_id(self):
        self.assertEqual(task_package.task_filename(REQ), f"{REQ}.md")
        self.assertTrue(task_package.validate_task_path(f"{REQ}.md", REQ))
        self.assertFalse(task_package.validate_task_path(f"docs/{REQ}.md", REQ))
        self.assertFalse(task_package.validate_task_path("REQ_20260831T043813Z_4827.md", REQ))

    def test_invalid_request_ids_fail_closed(self):
        for value in (
            "REQ_20261331T043812Z_4827",
            "REQ_20260831T043812Z_ABC1",
            "REQ_WP009_TEST",
        ):
            with self.subTest(value=value):
                with self.assertRaises(task_package.TaskPackageError):
                    task_package.task_filename(value)
                with self.assertRaises(task_package.TaskPackageError):
                    self.render(request_id=value)

    def test_rendered_task_contains_required_fields_in_order(self):
        content = self.render()
        fields = [
            "request_id: REQ_20260831T043812Z_4827",
            "author: Luna",
            "goal: Implement the bounded task package protocol.",
            "repository: AndrewVerhoturov1/dsh-workspace",
            f"base_commit: {BASE_COMMIT}",
            "required_documents:",
            "## Task",
            "## Expected result",
            "## Validation",
        ]
        positions = [content.index(field) for field in fields]
        self.assertEqual(positions, sorted(positions))
        self.assertIn(SKILL_URL, content)
        self.assertIn("https://github.com/AndrewVerhoturov1/dsh-workspace/blob/main/REPO_POLICY.md", content)
        self.assertIn("Keep the runtime unchanged.", content)
        self.assertTrue(content.endswith("\n"))
        self.assertNotIn("\r", content)

    def test_task_fields_must_not_be_empty_or_duplicated(self):
        for field in ("author", "goal", "repository", "base_commit", "task", "expected_result", "validation"):
            with self.subTest(field=field):
                with self.assertRaises(task_package.TaskPackageError):
                    self.render(**{field: "   "})
        with self.assertRaises(task_package.TaskPackageError):
            self.render(required_documents=[])
        with self.assertRaises(task_package.TaskPackageError):
            self.render(required_documents=[SKILL_URL, SKILL_URL])
        with self.assertRaises(task_package.TaskPackageError):
            self.render(base_commit="not-a-commit")

    def test_task_is_utf8_markdown_with_unicode(self):
        content = self.render(
            author="Луна",
            goal="Проверить передачу задачи: ✅",
            task="Сохранить Unicode: ё — 漢字.",
        )
        encoded = content.encode("utf-8")
        self.assertEqual(encoded.decode("utf-8"), content)
        self.assertIn("# POSTMAN TASK\n", content)
        self.assertIn("## Task\n", content)

    def test_intent_task_contains_explicit_fields_in_archive_order(self):
        content = self.render_intent()
        fields = [
            "request_id: REQ_20260831T043812Z_4827",
            "user_intent:\nPreserve the user's request while sending it to the external agent.",
            "confirmed_requirements:\n- Keep the request meaning unchanged.",
            "clarifications:\n- Which repository should be changed? — Confirmed: dsh-workspace.",
            "constraints:\n- Do not design the solution locally.",
            "required_documents:\n- " + SKILL_URL,
            "repository: AndrewVerhoturov1/dsh-workspace",
            "base_commit: " + BASE_COMMIT,
            "expected_output:\nA task file for the external agent.",
            "validation:\nRun unit tests and git diff --check.",
        ]
        positions = [content.index(field) for field in fields]
        self.assertEqual(positions, sorted(positions))
        self.assertTrue(content.endswith("\n"))
        self.assertNotIn("## Task", content)

    def test_intent_task_preserves_unicode_and_does_not_infer_empty_sections(self):
        content = self.render_intent(
            user_intent="Сохранить смысл: ё — 漢字 ✅",
            confirmed_requirements=["Только подтверждённое требование."],
            clarifications=[],
            constraints=[],
        )
        self.assertEqual(content.encode("utf-8").decode("utf-8"), content)
        self.assertIn("user_intent:\nСохранить смысл: ё — 漢字 ✅", content)
        self.assertIn("clarifications:\n\nconstraints:", content)
        self.assertNotIn("уточнение не требуется", content.lower())
        self.assertNotIn("архитектура", content.lower())

    def test_intent_task_rejects_missing_confirmed_requirements(self):
        with self.assertRaises(task_package.TaskPackageError):
            self.render_intent(confirmed_requirements=[])

    def test_intent_task_rejects_invalid_items_without_rewriting_them(self):
        for field in ("confirmed_requirements", "clarifications", "constraints"):
            with self.subTest(field=field):
                with self.assertRaises(task_package.TaskPackageError):
                    self.render_intent(**{field: [" "]})
                with self.assertRaises(task_package.TaskPackageError):
                    self.render_intent(**{field: ["line one\nline two"]})
        with self.assertRaises(task_package.TaskPackageError):
            self.render_intent(user_intent="   ")

    def test_external_prompt_contains_only_req_and_two_links(self):
        prompt = task_package.build_external_prompt(REQ, SKILL_URL, TASK_URL)
        self.assertEqual(
            prompt,
            "\n".join(
                (
                    f"POSTMAN_REQUEST_ID: {REQ}",
                    f"skill_repository: {SKILL_URL}",
                    f"task_file: {TASK_URL}",
                )
            ),
        )
        self.assertEqual(prompt.splitlines()[0], f"POSTMAN_REQUEST_ID: {REQ}")
        self.assertNotIn("Keep the runtime unchanged", prompt)
        self.assertNotIn("Preserve the user's request", prompt)
        self.assertNotIn("base_commit", prompt)
        self.assertNotIn("\nrepository:", prompt)

    def test_external_prompt_rejects_invalid_or_non_http_links(self):
        with self.assertRaises(task_package.TaskPackageError):
            task_package.build_external_prompt("REQ_20261331T043812Z_4827", SKILL_URL, TASK_URL)
        with self.assertRaises(task_package.TaskPackageError):
            task_package.build_external_prompt(REQ, "javascript:alert(1)", TASK_URL)
        with self.assertRaises(task_package.TaskPackageError):
            task_package.build_external_prompt(REQ, SKILL_URL, "https://example.test/REQ_20260831T043813Z_4827.md")
        with self.assertRaises(task_package.TaskPackageError):
            task_package.build_external_prompt(REQ, SKILL_URL, "https://example.test/task\nleak")


if __name__ == "__main__":
    unittest.main()
