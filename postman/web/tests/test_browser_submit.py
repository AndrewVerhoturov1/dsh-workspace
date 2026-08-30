from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

MODULE_PATH = WEB_DIR / "browser_submit.py"
spec = importlib.util.spec_from_file_location("browser_submit", MODULE_PATH)
submit = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(submit)


class FakeLocator:
    def __init__(self, page=None, kind="generic", items=None, visible=True, enabled=True, text=""):
        self.page = page
        self.kind = kind
        self.items = list(items or [])
        self._visible = visible
        self._enabled = enabled
        self._text = text
        self.last = self

    def count(self):
        return len(self.items) if self.items else (1 if self.kind in {"composer", "send", "body"} else 0)

    def is_visible(self):
        return self._visible

    def is_enabled(self):
        return self._enabled

    def input_value(self, timeout=None):
        if self.kind != "composer":
            raise RuntimeError("not input")
        return self.page.composer_text

    def inner_text(self, timeout=None):
        if self.kind == "composer":
            return self.page.composer_text
        if self.kind == "body":
            return self.page.body_text
        return self._text

    def text_content(self, timeout=None):
        return self.inner_text(timeout)

    def fill(self, text, timeout=None):
        if self.kind != "composer":
            raise RuntimeError("not composer")
        if self.page.fill_error:
            raise RuntimeError(self.page.fill_error)
        self.page.composer_text = text

    def click(self, timeout=None):
        if self.kind != "send":
            raise RuntimeError("not send")
        self.page.click_count += 1
        if self.page.click_error:
            raise RuntimeError(self.page.click_error)
        if self.page.confirm_on_click:
            self.page.user_turns.append(self.page.composer_text)
            self.page.composer_text = ""
            self.page.url = self.page.bound_url

    def nth(self, index):
        return FakeLocator(text=self.items[index])


class FakePage:
    def __init__(
        self,
        *,
        url="https://chatgpt.com/",
        composer_text="",
        turn_count=0,
        user_turns=None,
        body_text="",
        composer_visible=True,
        send_visible=True,
        send_enabled=True,
        fill_error=None,
        click_error=None,
        confirm_on_click=True,
        goto_error=None,
    ):
        self.url = url
        self.composer_text = composer_text
        self.turn_count = turn_count
        self.user_turns = list(user_turns or [])
        self.body_text = body_text
        self.composer_visible = composer_visible
        self.send_visible = send_visible
        self.send_enabled = send_enabled
        self.fill_error = fill_error
        self.click_error = click_error
        self.confirm_on_click = confirm_on_click
        self.goto_error = goto_error
        self.click_count = 0
        self.closed = False
        self.bound_url = "https://chatgpt.com/c/abc123"

    def goto(self, url, wait_until=None, timeout=None):
        if self.goto_error:
            raise RuntimeError(self.goto_error)
        self.url = url

    def locator(self, selector):
        if selector == "#prompt-textarea":
            return FakeLocator(self, "composer", visible=self.composer_visible)
        if selector in submit.bootstrap.COMPOSER_SELECTORS:
            return FakeLocator(items=[])
        if selector == "body":
            return FakeLocator(self, "body")
        if selector == submit.TURN_SELECTORS[0]:
            return FakeLocator(items=["turn"] * self.turn_count)
        if selector in submit.USER_TURN_SELECTORS:
            return FakeLocator(items=self.user_turns)
        if selector == submit.SEND_BUTTON_SELECTORS[0]:
            if self.send_visible:
                return FakeLocator(self, "send", visible=True, enabled=self.send_enabled)
            return FakeLocator(items=[])
        return FakeLocator(items=[])

    def get_by_role(self, role, name=None):
        return FakeLocator(items=[])

    def close(self):
        self.closed = True


class BrowserSubmitTests(unittest.TestCase):
    def test_root_url_accepts_chatgpt_root(self):
        self.assertTrue(submit.is_chatgpt_root_url("https://chatgpt.com/"))

    def test_root_url_rejects_conversation(self):
        self.assertFalse(submit.is_chatgpt_root_url("https://chatgpt.com/c/abc"))

    def test_bound_chat_url_accepts_conversation(self):
        self.assertTrue(submit.is_bound_chat_url("https://chatgpt.com/c/abc-123_X"))

    def test_bound_chat_url_rejects_root(self):
        self.assertFalse(submit.is_bound_chat_url("https://chatgpt.com/"))

    def test_prompt_sha_is_deterministic(self):
        self.assertEqual(submit.prompt_sha256("abc"), submit.prompt_sha256("abc"))
        self.assertNotEqual(submit.prompt_sha256("abc"), submit.prompt_sha256("abd"))

    def test_guard_starts_proven_not_sent(self):
        self.assertEqual(submit.SendGuard().state, submit.SEND_PROVEN_NOT_SENT)

    def test_guard_blocks_second_begin_after_started(self):
        guard = submit.SendGuard()
        guard.begin()
        with self.assertRaises(submit.SubmitError) as ctx:
            guard.begin()
        self.assertEqual(ctx.exception.code, submit.PROMPT_RESEND_BLOCKED)

    def test_guard_blocks_after_unknown(self):
        guard = submit.SendGuard()
        guard.begin()
        guard.unknown()
        with self.assertRaises(submit.SubmitError):
            guard.begin()

    def test_guard_blocks_after_confirmed(self):
        guard = submit.SendGuard()
        guard.begin()
        guard.confirm()
        with self.assertRaises(submit.SubmitError):
            guard.begin()

    def test_prepare_fresh_chat_requires_root(self):
        page = FakePage()
        page.goto = lambda *a, **k: setattr(page, "url", "https://chatgpt.com/c/stale")
        result = submit.prepare_fresh_chat(page, timeout_ms=0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], submit.FRESH_CHAT_NOT_CONFIRMED)

    def test_prepare_fresh_chat_requires_zero_turns(self):
        page = FakePage(turn_count=1)
        result = submit.prepare_fresh_chat(page, timeout_ms=0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], submit.FRESH_CHAT_NOT_CONFIRMED)

    def test_prepare_fresh_chat_requires_empty_composer(self):
        page = FakePage(composer_text="stale draft")
        result = submit.prepare_fresh_chat(page, timeout_ms=0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], submit.COMPOSER_NOT_EMPTY)

    def test_prepare_fresh_chat_accepts_root_zero_turn_empty_composer(self):
        page = FakePage()
        result = submit.prepare_fresh_chat(page, timeout_ms=0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], submit.FRESH_CHAT_CONFIRMED)

    def test_prepare_fresh_chat_navigation_failure_is_pre_send(self):
        page = FakePage(goto_error="offline")
        result = submit.prepare_fresh_chat(page, timeout_ms=0)
        self.assertEqual(result["code"], submit.SUBMIT_NAVIGATION_FAILED)

    def test_insert_prompt_requires_nonempty_prompt(self):
        page = FakePage()
        composer = page.locator("#prompt-textarea")
        result = submit.insert_prompt(page, composer, "")
        self.assertEqual(result["code"], submit.SUBMIT_INVALID_CONFIG)

    def test_insert_prompt_fills_exact_text(self):
        page = FakePage()
        composer = page.locator("#prompt-textarea")
        result = submit.insert_prompt(page, composer, "Привет")
        self.assertTrue(result["ok"])
        self.assertEqual(page.composer_text, "Привет")
        self.assertEqual(result["details"]["composerSelectorAfterFill"], "#prompt-textarea")

    def test_insert_prompt_reresolves_visible_composer_after_fill_swap(self):
        class SwapComposer:
            def __init__(self, page, kind):
                self.page = page
                self.kind = kind
                self.last = self

            def count(self):
                return 1

            def is_visible(self):
                return self.page.swapped if self.kind == "live" else not self.page.swapped

            def fill(self, text, timeout=None):
                if self.kind != "fallback":
                    raise RuntimeError("fixture expects fallback fill")
                self.page.live_text = text
                self.page.swapped = True

            def input_value(self, timeout=None):
                if self.kind == "fallback":
                    return ""
                raise RuntimeError("contenteditable has no input value")

            def inner_text(self, timeout=None):
                return self.page.live_text if self.kind == "live" else ""

            def text_content(self, timeout=None):
                return self.inner_text(timeout)

        class SwapPage:
            def __init__(self):
                self.swapped = False
                self.live_text = ""
                self.fallback = SwapComposer(self, "fallback")
                self.live = SwapComposer(self, "live")

            def locator(self, selector):
                if selector == "#prompt-textarea":
                    return self.live
                if selector == "textarea":
                    return self.fallback
                return FakeLocator(items=[])

        page = SwapPage()
        fallback = page.locator("textarea")
        self.assertTrue(fallback.is_visible())
        result = submit.insert_prompt(page, fallback, "WP005 swap probe", timeout_ms=0)
        self.assertTrue(result["ok"])
        self.assertTrue(page.swapped)
        self.assertFalse(fallback.is_visible())
        self.assertEqual(result["details"]["composerSelectorAfterFill"], "#prompt-textarea")
        self.assertEqual(result["details"]["observedTextLength"], len("WP005 swap probe"))

    def test_insert_failure_is_pre_send(self):
        page = FakePage(fill_error="blocked")
        result = submit.insert_prompt(page, page.locator("#prompt-textarea"), "x")
        self.assertEqual(result["code"], submit.PROMPT_INSERT_FAILED)

    def test_send_control_missing_does_not_start_send(self):
        page = FakePage(send_visible=False)
        composer = page.locator("#prompt-textarea")
        composer.fill("x")
        guard = submit.SendGuard()
        result = submit.submit_once(page, composer, "x", guard, timeout_ms=0)
        self.assertEqual(result["code"], submit.SEND_CONTROL_NOT_FOUND)
        self.assertEqual(guard.state, submit.SEND_PROVEN_NOT_SENT)
        self.assertEqual(page.click_count, 0)

    def test_click_exception_becomes_unknown_without_retry(self):
        page = FakePage(click_error="timeout")
        composer = page.locator("#prompt-textarea")
        composer.fill("x")
        guard = submit.SendGuard()
        result = submit.submit_once(page, composer, "x", guard, timeout_ms=0)
        self.assertEqual(result["code"], submit.PROMPT_SEND_UNKNOWN)
        self.assertEqual(guard.state, submit.SEND_UNKNOWN)
        self.assertEqual(page.click_count, 1)

    def test_no_proof_after_click_becomes_unknown(self):
        page = FakePage(confirm_on_click=False)
        composer = page.locator("#prompt-textarea")
        composer.fill("x")
        guard = submit.SendGuard()
        result = submit.submit_once(page, composer, "x", guard, timeout_ms=0)
        self.assertEqual(result["code"], submit.PROMPT_SEND_UNKNOWN)
        self.assertEqual(page.click_count, 1)

    def test_exact_new_turn_binds_send(self):
        page = FakePage()
        composer = page.locator("#prompt-textarea")
        composer.fill("probe")
        guard = submit.SendGuard()
        result = submit.submit_once(page, composer, "probe", guard, timeout_ms=0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["sendState"], submit.SEND_PROVEN_SENT)
        self.assertEqual(result["code"], submit.PROMPT_SEND_CONFIRMED)
        self.assertEqual(page.click_count, 1)
        self.assertTrue(result["details"]["chatUrlBound"])

    def test_wrong_user_turn_text_is_unknown(self):
        page = FakePage(confirm_on_click=False)
        composer = page.locator("#prompt-textarea")
        composer.fill("expected")
        button = page.locator(submit.SEND_BUTTON_SELECTORS[0])
        original_click = button.click
        def wrong_click(timeout=None):
            page.click_count += 1
            page.user_turns.append("wrong")
            page.composer_text = ""
            page.url = page.bound_url
        button.click = wrong_click
        page.locator = lambda selector, _orig=page.locator: button if selector == submit.SEND_BUTTON_SELECTORS[0] else _orig(selector)
        guard = submit.SendGuard()
        result = submit.submit_once(page, composer, "expected", guard, timeout_ms=0)
        self.assertEqual(result["code"], submit.PROMPT_SEND_UNKNOWN)

    def test_missing_bound_url_is_unknown(self):
        page = FakePage(confirm_on_click=False)
        composer = page.locator("#prompt-textarea")
        composer.fill("x")
        button = page.locator(submit.SEND_BUTTON_SELECTORS[0])
        def partial_click(timeout=None):
            page.click_count += 1
            page.user_turns.append("x")
            page.composer_text = ""
        button.click = partial_click
        page.locator = lambda selector, _orig=page.locator: button if selector == submit.SEND_BUTTON_SELECTORS[0] else _orig(selector)
        result = submit.submit_once(page, composer, "x", submit.SendGuard(), timeout_ms=0)
        self.assertEqual(result["code"], submit.PROMPT_SEND_UNKNOWN)

    def test_nonempty_composer_after_click_is_unknown(self):
        page = FakePage(confirm_on_click=False)
        composer = page.locator("#prompt-textarea")
        composer.fill("x")
        button = page.locator(submit.SEND_BUTTON_SELECTORS[0])
        def partial_click(timeout=None):
            page.click_count += 1
            page.user_turns.append("x")
            page.url = page.bound_url
        button.click = partial_click
        page.locator = lambda selector, _orig=page.locator: button if selector == submit.SEND_BUTTON_SELECTORS[0] else _orig(selector)
        result = submit.submit_once(page, composer, "x", submit.SendGuard(), timeout_ms=0)
        self.assertEqual(result["code"], submit.PROMPT_SEND_UNKNOWN)

    def test_full_submit_has_required_transition_chain(self):
        page = FakePage()
        result = submit.submit_fresh_prompt(page, "WP004 probe", timeout_ms=0)
        self.assertTrue(result["ok"])
        self.assertEqual(result["transitions"], [
            submit.PAGE_OWNED,
            submit.FRESH_CHAT_CONFIRMED,
            submit.COMPOSER_EMPTY_CONFIRMED,
            submit.PROMPT_INSERTED,
            submit.PROMPT_SEND_STARTED,
            submit.PROMPT_SEND_CONFIRMED,
            submit.CHAT_URL_BOUND,
        ])

    def test_full_submit_stale_draft_never_clicks(self):
        page = FakePage(composer_text="draft")
        result = submit.submit_fresh_prompt(page, "new", timeout_ms=0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["sendState"], submit.SEND_PROVEN_NOT_SENT)
        self.assertEqual(page.click_count, 0)

    def test_full_submit_stale_conversation_never_clicks(self):
        page = FakePage(turn_count=2)
        result = submit.submit_fresh_prompt(page, "new", timeout_ms=0)
        self.assertFalse(result["ok"])
        self.assertEqual(page.click_count, 0)

    def test_exact_prompt_proof_preserves_leading_and_trailing_spaces(self):
        page = FakePage()
        prompt = "  exact text  "
        result = submit.submit_fresh_prompt(page, prompt, timeout_ms=0)
        self.assertTrue(result["ok"])
        self.assertEqual(page.user_turns[-1], prompt)

    def test_ten_sequential_fresh_pages_each_send_once(self):
        results = []
        pages = []
        for index in range(10):
            page = FakePage()
            pages.append(page)
            results.append(submit.submit_fresh_prompt(page, f"probe-{index}", timeout_ms=0))
        self.assertTrue(all(result["ok"] for result in results))
        self.assertTrue(all(page.click_count == 1 for page in pages))
        self.assertEqual(sum(page.click_count for page in pages), 10)

    def test_full_submit_json_serializable(self):
        result = submit.submit_fresh_prompt(FakePage(), "probe", timeout_ms=0)
        json.dumps(result)

    def test_module_has_no_assistant_or_download_api(self):
        forbidden = {"download_artifact", "observe_assistant", "wait_assistant", "apply_artifact"}
        self.assertTrue(forbidden.isdisjoint(set(dir(submit))))

    def test_send_started_has_no_enter_fallback_symbol(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn('keyboard.press("Enter")', source)
        self.assertNotIn("keyboard.press('Enter')", source)

    def test_send_unknown_is_explicit_constant(self):
        self.assertEqual(submit.PROMPT_SEND_UNKNOWN, "PROMPT_SEND_UNKNOWN")


if __name__ == "__main__":
    unittest.main()
