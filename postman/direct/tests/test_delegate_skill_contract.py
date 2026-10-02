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

    def test_production_entrypoint_and_skill_identity(self):
        self.assertIn("DIRECT_POSTMAN_SKILL_VERSION: 24", self.skill)
        self.assertIn("name: delegate-via-postman", self.skill)
        self.assertIn(r"<current workspace>\postman\direct\postman.ps1", self.skill)
        self.assertIn("delegate-via-postman", self.agents)

    def test_trusted_input_zip_is_runtime_owned(self):
        for invariant in ("Host-authorized descriptors", "не читает local paths",
                          "не строит input ZIP", "manual browser upload", "Runtime handles input ZIP"):
            self.assertIn(invariant, self.skill)

    def test_native_first_in_every_skill_and_image_entrypoint(self):
        names = ("delegate-via-postman", "delegate-via-postman-ask", "postman-leader", "delegate-via-postman-image")
        for name in names:
            text = (ROOT / ".agents" / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("Native ChatGPT attachment is the primary input-file transport.", text)
            self.assertIn("GitHub public staging is fallback-only and requires explicit user approval.", text)
        image = (ROOT / ".agents" / "skills" / names[-1] / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn(r"^\s*@PostmanImage(?:\s|$)", image)
        self.assertIn("postman_send_current_turn()", image)
        self.assertIn("IMAGE_RESULT_DURABLE", image)
        self.assertIn("UNKNOWN", image)
        self.assertIn("delegate-via-postman-image", self.agents)

    def test_exact_current_message_trigger(self):
        pattern = re.compile(r"^\s*@Postman(?:\s|$)")
        for message in ("@Postman сделай X", "   @Postman сделай X"):
            self.assertRegex(message, pattern)
        for message in ("Postman сделай X", "продолжи проект Postman", "@PostmanAsk вопрос"):
            self.assertNotRegex(message, pattern)
        self.assertIn(pattern.pattern, self.skill)
        self.assertIn(pattern.pattern, self.agents)

    def test_trusted_current_turn_route_not_model_copy(self):
        for tool in ("postman_send_current_turn()", "postman_current_turn_status()"):
            self.assertIn(tool, self.skill)
        self.assertIn("TRUSTED_CURRENT_TURN_BOUNDARY_VERSION: 1", self.skill)
        self.assertIn("skill(delegate-via-postman)", self.skill)
        self.assertNotIn("postman_async_send(", self.skill)
        self.assertNotIn("postman_runtime_", self.skill)

    def test_natural_launch_and_terminal_markers(self):
        self.assertIn("50 естественных русских стартовых фраз", self.skill)
        self.assertIn("Полный prompt и SHA сохраняются", self.skill)
        self.assertIn("в новых launch prompts отсутствуют", self.skill)
        for marker in (
            "RESULT_DURABLE",
            "ASSISTANT_COMPLETED_NO_ARTIFACT", "ARTIFACT_REJECTED",
            "POSTMAN_TRANSPORT_FAILED", "resultZip", "assistantText",
            "DIRECT_CHAT_REFERENCE_UNAVAILABLE",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.skill)

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
