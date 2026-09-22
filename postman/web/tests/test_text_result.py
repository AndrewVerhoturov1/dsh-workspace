from __future__ import annotations

from pathlib import Path
import sys
import unittest

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import text_result

REQ = "REQ_20260922T010203Z_1234"


class TextResultTests(unittest.TestCase):
    def test_accepts_exact_req_bound_envelope(self):
        body = "Первая строка.\n\n- пункт 1\n- пункт 2"
        source = "\n".join((text_result.begin_marker(REQ), body, text_result.end_marker(REQ)))
        result = text_result.parse_text_envelope(source, REQ)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], text_result.TEXT_RESULT_CONFIRMED)
        self.assertEqual(result["details"]["assistantText"], body)
        self.assertEqual(len(result["details"]["assistantTextSha256"]), 64)

    def test_rejects_wrong_req_markers(self):
        wrong = "REQ_20260922T010204Z_1235"
        source = "\n".join((text_result.begin_marker(wrong), "Ответ", text_result.end_marker(wrong)))
        result = text_result.parse_text_envelope(source, REQ)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], text_result.TEXT_RESULT_MARKERS_MISSING)

    def test_rejects_extra_visible_text(self):
        source = "\n".join(("Готово:", text_result.begin_marker(REQ), "Ответ", text_result.end_marker(REQ)))
        result = text_result.parse_text_envelope(source, REQ)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], text_result.TEXT_RESULT_EXTRA_TEXT)

    def test_rejects_empty_and_ambiguous_envelopes(self):
        empty = "\n".join((text_result.begin_marker(REQ), "", text_result.end_marker(REQ)))
        self.assertEqual(text_result.parse_text_envelope(empty, REQ)["code"], text_result.TEXT_RESULT_EMPTY)
        ambiguous = "\n".join((
            text_result.begin_marker(REQ),
            text_result.begin_marker(REQ),
            "Ответ",
            text_result.end_marker(REQ),
        ))
        self.assertEqual(
            text_result.parse_text_envelope(ambiguous, REQ)["code"],
            text_result.TEXT_RESULT_MARKERS_AMBIGUOUS,
        )


if __name__ == "__main__":
    unittest.main()
