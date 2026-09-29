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


    def test_image_flow_uses_one_page_for_both_proven_turns_and_zip(self):
        chat = "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc"
        events = []
        class Page:
            closed = False
            def close(self):
                events.append("close")
                self.closed = True
            def is_closed(self): return self.closed
        page = Page()
        class Context:
            def new_page(self):
                events.append("new_page")
                return page
        class Browser:
            contexts = [Context()]
        class Factory:
            def __enter__(self):
                self.chromium = self
                return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, url): return Browser()
        submit = {"ok": True, "code": "SENT", "sendState": "PROVEN_SENT",
                  "details": {"chatUrl": chat}}
        image_proof = {"ok": True, "code": "ASSISTANT_TURN_COMPLETED",
                       "details": {"assistantText": "", "assistantImageCount": 1, "assistantIndex": 1}}
        zip_proof = {"ok": True, "code": "ASSISTANT_TURN_COMPLETED",
                     "details": {"assistantText": "ZIP", "assistantIndex": 3}}
        result_root = []
        pauses = []
        def pause(seconds):
            pauses.append(seconds)
            events.append("pause")
        def observe(target, prompt, *_args, **kwargs):
            self.assertIs(target, page)
            events.append("observe_image" if kwargs.get("image_mode") else "observe_zip")
            return image_proof if kwargs.get("image_mode") else zip_proof
        def followup(target, prompt, url, **kwargs):
            self.assertIs(target, page)
            self.assertEqual(url, chat)
            self.assertEqual(kwargs["navigate"], False)
            self.assertIn("observe_image", events)
            self.assertFalse(page.closed)
            events.append("submit_packaging")
            return submit
        def detect(target, **kwargs):
            self.assertIs(target, page)
            self.assertEqual(kwargs["request_id"], REQ)
            events.append("detect_zip")
            return {"ok": True, "code": "ARTIFACT_FOUND"}
        def download(target, **kwargs):
            self.assertIs(target, page)
            self.assertEqual(kwargs["request_id"], REQ)
            result_root.append(kwargs["result_root"])
            events.append("download_zip")
            return {"ok": True, "code": "RESULT_DURABLE", "details": {
                "resultDirectory": str(Path(kwargs["result_root"]) / REQ),
                "resultZip": str(Path(kwargs["result_root"]) / REQ / "result.zip"),
                "sha256": "c" * 64}}
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root, sleep=pause,
                                                    on_result_durable=lambda _: events.append("grant"))
            def prepare():
                events.append("publish_packaging")
                return {"task_url": TASK_URL, "prompt": "POSTMAN_REQUEST_ID: " + REQ + "\ntask_file: " + TASK_URL,
                        "expected_filename": f"POSTMAN_{REQ}_RESULT.zip",
                        "expected_request": {"requestId": REQ}}
            with patch.object(bridge_module.browser_submit, "submit_fresh_prompt", side_effect=lambda *_a, **_k: (events.append("submit_a"), submit)[1]) as fresh, \
                 patch.object(bridge_module.browser_submit, "submit_existing_prompt", side_effect=followup) as existing, \
                 patch.object(bridge_module.browser_observer, "observe_next_assistant", side_effect=observe) as observer, \
                 patch.object(bridge_module.browser_observer, "connection_interrupted", return_value=(False, {})), \
                 patch.object(bridge_module.artifact_detector, "detect_artifact_dom", side_effect=detect), \
                 patch.object(bridge_module.artifact_download, "download_validated_artifact", side_effect=download), \
                 patch.object(bridge_module.reminder_policy, "submit_reminder", side_effect=AssertionError("reminder")):
                result = bridge.run_request(REQ, task_url=TASK_URL, prompt="image request",
                    expected_filename="unused.zip", expected_request={},
                    playwright_factory=Factory, image_prepare=prepare)
            self.assertEqual(result["code"], bridge_module.RESULT_DURABLE, result)
            self.assertTrue(result["ok"])
            self.assertNotIn("secondRequestId", result["details"])
            self.assertEqual(result["details"]["imageObserverProof"]["details"]["assistantImageCount"], 1)
            self.assertEqual(bridge.read_state(REQ)["state"], bridge_module.RESULT_DURABLE)
            self.assertEqual(events, ["new_page", "submit_a", "observe_image", "publish_packaging", "pause",
                                      "submit_packaging", "observe_zip", "detect_zip", "pause", "download_zip", "close"])
            self.assertEqual(len(pauses), 2)
            self.assertTrue(all(3 <= seconds <= 7 for seconds in pauses))
            self.assertEqual((fresh.call_count, existing.call_count, observer.call_count), (1, 1, 2))
            self.assertEqual(fresh.call_args.kwargs["timeout_ms"], 90_000)
            self.assertEqual(result_root, [bridge.result_root])
            self.assertTrue(page.closed)


    def test_image_preparatory_restart_never_resends_from_persisted_state(self):
        for state in (bridge_module.ACCEPTED, bridge_module.WEB_STARTING,
                      bridge_module.PROMPT_SENT, bridge_module.WAITING_ASSISTANT,
                      bridge_module.IMAGE_TURN_COMPLETED, bridge_module.RESULT_DURABLE):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as root:
                original = bridge_module.WebWorkerBridge(root=root)
                request = bridge_module.BridgeRequest(REQ, "", str(original.result_path(REQ)), f"WEB_{REQ}")
                original._write_state(request, bridge_module.ACCEPTED)
                if state != bridge_module.ACCEPTED:
                    original._write_state(request, state)
                    if state == bridge_module.WEB_STARTING:
                        original._fail(request, "uncertain browser action")
                restarted = bridge_module.WebWorkerBridge(root=root)
                result = restarted.run_request(REQ, task_url="", prompt="image request",
                    expected_filename=f"POSTMAN_{REQ}_RESULT.zip", expected_request={"requestId": REQ},
                    image_prepare=lambda: self.fail("must not publish"),
                    playwright_factory=lambda: self.fail("must not attach or resend"))
                self.assertEqual(result["code"], state)
                self.assertEqual(restarted.read_state(REQ)["state"], state)

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

    def test_image_flow_rejects_two_ready_images_before_packaging_publication(self):
        chat = "https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc"
        calls = []
        pauses = []
        class Page:
            closed = False
            def close(self): self.closed = True
            def is_closed(self): return self.closed
        page = Page()
        class Context:
            def new_page(self): return page
        class Browser:
            contexts = [Context()]
        class Factory:
            def __enter__(self): self.chromium = self; return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, url): return Browser()
        submit = {"ok": True, "code": "SENT", "sendState": "PROVEN_SENT", "details": {"chatUrl": chat}}
        proof = {"ok": True, "code": "ASSISTANT_TURN_COMPLETED",
                 "details": {"assistantText": "", "assistantImageCount": 2, "assistantIndex": 1}}
        def prepare():
            calls.append("prepare")
            raise AssertionError("must not publish packaging task")
        for count in (0, 2, None, True):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as root:
                proof["details"]["assistantImageCount"] = count
                bridge = bridge_module.WebWorkerBridge(root=root, sleep=pauses.append)
                with patch.object(bridge_module.browser_submit, "submit_fresh_prompt", return_value=submit), \
                     patch.object(bridge_module.browser_observer, "observe_next_assistant", return_value=proof), \
                     patch.object(bridge_module.browser_observer, "connection_interrupted", return_value=(False, {})):
                    result = bridge.run_request(REQ, task_url="", prompt="image request",
                        expected_filename="unused.zip", expected_request={},
                        playwright_factory=Factory, image_prepare=prepare)
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], bridge_module.POSTMAN_TRANSPORT_FAILED)
                self.assertEqual(calls, [])
                self.assertEqual(pauses, [])


if __name__ == "__main__":
    unittest.main()
