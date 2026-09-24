"""No Web network: cross-process REQ/chat and cold Chrome startup races."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest

DIRECT_DIR = Path(__file__).resolve().parents[1]
POSTMAN_DIR = DIRECT_DIR.parent
WEB_DIR = POSTMAN_DIR / "web"
for candidate in (DIRECT_DIR, POSTMAN_DIR, WEB_DIR):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))
import process_lock
import chat_reference

REPO = "AndrewVerhoturov1/dsh-workspace"
REQ_A = "REQ_20260924T010203Z_0001"
REQ_B = "REQ_20260924T010203Z_0002"
REQ_C = "REQ_20260924T010203Z_0003"


def save_chat(root, request, chat):
    path = root / "requests" / f"{request}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "ok": True, "state": "TEXT_RESULT_DURABLE", "code": "TEXT_RESULT_DURABLE",
        "repository": REPO, "requestId": request, "conversationUrl": f"https://chatgpt.com/c/{chat}",
    }), encoding="utf-8")


class LockTests(unittest.TestCase):
    def test_chat_aliases_conflict_but_different_conversations_do_not(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            save_chat(root, REQ_A, "same-chat")
            save_chat(root, REQ_B, "same-chat")
            save_chat(root, REQ_C, "different-chat")
            with process_lock.lock_chat(root, REQ_A, REPO):
                with self.assertRaises(process_lock.ResourceBusyError):
                    with process_lock.lock_chat(root, REQ_B, REPO):
                        self.fail("second writer entered same chat")
                with process_lock.lock_chat(root, REQ_C, REPO):
                    pass
                with process_lock.lock_chat(root, None, REPO):
                    pass
            with process_lock.lock_chat(root, REQ_B, REPO):
                pass

    def test_missing_chat_fails_closed_without_creating_a_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(chat_reference.ChatReferenceError):
                with process_lock.lock_chat(root, REQ_A, REPO):
                    self.fail("unproven chat")
            self.assertFalse((root / "locks").exists())

    def test_request_claim_is_unique_and_persistent_across_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            process_lock.claim_request(root, REQ_A)
            with self.assertRaises(FileExistsError):
                process_lock.claim_request(root, REQ_A)
            process_lock.claim_request(root, REQ_B)
            self.assertTrue((root / "locks" / f"request-{REQ_A}.claim").exists())

    def test_simultaneous_request_claim_has_exactly_one_owner(self):
        with tempfile.TemporaryDirectory() as temp, ThreadPoolExecutor(max_workers=2) as pool:
            barrier = threading.Barrier(2)
            def claim():
                barrier.wait(timeout=3)
                try:
                    process_lock.claim_request(temp, REQ_A)
                    return "owner"
                except FileExistsError:
                    return "rejected"
            results = list(pool.map(lambda _: claim(), range(2)))
            self.assertEqual(sorted(results), ["owner", "rejected"])

    def test_simultaneous_startup_launches_once_and_rechecks_cdp(self):
        # Import real Direct module; never open a browser. Synchronize the initial
        # probes so both threads see CDP down before either may launch.
        from postman.direct.tests import test_postman_direct
        postman_direct = test_postman_direct.direct
        class Boot:
            DEFAULT_CDP_URL = "http://127.0.0.1:9222"
            BOOTSTRAP_CDP_UNREACHABLE = "BOOTSTRAP_CDP_UNREACHABLE"
            class BrowserBootstrapError(RuntimeError):
                def __init__(self):
                    self.code = "BOOTSTRAP_CDP_UNREACHABLE"
            barrier = threading.Barrier(2)
            local = threading.local()
            lock = threading.Lock()
            launched = False
            launches = 0
            @staticmethod
            def normalize_cdp_url(value): return value
            @classmethod
            def wait_for_cdp(cls, value, timeout_s=0):
                if not getattr(cls.local, "first", False):
                    cls.local.first = True
                    cls.barrier.wait(timeout=3)
                    raise cls.BrowserBootstrapError()
                with cls.lock:
                    if not cls.launched:
                        raise cls.BrowserBootstrapError()
                return {"ready": True}
            @staticmethod
            def discover_chrome_executable(explicit=None): return Path("chrome.exe")
            @classmethod
            def start_dedicated_chrome(cls, *_args):
                with cls.lock:
                    cls.launched = True
                    cls.launches += 1
                return types.SimpleNamespace(pid=99)
        with tempfile.TemporaryDirectory() as temp, ThreadPoolExecutor(max_workers=2) as pool:
            profile = Path(temp) / "profile"
            calls = [pool.submit(postman_direct.ensure_dedicated_chrome, profile_dir=profile, bootstrap_module=Boot) for _ in range(2)]
            results = [call.result(timeout=5) for call in calls]
        self.assertEqual(Boot.launches, 1)
        self.assertEqual(sorted(item["launched"] for item in results), [False, True])

    def test_lock_releases_after_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "lock"
            with self.assertRaisesRegex(RuntimeError, "failure"):
                with process_lock.exclusive_lock(path):
                    raise RuntimeError("failure")
            with process_lock.exclusive_lock(path):
                pass

    def test_cli_rejects_busy_chat_before_any_publication(self):
        from postman.direct.tests import test_postman_direct
        import contextlib
        import io
        from unittest.mock import patch
        direct = test_postman_direct.direct
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            save_chat(root, REQ_A, "same-chat")
            with process_lock.lock_chat(root, REQ_A, REPO), patch.object(
                direct.DirectPostman, "run", side_effect=AssertionError("must not send"),
            ), contextlib.redirect_stdout(io.StringIO()) as output:
                code = direct.main(["--request-id", REQ_B, "--task", "intent",
                                    "--chat-request-id", REQ_A, "--direct-root", str(root)])
            self.assertEqual(code, 2)
            value = json.loads(output.getvalue())
            self.assertEqual(value["code"], "POSTMAN_TRANSPORT_FAILED")
            self.assertEqual(value["transportCode"], "DIRECT_CHAT_BUSY")
            self.assertEqual(value["requestId"], REQ_B)
            self.assertFalse((root / "locks" / f"request-{REQ_B}.claim").exists())

    def test_publication_lock_releases_for_second_request(self):
        with tempfile.TemporaryDirectory() as temp:
            with process_lock.lock_publication(temp, REPO, "main"):
                with self.assertRaises(process_lock.ResourceBusyError):
                    with process_lock.exclusive_lock(
                        Path(temp) / "locks" / next(p.name for p in (Path(temp) / "locks").glob("publish-*.lock"))
                    ):
                        self.fail("concurrent publisher")
            with process_lock.lock_publication(temp, REPO, "main"):
                pass


if __name__ == "__main__":
    unittest.main()
