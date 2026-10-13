from __future__ import annotations

import base64
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
from postman.devspace import image_output, observer as dev_observer

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

    def test_bad_bytes_or_foreign_turn_never_create_output(self):
        self.assertIsNone(image_output.observe_owned_image(
            type('Page', (), {'url': 'https://chatgpt.com/c/foreign'})(), PROMPT, CHAT,
            self.binding))
        with self.assertRaisesRegex(ValueError, 'DEVSPACE_IMAGE_DECODE_FAILED'):
            image_output._store(self.binding, base64.b64encode(b'not an image').decode())
        self.assertFalse(list(self.root.iterdir()))

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

if __name__ == '__main__':
    unittest.main()
