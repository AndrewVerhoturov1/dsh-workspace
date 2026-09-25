from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from postman.direct import postman_ask


REQ = "REQ_20260922T200000Z_1234"


class Publisher:
    def __init__(self, **_kwargs):
        pass

    def snapshot(self):
        return SimpleNamespace(prepublication_commit="a" * 40, root_entries=("postman",))

    def publish_content(self, request_id, content, *, expected_parent, root_entries):
        return SimpleNamespace(
            task_url=f"https://example.test/{request_id}.md",
            prepublication_commit=expected_parent,
            publication_commit="b" * 40,
        )


class Bridge:
    result: dict = {}

    def __init__(self, **_kwargs):
        pass

    def run_request(self, request_id, **_kwargs):
        return self.__class__.result


class PostmanAskDeliveryTests(unittest.TestCase):
    def make_direct(self, root: str) -> postman_ask.DirectPostmanAsk:
        return postman_ask.DirectPostmanAsk(
            repo_root=root,
            direct_root=root,
            publisher_factory=Publisher,
            bridge_factory=Bridge,
            ensure_browser=lambda **_kwargs: {"cdpUrl": "http://127.0.0.1:9222"},
        )

    def test_exactly_4096_characters_stay_inline_without_markdown_file(self):
        with tempfile.TemporaryDirectory() as root:
            direct = self.make_direct(root)
            text = "x" * postman_ask.INLINE_ASSISTANT_TEXT_MAX_CHARS
            sha = hashlib.sha256(text.encode("utf-8")).hexdigest()

            delivery = direct._materialize_delivery(REQ, text, sha)

            self.assertEqual(delivery["deliveryMode"], postman_ask.DELIVERY_INLINE)
            self.assertEqual(delivery["assistantText"], text)
            self.assertEqual(delivery["assistantTextLength"], 4096)
            self.assertEqual(delivery["assistantTextByteLength"], 4096)
            self.assertEqual(delivery["assistantTextSha256"], sha)
            self.assertNotIn("resultFile", delivery)
            self.assertFalse((Path(root) / "text-results").exists())

    def test_4097_characters_spill_to_exact_utf8_markdown_without_inline_text(self):
        with tempfile.TemporaryDirectory() as root:
            direct = self.make_direct(root)
            text = "Ж" + ("x" * postman_ask.INLINE_ASSISTANT_TEXT_MAX_CHARS)
            encoded = text.encode("utf-8")
            sha = hashlib.sha256(encoded).hexdigest()

            delivery = direct._materialize_delivery(REQ, text, sha)

            self.assertEqual(delivery["deliveryMode"], postman_ask.DELIVERY_FILE)
            self.assertNotIn("assistantText", delivery)
            self.assertEqual(delivery["assistantTextLength"], 4097)
            self.assertEqual(delivery["assistantTextByteLength"], len(encoded))
            self.assertEqual(delivery["assistantTextSha256"], sha)
            self.assertEqual(delivery["resultFileSha256"], sha)
            self.assertEqual(delivery["resultMimeType"], "text/markdown")
            self.assertEqual(delivery["resultEncoding"], "utf-8")
            self.assertEqual(delivery["resultFileName"], f"POSTMAN_{REQ}_ANSWER.md")
            result_path = Path(delivery["resultFile"])
            self.assertTrue(result_path.is_absolute())
            self.assertEqual(result_path.read_bytes(), encoded)
            self.assertEqual(result_path.name, delivery["resultFileName"])

    def test_inline_and_file_success_keep_publication_identity(self):
        for length, expected_mode in ((4096, postman_ask.DELIVERY_INLINE),
                                      (4097, postman_ask.DELIVERY_FILE)):
            with self.subTest(length=length), tempfile.TemporaryDirectory() as root:
                direct = self.make_direct(root)
                text = "Ж" * length
                sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
                Bridge.result = {"ok": True, "code": postman_ask.ASSISTANT_COMPLETED_NO_ARTIFACT,
                                 "details": {"assistantText": "envelope", "assistantIndex": 7,
                                             "noArtifactRecheckMs": 10_000}}
                with patch.object(postman_ask.text_result, "parse_text_envelope",
                                  return_value={"ok": True, "details": {"assistantText": text,
                                                                          "assistantTextSha256": sha}}):
                    result = direct.run(request_id=REQ, task="probe")
                self.assertEqual(result["deliveryMode"], expected_mode)
                self.assertEqual(direct.publication_receipt["requestId"], REQ)
                self.assertEqual(direct.publication_receipt["taskPublicationCommit"], "b" * 40)
                self.assertEqual(direct.publication_receipt["baseCommit"], "a" * 40)
                self.assertNotIn("publicationReceipt", result)
                if expected_mode == postman_ask.DELIVERY_FILE:
                    self.assertNotIn("assistantText", result)
                    self.assertEqual(Path(result["resultFile"]).read_text(encoding="utf-8"), text)
                else:
                    self.assertEqual(result["assistantText"], text)
                    self.assertNotIn("resultFile", result)

    def test_run_file_mode_keeps_full_text_out_of_terminal_and_state_json(self):
        with tempfile.TemporaryDirectory() as root:
            direct = self.make_direct(root)
            text = "Д" + ("x" * postman_ask.INLINE_ASSISTANT_TEXT_MAX_CHARS)
            sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
            Bridge.result = {
                "ok": True,
                "code": postman_ask.ASSISTANT_COMPLETED_NO_ARTIFACT,
                "details": {
                    "assistantText": "wrapped transport text",
                    "assistantTextSha256": "c" * 64,
                    "assistantIndex": 7,
                    "conversationUrl": "https://chatgpt.com/c/postman-file-test",
                    "conversationId": "postman-file-test",
                    "noArtifactRecheckMs": 10_000,
                },
            }
            parsed = {
                "ok": True,
                "details": {
                    "assistantText": text,
                    "assistantTextSha256": sha,
                },
            }

            with patch.object(postman_ask.text_result, "parse_text_envelope", return_value=parsed):
                terminal = direct.run(request_id=REQ, task="probe")

            state = json.loads(direct.state_path(REQ).read_text(encoding="utf-8"))
            self.assertEqual(terminal["deliveryMode"], postman_ask.DELIVERY_FILE)
            self.assertNotIn("assistantText", terminal)
            self.assertNotIn("assistantText", state)
            self.assertNotIn("workerDetails", state)
            self.assertEqual(Path(terminal["resultFile"]).read_text(encoding="utf-8"), text)
            self.assertEqual(state["resultFile"], terminal["resultFile"])
            self.assertEqual(state["assistantTextSha256"], sha)


if __name__ == "__main__":
    unittest.main()
