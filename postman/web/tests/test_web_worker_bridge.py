from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))
MODULE_PATH = WEB_DIR / "web_worker_bridge.py"
spec = importlib.util.spec_from_file_location("web_worker_bridge", MODULE_PATH)
bridge_module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = bridge_module
spec.loader.exec_module(bridge_module)


REQ = "REQ_20260831T043820Z_0042"
TASK_URL = "https://example.test/tasks/request.md"


class WebWorkerBridgeTests(unittest.TestCase):
    def test_accept_persists_request_identity_and_result_path(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            result = bridge.accept_request(REQ, TASK_URL)

            self.assertTrue(result["ok"])
            self.assertEqual(result["code"], bridge_module.ACCEPTED)
            self.assertEqual(result["details"]["requestId"], REQ)
            self.assertEqual(result["details"]["workerJobId"], f"WEB_{REQ}")
            self.assertEqual(result["details"]["state"], bridge_module.ACCEPTED)
            self.assertTrue(result["details"]["resultPath"].replace("\\", "/").endswith(f"results/{REQ}"))
            stored = bridge.read_state(REQ)
            self.assertEqual(stored["requestId"], REQ)
            self.assertEqual(stored["taskUrl"], TASK_URL)

    def test_accept_rejects_invalid_identity_and_task_url(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            self.assertEqual(bridge.accept_request("REQ_BAD", TASK_URL)["code"], bridge_module.BRIDGE_INVALID_REQUEST)
            self.assertEqual(bridge.accept_request(REQ, "not-a-url")["code"], bridge_module.BRIDGE_INVALID_TASK_URL)
            self.assertIsNone(bridge.read_state(REQ))

    def test_existing_chat_url_is_validated_before_browser_attach(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            result = bridge.run_request(
                REQ,
                task_url=TASK_URL,
                prompt="POSTMAN_REQUEST_ID: " + REQ,
                expected_filename=f"POSTMAN_{REQ}_RESULT.zip",
                expected_request={},
                conversation_url="https://example.com/c/not-chatgpt",
                playwright_factory=lambda: (_ for _ in ()).throw(AssertionError("browser must not start")),
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], bridge_module.BRIDGE_INVALID_CONFIG)
            self.assertEqual(result["details"]["reason"], "invalid_conversation_url")

    def test_accept_is_idempotent_and_does_not_rewrite_request_id(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            first = bridge.accept_request(REQ, TASK_URL)
            second = bridge.accept_request(REQ, TASK_URL)

            self.assertEqual(first["details"]["requestId"], second["details"]["requestId"])
            self.assertEqual(second["details"]["workerJobId"], f"WEB_{REQ}")
            self.assertEqual(second["details"]["resultPath"], first["details"]["resultPath"])

    def test_state_machine_rejects_backward_transition(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            bridge.accept_request(REQ, TASK_URL)
            request = bridge_module.BridgeRequest(REQ, TASK_URL, str(bridge.result_path(REQ)), f"WEB_{REQ}")
            bridge._write_state(request, bridge_module.WEB_STARTING)
            with self.assertRaises(ValueError):
                bridge._write_state(request, bridge_module.ACCEPTED)

    def test_terminal_result_contains_the_same_request_id_and_durable_path(self):
        with tempfile.TemporaryDirectory() as root:
            callback_results = []
            bridge = bridge_module.WebWorkerBridge(root=root, on_result_durable=callback_results.append)
            bridge.accept_request(REQ, TASK_URL)
            request = bridge_module.BridgeRequest(REQ, TASK_URL, str(bridge.result_path(REQ)), f"WEB_{REQ}")
            stored = bridge._write_state(
                request,
                bridge_module.RESULT_DURABLE,
                resultPath=str(bridge.result_path(REQ)),
                resultSha256="a" * 64,
            )

            self.assertEqual(stored["requestId"], REQ)
            self.assertEqual(stored["state"], bridge_module.RESULT_DURABLE)
            self.assertTrue(stored["resultPath"].replace("\\", "/").endswith(f"results/{REQ}"))
            self.assertEqual(callback_results, [])


    def test_image_stage_accepts_empty_text_without_artifact_or_reminder(self):
        chat = "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc"
        class Page:
            def __init__(self): self.closed = False
            def close(self): self.closed = True
            def is_closed(self): return self.closed
        class Context:
            def __init__(self): self.page = Page()
            def new_page(self): return self.page
        class Browser:
            def __init__(self): self.contexts = [Context()]
        class Factory:
            def __enter__(self):
                self.chromium = self
                return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, url): return Browser()
        for continued in (False, True):
            with self.subTest(continued=continued), tempfile.TemporaryDirectory() as root:
                pauses = []
                callback = []
                bridge = bridge_module.WebWorkerBridge(root=root, sleep=pauses.append,
                                                       on_result_durable=callback.append)
                submit = {"ok": True, "code": "SENT", "sendState": "PROVEN_SENT",
                          "details": {"chatUrl": chat}}
                proof = {"ok": True, "code": "ASSISTANT_TURN_COMPLETED",
                         "details": {"assistantText": "", "assistantIndex": 1}}
                with patch.object(bridge_module.browser_submit, "submit_fresh_prompt", return_value=submit) as fresh, \
                     patch.object(bridge_module.browser_submit, "submit_existing_prompt", return_value=submit) as existing, \
                     patch.object(bridge_module.browser_observer, "observe_next_assistant", return_value=proof) as observer, \
                     patch.object(bridge_module.browser_observer, "connection_interrupted", return_value=(False, {})), \
                     patch.object(bridge_module.artifact_detector, "detect_artifact_dom", side_effect=AssertionError("artifact inspected")), \
                     patch.object(bridge_module.artifact_download, "download_validated_artifact", side_effect=AssertionError("download")), \
                     patch.object(bridge_module.reminder_policy, "submit_reminder", side_effect=AssertionError("reminder")):
                    result = bridge.run_request(REQ, task_url=TASK_URL, prompt="image request",
                        expected_filename="unused.zip", expected_request={},
                        conversation_url=chat if continued else None,
                        playwright_factory=Factory, image_stage=True)
                self.assertEqual(result["code"], bridge_module.IMAGE_TURN_COMPLETED)
                self.assertTrue(result["ok"])
                self.assertEqual(result["details"]["conversationUrl"], chat)
                self.assertEqual(result["details"]["conversationId"], chat.rsplit("/", 1)[-1])
                self.assertEqual(result["details"]["observerProof"], proof)
                self.assertEqual(result["details"]["reminders"], [])
                self.assertTrue(result["details"]["browserCleanup"]["ownedPageClosed"])
                self.assertEqual(bridge.read_state(REQ)["state"], bridge_module.IMAGE_TURN_COMPLETED)
                self.assertEqual(len(pauses), 3)
                self.assertTrue(all(3 <= seconds <= 7 for seconds in pauses))
                self.assertEqual(observer.call_args.kwargs["allow_empty_text"], True)
                self.assertEqual(fresh.call_count, 0 if continued else 1)
                self.assertEqual(existing.call_count, 1 if continued else 0)
                self.assertEqual(callback, [])

    def test_ordinary_mode_keeps_observer_contract_and_no_image_delay(self):
        with tempfile.TemporaryDirectory() as root:
            pauses = []
            bridge = bridge_module.WebWorkerBridge(root=root, sleep=pauses.append)
            class Context:
                def __enter__(self):
                    self.chromium = self
                    return self
                def __exit__(self, *args): pass
                def connect_over_cdp(self, url): return self
                @property
                def contexts(self): return [self]
                def new_page(self): return object()
            chat = "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc"
            with patch.object(bridge_module.browser_submit, "submit_fresh_prompt",
                              return_value={"ok": True, "details": {"chatUrl": chat}}), \
                 patch.object(bridge_module.browser_observer, "connection_interrupted", return_value=(False, {})), \
                 patch.object(bridge_module.browser_observer, "observe_next_assistant",
                              return_value={"ok": False, "code": "FATAL", "details": {}}) as observer:
                result = bridge.run_request(REQ, task_url=TASK_URL, prompt="ordinary",
                    expected_filename="unused.zip", expected_request={}, playwright_factory=Context)
            self.assertFalse(result["ok"])
            self.assertEqual(result["details"]["transportMessage"], "FATAL")
            self.assertNotIn("allow_empty_text", observer.call_args.kwargs)
            self.assertEqual(pauses, [])

if __name__ == "__main__":
    unittest.main()
