from __future__ import annotations

import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

WEB_DIR = Path(__file__).resolve().parents[1]
DIRECT_DIR = WEB_DIR.parent / "direct"
for item in (str(WEB_DIR), str(DIRECT_DIR)):
    if item not in sys.path:
        sys.path.insert(0, item)

import browser_observer as observer
import browser_submit as submit
import web_worker_bridge as bridge_module
import postman_direct as direct

REQ = "REQ_20260902T010203Z_1874"
KEY = f"POSTMAN_REQUEST_ID: {REQ}"
PROMPT = "\n".join(
    [
        KEY,
        "policy: https://example.test/policy",
        "task_file: https://example.test/task",
        "allowed_paths_json: [\"src\"]",
        "Render `inline code` and **markdown**.",
    ]
)


class WP014R2CorrelationTests(unittest.TestCase):
    def test_request_key_is_extracted_only_from_first_nonempty_line(self):
        self.assertEqual(submit.request_key_line_from_prompt(PROMPT), KEY)
        self.assertEqual(submit.request_key_line_from_prompt("hello\n" + KEY), "")

    def test_observer_falls_back_to_request_key_when_rendered_markdown_differs(self):
        rendered = "\n".join(
            [
                KEY,
                "policy: https://example.test/policy",
                "task_file: https://example.test/task",
                "allowed_paths_json: [\"src\"]",
                "Render inline code and markdown.",
            ]
        )
        turns = [
            {"index": 0, "role": "user", "text": rendered},
            {"index": 1, "role": "assistant", "text": "working"},
        ]
        self.assertNotEqual(rendered, PROMPT)
        self.assertEqual(observer.find_user_anchor(turns, PROMPT), 0)
        correlated = observer.correlate_next_assistant(turns, PROMPT)
        self.assertTrue(correlated["ok"])
        self.assertEqual(correlated["assistantIndex"], 1)

    def test_non_postman_prompt_still_requires_exact_rendered_text(self):
        turns = [{"index": 0, "role": "user", "text": "rendered differently"}]
        self.assertIsNone(observer.find_user_anchor(turns, "plain prompt"))

    def test_bridge_carries_submit_attestation_into_p5_proof(self):
        chat_url = "https://chatgpt.com/c/wp014r2"
        captured = {}

        class Page:
            def close(self):
                pass

        class Context:
            pages = []
            def new_page(self):
                return Page()
            def close(self):
                pass

        context = Context()

        class Browser:
            contexts = [context]

        class Chromium:
            def connect_over_cdp(self, url):
                return Browser()

        class Playwright:
            chromium = Chromium()

        class CM:
            def __enter__(self):
                return Playwright()
            def __exit__(self, exc_type, exc, tb):
                return False

        def fake_submit(page, prompt, timeout_ms=None):
            return {
                "ok": True,
                "code": submit.PROMPT_SEND_CONFIRMED,
                "sendState": submit.PROVEN_SENT,
                "details": {"chatUrl": chat_url, "userTurnCorrelationMode": "request_key"},
            }

        def fake_observe(*args, **kwargs):
            return {
                "ok": True,
                "code": observer.ASSISTANT_TURN_COMPLETED,
                "details": {
                    "chatUrl": chat_url,
                    "assistantIndex": 1,
                    "assistantTextSha256": "a" * 64,
                },
            }

        def fake_detect(*args, **kwargs):
            captured.update(kwargs["completed_observer_result"]["details"])
            return {"ok": False, "code": "EXPECTED_TEST_STOP", "details": {}}

        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(bridge_module.browser_submit, "submit_fresh_prompt", side_effect=fake_submit),
            patch.object(bridge_module.browser_observer, "observe_next_assistant", side_effect=fake_observe),
            patch.object(bridge_module.artifact_detector, "detect_artifact_dom", side_effect=fake_detect),
        ):
            bridge = bridge_module.WebWorkerBridge(root=root)
            result = bridge.run_request(
                REQ,
                task_url="https://example.test/task.md",
                prompt=PROMPT,
                expected_filename=f"POSTMAN_{REQ}_RESULT.zip",
                expected_request={},
                playwright_factory=lambda: CM(),
            )

        self.assertFalse(result["ok"])
        self.assertEqual(captured["submitCode"], submit.PROMPT_SEND_CONFIRMED)
        self.assertEqual(captured["submitSendState"], submit.PROVEN_SENT)
        self.assertEqual(captured["promptSha256"], submit.prompt_sha256(PROMPT))
        self.assertEqual(captured["submitCorrelationMode"], "request_key")

    def test_direct_bridge_waits_long_enough_for_coding_artifact(self):
        self.assertGreaterEqual(direct.DEFAULT_ASSISTANT_TIMEOUT_MS, 10 * 60 * 1000)


if __name__ == "__main__":
    unittest.main()
