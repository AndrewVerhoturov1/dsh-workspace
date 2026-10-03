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
    def test_transport_failure_is_not_eligible_for_continuation(self):
        with tempfile.TemporaryDirectory() as root:
            direct_root = Path(root) / "direct"
            path = direct_root / "requests" / f"{REQ}.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "ok": False,
                "code": "POSTMAN_TRANSPORT_FAILED",
                "state": "FAILED",
                "requestId": REQ,
                "repository": REPO,
                "conversationUrl": URL,
            }), encoding="utf-8")
            with self.assertRaises(chat_reference.ChatReferenceError) as ctx:
                chat_reference.resolve_chat_reference(direct_root, REQ, expected_repository=REPO)
            self.assertEqual(ctx.exception.code, "DIRECT_CHAT_REFERENCE_UNAVAILABLE")

    def failed_record(self, **fields):
        return {"requestId": REQ, "repository": REPO, "state": "FAILED", "ok": False,
                "failureCode": "ASSISTANT_TURN_TIMEOUT", "conversationUrl": URL,
                "conversationId": URL.rsplit("/", 1)[-1], "sendProofClass": "PROVEN_SENT", **fields}

    def test_failed_proven_sent_reference_has_recovery_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            direct_root = Path(root) / "direct"
            path = direct_root / "requests" / f"{REQ}.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(self.failed_record()), encoding="utf-8")
            ref = chat_reference.resolve_chat_reference(direct_root, REQ, expected_repository=REPO)
            self.assertEqual(ref.terminal_state, "FAILED")
            self.assertEqual(ref.send_proof_class, "PROVEN_SENT")
            self.assertTrue(ref.recovery_eligible)
            chat_reference.claim_recovery(direct_root, ref, "REQ_20261003T101323Z_7009")
            ref = chat_reference.resolve_chat_reference(direct_root, REQ, expected_repository=REPO)
            self.assertFalse(ref.recovery_eligible)
            self.assertTrue(ref.automatic_recovery_used)
            with self.assertRaises(chat_reference.ChatReferenceError):
                chat_reference.claim_recovery(direct_root, ref, "REQ_20261003T101324Z_7010")
            # The reference remains valid for an explicit human continuation.
            self.assertEqual(ref.conversation_url, URL)

    def test_failed_recovery_decision_matrix(self):
        prompt_sha = "a" * 64
        reproof = {"requestId": REQ, "conversationUrl": URL, "conversationId": URL.rsplit("/", 1)[-1],
                   "promptSha256": prompt_sha, "exactUserTurn": True}
        cases = [({}, True), ({"sendProofClass": "PROVEN_NOT_SENT"}, False),
                 ({"sendProofClass": "UNKNOWN"}, False),
                 ({"sendProofClass": "UNKNOWN", "promptSha256": prompt_sha, "readOnlySendReproof": reproof}, True),
                 ({"conversationUrl": None}, False), ({"conversationId": "foreign"}, False),
                 ({"repository": "foreign/repo"}, False), ({"requestId": "REQ_20261003T101324Z_7010"}, False),
                 ({"automaticRecoveryUsed": True}, False), ({"webResultAvailable": True}, False),
                 ({"unresolvedSendUnknown": True}, False), ({"state": "RESULT_DURABLE", "ok": True}, False)]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                self.assertEqual(chat_reference.can_continue_request(self.failed_record(**fields),
                    request_id=REQ, expected_repository=REPO), expected)

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

    def test_resolve_accepts_completed_no_artifact_with_high_continuation_index(self):
        with tempfile.TemporaryDirectory() as root:
            direct_root = Path(root) / "direct"
            path = direct_root / "requests" / f"{REQ}.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "ok": True,
                "code": "ASSISTANT_COMPLETED_NO_ARTIFACT",
                "state": "ASSISTANT_COMPLETED_NO_ARTIFACT",
                "requestId": REQ,
                "repository": REPO,
                "conversationUrl": URL,
                "rootRequestId": "REQ_20260917T100000Z_7000",
                "continuationIndex": 3,
            }), encoding="utf-8")
            result = chat_reference.resolve_chat_reference(direct_root, REQ, expected_repository=REPO)
            self.assertEqual(result.source, "direct_state")
            self.assertEqual(result.conversation_url, URL)
            self.assertEqual(result.root_request_id, "REQ_20260917T100000Z_7000")
            self.assertEqual(result.continuation_index, 3)

    def test_resolve_accepts_rejected_artifact_direct_state(self):
        with tempfile.TemporaryDirectory() as root:
            direct_root = Path(root) / "direct"
            path = direct_root / "requests" / f"{REQ}.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({
                "ok": True,
                "code": "ARTIFACT_REJECTED",
                "state": "ARTIFACT_REJECTED",
                "requestId": REQ,
                "repository": REPO,
                "conversationUrl": URL,
            }), encoding="utf-8")
            result = chat_reference.resolve_chat_reference(direct_root, REQ, expected_repository=REPO)
            self.assertEqual(result.root_request_id, REQ)
            self.assertEqual(result.continuation_index, 0)


if __name__ == "__main__":
    unittest.main()
