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
        self.assertIn("DIRECT_POSTMAN_SKILL_VERSION: 4", self.skill)
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
            "## 16. Canonical deterministic applicator",
            "## 20. Критические инварианты",
        ):
            self.assertIn(marker, self.skill)

    def test_canonical_at_postman_trigger_and_legacy_compatibility(self):
        self.assertIn("@Postman <user intent>", self.skill)
        self.assertRegex(self.skill, r"(?i)канонический и предпочтительный")
        for legacy_trigger in ("Postman, ...", "Через Postman ...", "Используй Postman ..."):
            self.assertIn(legacy_trigger, self.skill)

    def test_at_postman_requires_skill_before_implementation(self):
        self.assertIn("skill(delegate-via-postman)", self.skill)
        self.assertIn(
            "До загрузки этого skill Luna не должна выполнять implementation-действия",
            self.skill,
        )
        self.assertIn("сначала загрузить `delegate-via-postman`", self.agents)
        self.assertIn("task-specific implementation-действия", self.agents)
        self.assertIn("обходить skill через glob", self.agents)

    def test_at_postman_payload_strips_only_transport_marker(self):
        self.assertIn(
            "Удалить можно только префикс `@Postman` и окружающий его пробел.",
            self.skill,
        )
        self.assertIn("payload для Ч1 должен быть", self.skill)
        self.assertIn("\nсделай калькулятор\n", self.skill)

    def test_at_postman_is_fail_closed_when_skill_unavailable(self):
        for document in (self.skill, self.agents):
            self.assertIn("fail-closed", document)
            self.assertIn("STOP", document)
            self.assertRegex(document, r"(?i)(отсутствует|недоступен|не загружается)")

    def test_fast_integration_path_is_explicit(self):
        self.assertIn(r"C:\Users\andre\.dsh\postman\direct\integrate_result.ps1", self.skill)
        self.assertIn("READY_FOR_TEST", self.skill)
        self.assertIn("RESULT_DIAGNOSTIC_ONLY", self.skill)
        self.assertIn("exact bytes", self.skill)
        self.assertIn("foreground-вызов", self.skill)

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
        self.assertEqual("2.9.0", parsed["yamlVersion"])
        self.assertEqual("delegate-via-postman", parsed["name"])
        self.assertIsInstance(parsed["description"], str)
        self.assertTrue(parsed["description"].strip())
        self.assertTrue(parsed["modelInvocable"])

if __name__ == "__main__":
    unittest.main()
