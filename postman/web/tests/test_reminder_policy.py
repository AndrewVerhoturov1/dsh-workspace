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


class ReminderPolicyTests(unittest.TestCase):
    def test_fixed_schedule_is_ten_twenty_thirty_minutes(self):
        self.assertEqual(reminder_policy.DEFAULT_REMINDER_INTERVAL_MS, 600_000)
        self.assertEqual(reminder_policy.DEFAULT_REMINDER_COUNT, 3)
        self.assertEqual(reminder_policy.DEFAULT_OVERALL_TIMEOUT_MS, 2_700_000)
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

    def test_invalid_reminder_index_is_rejected(self):
        for value in (0, 4, True):
            with self.assertRaises(ValueError):
                reminder_policy.build_reminder_prompt(REQ, value)

    def test_submit_reminder_uses_current_page_and_existing_safe_send(self):
        page = object()
        composer = object()
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        confirmed = {
            "ok": True,
            "code": reminder_policy.submit.PROMPT_SEND_CONFIRMED,
            "sendState": reminder_policy.submit.PROVEN_SENT,
            "details": {"userTurnCorrelationMode": "exact"},
        }
        with (
            patch.object(
                reminder_policy,
                "prepare_same_chat",
                return_value={
                    "ok": True,
                    "code": reminder_policy.submit.EXISTING_CHAT_CONFIRMED,
                    "composer": composer,
                    "details": {"composerSelector": "#prompt-textarea"},
                },
            ) as prepare,
            patch.object(
                reminder_policy.submit,
                "insert_prompt",
                return_value={"ok": True, "code": reminder_policy.submit.PROMPT_INSERTED, "details": {}},
            ) as insert,
            patch.object(reminder_policy.submit, "submit_once", return_value=confirmed) as submit_once,
        ):
            result = reminder_policy.submit_reminder(page, prompt, CHAT_URL)

        self.assertTrue(result["ok"])
        prepare.assert_called_once_with(page, CHAT_URL, timeout_ms=reminder_policy.submit.DEFAULT_TIMEOUT_MS)
        insert.assert_called_once()
        submit_once.assert_called_once()

    def test_active_generation_suppresses_before_composer_readiness_check(self):
        class Page:
            url = CHAT_URL

        page = Page()
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
            result = reminder_policy.submit_reminder(page, prompt, CHAT_URL)

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_GENERATION_ACTIVE)
        self.assertEqual(result["details"]["suppressionPhase"], "before_prepare")
        self.assertTrue(result["details"]["sameConversation"])
        self.assertTrue(result["details"]["composerUntouched"])
        self.assertTrue(result["details"]["unsentPromptCleared"])
        prepare.assert_not_called()
        insert.assert_not_called()

    def test_active_generation_suppresses_reminder_before_composer_mutation(self):
        page = object()
        composer = object()
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        with (
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
                reminder_policy.browser_observer,
                "generation_active",
                return_value=(True, 'button[data-testid="stop-button"]'),
            ),
            patch.object(reminder_policy.submit, "insert_prompt") as insert,
            patch.object(reminder_policy.submit, "submit_once") as submit_once,
        ):
            result = reminder_policy.submit_reminder(page, prompt, CHAT_URL)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_GENERATION_ACTIVE)
        self.assertEqual(result["sendState"], reminder_policy.submit.SEND_PROVEN_NOT_SENT)
        self.assertTrue(result["details"]["generationActive"])
        self.assertEqual(result["details"]["suppressionPhase"], "before_insert")
        self.assertTrue(result["details"]["unsentPromptCleared"])
        self.assertTrue(result["details"]["composerUntouched"])
        insert.assert_not_called()
        submit_once.assert_not_called()

    def test_generation_race_after_insert_clears_exact_prompt_and_suppresses(self):
        page = object()
        composer = object()
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        with (
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
                reminder_policy.browser_observer,
                "generation_active",
                side_effect=[(False, ""), (True, 'button[data-testid="stop-button"]')],
            ),
            patch.object(
                reminder_policy.submit,
                "insert_prompt",
                return_value={"ok": True, "code": reminder_policy.submit.PROMPT_INSERTED, "details": {}},
            ),
            patch.object(reminder_policy, "_clear_unsent_prompt", return_value=True) as clear,
            patch.object(reminder_policy.submit, "submit_once") as submit_once,
        ):
            result = reminder_policy.submit_reminder(page, prompt, CHAT_URL)

        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSED_GENERATION_ACTIVE)
        self.assertEqual(result["sendState"], reminder_policy.submit.SEND_PROVEN_NOT_SENT)
        self.assertEqual(result["details"]["suppressionPhase"], "after_insert")
        self.assertTrue(result["details"]["unsentPromptCleared"])
        self.assertFalse(result["details"]["composerUntouched"])
        clear.assert_called_once_with(page, prompt, timeout_ms=reminder_policy.submit.DEFAULT_TIMEOUT_MS)
        submit_once.assert_not_called()

    def test_generation_race_cleanup_failure_stays_fail_closed(self):
        page = object()
        composer = object()
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        with (
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
                reminder_policy.browser_observer,
                "generation_active",
                side_effect=[(False, ""), (True, 'button[data-testid="stop-button"]')],
            ),
            patch.object(
                reminder_policy.submit,
                "insert_prompt",
                return_value={"ok": True, "code": reminder_policy.submit.PROMPT_INSERTED, "details": {}},
            ),
            patch.object(reminder_policy, "_clear_unsent_prompt", return_value=False),
            patch.object(reminder_policy.submit, "submit_once") as submit_once,
        ):
            result = reminder_policy.submit_reminder(page, prompt, CHAT_URL)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], reminder_policy.REMINDER_SUPPRESSION_CLEANUP_FAILED)
        self.assertEqual(result["sendState"], reminder_policy.submit.SEND_PROVEN_NOT_SENT)
        self.assertFalse(result["details"]["unsentPromptCleared"])
        submit_once.assert_not_called()

    def test_proven_unsent_reminder_is_cleared_from_composer(self):
        page = object()
        composer = object()
        prompt = reminder_policy.build_reminder_prompt(REQ, 1)
        not_sent = {
            "ok": False,
            "code": reminder_policy.submit.SEND_CONTROL_NOT_FOUND,
            "sendState": reminder_policy.submit.SEND_PROVEN_NOT_SENT,
            "details": {},
        }
        with (
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
            patch.object(reminder_policy.submit, "submit_once", return_value=not_sent),
            patch.object(reminder_policy, "_clear_unsent_prompt", return_value=True) as clear,
        ):
            result = reminder_policy.submit_reminder(page, prompt, CHAT_URL)

        self.assertFalse(result["ok"])
        self.assertTrue(result["details"]["unsentPromptCleared"])
        clear.assert_called_once()


if __name__ == "__main__":
    unittest.main()
