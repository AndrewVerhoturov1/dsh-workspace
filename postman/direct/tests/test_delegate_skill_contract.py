import json
from pathlib import Path
import re
import shutil
import subprocess
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
        self.assertIn("DIRECT_POSTMAN_SKILL_VERSION: 15", self.skill)
        self.assertIn("$workspace = (Get-Location).Path", self.skill)
        self.assertIn("$bridge = Join-Path $workspace 'postman\\direct\\postman.ps1'", self.skill)
        self.assertNotIn(r"C:\Users\andre\.dsh\postman\direct\postman.ps1", self.skill)

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
            "## 9. Разбор JSON и минимальный transport gate",
            "## 13. Не начинать Git integration в normal flow",
            "## 14. Legacy/manual explicit finalization",
            "## 20. Критические инварианты",
        ):
            self.assertIn(marker, self.skill)

    def test_normal_path_stops_after_durable_handoff(self):
        section = self.skill.split("## 0. Золотой путь", 1)[1].split(
            "## 1. Жёстко запрещённые обходы", 1
        )[0]
        for marker in ("RESULT_DURABLE", "resultHandoffPath", "request_id", "result_handoff_json", "STOP"):
            self.assertIn(marker, section)
        self.assertNotIn("resume_request.ps1", section)
        self.assertIn("normal flow не вызывает resume/PREPARE/TEST/PUBLISH", section)

    def test_exclusive_at_postman_trigger_contract(self):
        trigger_examples = (
            "@Postman сделай X",
            "   @Postman сделай X",
        )
        non_trigger_examples = (
            "Postman сделай X",
            "Postman, сделай X",
            "Через Postman сделай X",
            "Используй Postman",
            "продолжи проект Postman",
            "реализуй WP-020",
            "исправь код Postman",
            "доработай Direct Postman",
        )

        trigger_pattern = re.compile(r"^\s*@Postman(?:\s|$)")
        for message in trigger_examples:
            self.assertRegex(message, trigger_pattern)
        for message in non_trigger_examples:
            self.assertNotRegex(message, trigger_pattern)

        trigger_section = self.skill.split("## 2. Trigger", 1)[1].split(
            "## 3. Разделение ролей", 1
        )[0]
        self.assertIn("Postman по умолчанию OFF", trigger_section)
        self.assertIn(r"^\s*@Postman(?:\s|$)", trigger_section)
        for message in non_trigger_examples:
            self.assertIn(message, trigger_section)
        self.assertNotIn("Legacy-compatible triggers", trigger_section)
        self.assertNotIn("Для совместимости остаются", trigger_section)

    def test_existing_chat_continuation_contract(self):
        for marker in (
            "@Postman --chat REQ_20260917T101323Z_7008 <intent>",
            "-ChatRequestId $chatRequestId",
            "DIRECT_CHAT_REFERENCE_UNAVAILABLE",
            "новый canonical REQ",
            "UI search fallback отсутствует",
        ):
            self.assertIn(marker, self.skill)
        self.assertIn("payload = сравни это с новой версией", self.skill)

    def test_postman_permission_is_current_message_only(self):
        self.assertIn("Postman permission is current-message-only", self.skill)
        self.assertIn("Разрешение действует только для этого сообщения", self.agents)
        self.assertIn("не наследуется из предыдущих сообщений", self.agents)

        trigger_pattern = re.compile(r"^\s*@Postman(?:\s|$)")
        previous_message = "@Postman сделай X"
        next_message = "продолжи проект Postman"
        self.assertRegex(previous_message, trigger_pattern)
        self.assertNotRegex(next_message, trigger_pattern)

    def test_at_postman_requires_skill_before_task_specific_actions(self):
        self.assertIn("skill(delegate-via-postman)", self.skill)
        self.assertIn(
            "До загрузки этого skill Luna не должна выполнять task-specific действия",
            self.skill,
        )
        self.assertIn("сначала загрузить `delegate-via-postman`", self.agents)
        self.assertIn("до любого task-specific действия", self.agents)
        self.assertIn("обходить skill через glob", self.agents)

    def test_at_postman_payload_strips_only_transport_marker_and_is_verbatim(self):
        self.assertIn(
            "Удалить можно только точный transport marker `@Postman`",
            self.skill,
        )
        self.assertIn("передавать в `-Task` verbatim", self.skill)
        self.assertIn("НЕ добавляет предыдущий контекст", self.skill)
        self.assertIn("Оркестратор отвечает", self.skill)
        self.assertNotIn("разрешено добавить только минимальные факты из предыдущего контекста", self.skill)

    def test_normal_l1_role_is_transport_only(self):
        section = self.skill.split("### Л1 — local transport agent", 1)[1].split(
            "## 4. Intent preservation", 1
        )[0]
        for marker in ("canonical REQ", "minimal terminal transport gate", "optional Result Workspace registration", "STOP"):
            self.assertIn(marker, section)
        for forbidden in ("безопасное внедрение результата", "локальную проверку"):
            self.assertNotIn(forbidden, section)
        self.assertIn("не начинает Git/PR integration", section)
        self.assertIn("не интерпретирует содержимое ответа Ч1", section)

    def test_at_postman_is_fail_closed_when_skill_unavailable(self):
        for document in (self.skill, self.agents):
            self.assertIn("fail-closed", document)
            self.assertIn("STOP", document)
            self.assertRegex(document, r"(?i)(отсутствует|недоступен|не загружается)")

    def test_fast_integration_path_is_explicit(self):
        self.assertIn(r"C:\Users\andre\.dsh\postman\direct\integrate_result.ps1", self.skill)
        self.assertIn("READY_FOR_TEST", self.skill)
        self.assertIn("RESULT_DIAGNOSTIC_ONLY", self.skill)
        self.assertIn("foreground-вызов", self.skill)

    def test_link_only_prompt_and_task_manifest_contract(self):
        self.assertIn("Канонический prompt Ч1 состоит ровно из двух строк", self.skill)
        for marker in ("POSTMAN_REQUEST_ID:", "task_file:", "taskPublicationCommit"):
            self.assertIn(marker, self.skill)
        prompt_section = self.skill.split("Канонический prompt Ч1", 1)[1].split("## 9.", 1)[0]
        self.assertNotIn("policy: <policy link>", prompt_section)
        self.assertIn("self-contained", prompt_section)
        for metadata in ("repository", "base_commit", "expected_filename", "allowed_paths_json", "forbidden_paths_json"):
            self.assertIn(metadata, self.skill)
        self.assertIn("В prompt не должны находиться", self.skill)

    def test_wp018a_storage_and_quiet_contract(self):
        self.assertIn(r"D:\Downloads_dsh_auto", self.skill)
        self.assertIn("DSH_POSTMAN_RESULT_ROOT", self.skill)
        self.assertIn("DIRECT_RESULT_ROOT_UNAVAILABLE", self.skill)
        normal = self.skill.split("## 8. Единственный production-вызов", 1)[1].split(
            "## 9. Разбор JSON и минимальный transport gate", 1
        )[0]
        self.assertIn("$jsonText = & $bridge", normal)
        self.assertNotIn("$jsonText = & pwsh.exe", normal)

    def test_luna_does_not_write_result_root_before_bridge(self):
        normal = self.skill.split("## 8. Единственный production-вызов", 1)[1].split(
            "## 9. Разбор JSON и минимальный transport gate", 1
        )[0]
        for forbidden in ("New-Item", "Set-Content", "Out-File", "Remove-Item", "write-probe"):
            self.assertNotIn(forbidden, normal)
        self.assertIn("Luna-side normal invocation НЕ выполняет", self.skill)
        self.assertIn("Result-root creation и write-probe полностью принадлежат", self.skill)
        self.assertIn("DIRECT_RESULT_ROOT_UNAVAILABLE", self.skill)

    def test_production_invocation_is_direct_bridge_call(self):
        normal = self.skill.split("## 8. Единственный production-вызов", 1)[1].split(
            "## 9. Разбор JSON и минимальный transport gate", 1
        )[0]
        self.assertEqual(normal.count("$jsonText = & $bridge"), 2)
        self.assertIn("$jsonText = & $bridge `", normal)
        self.assertNotIn("$jsonText = & pwsh.exe", normal)
        self.assertLess(normal.index("$bridge"), normal.index("$jsonText = & $bridge"))

    def test_tool_level_spawn_failure_is_fail_closed(self):
        self.assertIn("spawn EPERM", self.skill)
        self.assertIn("POSTMAN_INVOCATION_NOT_STARTED", self.skill)
        self.assertIn("Send не происходил", self.skill)
        self.assertIn("tool-level spawn failure не разрешает recovery через старые request states", self.agents)
        self.assertIn("запрещено читать старые `REQ_*.json`", self.skill)
        self.assertIn("latest request", self.skill)
        self.assertIn("вызывать `job_list`", self.skill)
        self.assertIn("не повторять invocation", self.skill)

    def test_unified_resume_finalization_contract(self):
        self.assertIn(r"C:\Users\andre\.dsh\postman\direct\resume_request.ps1", self.skill)
        self.assertIn("resume_request.ps1", self.agents)
        for code in ("READY_FOR_TEST", "TEST_PASSED", "PUBLISHED"):
            self.assertIn(code, self.skill)
        self.assertIn("PREPARE/TEST/PUBLISH", self.skill)
        self.assertIn("legacy/manual explicit finalization", self.agents)
        section = self.skill.split("## 14. Legacy/manual explicit finalization", 1)[1].split(
            "## 15. Что normal `@Postman` НЕ делает после RESULT_DURABLE", 1
        )[0]
        self.assertIn("-TestScript", section)
        self.assertIn("-TestSpec", section)
        self.assertIn("НЕ вызывает", section)
        self.assertNotIn("-TestCommand @(", section)
        self.assertIn("запрещены `python -c`", section)
        self.assertIn("не являются", self.agents)

    def test_durable_handoff_contract(self):
        self.assertIn(r"C:\Users\andre\AppData\Local\DSH\Postman\direct\results\<REQ>.json", self.skill)
        self.assertIn("resultHandoffPath", self.skill)
        self.assertIn("request_id=<exact REQ>", self.skill)
        self.assertIn("result_handoff_json", self.skill)
        self.assertIn("receipt.requestId == request_id", self.skill)
        self.assertIn("не распаковывать и не анализировать ZIP повторно", self.skill)
        self.assertIn("не запускать resume", self.skill)
        self.assertIn("не создавать второй REQ", self.skill)
        self.assertIn("postman_result_workspace_register", self.skill)
        self.assertIn("presentation convenience", self.skill)

    def test_manual_changed_files_and_normal_result_link_contract(self):
        self.assertIn(
            "Кликабельные изменённые файлы только при explicit manual PUBLISHED finalization",
            self.skill,
        )
        manual = self.skill.split(
            "### Кликабельные изменённые файлы только при explicit manual PUBLISHED finalization", 1
        )[1].split("## 20. Критические инварианты", 1)[0]
        for marker in ("Markdown inline code", "changedFiles", "published.worktree"):
            self.assertIn(marker, manual)
        self.assertIn("не использовать bare path, `file://`", manual)
        self.assertIn("exact durable `resultZip`/`resultDirectory`", self.agents)
        self.assertIn("only to explicit manual `PUBLISHED` finalization", self.agents)

    def test_normal_report_is_minimal_and_does_not_expose_handoff_by_default(self):
        section = self.skill.split("## 19. Финальный отчёт", 1)[1].split(
            "### Кликабельные изменённые файлы только при explicit manual PUBLISHED finalization", 1
        )[0]
        self.assertIn("exact resultZip", section)
        self.assertIn("Workspace title/id", section)
        self.assertNotIn("\nresultHandoffPath\n", section)
        self.assertIn("не показывать без диагностической необходимости", section)

    def test_manual_finalization_uses_argv_safe_test_input(self):
        section = self.skill.split("## 14. Legacy/manual explicit finalization", 1)[1].split(
            "## 15. Что normal `@Postman` НЕ делает после RESULT_DURABLE", 1
        )[0]
        self.assertIn("-TestScript", section)
        self.assertIn("-TestSpec", section)
        self.assertIn("`-TestCommand` остаётся legacy", section)
        self.assertIn("запрещены `python -c`", section)
        self.assertIn("TestScript", self.agents)

    def test_normal_smoke_is_forbidden(self):
        self.assertIn("BrowserSmoke не является normal preflight", self.skill)
        self.assertIn("Smoke не является частью обычного golden path", self.skill)

    def test_failure_is_fail_closed(self):
        self.assertIn("Не создавать автоматически второй REQ", self.skill)
        self.assertIn("Новая отправка возможна только после нового пользовательского сообщения с exact `@Postman` trigger", self.skill)

    def test_agents_global_invariant(self):
        self.assertIn(
            r"POSTMAN_PRODUCTION_ENTRYPOINT: <current workspace>\postman\direct\postman.ps1",
            self.agents,
        )
        self.assertIn("postman_async_send", self.agents)
        self.assertIn("считать его устаревшим", self.agents)

    def test_frontmatter_parses_with_dsh_yaml_parser(self):
        npm = shutil.which("npm.cmd") or shutil.which("npm")
        node = shutil.which("node")
        self.assertIsNotNone(npm, "npm is required to locate the DSH runtime")
        self.assertIsNotNone(node, "node is required to run the DSH YAML parser")

        npm_root = subprocess.run(
            [npm, "root", "-g"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout.strip()
        dsh_root = Path(npm_root) / "@deepseek-ai" / "dsh"
        self.assertTrue(
            dsh_root.is_dir(),
            f"installed DSH runtime was not found at {dsh_root}",
        )

        parser_script = r"""
const fs = require("node:fs");
const { parse } = require("yaml");
const yamlPackage = require("yaml/package.json");

const skillPath = process.argv[1];
const source = fs.readFileSync(skillPath, "utf8");
const lines = source.split(/\r?\n/);
if (lines[0] !== "---") throw new Error("missing frontmatter opening delimiter");
const closing = lines.indexOf("---", 1);
if (closing < 0) throw new Error("missing frontmatter closing delimiter");

const frontmatter = parse(lines.slice(1, closing).join("\n"));
if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
  throw new Error("frontmatter must be a mapping");
}

process.stdout.write(JSON.stringify({
  yamlVersion: yamlPackage.version,
  name: frontmatter.name,
  description: frontmatter.description,
  modelInvocable: frontmatter["disable-model-invocation"] !== true,
}));
"""
        result = subprocess.run(
            [node, "-e", parser_script, str(SKILL)],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=dsh_root,
        )
        parsed = json.loads(result.stdout)
        self.assertIn(parsed["yamlVersion"], {"2.9.0", "2.9.1"})
        self.assertEqual("delegate-via-postman", parsed["name"])
        self.assertIsInstance(parsed["description"], str)
        self.assertTrue(parsed["description"].strip())
        self.assertTrue(parsed["modelInvocable"])

if __name__ == "__main__":
    unittest.main()
