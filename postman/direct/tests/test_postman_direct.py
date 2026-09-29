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
bridge_stub.IMAGE_TURN_COMPLETED = "IMAGE_TURN_COMPLETED"
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
    def test_image_mode_uses_one_req_and_packages_only_after_preparatory_intent(self):
        intent = "Создай ровно одно изображение: рыжий спаниэль.\nСветлый фон и мягкий свет."
        class Publisher:
            contents = []
            def __init__(self, **kwargs): pass
            def snapshot(self): return direct.TaskSnapshot(PRE, ("README.md",))
            def publish_content(self, request_id, content, *, expected_parent, root_entries):
                self.contents.append(content)
                return direct.PublishedTask(request_id, f"https://example.test/{request_id}.md",
                                             expected_parent, PUB, tuple(root_entries))
        class Bridge:
            calls = []
            def __init__(self, **kwargs): pass
            def run_request(self, request_id, **kwargs):
                self.calls.append((request_id, kwargs))
                return {"ok": True, "code": "RESULT_DURABLE", "details": {
                    "requestId": request_id, "conversationUrl": "https://chatgpt.com/c/abc",
                    "conversationId": "abc", "resultZip": str(zip_path), "resultSha256": "c" * 64}}
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "results" / REQ / "result.zip"
            zip_path.parent.mkdir(parents=True)
            zip_path.write_bytes(b"fake")
            (zip_path.parent / "validation.json").write_text(json.dumps({
                "ok": True, "sha256": "c" * 64, "inventory": [{"path": "image.png", "kind": "file"}]}), encoding="utf-8")
            runner = direct.DirectPostman(branch="preview", direct_root=Path(tmp) / "direct",
                result_root=Path(tmp) / "results", publisher_factory=Publisher,
                bridge_factory=Bridge, ensure_browser=lambda **_: {"cdpUrl": "http://127.0.0.1:9222"})
            Bridge.calls = []
            Publisher.contents = []
            image = {"path": str(Path(tmp) / "results" / REQ / "image.png"), "format": "PNG", "sha256": "d" * 64,
                     "bytes": 123, "width": 20, "height": 30, "mime": "image/png", "sourceEntry": "image.png"}
            image_path = Path(image["path"])
            image_path.write_bytes(b"x" * 123)
            with patch.object(direct.image_result, "extract_validated_image", return_value=image) as extract, \
                 patch.object(direct.durable_handoff, "validate_image_terminal", side_effect=lambda terminal, **_: terminal):
                terminal = runner.run(request_id=REQ, task=intent, image_mode=True)
            self.assertEqual(terminal["code"], "IMAGE_RESULT_DURABLE")
            self.assertNotIn("secondRequestId", terminal)
            self.assertEqual(terminal["requestId"], REQ)
            self.assertEqual(terminal["resultImage"], image["path"])
            self.assertNotIn("resultZip", terminal)
            task = Publisher.contents[0]
            self.assertNotIn(intent, task)
            self.assertIn("immediately preceding assistant response", task)
            self.assertIn("Do not generate a new image", task)
            self.assertIn(f"POSTMAN_{REQ}_RESULT.zip", task)
            self.assertEqual([x[0] for x in Bridge.calls], [REQ])
            call = Bridge.calls[0][1]
            self.assertEqual(call["prompt"], direct.build_external_prompt(request_id=REQ,
                task_url=f"https://example.test/{REQ}.md", repository=REPO, base_commit=PRE,
                expected_filename=f"POSTMAN_{REQ}_RESULT.zip", allowed_paths=["README.md"], forbidden_paths=list(direct.DEFAULT_FORBIDDEN_PATHS)))
            self.assertEqual(call["preparatory_prompt"], direct.build_image_generation_prompt(intent))
            self.assertEqual(call["task_url"], f"https://example.test/{REQ}.md")
            self.assertNotIn("secondRequestId", call)
            self.assertEqual(terminal["imageFormat"], "png")
            extract.assert_called_once_with(str(zip_path), [{"path": "image.png", "kind": "file"}],
                                            runner.result_root / REQ, expected_zip_sha256="c" * 64)
            self.assertEqual(json.loads(runner.result_handoff_path(REQ).read_text(encoding="utf-8"))["code"], "IMAGE_RESULT_DURABLE")

    def test_image_mode_rejects_rejected_artifact_without_extraction(self):
        class Publisher:
            def __init__(self, **kwargs): pass
            def snapshot(self): return direct.TaskSnapshot(PRE, ("README.md",))
            def publish_content(self, request_id, content, *, expected_parent, root_entries):
                return direct.PublishedTask(request_id, f"https://example.test/{request_id}.md",
                                             expected_parent, PUB, tuple(root_entries))
        class Bridge:
            def __init__(self, **kwargs): pass
            def run_request(self, request_id, **kwargs):
                return {"ok": True, "code": "ARTIFACT_REJECTED", "details": {"validationCode": "BAD_ZIP"}}
        with tempfile.TemporaryDirectory() as tmp:
            runner = direct.DirectPostman(branch="preview", direct_root=Path(tmp) / "direct",
                result_root=Path(tmp) / "results", publisher_factory=Publisher,
                bridge_factory=Bridge, ensure_browser=lambda **_: {"cdpUrl": "http://127.0.0.1:9222"})
            with patch.object(direct.image_result, "extract_validated_image") as extract:
                with self.assertRaises(direct.DirectPostmanError) as caught:
                    runner.run(request_id=REQ, task="image", image_mode=True)
            self.assertEqual(caught.exception.details["transportCode"], "ARTIFACT_REJECTED")
            extract.assert_not_called()
            self.assertEqual(json.loads(runner.state_path(REQ).read_text(encoding="utf-8"))["state"], "FAILED")

    def test_image_mode_requires_pillow_before_claiming_or_publishing(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = direct.DirectPostman(branch="preview", direct_root=Path(tmp) / "direct")
            original_import = __import__
            def unavailable(name, *args, **kwargs):
                if name == "PIL":
                    raise ImportError("Pillow missing")
                return original_import(name, *args, **kwargs)
            with patch("builtins.__import__", side_effect=unavailable):
                with self.assertRaises(direct.DirectPostmanError) as caught:
                    runner.run(request_id=REQ, task="image", image_mode=True)
            self.assertEqual(caught.exception.code, "IMAGE_DECODER_UNAVAILABLE")
            self.assertFalse(runner.state_path(REQ).exists())

    def test_image_mode_rejects_non_durable_packaging_and_manual_chat(self):
        self.assertTrue(direct._build_parser().parse_args(["--image-mode"]).image_mode)
        with tempfile.TemporaryDirectory() as tmp:
            runner = direct.DirectPostman(branch="preview", direct_root=Path(tmp))
            with self.assertRaises(direct.DirectPostmanError) as caught:
                runner.run(request_id=REQ, task="image", image_mode=True, chat_request_id=REQ)
            self.assertEqual(caught.exception.code, "DIRECT_IMAGE_CHAT_UNSUPPORTED")

    def test_cli_requires_explicit_branch_before_transport(self):
        with patch.object(direct.DirectPostman, "run", side_effect=AssertionError("must not publish")), contextlib.redirect_stdout(io.StringIO()) as stdout:
            code = direct.main(["--request-id", REQ, "--task", "intent"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stdout.getvalue())["code"], "DIRECT_BRANCH_REQUIRED")
        with self.assertRaises(direct.DirectPostmanError) as ctx:
            direct.GitHubTaskPublisher(repository=REPO)
        self.assertEqual(ctx.exception.code, "DIRECT_BRANCH_REQUIRED")

    def test_intent_task_is_minimal_and_preserves_text(self):
        task = "Postman, сделай простой калькулятор в древне-японском стиле."
        rendered = direct.render_intent_task(task)
        self.assertEqual(rendered, f"# POSTMAN TASK\n\nuser_intent:\n{task}\n")
        for invented in ("React", "responsive", "division by zero", "framework"):
            self.assertNotIn(invented, rendered)

    def test_preparatory_image_prompt_wraps_exact_multiline_user_intent_without_req_metadata(self):
        intent = "  Рыжий спаниэль\n\nОдно изображение ✅\n  "
        prompt = direct.build_image_generation_prompt(intent)
        self.assertEqual(prompt, f"Сгенерируй, пожалуйста, изображение по этому промту:\n\n{intent}\n\nСделай ровно одно изображение.")
        for forbidden in ("POSTMAN_REQUEST_ID", "task_file:", "REQ_", "https://", "RESULT_BEGIN", "RESULT_END"):
            self.assertNotIn(forbidden, prompt)

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

        publisher = direct.GitHubTaskPublisher(repository=REPO, branch="main", run=fake_run)
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

    def test_task_branch_publication_touches_only_bound_ref_and_pins_url(self):
        branch = "task/postman-0123456789abcdef0123456789abcdef"
        calls = []
        untouched_refs = {"main": "1" * 40, "preview": PRE}
        def fake_run(command, **kwargs):
            calls.append(command)
            endpoint = command[2]
            if endpoint.endswith("/git/ref/heads/" + branch.replace("/", "%2F")):
                result = {"object": {"sha": PRE}}
            elif endpoint.endswith("/git/commits/" + PUB):
                result = {"parents": [{"sha": PRE}]}
            elif command[command.index("--method") + 1] == "PUT" if "--method" in command else False:
                data = json.loads(kwargs["input"])
                self.assertEqual(data["branch"], branch)
                self.assertEqual(data["message"], "postman: publish task " + REQ)
                result = {"commit": {"sha": PUB}}
            elif "/contents?ref=" in endpoint:
                result = [{"name": "README.md"}]
            else:
                raise AssertionError(command)
            return subprocess.CompletedProcess(command, 0, stdout=json.dumps(result), stderr="")
        published = direct.GitHubTaskPublisher(repository=REPO, branch=branch, run=fake_run).publish(REQ, "задача")
        self.assertEqual(published.prepublication_commit, untouched_refs["preview"])
        self.assertEqual(published.publication_commit, PUB)
        self.assertTrue(published.task_url.endswith(f"/{PUB}/{REQ}.md"))
        self.assertFalse(any("/git/ref/heads/main" in cmd[2] or "/git/ref/heads/preview" in cmd[2] for cmd in calls))
        self.assertEqual(untouched_refs, {"main": "1" * 40, "preview": PRE})

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
                if cls.calls <= 2:
                    raise BrowserBootstrapError(cls.BOOTSTRAP_CDP_UNREACHABLE)
                return {"ready": True}
            @staticmethod
            def discover_chrome_executable(explicit=None): return Path("chrome.exe")
            @staticmethod
            def start_dedicated_chrome(*args, **kwargs): return types.SimpleNamespace(pid=99)
        with tempfile.TemporaryDirectory() as root:
            result = direct.ensure_dedicated_chrome(bootstrap_module=Boot, profile_dir=Path(root) / "profile")
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
                branch="main",
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
            validated = direct.durable_handoff.validate_terminal(
                handoff, expected_repository=REPO, request_id=REQ,
                expected_state_path=runner.state_path(REQ), expected_handoff_path=handoff_path,
            )
            self.assertEqual(validated["artifactSha256"], "c" * 64)
            with self.assertRaises(direct.durable_handoff.DurableHandoffError):
                direct.durable_handoff.validate_terminal(
                    {**handoff, "requestId": "REQ_20260902T010204Z_1235"},
                    expected_repository=REPO, request_id=REQ,
                )

    def test_first_and_second_automatic_continuations_inherit_chain(self):
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
            source="direct_state",
            root_request_id="REQ_20260902T010200Z_1200",
            continuation_index=0,
            terminal_state=direct.ASSISTANT_COMPLETED_NO_ARTIFACT,
        )
        with tempfile.TemporaryDirectory() as root, patch.object(
            direct.chat_reference, "resolve_chat_reference", return_value=reference
        ):
            Bridge.calls = []
            runner = direct.DirectPostman(
                branch="main",
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
            self.assertEqual(result["continuationIndex"], 1)
            self.assertEqual(result["conversationUrl"], conversation_url)
            self.assertEqual(result["conversationId"], "existing-chat-123")
            reference.continuation_index = 1
            reference.terminal_state = direct.ARTIFACT_REJECTED
            second_req = "REQ_20260902T010206Z_1237"
            second = runner.run(request_id=second_req, task="continue again", chat_request_id=REQ, automatic_continuation=True)
            self.assertEqual(second["continuationIndex"], 2)
            self.assertEqual(second["rootRequestId"], reference.root_request_id)
            self.assertEqual(len(Bridge.calls), 2)

    def test_third_automatic_continuation_stops_before_publication_or_browser(self):
        reference = types.SimpleNamespace(
            request_id=REQ, continuation_index=2, terminal_state=direct.ASSISTANT_COMPLETED_NO_ARTIFACT,
        )
        with tempfile.TemporaryDirectory() as root, patch.object(
            direct.chat_reference, "resolve_chat_reference", return_value=reference
        ):
            runner = direct.DirectPostman(
                branch="main", direct_root=Path(root) / "direct",
                publisher_factory=lambda **kwargs: (_ for _ in ()).throw(AssertionError("must not publish")),
                ensure_browser=lambda **kwargs: (_ for _ in ()).throw(AssertionError("must not send")),
            )
            with self.assertRaises(direct.DirectPostmanError) as ctx:
                runner.run(request_id="REQ_20260902T010207Z_1238", task="continue",
                           chat_request_id=REQ, automatic_continuation=True)
            self.assertEqual(ctx.exception.code, "POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED")

    def test_automatic_continuation_rejects_other_terminals_before_publication(self):
        for terminal in (direct.RESULT_DURABLE, "TEXT_RESULT_DURABLE", direct.POSTMAN_TRANSPORT_FAILED):
            with self.subTest(terminal=terminal), tempfile.TemporaryDirectory() as root:
                reference = types.SimpleNamespace(request_id=REQ, continuation_index=0, terminal_state=terminal)
                with patch.object(direct.chat_reference, "resolve_chat_reference", return_value=reference):
                    runner = direct.DirectPostman(
                        branch="main", direct_root=Path(root) / "direct",
                        publisher_factory=lambda **kwargs: (_ for _ in ()).throw(AssertionError("must not publish")),
                        ensure_browser=lambda **kwargs: (_ for _ in ()).throw(AssertionError("must not send")),
                    )
                    with self.assertRaises(direct.DirectPostmanError) as ctx:
                        runner.run(request_id="REQ_20260902T010207Z_1238", task="continue",
                                   chat_request_id=REQ, automatic_continuation=True)
                    self.assertEqual(ctx.exception.code, "DIRECT_INVALID_CONTINUATION")

    def test_manual_chat_with_high_continuation_index_is_allowed(self):
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
                branch="main",
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
                branch="main",
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
                branch="main",
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
                branch="main",
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
            exit_code = direct.main(["--request-id", REQ, "--task", "intent", "--branch", "main"])

        self.assertEqual(exit_code, 2)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], direct.POSTMAN_TRANSPORT_FAILED)
        self.assertEqual(payload["requestId"], REQ)
        self.assertEqual(payload["transportCode"], failure_details["transportCode"])
        self.assertEqual(payload["transportMessage"], failure_details["transportMessage"])
        self.assertEqual(payload["details"], failure_details["details"])

    def test_cli_failure_includes_only_same_request_publication_receipt(self):
        receipt = {"requestId": REQ, "repository": REPO, "branch": "main",
                   "taskUrl": f"https://raw.githubusercontent.com/{REPO}/{PUB}/{REQ}.md",
                   "baseCommit": PRE, "taskPublicationCommit": PUB}
        def fail_run(instance, **_kwargs):
            instance.publication_receipt = dict(receipt)
            raise direct.DirectPostmanError("DIRECT_BROWSER_FAILED", "browser unavailable")
        with patch.object(direct.DirectPostman, "run", fail_run), contextlib.redirect_stdout(io.StringIO()) as stdout:
            code = direct.main(["--request-id", REQ, "--task", "intent", "--branch", "main"])
        self.assertEqual(code, 2)
        failure = json.loads(stdout.getvalue())
        self.assertEqual(failure["code"], direct.POSTMAN_TRANSPORT_FAILED)
        self.assertEqual(failure["publicationReceipt"], receipt)

    def test_cli_prebridge_failure_keeps_publication_absence_explicit(self):
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
            exit_code = direct.main(["--request-id", REQ, "--task", "intent", "--branch", "main"])

        self.assertEqual(exit_code, 2)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], direct.POSTMAN_TRANSPORT_FAILED)
        self.assertEqual(payload["requestId"], REQ)
        self.assertEqual(payload["transportCode"], failure_code)
        self.assertEqual(payload["transportMessage"], failure_message)
        self.assertEqual(payload["details"], failure_details)
        self.assertIn("publicationReceipt", payload)
        self.assertIsNone(payload["publicationReceipt"])


if __name__ == "__main__":
    unittest.main()
