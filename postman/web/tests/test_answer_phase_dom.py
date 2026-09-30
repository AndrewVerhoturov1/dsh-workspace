"""Executable minimal ChatGPT turn-group DOM regressions."""
import sys
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

WEB = Path(__file__).resolve().parents[1]
if str(WEB) not in sys.path:
    sys.path.insert(0, str(WEB))
import browser_observer as observer

URL = "https://chatgpt.com/c/fixture-chat"
PROMPT = "POSTMAN_REQUEST_ID: REQ_20260925T162138Z_6278"


def html(activity="", final="", actions="", *, key="logical-1"):
    return (f'<main><div data-turn-key="{key}"><div data-user-message-bubble="true">{PROMPT}</div>'
            f'{activity}{final}{actions}</div></main>')


ACTIVITY = ('<div data-chatgpt-agent-turn-start><section data-testid="activity-progress">'
            '<div data-chatgpt-selection-message-id="unit-A"><div data-markdown-text-style="assistant-message">'
            'Researching...</div></div></section></div>')
FINAL = ('<div data-content-search-unit-key="logical-1:assistant" data-chatgpt-selection-message-id="unit-B">'
         '<div data-conversation-role="assistant"><div data-markdown-text-style="assistant-message">'
         'Final answer</div></div></div>')


class TurnGroupDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except Exception as exc:
            cls.playwright.stop()
            raise unittest.SkipTest(f"Chromium unavailable for DOM fixtures: {exc}") from exc

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.route('**/*', lambda route: route.fulfill(
            status=200, content_type='text/html', body='<html><body></body></html>'))
        self.page.goto(URL)
        self.tracker = observer.AnswerPhaseTracker()

    def tearDown(self):
        self.page.close()

    def inspect(self):
        return observer.inspect_answer_phase(self.page, PROMPT, URL, tracker=self.tracker)

    def test_activity_commentary_markdown_does_not_latch(self):
        self.page.set_content(html(ACTIVITY))
        phase = self.inspect()
        self.assertEqual(phase['phase'], observer.WORKING, phase)
        self.assertFalse(phase['finalAnswerLatched'])
        self.assertFalse(phase['finalUnitProven'])
        self.assertEqual(phase['logicalTurnKey'], 'logical-1')

    def test_tool_reasoning_and_status_are_working(self):
        self.page.set_content(html('<div data-chatgpt-agent-turn-start><div data-streaming-response-status>'
                                   '<div data-markdown-text-style="assistant-message">Thinking</div></div>'
                                   '<div data-testid="reasoning-summary">Reasoning</div>'
                                   '<div data-testid="tool-status-row">Tool running</div></div>'))
        self.assertEqual(self.inspect()['phase'], observer.WORKING)

    def test_internal_unit_changes_to_streaming_final(self):
        self.page.set_content(html(ACTIVITY))
        self.assertEqual(self.inspect()['phase'], observer.WORKING)
        self.page.set_content(html(ACTIVITY + FINAL))
        phase = self.inspect()
        self.assertEqual(phase['phase'], observer.FINAL_ANSWER_STARTED, phase)
        self.assertEqual(phase['assistantMessageId'], 'unit-B')
        self.assertEqual(phase['finalAnswerText'], 'Final answer')
        self.assertTrue(phase['finalAnswerLatched'])
        self.page.set_content(html(ACTIVITY))
        self.assertEqual(self.inspect()['phase'], observer.FINAL_ANSWER_STARTED)
        self.page.set_content(html())  # assistant units briefly detach during hydration
        self.assertEqual(self.inspect()['phase'], observer.FINAL_ANSWER_STARTED)

    def test_virtualized_anchor_index_does_not_clear_final_latch(self):
        self.page.set_content(html(FINAL))
        first = self.inspect()
        self.assertEqual(first['anchorIndex'], 0)
        self.assertEqual(first['phase'], observer.FINAL_ANSWER_STARTED)
        self.assertTrue(first['finalAnswerLatched'])

        prior = ('<main><div data-turn-key="earlier">'
                 '<div data-user-message-bubble="true">Earlier turn</div></div></main>')
        self.page.set_content(prior + html())  # same logical turn, no final unit this poll
        shifted = self.inspect()
        self.assertEqual(shifted['anchorIndex'], 1, shifted)
        self.assertEqual(shifted['logicalTurnKey'], 'logical-1')
        self.assertEqual(shifted['phase'], observer.FINAL_ANSWER_STARTED, shifted)
        self.assertTrue(shifted['finalAnswerLatched'])

    def test_agent_turn_marker_can_wrap_separate_final(self):
        self.page.set_content(html('<div data-chatgpt-agent-turn-start>'
                                   '<div data-testid="activity-progress"><div data-markdown-text-style="assistant-message">Thinking</div></div>'
                                   + FINAL + '</div>'))
        self.assertEqual(self.inspect()['phase'], observer.FINAL_ANSWER_STARTED)

    def test_completion_after_wrapped_final(self):
        self.page.set_content(html('<div data-chatgpt-agent-turn-start>' + FINAL +
                                   '<div class="turn-action-controls"><button data-testid="copy-turn-action-button">Copy</button></div></div>'))
        self.assertEqual(self.inspect()['phase'], observer.FINAL_ANSWER_COMPLETED)

    def test_completion_controls_on_exact_group(self):
        self.page.set_content(html(ACTIVITY + FINAL, actions='<div class="turn-action-controls">'
                                   '<button data-testid="copy-turn-action-button">Copy</button></div>'))
        self.assertEqual(self.inspect()['phase'], observer.FINAL_ANSWER_COMPLETED)

    def test_other_group_actions_do_not_complete(self):
        self.page.set_content(html(ACTIVITY + FINAL) + '<main><div data-turn-key="other">'
                                   '<button data-testid="copy-turn-action-button">Copy</button></div></main>')
        self.assertEqual(self.inspect()['phase'], observer.FINAL_ANSWER_STARTED)

    def test_uncategorized_markdown_fails_closed(self):
        self.page.set_content(html('<div data-chatgpt-selection-message-id="unit-A">'
                                   '<div data-markdown-text-style="assistant-message">Ambiguous</div></div>'))
        self.assertEqual(self.inspect()['phase'], observer.UNKNOWN)

    def test_new_anchor_resets_final_latch(self):
        self.page.set_content(html(FINAL))
        self.assertEqual(self.inspect()['phase'], observer.FINAL_ANSWER_STARTED)
        self.page.set_content(html(ACTIVITY, key='logical-2'))
        self.assertEqual(self.inspect()['phase'], observer.UNKNOWN)  # changed logical key at same anchor

    def test_observer_does_not_complete_activity_only(self):
        self.page.set_content(html(ACTIVITY))
        result = observer.observe_next_assistant(self.page, PROMPT, URL, timeout_ms=0, stable_ms=0)
        self.assertEqual(result['code'], observer.ASSISTANT_TURN_TIMEOUT, result)

    def test_observer_waits_through_commentary_and_reads_only_final(self):
        self.page.set_content(html(ACTIVITY))
        ticks = [0.0]
        def clock():
            return ticks[0]
        def advance(_seconds):
            ticks[0] += 0.1
            if ticks[0] >= 0.2:
                self.page.set_content(html(ACTIVITY + FINAL))
        result = observer.observe_next_assistant(self.page, PROMPT, URL,
                                                  timeout_ms=800, stable_ms=100,
                                                  poll_ms=10, sleep=advance, monotonic=clock)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['details']['assistantText'], 'Final answer')
        self.assertEqual(result['details']['answerPhase']['phase'], observer.FINAL_ANSWER_COMPLETED)

    def test_activity_actions_before_final_do_not_prove_completion(self):
        self.page.set_content(html(ACTIVITY + '<button data-testid="copy-turn-action-button">Activity copy</button>' + FINAL))
        self.assertEqual(self.inspect()['phase'], observer.FINAL_ANSWER_STARTED)


if __name__ == '__main__':
    unittest.main()
