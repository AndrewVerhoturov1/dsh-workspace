"""Natural initial message contracts; no Web/network needed."""
from pathlib import Path
import sys
import unittest

WEB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB_DIR))
from launch_prompts import LAUNCH_PHRASES, build_launch_prompt, is_launch_prompt
from continuation_prompts import CONTINUATION_TEMPLATES


class LaunchPromptTests(unittest.TestCase):
    REQ = "REQ_20261001T175853Z_9264"
    URL = "https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/" + "a" * 40 + "/" + REQ + ".md"

    def test_exactly_fifty_unique_russian_launch_phrases(self):
        self.assertEqual(len(LAUNCH_PHRASES), 50)
        self.assertEqual(len(set(LAUNCH_PHRASES)), 50)
        self.assertTrue(set(LAUNCH_PHRASES).isdisjoint(CONTINUATION_TEMPLATES))
        for phrase in LAUNCH_PHRASES:
            self.assertRegex(phrase, "[А-Яа-я]")
            self.assertNotIn("\n", phrase)

    def test_every_launch_phrase_contains_exact_url_without_protocol_labels(self):
        for phrase in LAUNCH_PHRASES:
            prompt = phrase + "\n" + self.URL
            self.assertTrue(is_launch_prompt(prompt, self.REQ))
            self.assertEqual(prompt.splitlines()[1], self.URL)
            for marker in ("POSTMAN_REQUEST_ID:", "task_file:", "POSTMAN_TRANSPORT_CONTROL"):
                self.assertNotIn(marker, prompt)

    def test_stable_per_request_selection_preserves_exact_full_text(self):
        self.assertEqual(build_launch_prompt(self.REQ, self.URL), build_launch_prompt(self.REQ, self.URL))
        self.assertTrue(is_launch_prompt(build_launch_prompt(self.REQ, self.URL), self.REQ))

    def test_foreign_request_or_non_launch_text_is_not_accepted(self):
        prompt = build_launch_prompt(self.REQ, self.URL)
        self.assertFalse(is_launch_prompt(prompt, "REQ_20261001T183800Z_3866"))
        self.assertFalse(is_launch_prompt("Другая задача\n" + self.URL, self.REQ))
        self.assertFalse(is_launch_prompt(prompt + "\nещё строка", self.REQ))
        self.assertFalse(is_launch_prompt(LAUNCH_PHRASES[0] + "\nfile:///" + self.REQ + ".md", self.REQ))


if __name__ == "__main__":
    unittest.main()
