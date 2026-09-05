from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

WEB_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = WEB_DIR / "artifact_detector.py"

# These stubs provide only the public WP-003/4/5 surface consumed by P5.
# In the repository the real modules are imported instead.
bootstrap_stub = types.ModuleType("browser_bootstrap")
bootstrap_stub.DEFAULT_CDP_URL = "http://127.0.0.1:9222"
class BrowserBootstrapError(Exception):
    def __init__(self, code="BOOTSTRAP_FAIL", recoverable=True, details=None):
        super().__init__(code)
        self.code = code
        self.recoverable = recoverable
        self.details = details or {}
bootstrap_stub.BrowserBootstrapError = BrowserBootstrapError
bootstrap_stub._load_sync_playwright = lambda: None
bootstrap_stub.normalize_cdp_url = lambda value: value

submit_stub = types.ModuleType("browser_submit")
submit_stub.DEFAULT_TIMEOUT_MS = 30000
submit_stub.PROMPT_SEND_CONFIRMED = "PROMPT_SEND_CONFIRMED"
submit_stub.PROVEN_SENT = "PROVEN_SENT"
submit_stub.prompt_sha256 = lambda text: hashlib.sha256(
    str(text).replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
).hexdigest()
submit_stub.is_bound_chat_url = lambda url: isinstance(url, str) and url.startswith("https://chatgpt.com/c/")
submit_stub.submit_fresh_prompt = lambda *args, **kwargs: {}

observer_stub = types.ModuleType("browser_observer")
observer_stub.DEFAULT_TIMEOUT_MS = 120000
observer_stub.DEFAULT_STABLE_MS = 2000
observer_stub.ASSISTANT_TURN_COMPLETED = "ASSISTANT_TURN_COMPLETED"
observer_stub._normalize_text = lambda value: str(value or "").replace("\r\n", "\n").replace("\r", "\n")
observer_stub.text_sha256 = lambda text: hashlib.sha256(
    observer_stub._normalize_text(text).encode("utf-8")
).hexdigest()
observer_stub.snapshot_turns = lambda page: page.snapshot_turns()
observer_stub.correlate_next_assistant = lambda turns, prompt: page_correlate(turns, prompt)
observer_stub.generation_active = lambda page: (page.generating, "stop-button" if page.generating else "")
observer_stub.observe_next_assistant = lambda *args, **kwargs: {}

sys.modules.setdefault("browser_bootstrap", bootstrap_stub)
sys.modules.setdefault("browser_submit", submit_stub)
sys.modules.setdefault("browser_observer", observer_stub)

spec = importlib.util.spec_from_file_location("artifact_detector", MODULE_PATH)
detector = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(detector)


def page_correlate(turns, prompt):
    matches = [
        turn["index"]
        for turn in turns
        if turn.get("role") == "user" and turn.get("text") == prompt
    ]
    if not matches:
        return {"ok": False, "code": "USER_TURN_ANCHOR_MISSING"}
    anchor = matches[-1]
    if anchor + 1 >= len(turns):
        return {"ok": False, "code": "ASSISTANT_NOT_STARTED"}
    assistant = turns[anchor + 1]
    if assistant.get("role") != "assistant":
        return {"ok": False, "code": "CHAT_CORRELATION_LOST"}
    return {
        "ok": True,
        "code": "ASSISTANT_TURN_STARTED",
        "anchorIndex": anchor,
        "assistantIndex": anchor + 1,
        "assistant": assistant,
    }


class FakeTurn:
    def __init__(self, candidate_records=None):
        self.candidate_records = list(candidate_records or [])
    def evaluate(self, script, expected_filename):
        return list(self.candidate_records)


class FakeTurnCollection:
    def __init__(self, turns):
        self.turns = turns
    def nth(self, index):
        return self.turns[index]


class FakePage:
    def __init__(
        self,
        *,
        prompt,
        assistant_text,
        url="https://chatgpt.com/c/chat1",
        candidates=None,
        stale_turns=None,
        generating=False,
    ):
        self.url = url
        self.generating = generating
        self.prompt = prompt
        self.assistant_text = assistant_text
        self.turn_data = list(stale_turns or []) + [
            {"index": len(stale_turns or []), "role": "user", "text": prompt, "testId": "conversation-turn-user"},
            {"index": len(stale_turns or []) + 1, "role": "assistant", "text": assistant_text, "testId": "conversation-turn-assistant"},
        ]
        # normalize indexes after caller-provided stale fixtures
        for i, item in enumerate(self.turn_data):
            item["index"] = i
        self.turn_locators = [
            FakeTurn([]) for _ in self.turn_data
        ]
        self.turn_locators[-1] = FakeTurn(candidates or [])
    def snapshot_turns(self):
        return list(self.turn_data), '[data-testid^="conversation-turn-"]'
    def locator(self, selector):
        if selector == '[data-testid^="conversation-turn-"]':
            return FakeTurnCollection(self.turn_locators)
        raise AssertionError(f"unexpected selector {selector}")


def envelope(req, filename, extra=""):
    parts = [
        detector.result_begin_marker(req),
        detector.result_artifact_marker(filename),
        detector.result_end_marker(req),
    ]
    if extra:
        parts.insert(2, extra)
    return "\n".join(parts)


def completed_result(prompt, page, *, assistant_index=None, text=None):
    assistant_index = len(page.turn_data) - 1 if assistant_index is None else assistant_index
    text = page.assistant_text if text is None else text
    return {
        "ok": True,
        "code": detector.observer.ASSISTANT_TURN_COMPLETED,
        "transitions": [
            "ASSISTANT_TURN_STARTED",
            "ASSISTANT_TURN_COMPLETED",
        ],
        "details": {
            "submitCode": detector.submit.PROMPT_SEND_CONFIRMED,
            "submitSendState": detector.submit.PROVEN_SENT,
            "chatUrl": page.url,
            "promptSha256": detector.submit.prompt_sha256(prompt),
            "assistantIndex": assistant_index,
            "assistantTextSha256": detector.observer.text_sha256(text),
        },
    }


def candidate(path="1/2", score=100, **overrides):
    value = {
        "path": path,
        "score": score,
        "evidence": ["download_attr_exact"],
        "tag": "a",
        "role": "",
        "dataTestId": "download-file",
        "ariaLabel": "Download",
        "title": "",
        "downloadExact": True,
        "hrefBasename": "",
        "textLength": 12,
    }
    value.update(overrides)
    return value


class ArtifactDetectorTests(unittest.TestCase):
    REQ = "REQ_WP006_TEST_01"
    FILENAME = "POSTMAN_REQ_WP006_TEST_01_RESULT.zip"
    PROMPT = "create artifact"

    def test_expected_filename_contract(self):
        self.assertEqual(
            detector.expected_artifact_filename(self.REQ),
            self.FILENAME,
        )

    def test_marker_contract(self):
        self.assertEqual(
            detector.result_begin_marker(self.REQ),
            "<<<POSTMAN_RESULT_BEGIN:REQ_WP006_TEST_01>>>",
        )
        self.assertEqual(
            detector.result_artifact_marker(self.FILENAME),
            "POSTMAN_ARTIFACT:POSTMAN_REQ_WP006_TEST_01_RESULT.zip",
        )
        self.assertEqual(
            detector.result_end_marker(self.REQ),
            "<<<POSTMAN_RESULT_END:REQ_WP006_TEST_01>>>",
        )

    def test_envelope_accepts_exact_order(self):
        result = detector.parse_result_envelope(
            envelope(self.REQ, self.FILENAME),
            self.REQ,
            self.FILENAME,
        )
        self.assertTrue(result["ok"])

    def test_envelope_allows_normal_text_between_markers(self):
        result = detector.parse_result_envelope(
            envelope(self.REQ, self.FILENAME, "artifact is attached"),
            self.REQ,
            self.FILENAME,
        )
        self.assertTrue(result["ok"])

    def test_envelope_rejects_missing_begin(self):
        text = "\n".join([
            detector.result_artifact_marker(self.FILENAME),
            detector.result_end_marker(self.REQ),
        ])
        result = detector.parse_result_envelope(text, self.REQ, self.FILENAME)
        self.assertEqual(result["code"], detector.ARTIFACT_ENVELOPE_MISSING)

    def test_envelope_rejects_wrong_request_id(self):
        text = envelope("REQ_OTHER", self.FILENAME)
        result = detector.parse_result_envelope(text, self.REQ, self.FILENAME)
        self.assertEqual(result["code"], detector.ARTIFACT_ENVELOPE_MISSING)

    def test_envelope_rejects_wrong_filename(self):
        text = envelope(self.REQ, "POSTMAN_REQ_OTHER_RESULT.zip")
        result = detector.parse_result_envelope(text, self.REQ, self.FILENAME)
        self.assertEqual(result["code"], detector.ARTIFACT_ENVELOPE_MISSING)

    def test_envelope_rejects_duplicate_begin(self):
        text = "\n".join([
            detector.result_begin_marker(self.REQ),
            detector.result_begin_marker(self.REQ),
            detector.result_artifact_marker(self.FILENAME),
            detector.result_end_marker(self.REQ),
        ])
        result = detector.parse_result_envelope(text, self.REQ, self.FILENAME)
        self.assertEqual(result["code"], detector.ARTIFACT_ENVELOPE_AMBIGUOUS)

    def test_envelope_rejects_multiple_artifact_declarations(self):
        text = "\n".join([
            detector.result_begin_marker(self.REQ),
            detector.result_artifact_marker(self.FILENAME),
            detector.result_artifact_marker("POSTMAN_REQ_OTHER_RESULT.zip"),
            detector.result_end_marker(self.REQ),
        ])
        result = detector.parse_result_envelope(text, self.REQ, self.FILENAME)
        self.assertEqual(result["code"], detector.ARTIFACT_ENVELOPE_AMBIGUOUS)

    def test_envelope_rejects_end_before_begin(self):
        text = "\n".join([
            detector.result_end_marker(self.REQ),
            detector.result_artifact_marker(self.FILENAME),
            detector.result_begin_marker(self.REQ),
        ])
        result = detector.parse_result_envelope(text, self.REQ, self.FILENAME)
        self.assertEqual(result["code"], detector.ARTIFACT_ENVELOPE_AMBIGUOUS)

    def test_candidate_selection_prefers_highest_score(self):
        result = detector.select_attachment_candidate([
            candidate("1", 70),
            candidate("2", 100),
        ])
        self.assertTrue(result["ok"])
        self.assertEqual(result["details"]["candidate"]["path"], "2")

    def test_candidate_selection_rejects_none(self):
        result = detector.select_attachment_candidate([])
        self.assertEqual(result["code"], detector.ARTIFACT_ATTACHMENT_NOT_FOUND)

    def test_candidate_selection_rejects_equal_best_ambiguity(self):
        result = detector.select_attachment_candidate([
            candidate("1", 100),
            candidate("2", 100),
        ])
        self.assertEqual(result["code"], detector.ARTIFACT_ATTACHMENT_AMBIGUOUS)

    def test_candidate_collection_sanitizes_records(self):
        turn = FakeTurn([
            candidate("1", 100, ariaLabel="x" * 500),
            {"path": "", "score": 100},
            {"path": "bad", "score": 0},
        ])
        records = detector._collect_attachment_candidates(turn, self.FILENAME)
        self.assertEqual(len(records), 1)
        self.assertEqual(len(records[0]["ariaLabel"]), 160)

    def test_invalid_request_id_fails_closed(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id="REQ_BAD\nID",
            expected_filename=self.FILENAME,
            completed_observer_result=completed_result(self.PROMPT, page),
        )
        self.assertEqual(result["code"], detector.ARTIFACT_INVALID_CONFIG)

    def test_filename_must_be_runtime_derived(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename="other.zip",
            completed_observer_result=completed_result(self.PROMPT, page),
        )
        self.assertEqual(result["code"], detector.ARTIFACT_INVALID_CONFIG)

    def test_observer_must_be_completed(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        proof = completed_result(self.PROMPT, page)
        proof["ok"] = False
        proof["code"] = "ASSISTANT_TURN_TIMEOUT"
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=proof,
        )
        self.assertEqual(result["code"], detector.ARTIFACT_TURN_NOT_COMPLETED)

    def test_submit_proof_must_be_confirmed(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        proof = completed_result(self.PROMPT, page)
        proof["details"]["submitCode"] = "PROMPT_SEND_UNKNOWN"
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=proof,
        )
        self.assertEqual(result["code"], detector.ARTIFACT_OBSERVER_PROOF_INVALID)

    def test_observer_prompt_sha_must_match(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        proof = completed_result(self.PROMPT, page)
        proof["details"]["promptSha256"] = "0" * 64
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=proof,
        )
        self.assertEqual(result["code"], detector.ARTIFACT_OBSERVER_PROOF_INVALID)

    def test_page_url_change_fails_correlation(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        proof = completed_result(self.PROMPT, page)
        expected_url = page.url
        page.url = "https://chatgpt.com/c/other"
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=expected_url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=proof,
        )
        self.assertEqual(result["code"], detector.ARTIFACT_CHAT_CORRELATION_LOST)

    def test_stale_attachment_before_anchor_is_ignored(self):
        stale = [
            {"index": 0, "role": "assistant", "text": "old zip", "testId": "conversation-turn-assistant"},
        ]
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate("current", 100)],
            stale_turns=stale,
        )
        # Give stale turn an attractive candidate; detector must never inspect it.
        page.turn_locators[0] = FakeTurn([candidate("stale", 100)])
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=completed_result(self.PROMPT, page),
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["details"]["attachment"]["path"], "current")

    def test_same_filename_outside_correlated_turn_is_rejected(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[],
            stale_turns=[
                {"index": 0, "role": "assistant", "text": self.FILENAME, "testId": "conversation-turn-assistant"},
            ],
        )
        page.turn_locators[0] = FakeTurn([candidate("stale", 100)])
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=completed_result(self.PROMPT, page),
        )
        self.assertEqual(result["code"], detector.ARTIFACT_ATTACHMENT_NOT_FOUND)

    def test_unrelated_download_button_inside_turn_is_ignored(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[],
        )
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=completed_result(self.PROMPT, page),
        )
        self.assertEqual(result["code"], detector.ARTIFACT_ATTACHMENT_NOT_FOUND)

    def test_assistant_index_change_fails_identity(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        proof = completed_result(self.PROMPT, page, assistant_index=99)
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=proof,
        )
        self.assertEqual(result["code"], detector.ARTIFACT_TURN_IDENTITY_MISMATCH)

    def test_assistant_text_change_after_completion_fails_identity(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        proof = completed_result(self.PROMPT, page, text="old completed text")
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=proof,
        )
        self.assertEqual(result["code"], detector.ARTIFACT_TURN_IDENTITY_MISMATCH)

    def test_generation_restarted_after_completion_fails_closed(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
            generating=True,
        )
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=completed_result(self.PROMPT, page),
        )
        self.assertEqual(result["code"], detector.ARTIFACT_TURN_NOT_COMPLETED)

    def test_valid_full_proof_confirms_dom_without_download(self):
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, self.FILENAME),
            candidates=[candidate()],
        )
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=completed_result(self.PROMPT, page),
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], detector.ARTIFACT_DOM_CONFIRMED)
        self.assertFalse(result["details"]["downloadStarted"])
        self.assertEqual(result["details"]["expectedFilename"], self.FILENAME)

    def test_json_output_is_windows_console_safe(self):
        payload = detector._json_dumps(
            {"ok": True, "details": {"probe": "ЛУНА"}}
        )
        self.assertTrue(payload.isascii())
        self.assertEqual(json.loads(payload)["details"]["probe"], "ЛУНА")

    def test_source_never_uses_page_body_search(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn('locator("body")', source)
        self.assertNotIn("locator('body')", source)

    def test_source_never_downloads_or_clicks(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        forbidden = [
            "expect_download",
            ".click(",
            "save_as(",
            "download.save",
        ]
        for token in forbidden:
            self.assertNotIn(token, source)

    def test_dom_collection_is_scoped_to_turn_evaluate(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("turn.evaluate(_DOM_CANDIDATE_JS", source)
        self.assertNotIn("page.evaluate(_DOM_CANDIDATE_JS", source)

    def test_live_wrapper_uses_existing_submit_and_observer_primitives(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("submit.submit_fresh_prompt", source)
        self.assertIn("observer.observe_next_assistant", source)


if __name__ == "__main__":
    unittest.main()
