"""Short CDP download critical sections; reuse the existing process lock."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sys

DIRECT_DIR = Path(__file__).resolve().parents[1] / "direct"
if str(DIRECT_DIR) not in sys.path:
    sys.path.insert(0, str(DIRECT_DIR))
import process_lock


@contextmanager
def locked_playwright(factory):
    # The request body is deliberately OUTSIDE the lock. Context exit disconnects
    # Playwright and may reset Chrome download behavior, so protect that exit too.
    manager = factory()
    with process_lock.lock_cdp_download():
        playwright = manager.__enter__()
    try:
        yield playwright
    finally:
        with process_lock.lock_cdp_download():
            manager.__exit__(*sys.exc_info())


def connect_over_cdp(playwright, endpoint, *, artifacts_dir=None):
    with process_lock.lock_cdp_download():
        if artifacts_dir is None:
            return playwright.chromium.connect_over_cdp(endpoint)
        return playwright.chromium.connect_over_cdp(endpoint, artifacts_dir=str(artifacts_dir))


@contextmanager
def download_behavior(page, artifacts_dir):
    """Reassert this connection's exact artifact directory while holding the lock."""
    session = page.context.browser.new_browser_cdp_session()
    try:
        session.send("Browser.setDownloadBehavior", {
            "behavior": "allowAndName",
            "downloadPath": str(Path(artifacts_dir).resolve()),
            "eventsEnabled": True,
        })
        # Detaching this session resets its override; keep it alive through copy.
        yield
    finally:
        session.detach()
