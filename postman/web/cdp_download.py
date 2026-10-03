"""Short CDP download critical sections; reuse the existing process lock."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sys
import shutil
import tempfile
import uuid

DIRECT_DIR = Path(__file__).resolve().parents[1] / "direct"
if str(DIRECT_DIR) not in sys.path:
    sys.path.insert(0, str(DIRECT_DIR))
import process_lock


@contextmanager
def temporary_artifacts_dir():
    if sys.platform != "win32":
        with tempfile.TemporaryDirectory(prefix="postman-cdp-") as name:
            yield name
        return
    # Python 3.13+ mkdir(0o700) replaces Windows ACLs with owner/admin/system.
    # An elevated creator may be owned by Administrators, excluding normal Chrome.
    # Keep the user TEMP directory's inherited ACL instead; never grant Everyone.
    path = Path(tempfile.gettempdir()) / f"postman-cdp-{uuid.uuid4().hex}"
    path.mkdir(mode=0o777)
    try:
        yield str(path)
    finally:
        shutil.rmtree(path)


@contextmanager
def locked_playwright(factory):
    manager = factory()
    playwright = manager.__enter__()
    try:
        yield playwright
    finally:
        with process_lock.lock_cdp_download():
            manager.__exit__(*sys.exc_info())


def connect_over_cdp(playwright, endpoint, *, artifacts_dir=None):
    import hashlib
    identity = hashlib.sha256(endpoint.encode("utf-8")).hexdigest()[:16]
    directory = Path(tempfile.gettempdir()) / ("dsh-postman-downloads-" + identity)
    directory.mkdir(mode=0o777, exist_ok=True)
    if directory.is_symlink() or getattr(directory, "is_junction", lambda: False)():
        raise ValueError("CDP download directory must be a regular directory")
    # All connections use the same browser path; only download-event GUIDs locate files.
    with process_lock.lock_cdp_download():
        browser = playwright.chromium.connect_over_cdp(endpoint, artifacts_dir=str(directory))
    browser._postman_download_dir = directory
    return browser


@contextmanager
def download_behavior(page, artifacts_dir):
    session = page.context.browser.new_browser_cdp_session()
    directory = page.context.browser._postman_download_dir
    try:
        with process_lock.lock_cdp_download():
            session.send("Browser.setDownloadBehavior", {"behavior": "allowAndName",
                         "downloadPath": str(directory.resolve()), "eventsEnabled": True})
        yield
    finally:
        with process_lock.lock_cdp_download():
            session.detach()

