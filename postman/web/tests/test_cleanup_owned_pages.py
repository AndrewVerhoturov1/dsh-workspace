from __future__ import annotations
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cleanup_owned_pages import cleanup_owned_pages, owner_is_alive


class Page:
    def __init__(self, target, context="private-context"):
        self.target, self.context_id, self.closed = target, context, False
    def close(self):
        self.closed = True


class Context:
    def __init__(self, pages):
        self.pages = pages
    def new_cdp_session(self, page):
        class Session:
            def send(self, method):
                return {"targetInfo": {"targetId": page.target, "browserContextId": page.context_id}}
            def detach(self):
                pass
        return Session()


class CleanupTests(unittest.TestCase):
    def test_only_exact_recorded_dead_owner_page_is_closed(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            pages = [Page(x) for x in ("dead", "alive", "reused", "unknown", "wrong-context")]
            browser = type("Browser", (), {"contexts": [Context(pages)]})()
            def record(target, pid, *, context="private-context", modern=False):
                path = root / ("devspace/channel/web/workers" if modern else "workers") / (target + ".json")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({"pageDiagnostic": {"pageId": target, "pid": pid,
                    "contextId": context}}), encoding="utf-8")
            record("dead", 100, modern=True)
            record("alive", 200)
            record("reused", 300)
            record("wrong-context", 100, context="old-browser-context")
            alive = lambda pid: pid in (200, 300)
            preview = cleanup_owned_pages(browser, root, is_alive=alive)
            self.assertEqual(preview["eligible"], ["dead"])
            self.assertFalse(any(p.closed for p in pages))
            result = cleanup_owned_pages(browser, root, apply=True, is_alive=alive)
            self.assertEqual(result["closed"], ["dead"])
            self.assertEqual([p.closed for p in pages], [True, False, False, False, False])

    def test_missing_owner_or_context_proof_is_preserved(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / "workers").mkdir()
            for proof in ({"pageId": "page", "pid": 100},
                          {"pageId": "page", "contextId": "private-context"}):
                (root / "workers/record.json").write_text(json.dumps({"pageDiagnostic": proof}), encoding="utf-8")
                page = Page("page")
                browser = type("Browser", (), {"contexts": [Context([page])]})()
                self.assertEqual(cleanup_owned_pages(browser, root, apply=True, is_alive=lambda pid: False)["closed"], [])
                self.assertFalse(page.closed)

    def test_own_process_is_alive(self):
        import os
        self.assertTrue(owner_is_alive(os.getpid()))


if __name__ == "__main__":
    unittest.main()
