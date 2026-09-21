from __future__ import annotations

import base64
import contextlib
import importlib.util
import io
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
bridge_stub.ASSISTANT_COMPLETED_NO_ARTIFACT = "ASSISTANT_COMPLETED_NO_ARTIFACT"
bridge_stub.ARTIFACT_REJECTED = "ARTIFACT_REJECTED"
bridge_stub.POSTMAN_TRANSPORT_FAILED = "POSTMAN_TRANSPORT_FAILED"
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

    def test_external_prompt_is_exactly_req_policy_and_task_link(self):
        filename = f"POSTMAN_{REQ}_RESULT.zip"
        task_url = f"https://raw.githubusercontent.com/x/y/{PUB}/{REQ}.md"
        prompt = direct.build_external_prompt(
            request_id=REQ,
            task_url=task_url,
            repository=REPO,
            base_commit=PRE,
            expected_filename=filename,
            allowed_paths=["apps", "README.md"],
            forbidden_paths=["settings.yaml"],
        )
        self.assertEqual(
            prompt,
            "\n".join(
                (
                    f"POSTMAN_REQUEST_ID: {REQ}",
                    f"task_file: {task_url}",
                )
            ),
        )
        self.assertEqual(2, len(prompt.splitlines()))
        self.assertNotIn("policy:", prompt)
        for forbidden in (
            "repository:",
            "base_commit:",
            "expected_filename:",
            "allowed_paths_json:",
            "forbidden_paths_json:",
            "RESULT_BEGIN",
            "RESULT_END",
        ):
            self.assertNotIn(forbidden, prompt)

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

    def test_github_publisher_uses_snapshot_parent_and_sha_pinned_url(self):
        calls = []
        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            endpoint = command[2]
            if "/git/ref/heads/" in endpoint:
                stdout = json.dumps({"object": {"sha": PRE}})
            elif endpoint.endswith(f"/git/commits/{PUB}"):
                stdout = json.dumps({"parents": [{"sha": PRE}]})
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

    def test_direct_run_uses_prepublication_base_and_self_contained_task(self):
        class Publisher:
            contents = []
            def __init__(self, **kwargs): pass
            def snapshot(self):
                return direct.TaskSnapshot(PRE, ("postman", "README.md"))
            def publish_content(self, request_id, content, *, expected_parent, root_entries):
                self.__class__.contents.append(content)
                if expected_parent != PRE:
                    raise AssertionError(expected_parent)
                return direct.PublishedTask(
                    request_id,
                    f"https://raw.githubusercontent.com/{REPO}/{PUB}/{REQ}.md",
                    PRE,
                    PUB,
                    tuple(root_entries),
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
            Publisher.contents = []
            Bridge.calls = []
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
            result = runner.run(request_id=REQ, task="добавь красную кнопку")
            self.assertTrue(result["ok"])
            self.assertEqual(result["code"], "RESULT_DURABLE")
            self.assertEqual(result["baseCommit"], PRE)
            self.assertEqual(result["taskPublicationCommit"], PUB)
            self.assertEqual(result["resultZip"], r"C:\result\result.zip")

            self.assertEqual(1, len(Publisher.contents))
            task_content = Publisher.contents[0]
            self.assertIn(f"base_commit: {PRE}", task_content)
            self.assertIn(f"expected_filename: POSTMAN_{REQ}_RESULT.zip", task_content)
            self.assertIn("добавь красную кнопку", task_content)
            self.assertIn("allowed_paths_json:", task_content)
            self.assertIn("forbidden_paths_json:", task_content)
            self.assertIn("`manifest.json` необязателен", task_content)
            self.assertIn("каталог `files/` не обязателен", task_content)
            self.assertNotIn('использовать universal `artifact` resultType', task_content)
            self.assertIn("не превращать его в задачу по изменению repository", task_content)
            self.assertNotIn("Реализацию готовить против точного `base_commit`", task_content)
            self.assertIn(f"<<<POSTMAN_RESULT_BEGIN:{REQ}>>>", task_content)

            self.assertEqual(1, len(Bridge.calls))
            bridge_kwargs = Bridge.calls[0][1]
            self.assertEqual(bridge_kwargs["expected_request"]["baseCommit"], PRE)
            self.assertIsNone(bridge_kwargs["conversation_url"])
            self.assertEqual(
                bridge_kwargs["prompt"].splitlines(),
                [
                    f"POSTMAN_REQUEST_ID: {REQ}",
                    f"task_file: https://raw.githubusercontent.com/{REPO}/{PUB}/{REQ}.md",
                ],
            )

            self.assertTrue(runner.state_path(REQ).is_file())
            state = json.loads(runner.state_path(REQ).read_text(encoding="utf-8"))
            self.assertEqual(state["state"], "RESULT_DURABLE")
            self.assertEqual(state["baseCommit"], PRE)
            self.assertEqual(state["taskPublicationCommit"], PUB)

            handoff_path = runner.result_handoff_path(REQ)
            self.assertTrue(handoff_path.is_file())
            handoff = json.loads(handoff_path.read_text(encoding="utf-8"))
            self.assertEqual(handoff["ok"], True)
            self.assertEqual(handoff["code"], "RESULT_DURABLE")
            self.assertEqual(handoff["state"], "RESULT_DURABLE")
            self.assertEqual(handoff["statePath"], str(runner.state_path(REQ)))
            self.assertEqual(handoff["resultHandoffPath"], str(handoff_path.resolve()))
            self.assertEqual(handoff["sha256"], "c" * 64)

    def test_automatic_continuation_resolves_old_req_and_inherits_chain(self):
        new_req = "REQ_20260902T010204Z_1235"
        conversation_url = "https://chatgpt.com/c/existing-chat-123"

        class Publisher:
            def __init__(self, **kwargs): pass
            def snapshot(self): return direct.TaskSnapshot(PRE, ("postman", "README.md"))
            def publish_content(self, request_id, content, *, expected_parent, root_entries):
                return direct.PublishedTask(
                    request_id,
                    f"https://raw.githubusercontent.com/{REPO}/{PUB}/{request_id}.md",
                    PRE,
                    PUB,
                    tuple(root_entries),
                )

        class Bridge:
            calls = []
            def __init__(self, **kwargs): pass
            def run_request(self, request_id, **kwargs):
                self.__class__.calls.append((request_id, kwargs))
                return {
                    "ok": True,
                    "code": "RESULT_DURABLE",
                    "details": {
                        "resultZip": r"C:\result\continued.zip",
                        "resultSha256": "d" * 64,
                        "conversationUrl": conversation_url,
                        "conversationId": "existing-chat-123",
                    },
                }

        reference = types.SimpleNamespace(
            request_id=REQ,
            conversation_url=conversation_url,
            conversation_id="existing-chat-123",
            source="durable_handoff",
            root_request_id="REQ_20260902T010200Z_1200",
            continuation_index=2,
        )
        with tempfile.TemporaryDirectory() as root, patch.object(
            direct.chat_reference, "resolve_chat_reference", return_value=reference
        ):
            Bridge.calls = []
            runner = direct.DirectPostman(
                direct_root=Path(root) / "direct",
                publisher_factory=Publisher,
                bridge_factory=Bridge,
                ensure_browser=lambda **kwargs: {"cdpUrl": "http://127.0.0.1:9222"},
            )
            result = runner.run(
                request_id=new_req,
                task="continue",
                chat_request_id=REQ,
                automatic_continuation=True,
            )
            self.assertEqual(Bridge.calls[0][1]["conversation_url"], conversation_url)
            self.assertEqual(result["continuedFromRequestId"], REQ)
            self.assertEqual(result["rootRequestId"], "REQ_20260902T010200Z_1200")
            self.assertEqual(result["continuationIndex"], 3)
            self.assertEqual(result["conversationUrl"], conversation_url)
            self.assertEqual(result["conversationId"], "existing-chat-123")

    def test_manual_chat_at_continuation_limit_is_allowed(self):
        new_req = "REQ_20260902T010205Z_1236"
        conversation_url = "https://chatgpt.com/c/manual-chat"

        class Publisher:
            def __init__(self, **kwargs): pass
            def snapshot(self): return direct.TaskSnapshot(PRE, ("postman", "README.md"))
            def publish_content(self, request_id, content, *, expected_parent, root_entries):
                return direct.PublishedTask(
                    request_id,
                    f"https://raw.githubusercontent.com/{REPO}/{PUB}/{request_id}.md",
                    PRE,
                    PUB,
                    tuple(root_entries),
                )

        class Bridge:
            def __init__(self, **kwargs): pass
            def run_request(self, request_id, **kwargs):
                return {
                    "ok": True,
                    "code": "RESULT_DURABLE",
                    "details": {
                        "resultZip": r"C:\result\manual.zip",
                        "resultSha256": "a" * 64,
                        "conversationUrl": conversation_url,
                        "conversationId": "manual-chat",
                    },
                }

        previous = types.SimpleNamespace(
            request_id=REQ,
            conversation_url=conversation_url,
            conversation_id="manual-chat",
            root_request_id="REQ_20260902T010200Z_1200",
            continuation_index=3,
            source="direct_state",
        )
        with tempfile.TemporaryDirectory() as root, patch.object(
            direct.chat_reference, "resolve_chat_reference", return_value=previous
        ):
            runner = direct.DirectPostman(
                direct_root=Path(root) / "direct",
                publisher_factory=Publisher,
                bridge_factory=Bridge,
                ensure_browser=lambda **kwargs: {"cdpUrl": "http://127.0.0.1:9222"},
            )
            result = runner.run(request_id=new_req, task="manual intent", chat_request_id=REQ)

        self.assertNotIn("continuedFromRequestId", result)
        self.assertEqual(result["rootRequestId"], new_req)
        self.assertEqual(result["continuationIndex"], 0)
        self.assertEqual(result["conversationUrl"], conversation_url)

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

    def test_no_artifact_terminal_is_returned_to_local_agent_and_can_continue_same_chat(self):
        conversation_url = "https://chatgpt.com/c/no-artifact-chat"

        class Publisher:
            def __init__(self, **kwargs): pass
            def snapshot(self): return direct.TaskSnapshot(PRE, ("postman", "README.md"))
            def publish_content(self, request_id, content, *, expected_parent, root_entries):
                return direct.PublishedTask(
                    request_id,
                    f"https://raw.githubusercontent.com/{REPO}/{PUB}/{request_id}.md",
                    PRE,
                    PUB,
                    tuple(root_entries),
                )

        class Bridge:
            def __init__(self, **kwargs): pass
            def run_request(self, request_id, **kwargs):
                return {
                    "ok": True,
                    "code": "ASSISTANT_COMPLETED_NO_ARTIFACT",
                    "details": {
                        "assistantText": "ZIP ещё не собран.",
                        "assistantTextSha256": "e" * 64,
                        "assistantIndex": 7,
                        "conversationUrl": conversation_url,
                        "conversationId": "no-artifact-chat",
                    },
                }

        with tempfile.TemporaryDirectory() as root:
            runner = direct.DirectPostman(
                direct_root=Path(root) / "direct",
                publisher_factory=Publisher,
                bridge_factory=Bridge,
                ensure_browser=lambda **kwargs: {"cdpUrl": "http://127.0.0.1:9222"},
            )
            result = runner.run(request_id=REQ, task="long task")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "ASSISTANT_COMPLETED_NO_ARTIFACT")
            self.assertEqual(result["state"], "ASSISTANT_COMPLETED_NO_ARTIFACT")
            self.assertEqual(result["assistantText"], "ZIP ещё не собран.")
            self.assertEqual(result["conversationUrl"], conversation_url)
            self.assertEqual(result["rootRequestId"], REQ)
            self.assertEqual(result["continuationIndex"], 0)
            self.assertFalse(runner.result_handoff_path(REQ).exists())

            state = json.loads(runner.state_path(REQ).read_text(encoding="utf-8"))
            self.assertEqual(state["state"], "ASSISTANT_COMPLETED_NO_ARTIFACT")
            self.assertEqual(state["code"], "ASSISTANT_COMPLETED_NO_ARTIFACT")
            self.assertEqual(state["conversationUrl"], conversation_url)

    def test_rejected_artifact_terminal_exposes_exact_validation_reason(self):
        conversation_url = "https://chatgpt.com/c/rejected-chat"

        class Publisher:
            def __init__(self, **kwargs): pass
            def snapshot(self): return direct.TaskSnapshot(PRE, ("postman", "README.md"))
            def publish_content(self, request_id, content, *, expected_parent, root_entries):
                return direct.PublishedTask(
                    request_id,
                    f"https://raw.githubusercontent.com/{REPO}/{PUB}/{request_id}.md",
                    PRE,
                    PUB,
                    tuple(root_entries),
                )

        class Bridge:
            def __init__(self, **kwargs): pass
            def run_request(self, request_id, **kwargs):
                return {
                    "ok": True,
                    "code": "ARTIFACT_REJECTED",
                    "details": {
                        "assistantText": "Готово.",
                        "assistantTextSha256": "f" * 64,
                        "assistantIndex": 8,
                        "conversationUrl": conversation_url,
                        "conversationId": "rejected-chat",
                        "validationCode": "ARTIFACT_BAD_ZIP",
                        "validationMessage": "ZIP is malformed or cannot be read safely",
                        "validationDetails": {"reason": "eocd"},
                    },
                }

        with tempfile.TemporaryDirectory() as root:
            runner = direct.DirectPostman(
                direct_root=Path(root) / "direct",
                publisher_factory=Publisher,
                bridge_factory=Bridge,
                ensure_browser=lambda **kwargs: {"cdpUrl": "http://127.0.0.1:9222"},
            )
            result = runner.run(request_id=REQ, task="long task")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "ARTIFACT_REJECTED")
            self.assertEqual(result["validationCode"], "ARTIFACT_BAD_ZIP")
            self.assertIn("malformed", result["validationMessage"])
            self.assertEqual(result["validationDetails"], {"reason": "eocd"})
            self.assertEqual(result["assistantIndex"], 8)
            self.assertNotIn("assistantTurnIndex", result)
            self.assertFalse(runner.result_handoff_path(REQ).exists())


    def test_cli_transport_failure_json_preserves_exact_request_and_nonzero_exit(self):
        failure_details = {
            "transportCode": "BRIDGE_PIPELINE_FAILED",
            "transportMessage": "bridge lost connection",
            "details": {"phase": "observer", "attempt": 1},
        }
        with patch.object(
            direct.DirectPostman,
            "run",
            side_effect=direct.DirectPostmanError(
                direct.POSTMAN_TRANSPORT_FAILED,
                failure_details["transportMessage"],
                details=failure_details,
            ),
        ), contextlib.redirect_stdout(io.StringIO()) as stdout:
            exit_code = direct.main(["--request-id", REQ, "--task", "intent"])

        self.assertEqual(exit_code, 2)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], direct.POSTMAN_TRANSPORT_FAILED)
        self.assertEqual(payload["requestId"], REQ)
        self.assertEqual(payload["transportCode"], failure_details["transportCode"])
        self.assertEqual(payload["transportMessage"], failure_details["transportMessage"])
        self.assertEqual(payload["details"], failure_details["details"])

    def test_cli_prebridge_failure_becomes_correlated_transport_failure(self):
        failure_code = "DIRECT_BROWSER_FAILED"
        failure_message = "dedicated Chrome failed to become ready"
        failure_details = {"phase": "cdp", "cdpUrl": "http://127.0.0.1:9222"}
        with patch.object(
            direct.DirectPostman,
            "run",
            side_effect=direct.DirectPostmanError(
                failure_code,
                failure_message,
                details=failure_details,
            ),
        ), contextlib.redirect_stdout(io.StringIO()) as stdout:
            exit_code = direct.main(["--request-id", REQ, "--task", "intent"])

        self.assertEqual(exit_code, 2)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], direct.POSTMAN_TRANSPORT_FAILED)
        self.assertEqual(payload["requestId"], REQ)
        self.assertEqual(payload["transportCode"], failure_code)
        self.assertEqual(payload["transportMessage"], failure_message)
        self.assertEqual(payload["details"], failure_details)

    def test_continuation_limit_stops_before_publication_or_send(self):
        previous = types.SimpleNamespace(
            request_id=REQ,
            conversation_url="https://chatgpt.com/c/limit-chat",
            conversation_id="limit-chat",
            root_request_id="REQ_20260902T010200Z_1200",
            continuation_index=3,
            source="direct_state",
        )
        with tempfile.TemporaryDirectory() as root, patch.object(
            direct.chat_reference, "resolve_chat_reference", return_value=previous
        ):
            runner = direct.DirectPostman(
                direct_root=Path(root) / "direct",
                publisher_factory=lambda **kwargs: (_ for _ in ()).throw(AssertionError("publisher must not run")),
                ensure_browser=lambda **kwargs: (_ for _ in ()).throw(AssertionError("browser must not start")),
            )
            with self.assertRaises(direct.DirectPostmanError) as ctx:
                runner.run(
                    request_id="REQ_20260902T010204Z_1235",
                    task="continue",
                    chat_request_id=REQ,
                    automatic_continuation=True,
                )
            self.assertEqual(ctx.exception.code, "DIRECT_CONTINUATION_LIMIT_REACHED")


if __name__ == "__main__":
    unittest.main()
