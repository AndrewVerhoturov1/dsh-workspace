from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest

WEB_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = WEB_DIR / "artifact_detector.py"

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
observer_stub.text_sha256 = lambda text: hashlib.sha256(observer_stub._normalize_text(text).encode("utf-8")).hexdigest()
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
    matches = [t["index"] for t in turns if t.get("role") == "user" and t.get("text") == prompt]
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


def candidate(path="1/2", *, between=True, filename_length=49):
    return {
        "path": path,
        "tag": "a",
        "role": "",
        "dataTestId": "download-file",
        "ariaLabel": "",
        "title": "",
        "visibleLabelExact": True,
        "visibleLabelLength": filename_length,
        "downloadExact": False,
        "hrefBasename": "",
        "betweenMarkers": between,
    }


def dom_proof(*candidates, begin=1, end=1):
    return {
        "beginMarkerCount": begin,
        "endMarkerCount": end,
        "candidates": list(candidates),
    }


class FakeTurn:
    def __init__(self, proof=None):
        self.proof = proof if proof is not None else dom_proof()

    def evaluate(self, script, args):
        return self.proof


class FakeTurnCollection:
    def __init__(self, turns):
        self.turns = turns

    def nth(self, index):
        return self.turns[index]


class FakePage:
    def __init__(self, *, prompt, assistant_text, url="https://chatgpt.com/c/chat1", proof=None, stale_turns=None, generating=False):
        self.url = url
        self.generating = generating
        self.prompt = prompt
        self.assistant_text = assistant_text
        self.turn_data = list(stale_turns or []) + [
            {"index": 0, "role": "user", "text": prompt, "testId": "conversation-turn-user"},
            {"index": 0, "role": "assistant", "text": assistant_text, "testId": "conversation-turn-assistant"},
        ]
        for i, item in enumerate(self.turn_data):
            item["index"] = i
        self.turn_locators = [FakeTurn(dom_proof()) for _ in self.turn_data]
        self.turn_locators[-1] = FakeTurn(proof if proof is not None else dom_proof(candidate()))

    def snapshot_turns(self):
        return list(self.turn_data), '[data-testid^="conversation-turn-"]'

    def locator(self, selector):
        if selector == '[data-testid^="conversation-turn-"]':
            return FakeTurnCollection(self.turn_locators)
        raise AssertionError(f"unexpected selector {selector}")


def envelope(req, filename):
    return "\n".join([
        detector.result_begin_marker(req),
        filename,
        detector.result_end_marker(req),
    ])


def completed_result(prompt, page, *, assistant_index=None, text=None):
    assistant_index = len(page.turn_data) - 1 if assistant_index is None else assistant_index
    text = page.assistant_text if text is None else text
    return {
        "ok": True,
        "code": detector.observer.ASSISTANT_TURN_COMPLETED,
        "details": {
            "submitCode": detector.submit.PROMPT_SEND_CONFIRMED,
            "submitSendState": detector.submit.PROVEN_SENT,
            "chatUrl": page.url,
            "promptSha256": detector.submit.prompt_sha256(prompt),
            "assistantIndex": assistant_index,
            "assistantTextSha256": detector.observer.text_sha256(text),
        },
    }


class ArtifactDetectorTests(unittest.TestCase):
    REQ = "REQ_20260831T043812Z_4827"
    FILENAME = "POSTMAN_REQ_20260831T043812Z_4827_RESULT.zip"
    PROMPT = "POSTMAN_REQUEST_ID: REQ_20260831T043812Z_4827\ncreate artifact"

    def detect(self, page, *, filename=None, request_id=None, completed=None):
        return detector.detect_artifact_dom(
            page,
            expected_prompt=self.PROMPT,
            expected_chat_url=page.url,
            request_id=request_id or self.REQ,
            expected_filename=filename or self.FILENAME,
            completed_observer_result=completed or completed_result(self.PROMPT, page),
        )

    def test_expected_single_filename_contract(self):
        self.assertEqual(detector.expected_artifact_filename(self.REQ), self.FILENAME)

    def test_expected_numbered_filename_contract(self):
        self.assertEqual(
            detector.expected_artifact_filename(self.REQ, 2),
            "POSTMAN_REQ_20260831T043812Z_4827_RESULT-02.zip",
        )

    def test_marker_contract_uses_real_filename_as_middle_visible_line(self):
        self.assertEqual(detector.result_begin_marker(self.REQ), "<<<POSTMAN_RESULT_BEGIN:REQ_20260831T043812Z_4827>>>")
        self.assertEqual(detector.result_artifact_marker(self.FILENAME), self.FILENAME)
        self.assertEqual(detector.result_end_marker(self.REQ), "<<<POSTMAN_RESULT_END:REQ_20260831T043812Z_4827>>>")

    def test_envelope_accepts_exact_three_visible_lines(self):
        self.assertTrue(detector.parse_result_envelope(envelope(self.REQ, self.FILENAME), self.REQ, self.FILENAME)["ok"])

    def test_envelope_rejects_extra_text(self):
        text = "extra\n" + envelope(self.REQ, self.FILENAME)
        result = detector.parse_result_envelope(text, self.REQ, self.FILENAME)
        self.assertEqual(result["code"], detector.ARTIFACT_ENVELOPE_MISSING)

    def test_envelope_rejects_missing_begin(self):
        text = "\n".join([self.FILENAME, detector.result_end_marker(self.REQ)])
        self.assertEqual(detector.parse_result_envelope(text, self.REQ, self.FILENAME)["code"], detector.ARTIFACT_ENVELOPE_MISSING)

    def test_envelope_rejects_wrong_request_id(self):
        other = "REQ_20260831T043813Z_4828"
        self.assertEqual(detector.parse_result_envelope(envelope(other, self.FILENAME), self.REQ, self.FILENAME)["code"], detector.ARTIFACT_ENVELOPE_MISSING)

    def test_envelope_rejects_wrong_filename(self):
        wrong = "POSTMAN_REQ_20260831T043812Z_4827_RESULT-01.zip"
        self.assertEqual(detector.parse_result_envelope(envelope(self.REQ, wrong), self.REQ, self.FILENAME)["code"], detector.ARTIFACT_ENVELOPE_MISSING)

    def test_envelope_rejects_duplicate_begin(self):
        text = "\n".join([detector.result_begin_marker(self.REQ), detector.result_begin_marker(self.REQ), self.FILENAME, detector.result_end_marker(self.REQ)])
        self.assertEqual(detector.parse_result_envelope(text, self.REQ, self.FILENAME)["code"], detector.ARTIFACT_ENVELOPE_AMBIGUOUS)

    def test_envelope_rejects_duplicate_filename(self):
        text = "\n".join([detector.result_begin_marker(self.REQ), self.FILENAME, self.FILENAME, detector.result_end_marker(self.REQ)])
        self.assertEqual(detector.parse_result_envelope(text, self.REQ, self.FILENAME)["code"], detector.ARTIFACT_ENVELOPE_AMBIGUOUS)

    def test_candidate_selection_accepts_one_control_between_markers(self):
        result = detector.select_attachment_candidate(dom_proof(candidate("a", between=True)))
        self.assertTrue(result["ok"])
        self.assertEqual(result["details"]["candidate"]["path"], "a")

    def test_candidate_selection_rejects_none(self):
        self.assertEqual(detector.select_attachment_candidate(dom_proof())["code"], detector.ARTIFACT_ATTACHMENT_NOT_FOUND)

    def test_candidate_selection_rejects_control_outside_markers(self):
        result = detector.select_attachment_candidate(dom_proof(candidate("a", between=False)))
        self.assertEqual(result["code"], detector.ARTIFACT_ATTACHMENT_OUTSIDE_ENVELOPE)

    def test_candidate_selection_rejects_two_controls_inside(self):
        result = detector.select_attachment_candidate(dom_proof(candidate("a"), candidate("b")))
        self.assertEqual(result["code"], detector.ARTIFACT_ATTACHMENT_AMBIGUOUS)

    def test_candidate_collection_sanitizes_bounded_metadata(self):
        turn = FakeTurn(dom_proof(candidate("a", filename_length=len(self.FILENAME)) | {"ariaLabel": "x" * 500}))
        proof = detector._collect_attachment_candidates(turn, self.REQ, self.FILENAME)
        self.assertEqual(len(proof["candidates"]), 1)
        self.assertEqual(len(proof["candidates"][0]["ariaLabel"]), 160)

    def test_invalid_request_id_fails_closed(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
        result = self.detect(page, request_id="REQ_BAD")
        self.assertEqual(result["code"], detector.ARTIFACT_INVALID_CONFIG)

    def test_prompt_must_start_with_exact_request_key(self):
        wrong_prompt = "create artifact without request key"
        page = FakePage(prompt=wrong_prompt, assistant_text=envelope(self.REQ, self.FILENAME))
        result = detector.detect_artifact_dom(
            page,
            expected_prompt=wrong_prompt,
            expected_chat_url=page.url,
            request_id=self.REQ,
            expected_filename=self.FILENAME,
            completed_observer_result=completed_result(wrong_prompt, page),
        )
        self.assertEqual(result["code"], detector.ARTIFACT_INVALID_CONFIG)
        self.assertEqual(result["details"]["reason"], "prompt_request_key_missing_or_not_first")

    def test_filename_must_embed_exact_request_key(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
        wrong = "POSTMAN_REQ_20260831T043813Z_4827_RESULT.zip"
        result = self.detect(page, filename=wrong)
        self.assertEqual(result["code"], detector.ARTIFACT_INVALID_CONFIG)

    def test_numbered_filename_is_allowed_when_trusted_exact_filename_matches(self):
        filename = "POSTMAN_REQ_20260831T043812Z_4827_RESULT-01.zip"
        page = FakePage(
            prompt=self.PROMPT,
            assistant_text=envelope(self.REQ, filename),
            proof=dom_proof(candidate("a", filename_length=len(filename))),
        )
        result = self.detect(page, filename=filename)
        self.assertTrue(result["ok"])
        self.assertEqual(result["details"]["expectedFilename"], filename)

    def test_observer_must_be_completed(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
        proof = completed_result(self.PROMPT, page)
        proof["ok"] = False
        proof["code"] = "ASSISTANT_TURN_TIMEOUT"
        result = self.detect(page, completed=proof)
        self.assertEqual(result["code"], detector.ARTIFACT_TURN_NOT_COMPLETED)

    def test_submit_proof_must_be_confirmed(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
        proof = completed_result(self.PROMPT, page)
        proof["details"]["submitCode"] = "PROMPT_SEND_UNKNOWN"
        self.assertEqual(self.detect(page, completed=proof)["code"], detector.ARTIFACT_OBSERVER_PROOF_INVALID)

    def test_observer_prompt_sha_must_match(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
        proof = completed_result(self.PROMPT, page)
        proof["details"]["promptSha256"] = "0" * 64
        self.assertEqual(self.detect(page, completed=proof)["code"], detector.ARTIFACT_OBSERVER_PROOF_INVALID)

    def test_page_url_change_fails_correlation(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
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
        stale = [{"index": 0, "role": "assistant", "text": self.FILENAME, "testId": "conversation-turn-assistant"}]
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME), stale_turns=stale)
        page.turn_locators[0] = FakeTurn(dom_proof(candidate("stale")))
        result = self.detect(page)
        self.assertTrue(result["ok"])
        self.assertNotEqual(result["details"]["attachment"]["path"], "stale")

    def test_same_filename_outside_correlated_turn_is_rejected(self):
        stale = [{"index": 0, "role": "assistant", "text": self.FILENAME, "testId": "conversation-turn-assistant"}]
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME), stale_turns=stale, proof=dom_proof())
        page.turn_locators[0] = FakeTurn(dom_proof(candidate("stale")))
        self.assertEqual(self.detect(page)["code"], detector.ARTIFACT_ATTACHMENT_NOT_FOUND)

    def test_generic_download_control_is_ignored_without_exact_visible_filename(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME), proof=dom_proof())
        self.assertEqual(self.detect(page)["code"], detector.ARTIFACT_ATTACHMENT_NOT_FOUND)

    def test_dom_requires_exact_begin_and_end_marker_nodes(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME), proof=dom_proof(candidate(), begin=0, end=1))
        self.assertEqual(self.detect(page)["code"], detector.ARTIFACT_ENVELOPE_DOM_MISMATCH)

    def test_real_control_must_be_physically_between_markers(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME), proof=dom_proof(candidate(between=False)))
        self.assertEqual(self.detect(page)["code"], detector.ARTIFACT_ATTACHMENT_OUTSIDE_ENVELOPE)

    def test_assistant_index_change_fails_identity(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
        proof = completed_result(self.PROMPT, page, assistant_index=99)
        self.assertEqual(self.detect(page, completed=proof)["code"], detector.ARTIFACT_TURN_IDENTITY_MISMATCH)

    def test_assistant_text_change_after_completion_fails_identity(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
        proof = completed_result(self.PROMPT, page, text="old text")
        self.assertEqual(self.detect(page, completed=proof)["code"], detector.ARTIFACT_TURN_IDENTITY_MISMATCH)

    def test_generation_restarted_after_completion_fails_closed(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME), generating=True)
        self.assertEqual(self.detect(page)["code"], detector.ARTIFACT_TURN_NOT_COMPLETED)

    def test_valid_full_proof_confirms_dom_without_download(self):
        page = FakePage(prompt=self.PROMPT, assistant_text=envelope(self.REQ, self.FILENAME))
        result = self.detect(page)
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], detector.ARTIFACT_DOM_CONFIRMED)
        self.assertFalse(result["details"]["downloadStarted"])
        self.assertTrue(result["details"]["attachment"]["betweenMarkers"])

    def test_json_output_is_windows_console_safe(self):
        payload = detector._json_dumps({"ok": True, "details": {"probe": "ЛУНА"}})
        self.assertTrue(payload.isascii())
        self.assertEqual(json.loads(payload)["details"]["probe"], "ЛУНА")

    def test_source_handles_markers_split_across_markdown_text_nodes(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("markerRanges", source)
        self.assertIn("NodeFilter.SHOW_ALL", source)
        self.assertIn("beginRanges.length === 1", source)
        self.assertIn("endRanges.length === 1", source)

    def test_source_never_uses_page_body_search(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn('locator("body")', source)
        self.assertNotIn("locator('body')", source)

    def test_source_never_downloads_or_clicks(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        for token in ["expect_download", ".click(", "save_as(", "download.save"]:
            self.assertNotIn(token, source)

    def test_dom_collection_is_scoped_to_correlated_turn(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("turn.evaluate(_DOM_CANDIDATE_JS", source)
        self.assertNotIn("page.evaluate(_DOM_CANDIDATE_JS", source)

    def test_live_wrapper_uses_existing_submit_and_observer_primitives(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("submit.submit_fresh_prompt", source)
        self.assertIn("observer.observe_next_assistant", source)


if __name__ == "__main__":
    unittest.main()
