from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

DIRECT_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = DIRECT_DIR / "postman_direct.py"

bootstrap_stub = types.ModuleType("browser_bootstrap")
bootstrap_stub.DEFAULT_CDP_URL = "http://127.0.0.1:9222"
bootstrap_stub.BOOTSTRAP_CDP_UNREACHABLE = "BOOTSTRAP_CDP_UNREACHABLE"

class BrowserBootstrapError(RuntimeError):
    def __init__(self, code, message="x", *, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}

bootstrap_stub.BrowserBootstrapError = BrowserBootstrapError
bootstrap_stub.default_profile_dir = lambda: Path(r"C:\Users\A\AppData\Local\DSH\Postman\browser-profile")
bootstrap_stub.normalize_cdp_url = lambda value: value.rstrip("/")
bootstrap_stub.wait_for_cdp = lambda value, timeout_s=0: {"cdpUrl": value, "webSocketDebuggerUrl": "ws://x"}
bootstrap_stub.discover_chrome_executable = lambda explicit=None: Path("chrome.exe")
bootstrap_stub.start_dedicated_chrome = lambda *args, **kwargs: types.SimpleNamespace(pid=42)

identity_stub = types.ModuleType("request_identity")

def assert_req(value):
    if not isinstance(value, str) or not value.startswith("REQ_") or len(value) != len("REQ_20260902T010203Z_1234"):
        raise ValueError("bad req")
    return value

identity_stub.assert_canonical_request_id = assert_req
identity_stub.expected_artifact_filename = lambda req: f"POSTMAN_{req}_RESULT.zip"
identity_stub.validate_expected_artifact_filename = lambda req, name: name == f"POSTMAN_{req}_RESULT.zip"
identity_stub.request_prompt_key_line = lambda req: f"POSTMAN_REQUEST_ID: {req}"

bridge_stub = types.ModuleType("web_worker_bridge")
bridge_stub.RESULT_DURABLE = "RESULT_DURABLE"
class PlaceholderBridge:
    pass
bridge_stub.WebWorkerBridge = PlaceholderBridge

with patch.dict(sys.modules, {
    "browser_bootstrap": bootstrap_stub,
    "request_identity": identity_stub,
    "web_worker_bridge": bridge_stub,
}):
    spec = importlib.util.spec_from_file_location("postman_direct", MODULE_PATH)
    direct = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = direct
    spec.loader.exec_module(direct)

REQ = "REQ_20260902T010203Z_1234"
REPO = "AndrewVerhoturov1/dsh-workspace"
PUB = "b" * 40
PRE = "a" * 40


class DirectPostmanUnitTests(unittest.TestCase):
    def test_intent_task_is_minimal_and_preserves_text(self):
        task = "Postman, сделай простой калькулятор в древне-японском стиле."
        rendered = direct.render_intent_task(task)
        self.assertEqual(rendered, f"# POSTMAN TASK\n\nuser_intent:\n{task}\n")
        for invented in ("React", "responsive", "division by zero", "framework"):
            self.assertNotIn(invented, rendered)

    def test_external_prompt_binds_all_trusted_metadata(self):
        filename = f"POSTMAN_{REQ}_RESULT.zip"
        prompt = direct.build_external_prompt(
            request_id=REQ,
            task_url=f"https://raw.githubusercontent.com/x/y/{PUB}/{REQ}.md",
            repository=REPO,
            base_commit=PUB,
            expected_filename=filename,
            allowed_paths=["apps", "README.md"],
            forbidden_paths=["settings.yaml"],
        )
        self.assertEqual(prompt.splitlines()[0], f"POSTMAN_REQUEST_ID: {REQ}")
        self.assertIn(f"repository: {REPO}", prompt)
        self.assertIn(f"base_commit: {PUB}", prompt)
        self.assertIn(f"expected_filename: {filename}", prompt)
        self.assertIn(f"<<<POSTMAN_RESULT_BEGIN:{REQ}>>>", prompt)
        self.assertIn(f"<<<POSTMAN_RESULT_END:{REQ}>>>", prompt)

    def test_allowed_paths_exclude_req_files_and_sensitive_roots(self):
        result = direct.derive_allowed_paths([
            ".agents", "README.md", "REQ_20260901T000000Z_0001.md", "settings.yaml", "postman"
        ])
        self.assertIn(".agents", result)
        self.assertIn("README.md", result)
        self.assertIn("postman", result)
        self.assertIn("apps", result)
        self.assertFalse(any(item.startswith("REQ_") for item in result))
        self.assertNotIn("settings.yaml", result)

    def test_forbidden_paths_include_local_sensitive_names(self):
        result = direct.derive_forbidden_paths(["private"])
        self.assertIn("settings.yaml", result)
        self.assertIn("attachments", result)
        self.assertIn("private", result)

    def test_github_publisher_uses_exact_intent_bytes_and_sha_pinned_url(self):
        calls = []
        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            endpoint = command[2]
            if "/git/ref/heads/" in endpoint:
                stdout = json.dumps({"object": {"sha": PRE}})
            elif command[command.index("--method") + 1] == "PUT" if "--method" in command else False:
                stdout = json.dumps({"commit": {"sha": PUB}})
            elif "/contents?ref=" in endpoint:
                stdout = json.dumps([{"name": "postman"}, {"name": "README.md"}])
            else:
                raise AssertionError(command)
            return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

        publisher = direct.GitHubTaskPublisher(repository=REPO, run=fake_run)
        task = "точный пользовательский текст ✅"
        published = publisher.publish(REQ, task)
        self.assertEqual(published.prepublication_commit, PRE)
        self.assertEqual(published.publication_commit, PUB)
        self.assertTrue(published.task_url.endswith(f"/{PUB}/{REQ}.md"))

        put = next((item for item in calls if "--method" in item[0]), None)
        self.assertIsNotNone(put)
        payload = json.loads(put[1]["input"])
        decoded = base64.b64decode(payload["content"]).decode("utf-8")
        self.assertEqual(decoded, direct.render_intent_task(task))
        self.assertEqual(payload["branch"], "main")

    def test_ensure_browser_reuses_existing_cdp_without_launch(self):
        class Boot:
            DEFAULT_CDP_URL = "http://127.0.0.1:9222"
            BOOTSTRAP_CDP_UNREACHABLE = "BOOTSTRAP_CDP_UNREACHABLE"
            BrowserBootstrapError = BrowserBootstrapError
            @staticmethod
            def default_profile_dir(): return Path("profile")
            @staticmethod
            def normalize_cdp_url(value): return value
            @staticmethod
            def wait_for_cdp(value, timeout_s=0): return {"ready": True}
            @staticmethod
            def discover_chrome_executable(explicit=None): raise AssertionError("must not discover")
            @staticmethod
            def start_dedicated_chrome(*args, **kwargs): raise AssertionError("must not launch")
        result = direct.ensure_dedicated_chrome(bootstrap_module=Boot)
        self.assertTrue(result["reused"])
        self.assertFalse(result["launched"])

    def test_ensure_browser_launches_after_cdp_unreachable(self):
        class Boot:
            DEFAULT_CDP_URL = "http://127.0.0.1:9222"
            BOOTSTRAP_CDP_UNREACHABLE = "BOOTSTRAP_CDP_UNREACHABLE"
            BrowserBootstrapError = BrowserBootstrapError
            calls = 0
            @staticmethod
            def default_profile_dir(): return Path("profile")
            @staticmethod
            def normalize_cdp_url(value): return value
            @classmethod
            def wait_for_cdp(cls, value, timeout_s=0):
                cls.calls += 1
                if cls.calls == 1:
                    raise BrowserBootstrapError(cls.BOOTSTRAP_CDP_UNREACHABLE)
                return {"ready": True}
            @staticmethod
            def discover_chrome_executable(explicit=None): return Path("chrome.exe")
            @staticmethod
            def start_dedicated_chrome(*args, **kwargs): return types.SimpleNamespace(pid=99)
        result = direct.ensure_dedicated_chrome(bootstrap_module=Boot)
        self.assertTrue(result["launched"])
        self.assertFalse(result["reused"])
        self.assertEqual(result["pid"], 99)

    def test_direct_run_returns_durable_result_without_applying_zip(self):
        class Publisher:
            def __init__(self, **kwargs): pass
            def publish(self, request_id, task):
                return direct.PublishedTask(
                    request_id,
                    f"https://raw.githubusercontent.com/x/y/{PUB}/{REQ}.md",
                    PRE,
                    PUB,
                    ("postman", "README.md"),
                )

        class Bridge:
            calls = []
            def __init__(self, **kwargs): self.kwargs = kwargs
            def run_request(self, request_id, **kwargs):
                Bridge.calls.append((request_id, kwargs))
                return {
                    "ok": True,
                    "code": "RESULT_DURABLE",
                    "details": {
                        "resultZip": r"C:\result\result.zip",
                        "resultSha256": "c" * 64,
                    },
                }

        with tempfile.TemporaryDirectory() as root:
            runner = direct.DirectPostman(
                direct_root=Path(root) / "direct",
                publisher_factory=Publisher,
                bridge_factory=Bridge,
                ensure_browser=lambda **kwargs: {
                    "launched": True,
                    "reused": False,
                    "cdpUrl": "http://127.0.0.1:9222",
                    "profileDir": "profile",
                },
            )
            result = runner.run(request_id=REQ, task="calculator")
            self.assertTrue(result["ok"])
            self.assertEqual(result["code"], "RESULT_DURABLE")
            self.assertEqual(result["resultZip"], r"C:\result\result.zip")
            self.assertTrue(runner.state_path(REQ).is_file())
            state = json.loads(runner.state_path(REQ).read_text(encoding="utf-8"))
            self.assertEqual(state["state"], "RESULT_DURABLE")
            self.assertEqual(len(Bridge.calls), 1)

    def test_existing_state_blocks_automatic_resend(self):
        with tempfile.TemporaryDirectory() as root:
            runner = direct.DirectPostman(
                direct_root=root,
                publisher_factory=lambda **kwargs: (_ for _ in ()).throw(AssertionError("publisher must not run")),
            )
            runner._write_state(REQ, "TASK_PUBLISHED")
            with self.assertRaises(direct.DirectPostmanError) as ctx:
                runner.run(request_id=REQ, task="x")
            self.assertEqual(ctx.exception.code, "DIRECT_REQUEST_EXISTS")


if __name__ == "__main__":
    unittest.main()
