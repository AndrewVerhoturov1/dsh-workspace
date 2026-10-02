"""Short shared lock regressions; no real browser required."""
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

WEB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB_DIR))
import cdp_download


class CdpDownloadTests(unittest.TestCase):
    def test_windows_artifacts_inherit_acl_and_cleanup_after_error(self):
        # Outside TemporaryDirectory: its protected 0o700 ACL is the regression.
        with patch.object(cdp_download.sys, "platform", "win32"):
            with patch.object(Path, "mkdir", autospec=True, wraps=Path.mkdir) as mkdir, \
                 patch.object(cdp_download.shutil, "rmtree") as cleanup:
                with self.assertRaisesRegex(RuntimeError, "download failure"):
                    with cdp_download.temporary_artifacts_dir() as name:
                        self.assertTrue(Path(name).name.startswith("postman-cdp-"))
                        raise RuntimeError("download failure")
                mkdir.assert_called_once_with(Path(name), mode=0o777)
                cleanup.assert_called_once_with(Path(name))

    def test_artifacts_are_unique_and_removed_after_use(self):
        with cdp_download.temporary_artifacts_dir() as first:
            with cdp_download.temporary_artifacts_dir() as second:
                self.assertNotEqual(first, second)
                (Path(first) / "download").write_bytes(b"artifact")
                self.assertTrue(Path(second).is_dir())
            self.assertFalse(Path(second).exists())
        self.assertFalse(Path(first).exists())

    def test_three_request_bodies_can_overlap_but_cdp_mutations_cannot(self):
        child = '''
import sys
from pathlib import Path
import cdp_download
root, token = Path(sys.argv[1]), sys.argv[2]
class Manager:
    def __enter__(self): return self
    def __exit__(self, *args): pass
with cdp_download.locked_playwright(Manager):
    (root / token).touch()
    # All three long-lived request bodies are simultaneously alive.
    import time
    deadline = time.monotonic() + 10
    while not all((root / str(i)).exists() for i in range(3)):
        if time.monotonic() >= deadline: raise RuntimeError("request body serialized")
        time.sleep(0.02)
    with cdp_download.process_lock.lock_cdp_download():
        marker = root / "mutation"
        with marker.open("x"): pass
        time.sleep(0.08)
        marker.unlink()
'''
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ, LOCALAPPDATA=temp, PYTHONPATH=str(WEB_DIR))
            jobs = [subprocess.Popen([sys.executable, "-c", child, temp, str(i)], env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    for i in range(3)]
            try:
                for job in jobs:
                    out, err = job.communicate(timeout=20)
                    self.assertEqual(job.returncode, 0, out + err)
            finally:
                for job in jobs:
                    if job.poll() is None:
                        job.kill()
                        job.wait()

    def test_disconnect_is_locked_and_body_is_unlocked_even_after_error(self):
        events = []
        @contextmanager
        def lock():
            events.append("lock")
            try: yield
            finally: events.append("unlock")
        class Manager:
            def __enter__(self):
                events.append("start")
                return self
            def __exit__(self, *args): events.append("disconnect")
        with patch.object(cdp_download.process_lock, "lock_cdp_download", lock):
            with self.assertRaisesRegex(RuntimeError, "failure"):
                with cdp_download.locked_playwright(Manager):
                    events.append("body")
                    raise RuntimeError("failure")
        self.assertEqual(events, ["lock", "start", "unlock", "body", "lock", "disconnect", "unlock"])

    def test_override_lives_until_download_body_finishes(self):
        events = []
        class Session:
            def send(self, command, params):
                self_params.update(params)
                events.append(command)
            def detach(self): events.append("detach")
        self_params = {}
        from types import SimpleNamespace
        page = SimpleNamespace(context=SimpleNamespace(browser=SimpleNamespace(
            new_browser_cdp_session=lambda: Session())))
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, "copy failure"):
                with cdp_download.download_behavior(page, temp):
                    events.append("download/copy")
                    raise RuntimeError("copy failure")
            self.assertEqual(self_params["downloadPath"], str(Path(temp).resolve()))
        self.assertEqual(self_params["behavior"], "allowAndName")
        self.assertEqual(events, ["Browser.setDownloadBehavior", "download/copy", "detach"])


if __name__ == "__main__":
    unittest.main()
