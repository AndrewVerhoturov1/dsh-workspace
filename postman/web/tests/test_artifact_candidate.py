from __future__ import annotations

import hashlib
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import artifact_detector as detector
import browser_observer as observer

REQ = "REQ_20260925T175605Z_0372"
PROMPT = f"POSTMAN_REQUEST_ID: {REQ}\ntask_file: https://example.test/{REQ}.md"
URL = "https://chatgpt.com/c/owned"
FILENAME = detector.expected_artifact_filename(REQ)
TEXT = "old answer"
SHA = hashlib.sha256(TEXT.encode()).hexdigest()


def saved_proof(**overrides):
    details = {"assistantIndex": 4, "assistantTextSha256": SHA, "assistantIdentity": {},
               "turnSelector": "main [data-testid^=conversation-turn-]", "observedAnswer": True,
               "candidateReasons": ["OLD_UNSEEN"], "boundRequestId": REQ,
               "boundExpectedFilename": FILENAME}
    details.update(overrides)
    return {"ok": False, "code": "ASSISTANT_CANDIDATE_OBSERVED", "details": details}


def turn(text=TEXT, index=4, **identity):
    return {"role": "assistant", "text": text, "index": index, **identity}


class FakeTurn:
    def __init__(self, dom=None):
        self.dom = dom or {"candidates": []}
        self.calls = []

    def evaluate(self, script, args):
        self.calls.append((script, args))
        return self.dom


class FakePage:
    def __init__(self, turns, *, url=URL, selector="main [data-testid^=conversation-turn-]", dom=None):
        self.url = url
        self.turns = turns
        self.selector = selector
        self.turn = FakeTurn(dom)
        self.dom_index = None

    def locator(self, selector):
        assert selector == self.selector
        class Locator:
            def __init__(self, page): self.page = page
            def nth(self, index):
                self.page.dom_index = index
                return self.page.turn
        return Locator(self)


def candidate_page(turns=None, *, dom=None, url=URL):
    page = FakePage(turns or [turn()], url=url, dom=dom or {"candidates": [
        {"path": "0/1", "label": "Download ZIP", "tag": "a", "hrefBasename": FILENAME,
         "betweenMarkers": True, "visibleLabelExact": False},
    ]})
    return page


def discover(page, proof=None):
    with patch.object(observer, "snapshot_turns", return_value=(page.turns, page.selector)):
        return detector.discover_artifact_candidate(page, expected_prompt=PROMPT, expected_chat_url=URL,
            request_id=REQ, expected_filename=FILENAME, completed_observer_result=proof or saved_proof())


class ArtifactCandidateTests(unittest.TestCase):
    def test_candidate_is_never_grantable_authority(self):
        result = discover(candidate_page())
        self.assertEqual(result["code"], detector.ARTIFACT_CANDIDATE_DOM)
        self.assertFalse(result["ok"])
        self.assertFalse(result["details"]["verified"])
        self.assertFalse(result["details"]["applyEligible"])
        self.assertFalse(result["details"]["downloadStarted"])

    def test_wrong_request_or_filename_has_no_candidate(self):
        bad_id = "REQ_20260925T175605Z_0373"
        result = detector.discover_artifact_candidate(candidate_page(), expected_prompt=PROMPT,
            expected_chat_url=URL, request_id=bad_id,
            expected_filename=detector.expected_artifact_filename(bad_id), completed_observer_result=saved_proof())
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], detector.ARTIFACT_CHAT_CORRELATION_LOST)
        with patch.object(observer, "snapshot_turns", return_value=([turn()], "main [data-testid^=conversation-turn-]")):
            result = detector.discover_artifact_candidate(candidate_page(), expected_prompt=PROMPT,
                expected_chat_url=URL, request_id=REQ, expected_filename="other.zip",
                completed_observer_result=saved_proof())
        self.assertEqual(result["code"], detector.ARTIFACT_CANDIDATE_DOM)
        self.assertFalse(result["ok"])

    def test_multiple_choices_are_reported_without_clicking(self):
        dom = {"candidates": [{"path": "0", "label": "Download ZIP", "betweenMarkers": True},
                              {"path": "1", "label": "Download ZIP", "betweenMarkers": True}]}
        page = candidate_page(dom=dom)
        result = discover(page)
        self.assertEqual(result["code"], detector.ARTIFACT_CANDIDATE_CHOICES)
        self.assertEqual(result["details"]["candidateCount"], 2)
        self.assertEqual(len(page.turn.calls), 1)  # Discovery reads scoped DOM but never clicks.

    def test_strong_identity_allows_reindex_but_changed_identity_refuses(self):
        turns = [{"role": "user", "text": PROMPT, "index": 0}, turn(index=9, groupKey="stable")]
        page = candidate_page(turns)
        result = discover(page, saved_proof(assistantIdentity={"groupKey": "stable"}))
        self.assertEqual(result["code"], detector.ARTIFACT_CANDIDATE_DOM)
        self.assertEqual(result["details"]["assistantIndex"], 9)
        changed = candidate_page([{"role": "user", "text": PROMPT, "index": 0}, turn(index=9, groupKey="changed")])
        result = discover(changed, saved_proof(assistantIdentity={"groupKey": "stable"}))
        self.assertIn(result["code"], {detector.ARTIFACT_TURN_IDENTITY_MISMATCH, detector.ARTIFACT_CHAT_CORRELATION_LOST})

    def test_weak_position_identity_change_refuses(self):
        page = candidate_page([{"role": "user", "text": PROMPT, "index": 0}, turn(index=9)])
        result = discover(page, saved_proof(assistantIdentity={}, assistantIndex=4))
        self.assertIn(result["code"], {detector.ARTIFACT_TURN_IDENTITY_MISMATCH, detector.ARTIFACT_CHAT_CORRELATION_LOST})

    def test_exact_chat_ownership_loss_refuses_candidate(self):
        result = discover(candidate_page(url="https://chatgpt.com/c/other"))
        self.assertEqual(result["code"], detector.ARTIFACT_CHAT_CORRELATION_LOST)

    def test_observed_old_unseen_answer_is_candidate_not_current_send_proof(self):
        proof = saved_proof(candidateReasons=["OLD_UNSEEN"])
        result = discover(candidate_page(), proof)
        self.assertFalse(result["ok"])
        self.assertTrue(result["details"]["reasons"])
        self.assertFalse(result["details"]["verified"])
        self.assertFalse(result["details"]["applyEligible"])

    def test_observer_localizes_only_latest_assistant_after_visible_last_user(self):
        class Page:
            url = URL
        turns = [{"role": "user", "text": "some other request", "index": 0},
                 turn(index=1, assistantMessageId="answer-id")]
        with patch.object(observer, "snapshot_turns", return_value=(turns, "selector")), \
             patch.object(observer, "generation_active", return_value=(False, {})):
            result = observer.observe_artifact_candidate(Page(), PROMPT, URL, timeout_ms=0, stable_ms=0,
                sleep=lambda _: None, monotonic=lambda: 0.0)
        self.assertEqual(result["code"], "ASSISTANT_CANDIDATE_OBSERVED")
        self.assertFalse(result["ok"])
        self.assertTrue(result["details"]["observedAnswer"])
        self.assertEqual(result["details"]["assistantIdentity"]["assistantMessageId"], "answer-id")
        self.assertNotIn("submitSendState", result["details"])

    def test_external_url_filter_is_not_proven_by_mocked_turn_payload(self):
        # FakeTurn supplies post-JS evidence; it cannot execute _CANDIDATE_DOM_JS.
        self.assertIn("url.origin === location.origin", detector._CANDIDATE_DOM_JS)
        self.assertIn("sandbox:/", detector._CANDIDATE_DOM_JS)
        self.assertFalse(discover(candidate_page(dom={"candidates": []}))["ok"])


if __name__ == "__main__":
    unittest.main()
