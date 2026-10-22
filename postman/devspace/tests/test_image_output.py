from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(REPO / 'postman' / 'web')]
from postman.devspace import image_output, observer as dev_observer, publication
import browser_submit

REQ = 'REQ_20261013T190000Z_0441'
CHAT = 'https://chatgpt.com/c/owned-gpt-image'
PROMPT = 'POSTMAN_REQUEST_ID: ' + REQ + '\nСоздай одно изображение'


class ImageOutputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.binding = {'channel': str(self.root), 'requestId': REQ}
        raw = io.BytesIO()
        Image.new('RGB', (73, 67), (44, 109, 202)).save(raw, format='PNG')
        self.png = raw.getvalue()

    def native_download(self, page, original=None):
        """Isolated ChatGPT fixture: native control downloads bytes, not preview."""
        page.evaluate("""encoded => {
            window.downloadClicks = 0;
            for (const gallery of document.querySelectorAll('[data-testid="generated-image-gallery"]')) {
                const button = document.createElement('button');
                button.setAttribute('aria-label', 'Download image');
                button.onclick = () => {
                    window.downloadClicks++;
                    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
                    a.download = 'original.png';
                    a.click();
                };
                gallery.append(button);
            }
        }""", base64.b64encode(original or self.png).decode('ascii'))

    def visual_binding(self, visual):
        job = "22222222-2222-4222-8222-222222222222"
        binding = {**self.binding, "imageMode": True, "jobId": job}
        revision = "a" * 40
        source = "b" * 40
        receipt = {"version": 1, "launchVersion": 2, "imageMode": True,
                   "requestId": REQ, "jobId": job, "commit": revision,
                   "sourceCommit": source,
                   "taskUrl": "", "rulesUrl": "",
                   "intentSha256": hashlib.sha256(visual.encode("utf-8")).hexdigest()}
        (self.root / "publication.json").write_text(json.dumps(receipt), encoding="utf-8")
        return binding

    def test_real_playwright_decodes_exact_own_generated_image_without_zip(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            try:
                page = browser.new_page()
                data = 'data:image/png;base64,' + base64.b64encode(self.png).decode('ascii')
                page.set_content('<main><div data-turn-key="group-ours">'
                    '<div data-user-message-bubble="true">' + PROMPT + '</div>'
                    '<div data-message-author-role="assistant">'
                    '<div data-testid="generated-image-gallery">'
                    '<img width="73" height="67" src="' + data + '"></div></div></div></main>')
                page.wait_for_function('document.querySelector("img").complete && document.querySelector("img").naturalWidth===73')
                # The browser must prove an exact owned chat, not any random page.
                page.goto('about:blank')
                self.assertIsNone(image_output.observe_owned_image(page, PROMPT, CHAT, self.binding))
                page.set_content('<main><div data-turn-key="group-ours">'
                    '<div data-user-message-bubble="true">' + PROMPT + '</div>'
                    '<div data-message-author-role="assistant">'
                    '<div data-testid="generated-image-gallery">'
                    '<img width="73" height="67" src="' + data + '"></div></div></div></main>')
                page.wait_for_function('document.querySelector("img").complete && document.querySelector("img").naturalWidth===73')
                # The test page URL is intentionally isolated; the trusted
                # ownership proof is supplied by the exact ChatGPT URL only.
                self.native_download(page)
                with patch.object(type(page), 'url', property(lambda _: CHAT)):
                    result = image_output.observe_owned_image(page, PROMPT, CHAT, self.binding)
                self.assertIsNotNone(result)
                self.assertEqual(result['code'], 'DEVSPACE_IMAGE_RESULT_DURABLE')
                details = result['details']
                self.assertEqual(details['source'], 'image_result')
                self.assertEqual(details['imageWidth'], 73)
                self.assertEqual(details['imageHeight'], 67)
                self.assertEqual(Path(details['resultImage']).read_bytes(), self.png)
                self.assertFalse((self.root / 'event.json').exists())
                self.assertEqual(len(list(self.root.glob('*.png'))), 1)
            finally:
                browser.close()

    def test_image_mode_one_owned_visual_turn_saves_original_bytes(self):
        visual = "Нарисуй одну яркую звезду."
        binding = self.visual_binding(visual)
        preview = io.BytesIO()
        Image.new('RGB', (64, 64), (1, 2, 3)).save(preview, format='PNG')
        encoded = base64.b64encode(preview.getvalue()).decode("ascii")
        markup = ('<main><div data-turn-key="ours">'
                  '<div data-user-message-bubble="true">' + visual + '</div>'
                  '<div data-message-author-role="assistant">'
                  '<div data-testid="generated-image-gallery">'
                  '<img src="data:image/png;base64,' + encoded + '"></div>'
                  '</div></div></main>')
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                page = browser.new_page()
                page.set_content(markup)
                page.wait_for_function("document.querySelector('img').naturalWidth===64")
                self.native_download(page)
                with patch.object(type(page), "url", property(lambda _: CHAT)):
                    result = image_output.observe_owned_image(page, visual, CHAT, binding)
                self.assertIsNotNone(result)
                details = result["details"]
                self.assertEqual(details["generationState"], "CONFIRMED")
                self.assertEqual(details["saveState"], "SAVED")
                self.assertEqual(details["deliveryState"], "READY_FOR_LEADER_READ")
                self.assertEqual(details["imageMimeType"], "image/png")
                self.assertEqual(details["imageSource"], "NATIVE_GENERATED_IMAGE_DOWNLOAD")
                self.assertEqual(details["downloadPhase"], "COMPLETE")
                self.assertEqual(details["downloadState"], "DOWNLOADED")
                self.assertTrue(details["downloadAttempted"])
                self.assertEqual(details["downloadError"], "NONE")
                self.assertEqual(page.evaluate("window.downloadClicks"), 1)
                self.assertNotEqual(preview.getvalue(), self.png)
                self.assertEqual(details["imageSha256"], hashlib.sha256(self.png).hexdigest())
                self.assertEqual(Path(details["resultImage"]).read_bytes(), self.png)
                self.assertTrue(Path(details["resultImage"]).is_absolute())
            finally:
                browser.close()

    def test_preview_without_download_or_invalid_original_is_not_delivered(self):
        visual = "Нарисуй одну звезду."
        binding = self.visual_binding(visual)
        data = base64.b64encode(self.png).decode('ascii')
        html = ('<main><div data-turn-key="ours">'
                '<div data-user-message-bubble="true">' + visual + '</div>'
                '<div data-message-author-role="assistant">'
                '<div data-testid="generated-image-gallery"><img src="data:image/png;base64,' +
                data + '"></div></div></div></main>')
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='chrome', headless=True)
            try:
                page = browser.new_page()
                page.set_content(html)
                page.wait_for_function("document.querySelector('img').naturalWidth===73")
                with patch.object(type(page), 'url', property(lambda _: CHAT)):
                    missing = {}
                    self.assertIsNone(image_output.observe_owned_image(
                        page, visual, CHAT, binding, diagnostic=missing))
                    self.assertEqual(missing["downloadPhase"], "FIND_NATIVE_BUTTON")
                    self.assertEqual(missing["downloadError"], "NATIVE_BUTTON_NOT_FOUND")
                    self.assertEqual(missing["downloadState"], "NOT_ATTEMPTED")
                    self.assertFalse(missing["downloadAttempted"])
                    self.assertEqual(missing["saveState"], "NOT_ATTEMPTED")
                    self.native_download(page, original=b'not an original image')
                    invalid = {}
                    self.assertIsNone(image_output.observe_owned_image(
                        page, visual, CHAT, binding, diagnostic=invalid))
                    self.assertEqual(invalid["downloadPhase"], "STORE_ORIGINAL")
                    self.assertEqual(invalid["downloadState"], "DOWNLOADED")
                    self.assertEqual(invalid["downloadError"], "DEVSPACE_IMAGE_DECODE_FAILED")
                    self.assertEqual(invalid["saveState"], "SAVE_FAILED")
                self.assertEqual(page.evaluate('window.downloadClicks'), 1)
                self.assertFalse(list(self.root.glob('POSTMAN_IMAGE_*')))
            finally:
                browser.close()

    def test_owned_preview_viewer_downloads_original_only_once(self):
        visual = "Нарисуй один маяк."
        binding = self.visual_binding(visual)
        preview = io.BytesIO()
        Image.new("RGB", (64, 64), (1, 2, 3)).save(preview, format="PNG")
        html = ('<main><div data-turn-key="ours"><div data-user-message-bubble="true">' +
                visual + '</div><div data-message-author-role="assistant">' +
                '<div data-testid="generated-image-gallery">' +
                '<button data-testid="generated-image-preview"><img src="data:image/png;base64,' +
                base64.b64encode(preview.getvalue()).decode("ascii") +
                '"></button></div></div></div></main>')
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                page = browser.new_page()
                page.set_content(html)
                page.wait_for_function("document.querySelector('img').naturalWidth === 64")
                page.evaluate("""encoded => {
                    window.previewClicks = 0;
                    window.downloadClicks = 0;
                    document.querySelector('[data-testid="generated-image-preview"]').onclick = () => {
                        window.previewClicks++;
                        const viewer = document.createElement('dialog');
                        const button = document.createElement('button');
                        button.setAttribute('aria-label', 'Download image');
                        button.onclick = () => {
                            window.downloadClicks++;
                            const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
                            const a = document.createElement('a');
                            a.href = URL.createObjectURL(new Blob([bytes], {type:'image/png'}));
                            a.download = 'original.png';
                            a.click();
                        };
                        viewer.append(button);
                        document.body.append(viewer);
                        viewer.showModal();
                    };
                }""", base64.b64encode(self.png).decode("ascii"))
                diagnostic = {}
                with patch.object(type(page), "url", property(lambda _: CHAT)):
                    result = image_output.observe_owned_image(
                        page, visual, CHAT, binding, diagnostic=diagnostic)
                self.assertIsNotNone(result)
                self.assertEqual(result["details"]["imageSource"], "NATIVE_GENERATED_IMAGE_DOWNLOAD")
                self.assertEqual(Path(result["details"]["resultImage"]).read_bytes(), self.png)
                self.assertNotEqual(preview.getvalue(), self.png)
                self.assertEqual(diagnostic["downloadPhase"], "COMPLETE")
                self.assertEqual(diagnostic["downloadState"], "DOWNLOADED")
                self.assertEqual(diagnostic["saveState"], "SAVED")
                self.assertEqual(page.evaluate("window.previewClicks"), 1)
                self.assertEqual(page.evaluate("window.downloadClicks"), 1)
                self.assertEqual(len(list(self.root.glob('POSTMAN_IMAGE_*'))), 1)
            finally:
                browser.close()

    def test_native_download_missing_event_records_attempted_failure(self):
        visual = "Нарисуй одну звезду."
        binding = self.visual_binding(visual)
        data = base64.b64encode(self.png).decode("ascii")
        html = ('<main><div data-turn-key="ours"><div data-user-message-bubble="true">' +
                visual + '</div><div data-message-author-role="assistant">' +
                '<div data-testid="generated-image-gallery"><img src="data:image/png;base64,' +
                data + '"><button aria-label="Download image">Save</button>' +
                '</div></div></div></main>')
        class TimedOutDownload:
            def __enter__(self):
                return self
            def __exit__(self, *_):
                raise TimeoutError("private browser error text must not escape")
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                page = browser.new_page()
                page.set_content(html)
                page.wait_for_function("document.querySelector('img').naturalWidth===73")
                diagnostic = {}
                with patch.object(type(page), "url", property(lambda _: CHAT)), \
                     patch.object(type(page), "expect_download", return_value=TimedOutDownload()):
                    result = image_output.observe_owned_image(
                        page, visual, CHAT, binding, diagnostic=diagnostic)
                self.assertIsNone(result)
                self.assertEqual(diagnostic["downloadPhase"], "WAIT_NATIVE_DOWNLOAD")
                self.assertEqual(diagnostic["downloadState"], "FAILED")
                self.assertTrue(diagnostic["downloadAttempted"])
                self.assertEqual(diagnostic["saveState"], "NOT_ATTEMPTED")
                self.assertEqual(diagnostic["downloadError"], "EXCEPTION")
                self.assertEqual(diagnostic["downloadExceptionType"], "TimeoutError")
                self.assertNotIn("private", repr(diagnostic))
                self.assertFalse(list(self.root.glob("POSTMAN_IMAGE_*")))
            finally:
                browser.close()

    def test_bad_bytes_or_foreign_turn_never_create_output(self):
        self.assertIsNone(image_output.observe_owned_image(
            type('Page', (), {'url': 'https://chatgpt.com/c/foreign'})(), PROMPT, CHAT,
            self.binding))
        with self.assertRaisesRegex(ValueError, 'DEVSPACE_IMAGE_DECODE_FAILED'):
            image_output._store(self.binding, b'not an image')
        self.assertFalse(list(self.root.iterdir()))

    def test_modern_sibling_gallery_is_inside_same_assistant_turn(self):
        visual = "Нарисуй один оранжевый квадрат."
        binding = self.visual_binding(visual)
        data = base64.b64encode(self.png).decode("ascii")
        html = ('<main><div data-user-message-bubble="true">' + visual + '</div>'
                '<section data-content-search-turn-key="owned-assistant">'
                '<div data-chatgpt-selection-message-id="assistant-1"></div>'
                '<div data-testid="generated-image-gallery">'
                '<img src="data:image/png;base64,' + data + '"></div></section></main>')
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                page = browser.new_page()
                page.set_content(html)
                page.wait_for_function("document.querySelector('img').naturalWidth===73")
                self.native_download(page)
                with patch.object(type(page), "url", property(lambda _: CHAT)):
                    result = image_output.observe_owned_image(page, visual, CHAT, binding)
                self.assertIsNotNone(result)
                self.assertEqual(Path(result["details"]["resultImage"]).read_bytes(), self.png)
            finally:
                browser.close()

    def test_foreign_newer_input_and_multiple_images_are_not_outputs(self):
        visual = "Нарисуй один зелёный круг."
        binding = self.visual_binding(visual)
        encoded = base64.b64encode(self.png).decode("ascii")
        image = '<img src="data:image/png;base64,' + encoded + '">'
        user = '<div data-user-message-bubble="true">' + visual + '</div>'
        gallery = '<div data-testid="generated-image-gallery">' + image + '</div>'
        assistant = '<div data-message-author-role="assistant">' + gallery + '</div>'
        cases = [
            '<main><div data-turn-key="own">' + user + assistant + '</div>' +
                '<div data-turn-key="later"><div data-user-message-bubble="true">foreign</div></div></main>',
            '<main><div data-turn-key="own"><div data-user-message-bubble="true">' +
                visual + image + '</div><div data-message-author-role="assistant">no image</div></div></main>',
            '<main><div data-turn-key="own">' + user +
                '<div data-message-author-role="assistant"><div data-testid="generated-image-gallery">' +
                image + image + '</div></div></div></main>',
        ]
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                page = browser.new_page()
                with patch.object(type(page), "url", property(lambda _: CHAT)):
                    for markup in cases:
                        with self.subTest(case=cases.index(markup)):
                            page.set_content(markup)
                            page.wait_for_function("Array.from(document.images).every(x=>x.complete)")
                            self.assertIsNone(image_output.observe_owned_image(
                                page, visual, CHAT, binding))
                self.assertFalse(list(self.root.glob("POSTMAN_IMAGE_*")))
            finally:
                browser.close()

    def test_result_can_be_registered_by_signal_observer_without_bell(self):
        from types import SimpleNamespace
        clock = [0.]
        page = SimpleNamespace(url=CHAT)
        captured = {'ok': True, 'code': 'DEVSPACE_IMAGE_RESULT_DURABLE',
                    'details': {'source': 'image_result', 'imageWidth': 73}}
        with patch.object(dev_observer, 'read_event', return_value=None), \
             patch.object(dev_observer.controls, 'process_one', return_value=None), \
             patch.object(dev_observer.observer, 'observe_next_assistant',
                 return_value={'ok': False, 'code': 'ASSISTANT_NOT_STARTED', 'details': {}}), \
             patch.object(dev_observer.image_output, 'observe_owned_image',
                 return_value=captured) as capture:
            result = dev_observer.wait_for_signal(page, PROMPT, CHAT, self.binding,
                timeout_ms=1000, interval_ms=1000, count=0,
                monotonic=lambda: clock[0], sleep=lambda s:clock.__setitem__(0,clock[0]+s),
                persist=lambda _:None)
        self.assertEqual(result['code'], 'DEVSPACE_IMAGE_RESULT_DURABLE')
        self.assertEqual(result['details']['conversationRef'], CHAT)
        capture.assert_called_once()

    def test_dom_aliases_count_one_logical_user_but_distinct_users_remain(self):
        markup = ('<main>'
                  '<div data-message-author-role="user" data-turn-key="u-one">'
                  '<div data-message-author-role="user" data-testid="user-message-content">same</div></div>'
                  '<div data-message-author-role="user" data-turn-key="u-two">'
                  '<div data-message-author-role="user" data-testid="user-message-content">same</div></div>'
                  '</main>')
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="chrome", headless=True)
            try:
                page = browser.new_page()
                page.set_content(markup)
                self.assertEqual(browser_submit.collect_user_turn_texts(page), ["same", "same"])
                turns, _ = dev_observer.observer.snapshot_turns(page)
                self.assertEqual([turn["role"] for turn in turns], ["user", "user"])
            finally:
                browser.close()

    def test_bridge_image_unknown_does_not_resend_on_reentry(self):
        from types import SimpleNamespace
        import web_worker_bridge
        visual = "Сгенерируй одно изображение горного озера."
        binding = self.visual_binding(visual)
        receipt = json.loads((self.root / "publication.json").read_text(encoding="utf-8"))
        page = SimpleNamespace(url=CHAT, close=lambda: None)
        class Factory:
            def __enter__(self):
                self.chromium = self
                return self
            def __exit__(self, *args):
                pass
            def connect_over_cdp(self, *args, **kwargs):
                return self
            @property
            def contexts(self):
                return [self]
            def new_page(self):
                return page

        bridge = web_worker_bridge.WebWorkerBridge(root=self.root / "web")
        submitted = {"ok": False, "code": "PROMPT_SEND_UNKNOWN", "sendState": "UNKNOWN",
                     "details": {"chatUrl": CHAT}}
        diagnostic = {"ok": True, "code": "DEVSPACE_DIAGNOSTIC",
                      "details": {"source": "transport_diagnostic", "diagnostic": "UNKNOWN",
                                  "sendState": "UNKNOWN", "generationState": "CONFIRMED",
                                  "saveState": "NOT_ATTEMPTED", "deliveryState": "UNAVAILABLE",
                                  "downloadPhase": "FIND_NATIVE_BUTTON",
                                  "downloadState": "NOT_ATTEMPTED",
                                  "downloadAttempted": False,
                                  "downloadError": "NATIVE_BUTTON_NOT_FOUND"}}
        args = dict(task_url=receipt["taskUrl"], prompt=visual,
                    expected_filename="", expected_request={"transportKind": "devspace"},
                    artifact_mode=False, devspace_binding=binding, playwright_factory=Factory,
                    observer_timeout_ms=1000, max_reminders=0)
        with patch.object(web_worker_bridge.browser_submit, "submit_fresh_prompt",
                          return_value=submitted) as send, \
             patch.object(dev_observer.controls, "revoked", return_value=False), \
             patch.object(dev_observer, "wait_for_image", return_value=diagnostic) as observe:
            first = bridge.run_request(REQ, **args)
            second = bridge.run_request(REQ, **args)
        self.assertEqual(first["code"], "DEVSPACE_DIAGNOSTIC")
        self.assertEqual(second["code"], "DEVSPACE_DIAGNOSTIC")
        send.assert_called_once()
        observe.assert_called_once()
        self.assertEqual(observe.call_args.kwargs["send_state"], "UNKNOWN")
        status = bridge.read_state(REQ)
        self.assertEqual(status["downloadPhase"], "FIND_NATIVE_BUTTON")
        self.assertEqual(status["downloadError"], "NATIVE_BUTTON_NOT_FOUND")
        self.assertFalse(status["downloadAttempted"])
        self.assertEqual(status["saveState"], "NOT_ATTEMPTED")

    def test_verified_image_with_unavailable_bytes_reports_generation_separately(self):
        from types import SimpleNamespace
        visual = "Создай один красный круг."
        binding = self.visual_binding(visual)
        clock = [0.0]

        def observed(*args, **kwargs):
            clock[0] += 0.4
            return {"ok": True, "code": "ASSISTANT_TURN_COMPLETED",
                    "details": {"assistantImageCount": 1}}

        with patch.object(dev_observer.observer, "observe_next_assistant",
                          side_effect=observed), \
             patch.object(dev_observer.image_output, "observe_owned_image",
                          return_value=None) as extract:
            result = dev_observer.wait_for_image(SimpleNamespace(url=CHAT),
                visual, CHAT, binding, timeout_ms=300,
                monotonic=lambda: clock[0],
                sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
        self.assertEqual(result["details"]["generationState"], "CONFIRMED")
        self.assertEqual(result["details"]["saveState"], "NOT_ATTEMPTED")
        self.assertEqual(result["details"]["downloadState"], "NOT_ATTEMPTED")
        self.assertEqual(result["details"]["downloadPhase"], "NOT_STARTED")
        self.assertEqual(result["details"]["deliveryState"], "UNAVAILABLE")
        extract.assert_called_once()

    def test_wait_for_image_retains_failed_store_diagnostics(self):
        from types import SimpleNamespace
        visual = "Нарисуй одно солнце."
        binding = self.visual_binding(visual)
        clock = [0.0]
        def observed(*args, **kwargs):
            clock[0] += 0.4
            return {"ok": True, "code": "ASSISTANT_TURN_COMPLETED",
                    "details": {"assistantImageCount": 1}}
        def failed_save(*args, **kwargs):
            kwargs["diagnostic"].update(downloadPhase="STORE_ORIGINAL",
                downloadState="DOWNLOADED", downloadAttempted=True,
                downloadError="DEVSPACE_IMAGE_SAVE_FAILED", saveState="SAVE_FAILED",
                downloadExceptionType="ValueError")
            return None
        with patch.object(dev_observer.observer, "observe_next_assistant",
                          side_effect=observed), \
             patch.object(dev_observer.image_output, "observe_owned_image",
                          side_effect=failed_save):
            result = dev_observer.wait_for_image(SimpleNamespace(url=CHAT),
                visual, CHAT, binding, timeout_ms=300, send_state="UNKNOWN",
                monotonic=lambda: clock[0],
                sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds))
        details = result["details"]
        self.assertEqual(details["generationState"], "CONFIRMED")
        self.assertEqual(details["sendState"], "UNKNOWN")
        self.assertEqual(details["downloadState"], "DOWNLOADED")
        self.assertEqual(details["downloadPhase"], "STORE_ORIGINAL")
        self.assertTrue(details["downloadAttempted"])
        self.assertEqual(details["downloadError"], "DEVSPACE_IMAGE_SAVE_FAILED")
        self.assertEqual(details["downloadExceptionType"], "ValueError")
        self.assertEqual(details["saveState"], "SAVE_FAILED")
        self.assertEqual(details["deliveryState"], "UNAVAILABLE")

    def test_unknown_image_send_wait_is_read_only_not_another_send(self):
        from types import SimpleNamespace
        visual = "Нарисуй один жёлтый шар."
        binding = self.visual_binding(visual)
        clock = [0.0]
        def observe(*args, **kwargs):
            self.assertTrue(kwargs["image_mode"])
            clock[0] += 0.3
            return {"ok": False, "code": "ASSISTANT_TURN_TIMEOUT", "details": {}}
        with patch.object(dev_observer.observer, "observe_next_assistant",
                          side_effect=observe) as watched, \
             patch.object(browser_submit, "submit_existing_prompt",
                          side_effect=AssertionError("no resend")) as sent, \
             patch.object(dev_observer.image_output, "observe_owned_image",
                          side_effect=AssertionError("no generated image")) as captured:
            result = dev_observer.wait_for_image(SimpleNamespace(url=CHAT),
                visual, CHAT, binding, timeout_ms=200, send_state="UNKNOWN",
                monotonic=lambda:clock[0],
                sleep=lambda seconds:clock.__setitem__(0, clock[0] + seconds))
        self.assertEqual(result["details"]["sendState"], "UNKNOWN")
        self.assertEqual(result["details"]["saveState"], "NOT_SAVED")
        self.assertEqual(result["details"]["downloadState"], "NOT_ATTEMPTED")
        self.assertEqual(result["details"]["downloadPhase"], "NOT_STARTED")
        self.assertFalse(result["details"]["downloadAttempted"])
        self.assertEqual(result["details"]["deliveryState"], "UNAVAILABLE")
        watched.assert_called_once()
        sent.assert_not_called()
        captured.assert_not_called()

if __name__ == '__main__':
    unittest.main()
