from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import browser_recovery


CHAT_URL = "https://chatgpt.com/c/recovery-test"
PROMPT = "POSTMAN_REQUEST_ID: REQ_20260921T000000Z_1234\ntask_file: https://example.test/task.md"


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def monotonic(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += max(float(seconds), 0.0)


class FakePage:
    def __init__(self) -> None:
        self.url = CHAT_URL
        self.reload_calls = []

    def reload(self, *, wait_until: str, timeout: int):
        self.reload_calls.append((wait_until, timeout))
        return None


class BrowserRecoveryTests(unittest.TestCase):
    def test_defaults_match_agreed_cadence(self):
        self.assertEqual(browser_recovery.DEFAULT_POLL_MS, 3_000)
        self.assertEqual(browser_recovery.DEFAULT_SETTLE_MS, 10_000)
        self.assertEqual(browser_recovery.DEFAULT_MAX_RELOAD_ATTEMPTS, 3)

    def test_recovery_reloads_same_page_then_waits_ten_second_settle(self):
        clock = FakeClock()
        page = FakePage()
        ready = {
            "ok": True,
            "code": browser_recovery.RECOVERY_READY,
            "details": {"sameConversation": True},
        }

        def wait_ready(*args, **kwargs):
            clock.sleep(kwargs["settle_ms"] / 1000.0)
            return ready

        with patch.object(browser_recovery, "wait_for_chat_ready", side_effect=wait_ready) as wait:
            result = browser_recovery.recover_interrupted_chat(
                page,
                CHAT_URL,
                PROMPT,
                sleep=clock.sleep,
                monotonic=clock.monotonic,
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(page.reload_calls, [("domcontentloaded", 60_000)])
        self.assertEqual(clock.monotonic(), 10.0)
        wait.assert_called_once()
        self.assertEqual(wait.call_args.kwargs["settle_ms"], 10_000)

    def test_recovery_is_bounded_to_three_reload_attempts(self):
        clock = FakeClock()
        page = FakePage()
        not_ready = {
            "ok": False,
            "code": browser_recovery.RECOVERY_NOT_READY,
            "recoverable": True,
            "details": {},
        }
        with patch.object(browser_recovery, "wait_for_chat_ready", return_value=not_ready):
            result = browser_recovery.recover_interrupted_chat(
                page,
                CHAT_URL,
                PROMPT,
                sleep=clock.sleep,
                monotonic=clock.monotonic,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], browser_recovery.RECOVERY_EXHAUSTED)
        self.assertEqual(len(page.reload_calls), 3)
        self.assertEqual(clock.monotonic(), 45.0)

    def test_budget_prevents_recovery_from_overrunning_request_deadline(self):
        clock = FakeClock()
        page = FakePage()
        result = browser_recovery.recover_interrupted_chat(
            page,
            CHAT_URL,
            PROMPT,
            budget_ms=5_000,
            sleep=clock.sleep,
            monotonic=clock.monotonic,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], browser_recovery.RECOVERY_BUDGET_EXHAUSTED)
        self.assertEqual(page.reload_calls, [])


if __name__ == "__main__":
    unittest.main()
