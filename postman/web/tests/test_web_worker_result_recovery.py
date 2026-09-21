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
import browser_recovery
import browser_submit
import reminder_policy
import web_worker_bridge


REQ = "REQ_20260921T000000Z_1234"
TASK_URL = "https://example.test/REQ.md"
CHAT_URL = "https://chatgpt.com/c/postman-result-recovery"
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
        self.page = page
        self.pages = []

    def new_page(self) -> FakePage:
        self.pages.append(self.page)
        return self.page


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
        self.context = FakeContext(page)
        self.playwright = FakePlaywright(FakeBrowser(self.context))

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


def missing_artifact() -> dict:
    return {
        "ok": False,
        "code": artifact_detector.ARTIFACT_ATTACHMENT_NOT_FOUND,
        "details": {},
    }


def found_artifact() -> dict:
    return {
        "ok": True,
        "code": artifact_detector.ARTIFACT_DOM_CONFIRMED,
        "details": {},
    }


def durable_result() -> dict:
    return {
        "ok": True,
        "code": artifact_download.RESULT_DURABLE,
        "details": {
            "resultDirectory": "result-dir",
            "resultZip": "result.zip",
            "sha256": "c" * 64,
        },
    }


def ready_chat() -> dict:
    return {
        "ok": True,
        "code": browser_recovery.RECOVERY_READY,
        "details": {
            "sameConversation": True,
            "connectionInterrupted": False,
        },
    }


class WebWorkerResultRecoveryTests(unittest.TestCase):
    def make_bridge(self, root: str, clock: FakeClock) -> web_worker_bridge.WebWorkerBridge:
        return web_worker_bridge.WebWorkerBridge(
            root=root,
            monotonic=clock.monotonic,
            sleep=clock.sleep,
        )

    def common_patches(self, detector_side_effect):
        return (
            patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
            patch.object(browser_observer, "observe_next_assistant", return_value=completed_observer()),
            patch.object(browser_observer, "connection_interrupted", return_value=(False, {})),
            patch.object(artifact_detector, "detect_artifact_dom", side_effect=detector_side_effect),
            patch.object(artifact_download, "download_validated_artifact", return_value=durable_result()),
            patch.object(browser_recovery, "chat_ready_snapshot", return_value=ready_chat()),
        )

    def test_due_reminder_runs_final_result_check_and_is_cancelled_when_zip_appears(self):
        clock = FakeClock()
        page = FakePage()
        detector_calls = [missing_artifact(), missing_artifact(), found_artifact()]

        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            patches = self.common_patches(detector_calls)
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patch.object(
                reminder_policy, "submit_reminder"
            ) as send_reminder:
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    observer_timeout_ms=60_000,
                    reminder_interval_ms=20_000,
                    max_reminders=1,
                    playwright_factory=FakeFactory(page),
                )

        self.assertTrue(result["ok"], result)
        self.assertEqual(clock.monotonic(), 20.0)
        send_reminder.assert_not_called()
        self.assertEqual(result["details"]["reminders"], [])

    def test_connection_interruption_recovers_same_chat_before_any_reminder(self):
        clock = FakeClock()
        page = FakePage()
        interruption_checks = 0

        def interruption(_page):
            nonlocal interruption_checks
            interruption_checks += 1
            if interruption_checks == 1:
                return True, {"matchedText": "Соединение прервано. Ожидание полного ответа"}
            return False, {}

        recovered = {
            "ok": True,
            "code": browser_recovery.RECOVERY_READY,
            "details": {"attempt": 1, "settleMs": 10_000},
        }

        with tempfile.TemporaryDirectory() as root:
            bridge = self.make_bridge(root, clock)
            with (
                patch.object(browser_submit, "submit_fresh_prompt", return_value=confirmed_submit(PROMPT)),
                patch.object(browser_observer, "connection_interrupted", side_effect=interruption),
                patch.object(browser_recovery, "recover_interrupted_chat", return_value=recovered) as recover,
                patch.object(browser_observer, "observe_next_assistant", return_value=completed_observer()),
                patch.object(artifact_detector, "detect_artifact_dom", return_value=found_artifact()),
                patch.object(artifact_download, "download_validated_artifact", return_value=durable_result()),
                patch.object(reminder_policy, "submit_reminder") as send_reminder,
            ):
                result = bridge.run_request(
                    REQ,
                    task_url=TASK_URL,
                    prompt=PROMPT,
                    expected_filename=FILENAME,
                    expected_request={},
                    observer_timeout_ms=60_000,
                    reminder_interval_ms=20_000,
                    max_reminders=1,
                    playwright_factory=FakeFactory(page),
                )

        self.assertTrue(result["ok"], result)
        recover.assert_called_once()
        self.assertIs(recover.call_args.args[0], page)
        self.assertEqual(recover.call_args.args[1], CHAT_URL)
        self.assertEqual(recover.call_args.args[2], PROMPT)
        send_reminder.assert_not_called()


if __name__ == "__main__":
    unittest.main()
