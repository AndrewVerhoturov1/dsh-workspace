"""Global draft exclusion is fresh-only; page transaction guards remain shared."""
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import browser_submit as submit
import browser_observer as observer
import reminder_policy as reminders
from test_browser_submit import FakePage


class PresendLockScopeTests(unittest.TestCase):
    def test_fresh_takes_lock_but_existing_does_not(self):
        with patch.object(submit.process_lock, "lock_browser_presend") as lock:
            page = FakePage()
            self.assertTrue(submit.submit_fresh_prompt(page, "fresh", timeout_ms=0)["ok"])
            lock.assert_called_once_with()
            lock.reset_mock()
            page = FakePage(url="https://chatgpt.com/c/abc123", user_turns=["old"])
            self.assertTrue(submit.submit_existing_prompt(page, "packaging", page.url, timeout_ms=0)["ok"])
            lock.assert_not_called()

    def test_timeout_has_no_page_access_or_mutations(self):
        @contextmanager
        def busy():
            raise submit.process_lock.ResourceBusyError("private path")
            yield
        with patch.object(submit.process_lock, "lock_browser_presend", busy), \
             patch.object(submit, "_page_diagnostic") as diagnostic, \
             patch.object(submit, "prepare_fresh_chat") as prepare, \
             patch.object(submit.attachments, "upload") as upload, \
             patch.object(submit, "insert_prompt") as insert, \
             patch.object(submit, "clear_owned_unsent_prompt") as cleanup:
            result = submit.submit_fresh_prompt(object(), "own", input_attachment=object())
        self.assertEqual(result["code"], "BROWSER_PRESEND_LOCK_TIMEOUT")
        self.assertEqual(result["sendState"], submit.SEND_PROVEN_NOT_SENT)
        self.assertFalse(result["recoverable"])
        self.assertTrue(result["details"]["composerUntouched"])
        for call in (diagnostic, prepare, upload, insert, cleanup):
            call.assert_not_called()
        self.assertNotIn("private path", str(result))

    def test_reminder_and_system_continuation_do_not_wait_for_fresh_lock(self):
        page = FakePage(url="https://chatgpt.com/c/abc123")
        for system in (False, True):
            with self.subTest(system=system), \
                 patch.object(submit.process_lock, "lock_browser_presend", side_effect=AssertionError("global lock")) as lock, \
                 patch.object(observer, "inspect_answer_phase", return_value={"phase": observer.FINAL_ANSWER_STARTED, "finalAnswerLatched": True}), \
                 patch.object(observer, "connection_interrupted", return_value=(False, {})), \
                 patch.object(observer, "additional_processing", return_value=(False, {})):
                result = reminders.submit_reminder(page, "continue", page.url, system_continuation=system)
                self.assertEqual(result["sendState"], submit.SEND_PROVEN_NOT_SENT)
                lock.assert_not_called()

    def test_existing_exception_still_keeps_exact_unsent_cleanup(self):
        page = FakePage(url="https://chatgpt.com/c/abc123")
        page.send_visible = False
        with patch.object(submit.process_lock, "lock_browser_presend", side_effect=AssertionError("global lock")):
            result = submit.submit_existing_prompt(page, "own", page.url, timeout_ms=0)
        self.assertEqual(result["sendState"], submit.SEND_PROVEN_NOT_SENT)
        self.assertEqual(page.composer_text, "")
        self.assertEqual(page.click_count, 0)

    def test_existing_unknown_still_never_cleans_or_retries(self):
        page = FakePage(url="https://chatgpt.com/c/abc123", confirm_on_click=False)
        with patch.object(submit.process_lock, "lock_browser_presend", side_effect=AssertionError("global lock")):
            result = submit.submit_existing_prompt(page, "own", page.url, timeout_ms=0)
        self.assertEqual(result["sendState"], submit.SEND_UNKNOWN)
        self.assertEqual(page.composer_text, "own")
        self.assertEqual(page.click_count, 1)


if __name__ == "__main__":
    unittest.main()
