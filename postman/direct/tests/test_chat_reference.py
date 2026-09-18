from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

DIRECT_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = DIRECT_DIR.parent / "web"
for path in (DIRECT_DIR, WEB_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import chat_reference

REQ = "REQ_20260917T101323Z_7008"
REPO = "AndrewVerhoturov1/dsh-workspace"
URL = "https://chatgpt.com/c/861d4716-8c1b-41bc-b37e-a912e2323e70"


class ChatReferenceTests(unittest.TestCase):
    def test_normalize_conversation_url(self):
        conversation_id, url = chat_reference.normalize_conversation_url(URL)
        self.assertEqual(conversation_id, "861d4716-8c1b-41bc-b37e-a912e2323e70")
        self.assertEqual(url, URL)

    def test_resolve_prefers_durable_handoff(self):
        with tempfile.TemporaryDirectory() as root:
            direct_root = Path(root) / "direct"
            path = direct_root / "results" / f"{REQ}.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "ok": True,
                "code": "RESULT_DURABLE",
                "state": "RESULT_DURABLE",
                "requestId": REQ,
                "repository": REPO,
                "conversationUrl": URL,
            }), encoding="utf-8")
            result = chat_reference.resolve_chat_reference(direct_root, REQ, expected_repository=REPO)
            self.assertEqual(result.source, "durable_handoff")
            self.assertEqual(result.conversation_url, URL)

    def test_resolve_recovers_old_direct_state_submit_proof(self):
        with tempfile.TemporaryDirectory() as root:
            direct_root = Path(root) / "direct"
            path = direct_root / "requests" / f"{REQ}.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "state": "RESULT_DURABLE",
                "requestId": REQ,
                "repository": REPO,
                "workerDetails": {
                    "submitProof": {"details": {"chatUrl": URL}}
                },
            }), encoding="utf-8")
            result = chat_reference.resolve_chat_reference(direct_root, REQ, expected_repository=REPO)
            self.assertEqual(result.source, "direct_state")
            self.assertEqual(result.conversation_url, URL)

    def test_missing_url_does_not_search_ui(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(chat_reference.ChatReferenceError) as ctx:
                chat_reference.resolve_chat_reference(Path(root) / "direct", REQ, expected_repository=REPO)
            self.assertEqual(ctx.exception.code, "DIRECT_CHAT_REFERENCE_UNAVAILABLE")
            self.assertFalse(ctx.exception.details["uiSearchAttempted"])


if __name__ == "__main__":
    unittest.main()
