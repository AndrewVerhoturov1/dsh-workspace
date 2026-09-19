from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
LAUNCHER = ROOT / "tools" / "deepseek-harness-launcher"
PLUGIN = ROOT / "plugins" / "dsh-restart-web" / "lib" / "index.js"
WORKFLOW = ROOT / "docs" / "workflow" / "PREVIEW_BRANCH_WORKFLOW.md"


class PreviewLauncherContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.common = (LAUNCHER / "DSH-Common.ps1").read_text(encoding="utf-8")
        cls.preview_vbs = (LAUNCHER / "Launch-DSH-Preview.vbs").read_text(encoding="utf-8")
        cls.prepare = (LAUNCHER / "Prepare-DSH-Preview.ps1").read_text(encoding="utf-8")
        cls.controller = (LAUNCHER / "dsh-process-controller.js").read_text(encoding="utf-8")
        cls.plugin = PLUGIN.read_text(encoding="utf-8")
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_main_defaults_remain_4173_and_main_worktree(self):
        self.assertIn(r"-DefaultValue 'C:\Users\andre\.dsh'", self.common)
        self.assertIn("-DefaultValue '4173'", self.common)
        self.assertIn("-DefaultValue 'DeepSeekHarnessLauncher.StartStop'", self.common)

    def test_common_accepts_isolated_launcher_environment(self):
        for marker in (
            "DSH_WORKING_DIRECTORY",
            "DSH_PROFILE",
            "DSH_PORT",
            "DSH_LAUNCHER_ROOT",
            "DSH_PROCESS_CONTROLLER",
            "DSH_LAUNCHER_MUTEX",
            "DSH_LAUNCHER_TITLE",
            "DSH_REQUIRE_PROFILE_INSTALL",
        ):
            self.assertIn(marker, self.common)
        self.assertIn("Assert-DshWorkspaceReady", self.common)
        self.assertIn("Prepare-DSH-Preview.ps1", self.common)

    def test_preview_launcher_is_exactly_isolated(self):
        expected = {
            'DSH_WORKING_DIRECTORY': r'C:\Users\andre\.dsh-preview',
            'DSH_PROFILE': 'web',
            'DSH_PORT': '4174',
            'DSH_LAUNCHER_MUTEX': 'DeepSeekHarnessPreviewLauncher.StartStop',
            'DSH_LAUNCHER_TITLE': 'DeepSeek Harness Preview',
            'DSH_REQUIRE_PROFILE_INSTALL': '1',
        }
        for name, value in expected.items():
            self.assertIn(f'env("{name}") = "{value}"', self.preview_vbs)
        self.assertIn('env("DSH_LAUNCHER_ROOT") = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\DeepSeekHarnessLauncher-Preview"', self.preview_vbs)
        self.assertIn('env("DSH_PROCESS_CONTROLLER") = root & "\\dsh-process-controller.js"', self.preview_vbs)
        self.assertIn('env("DSH_RESTART_HELPER") = root & "\\Web-Restart.vbs"', self.preview_vbs)

    def test_preview_batch_wrappers_target_preview_vbs(self):
        actions = {
            "start-dsh-preview.bat": "start",
            "stop-dsh-preview.bat": "stop",
            "restart-dsh-preview.bat": "restart",
        }
        for filename, action in actions.items():
            text = (LAUNCHER / filename).read_text(encoding="utf-8")
            self.assertIn('Launch-DSH-Preview.vbs', text)
            self.assertIn(action, text)

    def test_controller_propagates_runtime_identity_to_dsh_child(self):
        for marker in (
            "DSH_WORKING_DIRECTORY: config.workingDirectory",
            "DSH_PROFILE: config.profile",
            "DSH_PORT: String(config.port)",
            "DSH_LAUNCHER_ROOT: config.launcherRoot",
            "DSH_PROCESS_CONTROLLER: path.resolve(__filename)",
            "DSH_RESTART_HELPER: process.env.DSH_RESTART_HELPER",
        ):
            self.assertIn(marker, self.controller)

    def test_restart_plugin_uses_runtime_port_and_profile(self):
        self.assertIn("Number(process.env.DSH_PORT || 4173)", self.plugin)
        self.assertIn("process.env.DSH_PROFILE || 'web'", self.plugin)
        self.assertIn("process.env.DSH_WORKING_DIRECTORY", self.plugin)
        self.assertIn("process.env.DSH_LAUNCHER_ROOT", self.plugin)
        self.assertIn("process.env.DSH_PROCESS_CONTROLLER", self.plugin)
        self.assertIn("process.env.DSH_RESTART_HELPER", self.plugin)

    def test_prepare_installs_dependencies_and_never_overwrites_local_config(self):
        self.assertIn("'run' 'install:production'", self.prepare)
        self.assertIn("[switch]$SeedLocalConfig", self.prepare)
        for name in ("settings.yaml", ".credentials.yaml", "codex-oauth.json"):
            self.assertIn(name, self.prepare)
        self.assertIn("if (Test-Path -LiteralPath $target)", self.prepare)
        for forbidden in ("reset --hard", "git clean", "git stash", "push --force", "Remove-Item"):
            self.assertNotIn(forbidden, self.prepare)

    def test_prepare_normalizes_single_line_git_output_before_trim(self):
        self.assertIn("function Get-GitSingleLine", self.prepare)
        self.assertIn("$lines = @(Invoke-Git -RepoRoot $RepoRoot -Arguments $Arguments)", self.prepare)
        self.assertIn("if ($lines.Count -ne 1)", self.prepare)
        self.assertIn("return ([string]$lines[0]).Trim()", self.prepare)
        self.assertIn("$actualTop = Get-GitSingleLine", self.prepare)
        self.assertIn("$branch = Get-GitSingleLine", self.prepare)
        self.assertNotIn(")[0].Trim()", self.prepare)

    def test_preview_workflow_documents_port_and_launcher(self):
        self.assertIn("PREVIEW_HARNESS_LAUNCHER_VERSION: 1", self.workflow)
        self.assertIn("http://127.0.0.1:4174/", self.workflow)
        self.assertIn("start-dsh-preview.bat", self.workflow)
        self.assertIn("Prepare-DSH-Preview.ps1", self.workflow)


if __name__ == "__main__":
    unittest.main()
