import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock, ANY
from contextlib import nullcontext

from postman.devspace import transport
from postman.web import web_worker_bridge as web

class ImageActions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "22222222-1111-4111-8111-111111111111"
        self.root.mkdir()
        self.req = "REQ_20261022T120000Z_0001"
        self.chat = "https://chatgpt.com/c/owned"
        self.binding = {"requestId": self.req, "jobId": self.root.name, "leaderSessionId": "leader",
            "lunaSessionId": "luna", "capability": "private", "version": 1, "mode": "WRITE_TEST",
            "channel": str(self.root), "imageMode": True, "conversationUrl": self.chat}
        (self.root / "binding.json").write_text(json.dumps(self.binding))
        (self.root / "task.md").write_text("visual prompt")
        import hashlib
        from postman.devspace.publication import publish_assignment
        publish_assignment(self.binding, "visual prompt", "", image_mode=True,
            publisher=None, fetch=lambda *_: None, source=lambda: ("a"*40, {}))
        self.original = {"requestId": self.req, "conversationRef": self.chat, "sendState": "PROVEN_SENT"}
        (self.root / "result.json").write_text(json.dumps(self.original))
    def tearDown(self): self.temp.cleanup()
    def test_inspect_then_download_claim_once_and_preserve_result(self):
        identity = {"assistantMessageId":"assistant-1"}
        class Bridge:
            def __init__(self, **kwargs): pass
            def run_image_action(self, binding, prompt, chat, action, **kwargs):
                self_outer.assertEqual((prompt, chat), ("visual prompt", self_outer.chat))
                return {"ok":True,"code":"INSPECTED" if action == "image_inspect" else "DOWNLOADED",
                    "details":{"assistantIdentity":identity}}
        self_outer = self
        browser = {"cdpUrl":"http://localhost"}
        with patch.object(transport, "load_binding", return_value=self.binding), \
             patch("postman.devspace.transport.ensure_dedicated_chrome", return_value=browser), \
             patch.object(transport, "WebWorkerBridge", Bridge):
            inspected = transport.run_image_action(self.root, self.req, "image_inspect", ensure_browser=lambda: browser, bridge_factory=Bridge)
            self.assertTrue(inspected["ok"])
            downloaded = transport.run_image_action(self.root, self.req, "image_download", ensure_browser=lambda: browser, bridge_factory=Bridge)
            self.assertTrue(downloaded["ok"])
            with self.assertRaisesRegex(ValueError, "ALREADY_ATTEMPTED"):
                transport.run_image_action(self.root, self.req, "image_download", ensure_browser=lambda: browser, bridge_factory=Bridge)
        self.assertEqual(json.loads((self.root / "result.json").read_text()), self.original)
        self.assertEqual(inspected["conversationRef"], self.chat)
        self.assertEqual(inspected["sendState"], "PROVEN_SENT")
        self.assertTrue((self.root / "image-download-attempt.json").is_file())
        claim = json.loads((self.root / "image-download-attempt.json").read_text())
        self.assertEqual(claim["code"], "POSTMAN_DEVSPACE_IMAGE_DOWNLOAD_CLAIMED")
        self.assertEqual(claim["outcome"], "UNKNOWN")
        self.assertEqual(claim["sendState"], "PROVEN_SENT")

    def test_bridge_inspect_and_download_use_owned_page_without_send(self):
        identity = {"assistantMessageId": "assistant-1"}
        events = []
        page = Mock()
        page.url = self.chat
        page.goto.side_effect = lambda url: events.append(("goto", url))
        page.close.side_effect = lambda: events.append(("page.close",))
        context = Mock()
        context.pages = []
        context.new_page.return_value = page
        context.browser = Mock()
        browser = Mock()
        browser.contexts = [context]
        playwright = Mock()
        class Manager:
            def __enter__(self): return playwright
            def __exit__(self, *args): events.append(("playwright.exit",))
        manager = Manager()
        download_context = Mock()
        download_context.__enter__ = lambda *_: events.append(("download.enter",))
        download_context.__exit__ = lambda *_: events.append(("download.exit",))
        readiness = Mock(return_value={"ok":True,"code":web.browser_observer.ASSISTANT_TURN_COMPLETED,"details":{}})
        inspect = Mock(return_value={"ok":True,"code":"INSPECTED","details":{"assistantIdentity":identity}})
        observe = Mock(return_value={"ok":True,"code":"DOWNLOADED","details":{"assistantIdentity":identity}})
        with patch.object(web.browser_submit, "is_bound_chat_url", return_value=True), \
             patch.object(web.browser_observer, "observe_next_assistant", readiness), \
             patch("postman.devspace.publication.bound_prompt", return_value=True), \
             patch("postman.devspace.controls.revoked", return_value=False), \
             patch("postman.devspace.image_output.inspect_owned_image", inspect), \
             patch("postman.devspace.image_output.observe_owned_image", observe), \
             patch.object(web.cdp_download, "temporary_artifacts_dir", return_value=nullcontext("artifact-dir")), \
             patch.object(web.cdp_download, "locked_playwright", return_value=manager), \
             patch.object(web.cdp_download, "connect_over_cdp", return_value=browser), \
             patch.object(web.cdp_download, "download_behavior", return_value=download_context) as download_behavior, \
             patch.object(web.browser_submit, "submit_fresh_prompt") as submit_prompt, \
             patch.object(web.browser_submit, "submit_existing_prompt") as submit_existing:
            bridge = web.WebWorkerBridge(root=self.root / "web")
            inspected = bridge.run_image_action(self.binding, "visual prompt", self.chat, "image_inspect")
            self.assertTrue(inspected["ok"])
            self.assertEqual(events[:2], [("goto", self.chat), ("page.close",)])
            self.assertLess(events.index(("page.close",)), events.index(("playwright.exit",)))
            inspect.assert_called_once_with(page, "visual prompt", self.chat, self.binding)
            download_behavior.assert_not_called()
            observed = bridge.run_image_action(self.binding, "visual prompt", self.chat, "image_download",
                expected_identity=identity)
            self.assertTrue(observed["ok"])
            download_behavior.assert_called_once_with(page, "artifact-dir")
            observe.assert_called_once_with(page, "visual prompt", self.chat, self.binding,
                diagnostic=ANY, expected_identity=identity)
            submit_prompt.assert_not_called()
            submit_existing.assert_not_called()

    def test_rejects_nonimage_and_wrong_request(self):
        with patch.object(transport, "load_binding", return_value={**self.binding, "imageMode":False}):
            with self.assertRaisesRegex(ValueError, "BINDING_INVALID"):
                transport.run_image_action(self.root, self.req, "image_inspect")
        with patch.object(transport, "load_binding", return_value=self.binding):
            with self.assertRaisesRegex(ValueError, "BINDING_INVALID"):
                transport.run_image_action(self.root, "REQ_20261022T120001Z_0002", "image_inspect")

    def test_browser_failure_keeps_unknown_claim_and_separate_receipt(self):
        class Bridge:
            def __init__(self, **kwargs): pass
            def run_image_action(self, *args, **kwargs): raise AssertionError("not reached")
        identity = {"assistantMessageId": "assistant-1"}
        (self.root / "image-inspect.json").write_text(json.dumps({"ok":True,
            "assistantIdentity":identity,"requestId":self.req,"jobId":self.root.name,
            "leaderSessionId":"leader","lunaSessionId":"luna","action":"image_inspect",
            "conversationRef":self.chat}))
        with patch.object(transport, "load_binding", return_value=self.binding):
            receipt = transport.run_image_action(self.root, self.req, "image_download",
                ensure_browser=lambda: (_ for _ in ()).throw(RuntimeError("browser down")), bridge_factory=Bridge)
        self.assertFalse(receipt["ok"])
        claim = json.loads((self.root / "image-download-attempt.json").read_text())
        self.assertEqual(claim["outcome"], "UNKNOWN")
        self.assertEqual(json.loads((self.root / "result.json").read_text()), self.original)
        with patch.object(transport, "load_binding", return_value=self.binding), \
             self.assertRaisesRegex(ValueError, "ALREADY_ATTEMPTED"):
            transport.run_image_action(self.root, self.req, "image_download")

if __name__ == "__main__": unittest.main()
