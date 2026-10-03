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
import transport_control
from continuation_prompts import choose_continuation, CONTINUATION_TEMPLATES


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
        self.playwright_active = True
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1
        if not self.playwright_active:
            raise RuntimeError("Playwright already stopped before page.close()")
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

    def connect_over_cdp(self, _url: str, **kwargs) -> FakeBrowser:
        return self.browser


class FakePlaywright:
    def __init__(self, browser: FakeBrowser) -> None:
        self.chromium = FakeChromium(browser)


class FakeFactoryContext:
    def __init__(self, playwright: FakePlaywright, page: FakePage) -> None:
        self.playwright = playwright
        self.page = page

    def __enter__(self) -> FakePlaywright:
        self.page.playwright_active = True
        return self.playwright

    def __exit__(self, exc_type, exc, tb) -> None:
        self.page.playwright_active = False
        return None


class FakeFactory:
    def __init__(self, page: FakePage) -> None:
        context = FakeContext(page)
        self.playwright = FakePlaywright(FakeBrowser(context))
        self.page = page

    def __call__(self) -> FakeFactoryContext:
        return FakeFactoryContext(self.playwright, self.page)


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


def mocked_intent(_page, request_id, url, original, anchor, **kwargs):
    choice = choose_continuation(randrange=lambda _: 0)
    return {"requestId": request_id, "conversationUrl": url, **choice,
            "promptSha256": browser_submit.prompt_sha256(choice["exactPromptText"]),
            "slot": kwargs.get("slot"), "recoveryEventId": kwargs.get("recovery_event_id"),
            "expectedUserTurnRelation": {"userOrdinal": 1, "precedingUserHashes": [browser_submit.prompt_sha256(original)]}}


class WebWorkerReminderTests(unittest.TestCase):
    def setUp(self):
        # These legacy tests isolate scheduling. Real Send/lineage is exercised
        # independently against executable Chromium DOM in test_transport_dom.
        self.intent_patch = patch.object(transport_control, "make_intent", side_effect=mocked_intent)
        self.binding_patch = patch.object(transport_control, "confirmed_binding", return_value={"fixture": True})
        self.intent_patch.start()
        self.binding_patch.start()
        self.addCleanup(self.intent_patch.stop)
        self.addCleanup(self.binding_patch.stop)

    def make_bridge(self, root: str, clock: FakeClock) -> web_worker_bridge.WebWorkerBridge:
        return web_worker_bridge.WebWorkerBridge(
            root=root,
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        )

    def test_close_owned_page_retries_once_while_playwright_is_active(self):
        class FlakyPage(FakePage):
            def close(self) -> None:
                self.close_calls += 1
                if not self.playwright_active:
                    raise RuntimeError("Playwright already stopped before page.close()")
                if self.close_calls == 1:
                    raise RuntimeError("transient close failure")
                self.closed = True

        page = FlakyPage()
        cleanup = web_worker_bridge._close_owned_page(page)

        self.assertTrue(cleanup["ownedPageClosed"])
        self.assertEqual(cleanup["closeAttempts"], 2)
        self.assertEqual(page.close_calls, 2)

    def test_five_reminders_are_attempted_at_fixed_ten_minute_offsets(self):
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

        def send_reminder(_page, prompt, _chat_url, **_kwargs):
            reminder_times.append(round(clock.monotonic()))
            reminder_prompts.append(prompt)
            return confirmed_submit(prompt)

        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (
                patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                patch.object(browser_observer, "observe_next_assistant", side_effect=observe_timeout),
                patch.object(browser_observer, "inspect_answer_phase", return_value={"phase": browser_observer.WORKING}),
                patch.object(reminder_policy, "submit_reminder", side_effect=send_reminder),
            ):
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    observer_timeout_ms=60 * 60 * 1000,
                    reminder_interval_ms=10 * 60 * 1000,
                    max_reminders=5,
                    playwright_factory=FakeFactory(page),
                )

            self.assertFalse(result["ok"])
            self.assertEqual(reminder_times, [600, 1200, 1800, 2400, 3000])
            self.assertEqual(len(reminder_prompts), 5)
            self.assertTrue(all(p in CONTINUATION_TEMPLATES for p in reminder_prompts))
            self.assertEqual(round(clock.monotonic()), 3600)
            self.assertTrue(page.closed)

            stored = bridge.read_state(REQ)
            self.assertEqual(len(stored["failureDetails"]["reminders"]), 5)

    def test_due_unknown_retries_same_slot_before_next_checkpoint(self):
        clock = FakeClock()
        page = FakePage()
        phases = 0
        send_times = []
        def observe(_page, _prompt, _url, *, timeout_ms, **_kwargs):
            clock.sleep(timeout_ms / 1000.0)
            return {"ok": False, "code": browser_observer.ASSISTANT_TURN_TIMEOUT,
                    "details": {"chatUrl": CHAT_URL}}
        def phase(*_args, **_kwargs):
            nonlocal phases
            phases += 1
            return {"phase": browser_observer.UNKNOWN if phases == 1 else browser_observer.WORKING}
        def send(_page, prompt, _url, **_kwargs):
            send_times.append(clock.monotonic())
            return confirmed_submit(prompt)
        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                  patch.object(browser_observer, "observe_next_assistant", side_effect=observe),
                  patch.object(browser_observer, "inspect_answer_phase", side_effect=phase),
                  patch.object(reminder_policy, "submit_reminder", side_effect=send)):
                result = bridge.run_request(REQ, task_url=TASK_URL, prompt=PROMPT,
                                            expected_filename=FILENAME, expected_request={},
                                            observer_timeout_ms=30_000, reminder_interval_ms=10_000,
                                            max_reminders=1, playwright_factory=FakeFactory(page))
        self.assertFalse(result["ok"])
        self.assertEqual(len(send_times), 1)
        self.assertEqual(send_times[0], 10.0)  # Unknown phase no longer blocks a due reminder.
        self.assertLess(send_times[0], 20.0)
        self.assertEqual(result["details"]["details"]["reminders"][0]["index"], 1)

    def test_completed_error_response_is_rechecked_after_ten_seconds_without_reminder(self):
        clock = FakeClock()
        page = FakePage()
        detector_calls = 0

        def detect(*_args, **_kwargs):
            nonlocal detector_calls
            detector_calls += 1
            if detector_calls == 1:
                return {"ok": False, "code": artifact_detector.ARTIFACT_ENVELOPE_MISSING, "details": {}}
            return {"ok": True, "code": artifact_detector.ARTIFACT_DOM_CONFIRMED, "details": {}}

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
                patch.object(browser_observer, "connection_interrupted", return_value=(False, {})),
                patch.object(artifact_detector, "detect_artifact_dom", side_effect=detect),
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
        self.assertEqual(result["code"], web_worker_bridge.RESULT_DURABLE)
        self.assertEqual(clock.monotonic(), 10.0)
        send_reminder.assert_not_called()
        self.assertEqual(result["details"]["reminders"], [])
        self.assertTrue(result["details"]["browserCleanup"]["ownedPageClosed"])
        self.assertEqual(result["details"]["browserCleanup"]["closeAttempts"], 1)
        self.assertTrue(page.closed)

    def test_no_artifact_requires_fresh_observer_proof_after_ten_seconds(self):
        clock = FakeClock()
        page = FakePage()
        observer_calls = []

        def observe(_page, _prompt, _chat_url, **_kwargs):
            observer_calls.append(clock.monotonic())
            result = completed_observer()
            result["details"]["assistantText"] = "stable assistant text"
            result["details"]["assistantTextSha256"] = "a" * 64
            return result

        missing = {"ok": False, "code": artifact_detector.ARTIFACT_ATTACHMENT_NOT_FOUND, "details": {}}
        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (
                patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                patch.object(browser_observer, "observe_next_assistant", side_effect=observe),
                patch.object(browser_observer, "connection_interrupted", return_value=(False, {})),
                patch.object(artifact_detector, "detect_artifact_dom", return_value=missing),
                patch.object(reminder_policy, "submit_reminder") as send_reminder,
            ):
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    playwright_factory=FakeFactory(page),
                    observer_timeout_ms=20_000,
                    reminder_interval_ms=60_000,
                    max_reminders=0,
                )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], web_worker_bridge.ASSISTANT_COMPLETED_NO_ARTIFACT)
        self.assertGreaterEqual(len(observer_calls), 2)
        self.assertGreaterEqual(observer_calls[1], 10.0)
        self.assertEqual(result["details"]["assistantIndex"], 1)
        send_reminder.assert_not_called()

    def test_rejected_zip_returns_terminal_immediately_without_reminder(self):
        clock = FakeClock()
        page = FakePage()
        invalid = {
            "ok": False,
            "code": artifact_download.ARTIFACT_INVALID,
            "recoverable": True,
            "details": {
                "phase": "validator",
                "validatorCode": "ARTIFACT_BAD_ZIP",
                "validationMessage": "ZIP is malformed or cannot be read safely",
                "validationDetails": {"reason": "eocd"},
                "stagingDiscarded": True,
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
                patch.object(artifact_download, "download_validated_artifact", return_value=invalid) as download,
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

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], web_worker_bridge.ARTIFACT_REJECTED)
        self.assertEqual(result["details"]["validationCode"], "ARTIFACT_BAD_ZIP")
        self.assertIn("malformed", result["details"]["validationMessage"])
        self.assertEqual(result["details"]["validationDetails"], {"reason": "eocd"})
        self.assertEqual(result["details"]["assistantIndex"], 1)
        self.assertEqual(clock.monotonic(), 0.0)
        download.assert_called_once()
        send_reminder.assert_not_called()
        self.assertTrue(page.closed)

    def test_unknown_reminder_send_stops_without_later_reminders(self):
        clock = FakeClock()
        page = FakePage()

        def observe_timeout(_page, _prompt, _chat_url, *, timeout_ms, **_kwargs):
            clock.sleep(timeout_ms / 1000.0)
            return {
                "ok": False,
                "code": browser_observer.ASSISTANT_TURN_TIMEOUT,
                "recoverable": True,
                "transitions": [],
                "details": {"chatUrl": CHAT_URL},
            }

        unknown = {
            "ok": False,
            "code": browser_submit.PROMPT_SEND_UNKNOWN,
            "sendState": browser_submit.SEND_UNKNOWN,
            "details": {},
        }

        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (
                patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                patch.object(browser_observer, "observe_next_assistant", side_effect=observe_timeout),
                patch.object(browser_observer, "inspect_answer_phase", return_value={"phase": browser_observer.WORKING}),
                patch.object(reminder_policy, "submit_reminder", return_value=unknown) as send_reminder,
            ):
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    observer_timeout_ms=60 * 60 * 1000,
                    reminder_interval_ms=10 * 60 * 1000,
                    max_reminders=5,
                    playwright_factory=FakeFactory(page),
                )

                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], web_worker_bridge.POSTMAN_TRANSPORT_FAILED)
                self.assertEqual(result["details"]["transportCode"], web_worker_bridge.BRIDGE_PIPELINE_FAILED)
                self.assertEqual(result["details"]["transportMessage"], "reminder send state is UNKNOWN")
                self.assertEqual(result["details"]["details"]["reminderSubmit"]["sendState"], browser_submit.SEND_UNKNOWN)
                self.assertEqual(round(clock.monotonic()), 600)
                send_reminder.assert_called_once()
                self.assertEqual(
                    bridge.read_state(REQ)["failureDetails"]["reminders"][0]["sendState"],
                    browser_submit.SEND_UNKNOWN,
                )
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
            self.assertEqual(result["code"], web_worker_bridge.POSTMAN_TRANSPORT_FAILED)
            self.assertEqual(result["details"]["transportCode"], web_worker_bridge.BRIDGE_PIPELINE_FAILED)
            self.assertEqual(result["details"]["transportMessage"], "EXPECTED_TEST_STOP")
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
