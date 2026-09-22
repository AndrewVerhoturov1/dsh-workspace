from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import reminder_policy


REQ = "REQ_20260920T120000Z_1234"
CHAT_URL = "https://chatgpt.com/c/postman-reminder-test"


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0
        self.sleeps: list[float] = []

    def monotonic(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        value = max(float(seconds), 0.0)
        self.sleeps.append(value)
        self.value += value


class Page:
    url = CHAT_URL


class Button:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.click_count = 0
        self.timeouts: list[int] = []

    def click(self, *, timeout: int) -> None:
        self.click_count += 1
        self.timeouts.append(timeout)
        if self.fail:
            raise RuntimeError("click failed")


def safe_anchor() -> dict:
    return {
        "safe": True,
        "reason": "",
        "turnCount": 1,
        "turnSelector": "turns",
        "requestKeyLine": f"POSTMAN_REQUEST_ID: {REQ}",
        "requestKeyMatched": True,
        "fingerprint": {
            "turnCount": 1,
            "lastTurnIndex": 0,
            "lastTurnRole": "user",
            "lastTurnTextSha256": "a" * 64,
        },
    }


def assistant_anchor() -> dict:
    return {
        "safe": False,
        "reason": "assistant_turn_present",
        "turnCount": 2,
        "turnSelector": "turns",
        "requestKeyLine": f"POSTMAN_REQUEST_ID: {REQ}",
        "requestKeyMatched": False,
        "fingerprint": {
            "turnCount": 2,
            "lastTurnIndex": 1,
            "lastTurnRole": "assistant",
            "lastTurnTextSha256": "b" * 64,
        },
    }


class ReminderPolicyTests(unittest.TestCase):
    def test_fixed_schedule_and_reminder_safe_send_timing(self):
        self.assertEqual(reminder_policy.DEFAULT_REMINDER_INTERVAL_MS, 600_000)
        self.assertEqual(reminder_policy.DEFAULT_REMINDER_COUNT, 3)
        self.assertEqual(reminder_policy.DEFAULT_OVERALL_TIMEOUT_MS, 2_700_000)
        self.assertEqual(reminder_policy.DEFAULT_REMINDER_SEND_WINDOW_MS, 5_000)
        self.assertEqual(reminder_policy.DEFAULT_REMINDER_POLL_MS, 1_000)
        self.assertEqual(reminder_policy.DEFAULT_REMINDER_CLICK_TIMEOUT_MS, 1_000)
        self.assertEqual(
            [reminder_policy.scheduled_elapsed_ms(index) for index in (1, 2, 3)],
            [600_000, 1_200_000, 1_800_000],
        )

    def test_reminder_keeps_same_req_and_is_explicit_transport_control(self):
        prompt = reminder_policy.build_reminder_prompt(REQ, 2)
        lines = prompt.splitlines()
        self.assertEqual(lines[0], f"POSTMAN_REQUEST_ID: {REQ}")
        self.assertEqual(lines[1], "POSTMAN_TRANSPORT_CONTROL: REMINDER 2/3")
        self.assertIn("Продолжай выполнение исходной задачи", prompt)
        self.assertIn("Не начинай исходную задачу заново", prompt)
        self.assertIn("Не отвечай отдельно", prompt)
        self.assertIn("строго по правилам исходной задачи", prompt)

    def test_invalid_reminder_configuration_is_rejected(self):
        for value in (0, 4, True):
            with self.assertRaises(ValueError):
                reminder_policy.build_reminder_prompt(REQ, value)
        with self.assertRaises(ValueError):
            reminder_policy.submit_reminder(Page(), reminder_policy.build_reminder_prompt(REQ, 1), CHAT_URL, poll_ms=0)
        with self.assertRaises(ValueError):
            reminder_policy.submit_reminder(Page(), reminder_policy.build_reminder_prompt(REQ, 1), CHAT_URL, send_window_ms=-1)

    def test_req_anchor_snapshot_accepts_only_latest_same_req_user_turn(self):
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        user_text = f"POSTMAN_REQUEST_ID: {REQ}\ntask_file: https://example.test/task.md"
        with patch.object(
            reminder_policy.browser_observer,
            "snapshot_turns",
            return_value=([{"index": 0, "role": "user", "text": user_text}], "turns"),
        ):
            result = reminder_policy._req_anchor_snapshot(Page(), prompt)
        self.assertTrue(result["safe"])
        self.assertTrue(result["requestKeyMatched"])

        with patch.object(
            reminder_policy.browser_observer,
            "snapshot_turns",
            return_value=(
                [
                    {"index": 0, "role": "user", "text": user_text},
                    {"index": 1, "role": "assistant", "text": "still working"},
                ],
                "turns",
            ),
        ):
            result = reminder_policy._req_anchor_snapshot(Page(), prompt)
        self.assertFalse(result["safe"])
        self.assertEqual(result["reason"], "assistant_turn_present")

    def test_active_generation_suppresses_before_composer_readiness(self):
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        with (
            patch.object(reminder_policy.submit, "same_conversation_url", return_value=True),
            patch.object(
                reminder_policy.browser_observer,
                "generation_active",
                return_value=(True, 'button[data-testid="stop-button"]'),
            ),
            patch.object(reminder_policy, "prepare_same_chat") as prepare,
            patch.object(reminder_policy.submit, "insert_prompt") as insert,
        ):
            result = reminder_policy.submit_reminder(Page(), prompt, CHAT_URL)

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_GENERATION_ACTIVE)
        self.assertTrue(result["details"]["composerUntouched"])
        self.assertTrue(result["details"]["unsentPromptCleared"])
        prepare.assert_not_called()
        insert.assert_not_called()

    def test_existing_assistant_turn_suppresses_without_touching_composer(self):
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        with (
            patch.object(reminder_policy.submit, "same_conversation_url", return_value=True),
            patch.object(reminder_policy.browser_observer, "generation_active", return_value=(False, "")),
            patch.object(reminder_policy, "_req_anchor_snapshot", return_value=assistant_anchor()),
            patch.object(reminder_policy, "prepare_same_chat") as prepare,
            patch.object(reminder_policy.submit, "insert_prompt") as insert,
        ):
            result = reminder_policy.submit_reminder(Page(), prompt, CHAT_URL)

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY)
        self.assertTrue(result["details"]["composerUntouched"])
        self.assertTrue(result["details"]["unsentPromptCleared"])
        prepare.assert_not_called()
        insert.assert_not_called()

    def test_composer_readiness_is_one_shot_not_thirty_second_wait(self):
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        page = Page()
        with (
            patch.object(reminder_policy.submit, "same_conversation_url", return_value=True),
            patch.object(reminder_policy.browser_observer, "generation_active", return_value=(False, "")),
            patch.object(reminder_policy, "_req_anchor_snapshot", return_value=safe_anchor()),
            patch.object(
                reminder_policy,
                "prepare_same_chat",
                return_value={"ok": False, "code": reminder_policy.submit.EXISTING_CHAT_NOT_CONFIRMED, "details": {}},
            ) as prepare,
            patch.object(reminder_policy.submit, "insert_prompt") as insert,
        ):
            result = reminder_policy.submit_reminder(page, prompt, CHAT_URL)

        prepare.assert_called_once_with(page, CHAT_URL, timeout_ms=0)
        insert.assert_not_called()
        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_SEND_NOT_READY)
        self.assertTrue(result["details"]["unsentPromptCleared"])

    def _run_inserted_window(
        self,
        *,
        clock: FakeClock,
        generation,
        anchor,
        send_button,
        clear=True,
        send_window_ms=5_000,
        poll_ms=1_000,
    ):
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        composer = object()
        with (
            patch.object(reminder_policy.submit, "same_conversation_url", return_value=True),
            patch.object(reminder_policy.browser_observer, "generation_active", side_effect=generation),
            patch.object(reminder_policy, "_req_anchor_snapshot", side_effect=anchor),
            patch.object(
                reminder_policy,
                "prepare_same_chat",
                return_value={
                    "ok": True,
                    "code": reminder_policy.submit.EXISTING_CHAT_CONFIRMED,
                    "composer": composer,
                    "details": {"composerSelector": "#prompt-textarea"},
                },
            ),
            patch.object(
                reminder_policy.submit,
                "insert_prompt",
                return_value={"ok": True, "code": reminder_policy.submit.PROMPT_INSERTED, "details": {}},
            ),
            patch.object(reminder_policy.submit, "_exact_prompt_readback", return_value=(True, {})),
            patch.object(reminder_policy.submit, "find_send_button", side_effect=send_button),
            patch.object(reminder_policy, "_clear_unsent_prompt", return_value=clear) as clear_prompt,
            patch.object(reminder_policy, "_click_ready_reminder_once") as click_ready,
        ):
            click_ready.return_value = {
                "ok": True,
                "code": reminder_policy.submit.PROMPT_SEND_CONFIRMED,
                "sendState": reminder_policy.submit.SEND_PROVEN_SENT,
                "transitions": [],
                "details": {},
            }
            result = reminder_policy.submit_reminder(
                Page(),
                prompt,
                CHAT_URL,
                send_window_ms=send_window_ms,
                poll_ms=poll_ms,
                sleep=clock.sleep,
                monotonic=clock.monotonic,
            )
        return result, clear_prompt, click_ready

    def test_send_window_polls_once_per_second_and_expires_after_five_seconds(self):
        clock = FakeClock()
        result, clear_prompt, click_ready = self._run_inserted_window(
            clock=clock,
            generation=lambda _page: (False, ""),
            anchor=lambda _page, _prompt: safe_anchor(),
            send_button=lambda _page: (None, None),
        )

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_SEND_NOT_READY)
        self.assertEqual(clock.value, 5.0)
        self.assertEqual(clock.sleeps, [1.0, 1.0, 1.0, 1.0, 1.0])
        self.assertEqual(result["details"]["reminderPollMs"], 1_000)
        self.assertEqual(result["details"]["reminderSendWindowMs"], 5_000)
        self.assertTrue(result["details"]["unsentPromptCleared"])
        clear_prompt.assert_called_once()
        click_ready.assert_not_called()

    def test_generation_start_during_send_window_aborts_immediately(self):
        clock = FakeClock()

        def generation(_page):
            return (clock.monotonic() >= 1.0, 'button[data-testid="stop-button"]' if clock.monotonic() >= 1.0 else "")

        result, clear_prompt, click_ready = self._run_inserted_window(
            clock=clock,
            generation=generation,
            anchor=lambda _page, _prompt: safe_anchor(),
            send_button=lambda _page: (None, None),
        )

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_GENERATION_ACTIVE)
        self.assertEqual(clock.value, 1.0)
        self.assertEqual(clock.sleeps, [1.0])
        self.assertTrue(result["details"]["unsentPromptCleared"])
        clear_prompt.assert_called_once()
        click_ready.assert_not_called()

    def test_assistant_activity_during_send_window_aborts_even_if_stop_control_flickers(self):
        clock = FakeClock()

        def anchor(_page, _prompt):
            return assistant_anchor() if clock.monotonic() >= 1.0 else safe_anchor()

        result, clear_prompt, click_ready = self._run_inserted_window(
            clock=clock,
            generation=lambda _page: (False, ""),
            anchor=anchor,
            send_button=lambda _page: (None, None),
        )

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY)
        self.assertEqual(clock.value, 1.0)
        self.assertTrue(result["details"]["unsentPromptCleared"])
        clear_prompt.assert_called_once()
        click_ready.assert_not_called()

    def test_ready_send_uses_immediate_final_reproof_before_single_click(self):
        clock = FakeClock()
        button = Button()
        result, clear_prompt, click_ready = self._run_inserted_window(
            clock=clock,
            generation=lambda _page: (False, ""),
            anchor=lambda _page, _prompt: safe_anchor(),
            send_button=lambda _page: (button, 'button[data-testid="send-button"]'),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], reminder_policy.submit.PROMPT_SEND_CONFIRMED)
        self.assertEqual(result["details"]["reminderPollCount"], 1)
        self.assertEqual(clock.sleeps, [])
        clear_prompt.assert_not_called()
        click_ready.assert_called_once()

    def test_generation_visible_on_final_preclick_reproof_never_clicks(self):
        clock = FakeClock()
        button = Button()
        calls = 0

        def generation(_page):
            nonlocal calls
            calls += 1
            # before_prepare, before_insert, send-window poll are idle; the
            # immediate pre-click re-proof sees generation.
            if calls >= 4:
                return True, 'button[data-testid="stop-button"]'
            return False, ""

        result, clear_prompt, click_ready = self._run_inserted_window(
            clock=clock,
            generation=generation,
            anchor=lambda _page, _prompt: safe_anchor(),
            send_button=lambda _page: (button, 'button[data-testid="send-button"]'),
        )

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_GENERATION_ACTIVE)
        self.assertEqual(result["details"]["suppressionPhase"], "pre_click")
        clear_prompt.assert_called_once()
        click_ready.assert_not_called()

    def test_cleanup_failure_after_window_expiry_stays_fail_closed(self):
        clock = FakeClock()
        result, _clear_prompt, click_ready = self._run_inserted_window(
            clock=clock,
            generation=lambda _page: (False, ""),
            anchor=lambda _page, _prompt: safe_anchor(),
            send_button=lambda _page: (None, None),
            clear=False,
            send_window_ms=1_000,
        )

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSION_CLEANUP_FAILED)
        self.assertEqual(result["sendState"], reminder_policy.submit.SEND_PROVEN_NOT_SENT)
        self.assertFalse(result["details"]["unsentPromptCleared"])
        click_ready.assert_not_called()

    def test_conversation_change_after_insert_fails_closed_without_touching_unknown_composer(self):
        clock = FakeClock()
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        composer = object()
        same_calls = 0

        def same_conversation(_left, _right):
            nonlocal same_calls
            same_calls += 1
            return same_calls < 2

        with (
            patch.object(reminder_policy.submit, "same_conversation_url", side_effect=same_conversation),
            patch.object(reminder_policy.browser_observer, "generation_active", return_value=(False, "")),
            patch.object(reminder_policy, "_req_anchor_snapshot", return_value=safe_anchor()),
            patch.object(
                reminder_policy,
                "prepare_same_chat",
                return_value={
                    "ok": True,
                    "code": reminder_policy.submit.EXISTING_CHAT_CONFIRMED,
                    "composer": composer,
                    "details": {"composerSelector": "#prompt-textarea"},
                },
            ),
            patch.object(
                reminder_policy.submit,
                "insert_prompt",
                return_value={"ok": True, "code": reminder_policy.submit.PROMPT_INSERTED, "details": {}},
            ),
            patch.object(reminder_policy, "_clear_unsent_prompt") as clear_prompt,
        ):
            result = reminder_policy.submit_reminder(
                Page(), prompt, CHAT_URL, sleep=clock.sleep, monotonic=clock.monotonic
            )

        self.assertEqual(result["code"], reminder_policy.REMINDER_SEND_GUARD_FAILED)
        self.assertFalse(result["details"]["unsentPromptCleared"])
        clear_prompt.assert_not_called()

    def test_click_ready_reminder_clicks_once_and_proves_send(self):
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        button = Button()
        with (
            patch.object(reminder_policy.submit, "collect_user_turn_texts", return_value=["previous"]),
            patch.object(
                reminder_policy.submit,
                "_wait_until",
                return_value=(True, {"userTurnCorrelationMode": "exact"}),
            ) as wait_until,
        ):
            result = reminder_policy._click_ready_reminder_once(
                Page(),
                button,
                'button[data-testid="send-button"]',
                prompt,
                before_turn_count=1,
                transitions=[reminder_policy.submit.PAGE_OWNED],
                timeout_ms=30_000,
                poll_ms=1_000,
            )

        self.assertTrue(result["ok"])
        self.assertEqual(result["sendState"], reminder_policy.submit.SEND_PROVEN_SENT)
        self.assertEqual(button.click_count, 1)
        self.assertEqual(button.timeouts, [1_000])
        self.assertEqual(result["details"]["reminderProofPollMs"], 1_000)
        self.assertEqual(wait_until.call_args.kwargs["poll_ms"], 1_000)

    def test_click_exception_is_unknown_and_never_retried(self):
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        button = Button(fail=True)
        with patch.object(reminder_policy.submit, "collect_user_turn_texts", return_value=["previous"]):
            result = reminder_policy._click_ready_reminder_once(
                Page(),
                button,
                'button[data-testid="send-button"]',
                prompt,
                before_turn_count=1,
                transitions=[reminder_policy.submit.PAGE_OWNED],
                timeout_ms=30_000,
                poll_ms=1_000,
            )

        self.assertEqual(result["code"], reminder_policy.submit.PROMPT_SEND_UNKNOWN)
        self.assertEqual(result["sendState"], reminder_policy.submit.SEND_UNKNOWN)
        self.assertEqual(button.click_count, 1)

    def test_reminder_path_does_not_use_generic_thirty_second_submit_once(self):
        source = Path(reminder_policy.__file__).read_text(encoding="utf-8")
        self.assertNotIn("submit.submit_once(", source)
        self.assertIn("prepare_same_chat(page, conversation_url, timeout_ms=0)", source)


if __name__ == "__main__":
    unittest.main()
