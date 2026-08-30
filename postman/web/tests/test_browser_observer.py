from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

MODULE_PATH = WEB_DIR / "browser_observer.py"
spec = importlib.util.spec_from_file_location("browser_observer", MODULE_PATH)
observer = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(observer)


class FakeLocator:
    def __init__(
        self,
        *,
        items=None,
        text="",
        attrs=None,
        visible=True,
        child_role="",
    ):
        self.items = list(items or [])
        self._text = text
        self.attrs = dict(attrs or {})
        self._visible = visible
        self.child_role = child_role
        self.first = self
        self.last = self

    def count(self):
        return len(self.items) if self.items else (1 if self.attrs or self._text or self.child_role else 0)

    def nth(self, index):
        return self.items[index]

    def inner_text(self, timeout=None):
        return self._text

    def get_attribute(self, name):
        return self.attrs.get(name)

    def is_visible(self):
        return self._visible

    def locator(self, selector):
        if selector == "[data-message-author-role]" and self.child_role:
            return FakeLocator(attrs={"data-message-author-role": self.child_role})
        return FakeLocator(items=[])


def turn(role, text, test_id=""):
    attrs = {}
    if role:
        attrs["data-message-author-role"] = role
    if test_id:
        attrs["data-testid"] = test_id
    return FakeLocator(text=text, attrs=attrs)


class FakePage:
    def __init__(self, snapshots, *, url="https://chatgpt.com/c/chat1", generating=None):
        self.snapshots = list(snapshots)
        self.url = url
        self.step = 0
        self.generating = list(generating or [False] * max(len(self.snapshots), 1))

    @property
    def current(self):
        return self.snapshots[min(self.step, len(self.snapshots) - 1)]

    def locator(self, selector):
        if selector == observer.TURN_CONTAINER_SELECTORS[0]:
            return FakeLocator(items=self.current)
        if selector == observer.TURN_CONTAINER_SELECTORS[1]:
            return FakeLocator(items=[])
        if selector in observer.GENERATION_CONTROL_SELECTORS:
            active = self.generating[min(self.step, len(self.generating) - 1)]
            return FakeLocator(attrs={"x": "1"}, visible=active) if active else FakeLocator(items=[])
        return FakeLocator(items=[])

    def get_by_role(self, role, name=None):
        return FakeLocator(items=[])


class FakeClock:
    def __init__(self, page, *, increment=0.25):
        self.value = 0.0
        self.page = page
        self.increment = increment

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.value += max(seconds, self.increment)
        self.page.step += 1


class ObserverTests(unittest.TestCase):
    def test_normalize_only_line_endings(self):
        self.assertEqual(observer._normalize_text("  a\r\nb  "), "  a\nb  ")

    def test_text_sha_is_deterministic(self):
        self.assertEqual(observer.text_sha256("x"), observer.text_sha256("x"))
        self.assertNotEqual(observer.text_sha256("x"), observer.text_sha256("y"))

    def test_infer_role_direct_user(self):
        self.assertEqual(observer.infer_turn_role(turn("user", "x")), "user")

    def test_infer_role_direct_assistant(self):
        self.assertEqual(observer.infer_turn_role(turn("assistant", "x")), "assistant")

    def test_infer_role_nested(self):
        node = FakeLocator(text="x", child_role="assistant")
        self.assertEqual(observer.infer_turn_role(node), "assistant")

    def test_extract_turn_text_prefers_nested_semantic_message(self):
        class OuterWithUi(FakeLocator):
            def __init__(self):
                super().__init__(text="prompt Copy Edit", attrs={"data-testid": "conversation-turn-1"})
            def locator(self, selector):
                if selector == "[data-message-author-role]":
                    return FakeLocator(
                        items=[FakeLocator(text="prompt", attrs={"data-message-author-role": "user"})]
                    )
                return FakeLocator(items=[])

        self.assertEqual(observer.extract_turn_text(OuterWithUi()), "prompt")

    def test_snapshot_ignores_outer_ui_labels_for_anchor_text(self):
        class OuterWithUi(FakeLocator):
            def __init__(self, role, message, ui, test_id):
                super().__init__(text=message + ui, attrs={"data-testid": test_id})
                self.role = role
                self.message = message
            def locator(self, selector):
                if selector == "[data-message-author-role]":
                    return FakeLocator(
                        items=[FakeLocator(text=self.message, attrs={"data-message-author-role": self.role})]
                    )
                return FakeLocator(items=[])

        page = FakePage([[
            OuterWithUi("user", "exact prompt", " Copy Edit", "conversation-turn-1"),
            OuterWithUi("assistant", "answer", " Copy", "conversation-turn-2"),
        ]])
        turns, _ = observer.snapshot_turns(page)
        self.assertEqual(turns[0]["text"], "exact prompt")
        self.assertEqual(observer.find_user_anchor(turns, "exact prompt"), 0)

    def test_infer_role_from_semantic_testid(self):
        node = FakeLocator(text="x", attrs={"data-testid": "conversation-turn-user"})
        self.assertEqual(observer.infer_turn_role(node), "user")

    def test_infer_role_unknown_fail_closed(self):
        self.assertEqual(observer.infer_turn_role(FakeLocator(text="x")), "unknown")

    def test_snapshot_preserves_dom_order(self):
        page = FakePage([[turn("user", "u"), turn("assistant", "a")]])
        turns, selector = observer.snapshot_turns(page)
        self.assertEqual(selector, observer.TURN_CONTAINER_SELECTORS[0])
        self.assertEqual([t["role"] for t in turns], ["user", "assistant"])
        self.assertEqual([t["index"] for t in turns], [0, 1])

    def test_anchor_requires_exact_text(self):
        turns = [
            {"index": 0, "role": "user", "text": " probe "},
        ]
        self.assertIsNone(observer.find_user_anchor(turns, "probe"))
        self.assertEqual(observer.find_user_anchor(turns, " probe "), 0)

    def test_anchor_uses_last_exact_user_turn(self):
        turns = [
            {"index": 0, "role": "user", "text": "x"},
            {"index": 1, "role": "assistant", "text": "old"},
            {"index": 2, "role": "user", "text": "x"},
        ]
        self.assertEqual(observer.find_user_anchor(turns, "x"), 2)

    def test_old_assistant_before_anchor_is_ignored(self):
        turns = [
            {"index": 0, "role": "assistant", "text": "stale"},
            {"index": 1, "role": "user", "text": "probe"},
            {"index": 2, "role": "assistant", "text": "fresh"},
        ]
        result = observer.correlate_next_assistant(turns, "probe")
        self.assertTrue(result["ok"])
        self.assertEqual(result["assistantIndex"], 2)
        self.assertEqual(result["assistant"]["text"], "fresh")

    def test_anchor_missing(self):
        result = observer.correlate_next_assistant(
            [{"index": 0, "role": "user", "text": "other"}],
            "probe",
        )
        self.assertEqual(result["code"], observer.USER_TURN_ANCHOR_MISSING)

    def test_assistant_not_started(self):
        result = observer.correlate_next_assistant(
            [{"index": 0, "role": "user", "text": "probe"}],
            "probe",
        )
        self.assertEqual(result["code"], observer.ASSISTANT_NOT_STARTED)

    def test_next_user_is_correlation_lost(self):
        result = observer.correlate_next_assistant(
            [
                {"index": 0, "role": "user", "text": "probe"},
                {"index": 1, "role": "user", "text": "unexpected"},
            ],
            "probe",
        )
        self.assertEqual(result["code"], observer.CHAT_CORRELATION_LOST)

    def test_unknown_next_turn_is_state_unknown(self):
        result = observer.correlate_next_assistant(
            [
                {"index": 0, "role": "user", "text": "probe"},
                {"index": 1, "role": "unknown", "text": "?"},
            ],
            "probe",
        )
        self.assertEqual(result["code"], observer.ASSISTANT_STATE_UNKNOWN)

    def test_tracker_started_on_first_target(self):
        tracker = observer.AssistantLifecycleTracker(stable_ms=500)
        self.assertFalse(tracker.observe("", generating=False, now_ms=0))
        self.assertEqual(tracker.transitions, [observer.ASSISTANT_TURN_STARTED])

    def test_tracker_streaming_from_generation_control(self):
        tracker = observer.AssistantLifecycleTracker(stable_ms=500)
        tracker.observe("a", generating=True, now_ms=0)
        self.assertIn(observer.ASSISTANT_TURN_STREAMING, tracker.transitions)

    def test_tracker_streaming_from_text_change(self):
        tracker = observer.AssistantLifecycleTracker(stable_ms=500)
        tracker.observe("a", generating=False, now_ms=0)
        tracker.observe("ab", generating=False, now_ms=100)
        self.assertIn(observer.ASSISTANT_TURN_STREAMING, tracker.transitions)

    def test_tracker_does_not_complete_empty_turn(self):
        tracker = observer.AssistantLifecycleTracker(stable_ms=0)
        tracker.observe("", generating=False, now_ms=0)
        self.assertFalse(tracker.observe("", generating=False, now_ms=1))

    def test_tracker_completes_nonempty_stable_turn(self):
        tracker = observer.AssistantLifecycleTracker(stable_ms=500)
        tracker.observe("done", generating=False, now_ms=0)
        self.assertTrue(tracker.observe("done", generating=False, now_ms=500))
        self.assertEqual(tracker.transitions[-1], observer.ASSISTANT_TURN_COMPLETED)

    def test_tracker_never_completes_while_generating(self):
        tracker = observer.AssistantLifecycleTracker(stable_ms=0)
        tracker.observe("done", generating=True, now_ms=0)
        self.assertFalse(tracker.observe("done", generating=True, now_ms=1000))

    def test_generation_active_detects_stop_control(self):
        page = FakePage([[turn("user", "x")]], generating=[True])
        active, selector = observer.generation_active(page)
        self.assertTrue(active)
        self.assertIn("stop", selector)

    def test_observer_rejects_invalid_expected_url(self):
        page = FakePage([[turn("user", "probe")]])
        result = observer.observe_next_assistant(
            page,
            "probe",
            "https://chatgpt.com/",
            timeout_ms=0,
        )
        self.assertEqual(result["code"], observer.OBSERVER_INVALID_CONFIG)

    def test_observer_rejects_empty_prompt(self):
        page = FakePage([[turn("user", "probe")]])
        result = observer.observe_next_assistant(
            page,
            "",
            page.url,
            timeout_ms=0,
        )
        self.assertEqual(result["code"], observer.OBSERVER_INVALID_CONFIG)

    def test_url_change_is_correlation_lost(self):
        page = FakePage([[turn("user", "probe"), turn("assistant", "a")]], url="https://chatgpt.com/c/other")
        result = observer.observe_next_assistant(
            page,
            "probe",
            "https://chatgpt.com/c/expected",
            timeout_ms=0,
        )
        self.assertEqual(result["code"], observer.CHAT_CORRELATION_LOST)

    def test_observer_waits_for_anchor_then_assistant(self):
        page = FakePage([
            [],
            [turn("user", "probe")],
            [turn("user", "probe"), turn("assistant", "done", "conversation-turn-2")],
            [turn("user", "probe"), turn("assistant", "done", "conversation-turn-2")],
        ])
        clock = FakeClock(page, increment=0.25)
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=2000,
            stable_ms=0,
            poll_ms=10,
            sleep=clock.sleep,
            monotonic=clock.monotonic,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], observer.ASSISTANT_TURN_COMPLETED)

    def test_observer_records_streaming_and_completion(self):
        page = FakePage(
            [
                [turn("user", "probe")],
                [turn("user", "probe"), turn("assistant", "a", "conversation-turn-2")],
                [turn("user", "probe"), turn("assistant", "ab", "conversation-turn-2")],
                [turn("user", "probe"), turn("assistant", "done", "conversation-turn-2")],
                [turn("user", "probe"), turn("assistant", "done", "conversation-turn-2")],
            ],
            generating=[False, True, True, False, False],
        )
        clock = FakeClock(page, increment=0.25)
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=3000,
            stable_ms=200,
            poll_ms=10,
            sleep=clock.sleep,
            monotonic=clock.monotonic,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(
            result["transitions"],
            [
                observer.ASSISTANT_TURN_STARTED,
                observer.ASSISTANT_TURN_STREAMING,
                observer.ASSISTANT_TURN_COMPLETED,
            ],
        )
        self.assertEqual(result["details"]["assistantText"], "done")
        self.assertTrue(result["details"]["streamingObserved"])

    def test_observer_short_complete_may_skip_streaming(self):
        page = FakePage([
            [turn("user", "probe"), turn("assistant", "ok", "conversation-turn-2")],
            [turn("user", "probe"), turn("assistant", "ok", "conversation-turn-2")],
        ])
        clock = FakeClock(page, increment=0.25)
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=1000,
            stable_ms=0,
            poll_ms=10,
            sleep=clock.sleep,
            monotonic=clock.monotonic,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["transitions"][0], observer.ASSISTANT_TURN_STARTED)
        self.assertEqual(result["transitions"][-1], observer.ASSISTANT_TURN_COMPLETED)

    def test_observer_next_user_fails_closed(self):
        page = FakePage([[
            turn("user", "probe"),
            turn("user", "unexpected"),
        ]])
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=0,
        )
        self.assertEqual(result["code"], observer.CHAT_CORRELATION_LOST)

    def test_observer_unknown_role_fails_closed(self):
        page = FakePage([[
            turn("user", "probe"),
            FakeLocator(text="mystery", attrs={"data-testid": "conversation-turn-2"}),
        ]])
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=0,
        )
        self.assertEqual(result["code"], observer.ASSISTANT_STATE_UNKNOWN)

    def test_observer_timeout_before_assistant(self):
        page = FakePage([[turn("user", "probe")]])
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=0,
        )
        self.assertEqual(result["code"], observer.ASSISTANT_TURN_TIMEOUT)

    def test_observer_anchor_missing_timeout(self):
        page = FakePage([[turn("user", "other")]])
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=0,
        )
        self.assertEqual(result["code"], observer.USER_TURN_ANCHOR_MISSING)

    def test_assistant_identity_change_is_correlation_lost(self):
        page = FakePage([
            [turn("user", "probe"), turn("assistant", "a", "conversation-turn-2")],
            [turn("user", "probe"), turn("assistant", "a", "conversation-turn-99")],
        ], generating=[True, False])
        clock = FakeClock(page, increment=0.25)
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=1000,
            stable_ms=500,
            poll_ms=10,
            sleep=clock.sleep,
            monotonic=clock.monotonic,
        )
        self.assertEqual(result["code"], observer.CHAT_CORRELATION_LOST)

    def test_result_json_serializable(self):
        page = FakePage([
            [turn("user", "probe"), turn("assistant", "ok", "conversation-turn-2")],
            [turn("user", "probe"), turn("assistant", "ok", "conversation-turn-2")],
        ])
        clock = FakeClock(page)
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=1000,
            stable_ms=0,
            sleep=clock.sleep,
            monotonic=clock.monotonic,
        )
        json.dumps(result)

    def test_module_has_no_download_api(self):
        forbidden = {"download_artifact", "apply_artifact", "save_artifact", "expect_download"}
        self.assertTrue(forbidden.isdisjoint(set(dir(observer))))

    def test_module_has_no_body_wide_response_search(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertNotIn('locator("body")', source)
        self.assertNotIn("locator('body')", source)

    def test_live_wrapper_uses_p3_submit_primitive_symbol(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn("submit.submit_fresh_prompt", source)

    def test_required_state_constants_are_exact(self):
        self.assertEqual(observer.ASSISTANT_TURN_STARTED, "ASSISTANT_TURN_STARTED")
        self.assertEqual(observer.ASSISTANT_TURN_STREAMING, "ASSISTANT_TURN_STREAMING")
        self.assertEqual(observer.ASSISTANT_TURN_COMPLETED, "ASSISTANT_TURN_COMPLETED")


if __name__ == "__main__":
    unittest.main()
