from __future__ import annotations

from pathlib import Path
import contextlib
import io
from unittest.mock import patch
from types import SimpleNamespace
import hashlib
import json
import sys
import tempfile
import unittest

DIRECT_DIR = Path(__file__).resolve().parents[1]
POSTMAN_DIR = DIRECT_DIR.parent
WEB_DIR = POSTMAN_DIR / "web"
for candidate in (DIRECT_DIR, POSTMAN_DIR, WEB_DIR):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

import base64
import types

import chat_reference
import text_result

# Keep this unit test runnable in an authoring shadow that contains only the
# touched files. The real repository imports the same names from production.
bootstrap_stub = types.ModuleType("browser_bootstrap")
bootstrap_stub.DEFAULT_CDP_URL = "http://127.0.0.1:9222"
sys.modules["browser_bootstrap"] = bootstrap_stub

task_package_stub = types.ModuleType("task_package")
task_package_stub.build_external_prompt = lambda request_id, _policy, task_url: (
    f"POSTMAN_REQUEST_ID: {request_id}\ntask_file: {task_url}"
)
sys.modules["task_package"] = task_package_stub

postman_direct_stub = types.ModuleType("postman_direct")
postman_direct_stub.DEFAULT_BRANCH = "main"
postman_direct_stub.DEFAULT_GH_BINARY = "gh"
postman_direct_stub.DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
postman_direct_stub.PUBLIC_POLICY_URL = "https://example.test/policy"

class _DirectPostmanError(RuntimeError):
    def __init__(self, code, message, *, details=None):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})

postman_direct_stub.DirectPostmanError = _DirectPostmanError
postman_direct_stub.GitHubTaskPublisher = object
postman_direct_stub._decode_task_b64 = lambda value: base64.b64decode(value).decode("utf-8")
postman_direct_stub._decode_task_file = lambda value: Path(value).read_text(encoding="utf-8")
postman_direct_stub._sha256_text = lambda value: hashlib.sha256(value.encode("utf-8")).hexdigest()
postman_direct_stub.default_direct_root = lambda: Path("direct")
postman_direct_stub.ensure_dedicated_chrome = lambda **_kwargs: {"cdpUrl": bootstrap_stub.DEFAULT_CDP_URL}
sys.modules["postman_direct"] = postman_direct_stub

worker_stub = types.ModuleType("web_worker_bridge")
worker_stub.ARTIFACT_REJECTED = "ARTIFACT_REJECTED"
worker_stub.ASSISTANT_COMPLETED_NO_ARTIFACT = "ASSISTANT_COMPLETED_NO_ARTIFACT"
worker_stub.RESULT_DURABLE = "RESULT_DURABLE"
worker_stub.POSTMAN_TRANSPORT_FAILED = "POSTMAN_TRANSPORT_FAILED"
worker_stub.WebWorkerBridge = object
sys.modules["web_worker_bridge"] = worker_stub

import postman_ask

REQ = "REQ_20260922T010203Z_1234"
OLD_REQ = "REQ_20260921T010203Z_9999"
BASE = "a" * 40
PUB = "b" * 40
URL = "https://chatgpt.com/c/postman-ask-test"


def envelope(body: str) -> str:
    return "\n".join((text_result.begin_marker(REQ), body, text_result.end_marker(REQ)))


class Publisher:
    contents: list[str] = []

    def __init__(self, **_kwargs):
        pass

    def snapshot(self):
        return SimpleNamespace(prepublication_commit=BASE, root_entries=("postman", "docs"))

    def publish_content(self, request_id, content, *, expected_parent, root_entries):
        self.__class__.contents.append(content)
        return SimpleNamespace(
            request_id=request_id,
            task_url=f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{PUB}/{request_id}.md",
            prepublication_commit=expected_parent,
            publication_commit=PUB,
            root_entries=tuple(root_entries),
        )


class Bridge:
    result: dict = {}
    calls: list[dict] = []

    def __init__(self, **_kwargs):
        pass

    def run_request(self, request_id, **kwargs):
        self.__class__.calls.append({"request_id": request_id, **kwargs})
        return self.__class__.result


class PostmanAskTests(unittest.TestCase):
    def setUp(self):
        Publisher.contents = []
        Bridge.calls = []

    def make_runner(self, root):
        return postman_ask.DirectPostmanAsk(
            direct_root=Path(root) / "direct",
            publisher_factory=Publisher,
            bridge_factory=Bridge,
            ensure_browser=lambda **_kwargs: {"cdpUrl": "http://127.0.0.1:9222"},
        )

    def test_success_returns_text_after_worker_reproof_terminal(self):
        body = "Текстовый итог."
        Bridge.result = {
            "ok": True,
            "code": "ASSISTANT_COMPLETED_NO_ARTIFACT",
            "details": {
                "assistantText": envelope(body),
                "assistantTextSha256": "c" * 64,
                "assistantIndex": 5,
                "conversationUrl": URL,
                "conversationId": "postman-ask-test",
                "noArtifactRecheckMs": 10_000,
            },
        }
        with tempfile.TemporaryDirectory() as root:
            runner = self.make_runner(root)
            result = runner.run(request_id=REQ, task="исследуй вопрос")
            state = json.loads(runner.state_path(REQ).read_text(encoding="utf-8"))

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "TEXT_RESULT_DURABLE")
        self.assertEqual(result["assistantText"], body)
        self.assertEqual(result["assistantTextSha256"], hashlib.sha256(body.encode("utf-8")).hexdigest())
        self.assertEqual(result["textSettleMs"], 10_000)
        self.assertEqual(state["state"], "TEXT_RESULT_DURABLE")
        self.assertEqual(Bridge.calls[0]["observer_timeout_ms"], 45 * 60 * 1000)
        self.assertIn("result_mode: text", Publisher.contents[0])
        self.assertIn(text_result.begin_marker(REQ), Publisher.contents[0])

    def test_plain_completed_text_is_not_success(self):
        Bridge.result = {
            "ok": True,
            "code": "ASSISTANT_COMPLETED_NO_ARTIFACT",
            "details": {
                "assistantText": "обычный текст без transport trigger",
                "assistantTextSha256": "d" * 64,
                "assistantIndex": 1,
                "conversationUrl": URL,
                "noArtifactRecheckMs": 10_000,
            },
        }
        with tempfile.TemporaryDirectory() as root:
            runner = self.make_runner(root)
            with self.assertRaises(postman_ask.DirectPostmanError) as raised:
                runner.run(request_id=REQ, task="вопрос")
            self.assertEqual(raised.exception.code, "POSTMAN_ASK_RESULT_TRIGGER_INVALID")
            state = json.loads(runner.state_path(REQ).read_text(encoding="utf-8"))
            self.assertEqual(state["state"], "ASK_FAILED")
            self.assertEqual(state["textResultCode"], "TEXT_RESULT_MARKERS_MISSING")

    def test_unexpected_zip_terminal_is_fail_closed(self):
        Bridge.result = {
            "ok": True,
            "code": "RESULT_DURABLE",
            "details": {"resultZip": "x.zip", "conversationUrl": URL},
        }
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(postman_ask.DirectPostmanError) as raised:
                self.make_runner(root).run(request_id=REQ, task="вопрос")
        self.assertEqual(raised.exception.code, "POSTMAN_ASK_UNEXPECTED_WEB_RESULT")

    def test_failure_after_publication_exposes_receipt_only_from_this_run(self):
        Bridge.result = {"ok": False, "code": "WEB_LOST", "details": {"reason": "observer"}}
        with tempfile.TemporaryDirectory() as root:
            runner = self.make_runner(root)
            with self.assertRaises(postman_ask.DirectPostmanError):
                runner.run(request_id=REQ, task="вопрос")
            self.assertEqual(runner.publication_receipt, {
                "requestId": REQ, "repository": "AndrewVerhoturov1/dsh-workspace", "branch": "main",
                "taskUrl": f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{PUB}/{REQ}.md",
                "baseCommit": BASE, "taskPublicationCommit": PUB,
            })
            self.assertEqual(json.loads(runner.state_path(REQ).read_text(encoding="utf-8"))["taskPublicationCommit"], PUB)

    def test_cli_failure_includes_same_request_publication_receipt(self):
        receipt = {"requestId": REQ, "repository": "AndrewVerhoturov1/dsh-workspace", "branch": "main",
                   "taskUrl": f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{PUB}/{REQ}.md",
                   "baseCommit": BASE, "taskPublicationCommit": PUB}
        def fail_run(instance, **_kwargs):
            instance.publication_receipt = dict(receipt)
            raise postman_ask.DirectPostmanError("DIRECT_BROWSER_FAILED", "browser unavailable")
        with patch.object(postman_ask.DirectPostmanAsk, "run", fail_run), contextlib.redirect_stdout(io.StringIO()) as stdout:
            code = postman_ask.main(["--request-id", REQ, "--task", "intent"])
        self.assertEqual(code, 2)
        failure = json.loads(stdout.getvalue())
        self.assertEqual(failure["code"], postman_ask.POSTMAN_TRANSPORT_FAILED)
        self.assertEqual(failure["publicationReceipt"], receipt)

    def test_text_terminal_is_eligible_for_later_chat_continuation(self):
        with tempfile.TemporaryDirectory() as root:
            direct_root = Path(root) / "direct"
            state_path = direct_root / "requests" / f"{OLD_REQ}.json"
            state_path.parent.mkdir(parents=True)
            state_path.write_text(json.dumps({
                "ok": True,
                "code": "TEXT_RESULT_DURABLE",
                "state": "TEXT_RESULT_DURABLE",
                "requestId": OLD_REQ,
                "repository": "AndrewVerhoturov1/dsh-workspace",
                "conversationUrl": URL,
            }), encoding="utf-8")
            resolved = chat_reference.resolve_chat_reference(
                direct_root,
                OLD_REQ,
                expected_repository="AndrewVerhoturov1/dsh-workspace",
            )
        self.assertEqual(resolved.terminal_state, "TEXT_RESULT_DURABLE")
        self.assertEqual(resolved.conversation_url, URL)


if __name__ == "__main__":
    unittest.main()
