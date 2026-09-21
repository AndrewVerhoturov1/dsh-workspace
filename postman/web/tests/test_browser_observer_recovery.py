from __future__ import annotations

from pathlib import Path
import sys
import unittest

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import browser_observer as observer


class FakeLocator:
    def __init__(
        self,
        *,
        items=None,
        text="",
        attrs=None,
        visible=True,
        scope_text=None,
        inside_turn=False,
    ):
        self.items = list(items or [])
        self._text = text
        self.attrs = dict(attrs or {})
        self._visible = visible
        self.scope_text = scope_text if scope_text is not None else text
        self.inside_turn = inside_turn
        self.first = self
        self.last = self

    def count(self):
        return len(self.items) if self.items else (1 if self.attrs or self._text else 0)

    def nth(self, index):
        return self.items[index]

    def inner_text(self, timeout=None):
        return self._text

    def get_attribute(self, name):
        return self.attrs.get(name)

    def is_visible(self):
        return self._visible

    def locator(self, selector):
        return FakeLocator(items=[])

    def evaluate(self, _script):
        return {
            "insideConversation": self.inside_turn,
            "scopeText": self.scope_text,
        }


def turn(role, text, test_id=""):
    attrs = {"data-message-author-role": role}
    if test_id:
        attrs["data-testid"] = test_id
    return FakeLocator(text=text, attrs=attrs)


class FakePage:
    def __init__(self, *, interrupted=None, inside_turn=False):
        self.url = "https://chatgpt.com/c/observer-recovery"
        self.interrupted = interrupted
        self.inside_turn = inside_turn
        self.turns = [
            turn("user", "probe", "conversation-turn-user"),
            turn("assistant", "done", "conversation-turn-assistant"),
        ]

    def locator(self, selector):
        if selector == observer.TURN_CONTAINER_SELECTORS[0]:
            return FakeLocator(items=self.turns)
        if selector == observer.TURN_CONTAINER_SELECTORS[1]:
            return FakeLocator(items=[])
        if selector in observer.GENERATION_CONTROL_SELECTORS:
            return FakeLocator(items=[])
        return FakeLocator(items=[])

    def get_by_role(self, role, name=None):
        return FakeLocator(items=[])

    def get_by_text(self, pattern):
        if not self.interrupted:
            return FakeLocator(items=[])
        if not pattern.search(self.interrupted):
            return FakeLocator(items=[])
        return FakeLocator(
            items=[
                FakeLocator(
                    text=self.interrupted,
                    scope_text=self.interrupted,
                    inside_turn=self.inside_turn,
                )
            ]
        )


class FakeClock:
    def __init__(self):
        self.value = 0.0

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.value += max(float(seconds), 0.0)


class ObserverRecoveryTests(unittest.TestCase):
    def test_generation_poll_interval_is_three_seconds(self):
        self.assertEqual(observer.DEFAULT_POLL_MS, 3_000)

    def test_russian_connection_interruption_is_detected(self):
        page = FakePage(interrupted="Соединение прервано. Ожидание полного ответа")
        active, details = observer.connection_interrupted(page)
        self.assertTrue(active)
        self.assertIn("Соединение прервано", details["matchedText"])

    def test_english_connection_interruption_is_detected(self):
        page = FakePage(interrupted="Connection interrupted. Waiting for full response")
        active, _ = observer.connection_interrupted(page)
        self.assertTrue(active)

    def test_same_text_inside_assistant_turn_is_not_treated_as_ui_interruption(self):
        page = FakePage(
            interrupted="Соединение прервано. Ожидание полного ответа",
            inside_turn=True,
        )
        active, _ = observer.connection_interrupted(page)
        self.assertFalse(active)

    def test_interruption_wins_over_stable_assistant_completion(self):
        page = FakePage(interrupted="Соединение прервано. Ожидание полного ответа")
        clock = FakeClock()
        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=10_000,
            stable_ms=0,
            sleep=clock.sleep,
            monotonic=clock.monotonic,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], observer.ASSISTANT_CONNECTION_INTERRUPTED)
        self.assertTrue(result["recoverable"])


    def test_observer_timeout_does_not_overshoot_three_second_poll(self):
        page = FakePage()
        page.turns = []
        clock = FakeClock()
        sleeps = []

        def bounded_sleep(seconds):
            sleeps.append(seconds)
            clock.sleep(seconds)

        result = observer.observe_next_assistant(
            page,
            "probe",
            page.url,
            timeout_ms=10_000,
            stable_ms=0,
            poll_ms=3_000,
            sleep=bounded_sleep,
            monotonic=clock.monotonic,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], observer.USER_TURN_ANCHOR_MISSING)
        self.assertEqual(sleeps, [3.0, 3.0, 3.0, 1.0])
        self.assertEqual(clock.monotonic(), 10.0)


if __name__ == "__main__":
    unittest.main()
