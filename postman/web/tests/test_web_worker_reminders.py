from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import artifact_detector
import artifact_download
import browser_observer
import browser_submit
import reminder_policy
import web_worker_bridge


REQ = "REQ_20260920T120000Z_1234"
TASK_URL = "https://example.test/REQ.md"
CHAT_URL = "https://chatgpt.com/c/postman-reminder-test"
PROMPT = f"POSTMAN_REQUEST_ID: {REQ}\ntask_file: https://example.test/task.md"
FILENAME = f"POSTMAN_{REQ}_RESULT.zip"


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
        self.closed = False

    def close(self) -> None:
        self.closed = True

    def is_closed(self) -> bool:
        return self.closed


class FakeContext:
    def __init__(self, page: FakePage) -> None:
        self.pages = []
        self.page = page
        self.closed = False

    def new_page(self) -> FakePage:
        self.pages.append(self.page)
        return self.page

    def close(self) -> None:
        self.closed = True


class FakeBrowser:
    def __init__(self, context: FakeContext) -> None:
        self.contexts = [context]


class FakeChromium:
    def __init__(self, browser: FakeBrowser) -> None:
        self.browser = browser

    def connect_over_cdp(self, _url: str) -> FakeBrowser:
        return self.browser


class FakePlaywright:
    def __init__(self, browser: FakeBrowser) -> None:
        self.chromium = FakeChromium(browser)


class FakeFactoryContext:
    def __init__(self, playwright: FakePlaywright) -> None:
        self.playwright = playwright

    def __enter__(self) -> FakePlaywright:
        return self.playwright

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


class FakeFactory:
    def __init__(self, page: FakePage) -> None:
        context = FakeContext(page)
        self.playwright = FakePlaywright(FakeBrowser(context))

    def __call__(self) -> FakeFactoryContext:
        return FakeFactoryContext(self.playwright)


def confirmed_submit(prompt: str) -> dict:
    return {
        "ok": True,
        "code": browser_submit.PROMPT_SEND_CONFIRMED,
        "sendState": browser_submit.PROVEN_SENT,
        "details": {
            "chatUrl": CHAT_URL,
            "userTurnCorrelationMode": "exact",
            "promptSha256": browser_submit.prompt_sha256(prompt),
        },
    }


def completed_observer() -> dict:
    return {
        "ok": True,
        "code": browser_observer.ASSISTANT_TURN_COMPLETED,
        "transitions": [browser_observer.ASSISTANT_TURN_COMPLETED],
        "details": {
            "chatUrl": CHAT_URL,
            "assistantIndex": 1,
            "assistantTextSha256": "a" * 64,
        },
    }


class WebWorkerReminderTests(unittest.TestCase):
    def make_bridge(self, root: str, clock: FakeClock) -> web_worker_bridge.WebWorkerBridge:
        return web_worker_bridge.WebWorkerBridge(
            root=root,
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        )

    def test_three_reminders_are_attempted_at_fixed_ten_minute_offsets(self):
        clock = FakeClock()
        page = FakePage()
        reminder_times = []
        reminder_prompts = []

        def observe_timeout(_page, _prompt, _chat_url, *, timeout_ms, **_kwargs):
            clock.sleep(timeout_ms / 1000.0)
            return {
                "ok": False,
                "code": browser_observer.ASSISTANT_TURN_TIMEOUT,
                "recoverable": True,
                "transitions": [],
                "details": {"chatUrl": CHAT_URL},
            }

        def send_reminder(_page, prompt, _chat_url, *, timeout_ms):
            reminder_times.append(round(clock.monotonic()))
            reminder_prompts.append(prompt)
            return confirmed_submit(prompt)

        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (
                patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                patch.object(browser_observer, "observe_next_assistant", side_effect=observe_timeout),
                patch.object(reminder_policy, "submit_reminder", side_effect=send_reminder),
            ):
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    observer_timeout_ms=45 * 60 * 1000,
                    reminder_interval_ms=10 * 60 * 1000,
                    max_reminders=3,
                    playwright_factory=FakeFactory(page),
                )

            self.assertFalse(result["ok"])
            self.assertEqual(reminder_times, [600, 1200, 1800])
            self.assertEqual(len(reminder_prompts), 3)
            self.assertIn("REMINDER 1/3", reminder_prompts[0])
            self.assertIn("REMINDER 2/3", reminder_prompts[1])
            self.assertIn("REMINDER 3/3", reminder_prompts[2])
            self.assertEqual(round(clock.monotonic()), 2700)
            self.assertTrue(page.closed)

            stored = bridge.read_state(REQ)
            self.assertEqual(len(stored["failureDetails"]["reminders"]), 3)

    def test_completed_error_response_waits_until_ten_minutes_before_reminder(self):
        clock = FakeClock()
        page = FakePage()
        reminder_times = []
        detector_calls = 0

        def detect(*_args, **_kwargs):
            nonlocal detector_calls
            detector_calls += 1
            if detector_calls == 1:
                return {"ok": False, "code": artifact_detector.ARTIFACT_ENVELOPE_MISSING, "details": {}}
            return {"ok": True, "code": artifact_detector.ARTIFACT_DOM_CONFIRMED, "details": {}}

        def send_reminder(_page, prompt, _chat_url, *, timeout_ms):
            reminder_times.append(round(clock.monotonic()))
            return confirmed_submit(prompt)

        durable = {
            "ok": True,
            "code": artifact_download.RESULT_DURABLE,
            "details": {
                "resultDirectory": "result-dir",
                "resultZip": "result.zip",
                "sha256": "b" * 64,
            },
        }

        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (
                patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                patch.object(browser_observer, "observe_next_assistant", return_value=completed_observer()),
                patch.object(artifact_detector, "detect_artifact_dom", side_effect=detect),
                patch.object(artifact_download, "download_validated_artifact", return_value=durable),
                patch.object(reminder_policy, "submit_reminder", side_effect=send_reminder),
            ):
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    playwright_factory=FakeFactory(page),
                )

            self.assertTrue(result["ok"])
            self.assertEqual(result["code"], web_worker_bridge.RESULT_DURABLE)
            self.assertEqual(reminder_times, [600])
            self.assertEqual(len(result["details"]["reminders"]), 1)
            self.assertTrue(result["details"]["browserCleanup"]["ownedPageClosed"])
            self.assertTrue(page.closed)

    def test_unknown_detector_failure_stops_immediately_without_waiting_for_reminder(self):
        clock = FakeClock()
        page = FakePage()

        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (
                patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                patch.object(browser_observer, "observe_next_assistant", return_value=completed_observer()),
                patch.object(
                    artifact_detector,
                    "detect_artifact_dom",
                    return_value={"ok": False, "code": "EXPECTED_TEST_STOP", "details": {}},
                ),
                patch.object(reminder_policy, "submit_reminder") as send_reminder,
            ):
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    playwright_factory=FakeFactory(page),
                )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], web_worker_bridge.BRIDGE_PIPELINE_FAILED)
            self.assertEqual(result["details"]["reason"], "EXPECTED_TEST_STOP")
            self.assertEqual(clock.monotonic(), 0.0)
            send_reminder.assert_not_called()
            self.assertTrue(page.closed)

    def test_valid_zip_before_ten_minutes_cancels_all_reminders(self):
        clock = FakeClock()
        page = FakePage()
        durable = {
            "ok": True,
            "code": artifact_download.RESULT_DURABLE,
            "details": {
                "resultDirectory": "result-dir",
                "resultZip": "result.zip",
                "sha256": "c" * 64,
            },
        }

        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (
                patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                patch.object(browser_observer, "observe_next_assistant", return_value=completed_observer()),
                patch.object(
                    artifact_detector,
                    "detect_artifact_dom",
                    return_value={"ok": True, "code": artifact_detector.ARTIFACT_DOM_CONFIRMED, "details": {}},
                ),
                patch.object(artifact_download, "download_validated_artifact", return_value=durable),
                patch.object(reminder_policy, "submit_reminder") as send_reminder,
            ):
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    playwright_factory=FakeFactory(page),
                )

            self.assertTrue(result["ok"])
            send_reminder.assert_not_called()
            self.assertEqual(result["details"]["reminders"], [])
            self.assertTrue(page.closed)


if __name__ == "__main__":
    unittest.main()
