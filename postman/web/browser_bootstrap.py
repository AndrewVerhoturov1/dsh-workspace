#!/usr/bin/env python3
"""Web Postman P2 browser bootstrap.

This module owns only the pre-send browser bootstrap boundary:

Chrome/CDP -> Playwright attach -> dedicated owned Page -> chatgpt.com ->
manual-session readiness -> visible composer.

It intentionally does NOT type credentials, solve CAPTCHA/2FA, send prompts,
observe assistant turns, download artifacts, mutate Postman Runtime state, or
close an externally owned browser/context.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

CHATGPT_URL = "https://chatgpt.com/"
DEFAULT_CDP_URL = "http://127.0.0.1:9222"
DEFAULT_REMOTE_DEBUGGING_PORT = 9222
DEFAULT_TIMEOUT_MS = 20_000

BOOTSTRAP_READY = "BOOTSTRAP_READY"
BOOTSTRAP_LOGIN_REQUIRED = "BOOTSTRAP_LOGIN_REQUIRED"
BOOTSTRAP_COMPOSER_NOT_FOUND = "BOOTSTRAP_COMPOSER_NOT_FOUND"
BOOTSTRAP_CDP_UNREACHABLE = "BOOTSTRAP_CDP_UNREACHABLE"
BOOTSTRAP_ATTACH_FAILED = "BOOTSTRAP_ATTACH_FAILED"
BOOTSTRAP_NAVIGATION_FAILED = "BOOTSTRAP_NAVIGATION_FAILED"
BOOTSTRAP_PLAYWRIGHT_NOT_INSTALLED = "BOOTSTRAP_PLAYWRIGHT_NOT_INSTALLED"
BOOTSTRAP_CHROME_NOT_FOUND = "BOOTSTRAP_CHROME_NOT_FOUND"
BOOTSTRAP_INVALID_CONFIG = "BOOTSTRAP_INVALID_CONFIG"

COMPOSER_SELECTORS = (
    "#prompt-textarea",
    '[data-testid="composer-text-input"]',
    "textarea",
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[role="textbox"]',
)

LOGIN_TEXT_MARKERS = (
    "log in",
    "login",
    "sign up",
    "sign in",
    "войти",
    "регистрация",
)


class BrowserBootstrapError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        recoverable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable
        self.details = dict(details or {})


def _result(
    code: str,
    *,
    ok: bool,
    recoverable: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "code": code,
        "recoverable": recoverable,
        "details": dict(details or {}),
    }


def default_profile_dir(env: dict[str, str] | None = None) -> Path:
    source = os.environ if env is None else env
    local = source.get("LOCALAPPDATA")
    if local:
        return Path(local) / "DSH" / "Postman" / "browser-profile"
    return Path.home() / ".dsh" / "postman" / "browser-profile"


def normalize_cdp_url(cdp_url: str, *, allow_remote: bool = False) -> str:
    value = (cdp_url or "").strip()
    if not value:
        raise BrowserBootstrapError(BOOTSTRAP_INVALID_CONFIG, "CDP URL is empty")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https", "ws", "wss"} or not parsed.hostname:
        raise BrowserBootstrapError(
            BOOTSTRAP_INVALID_CONFIG,
            f"Unsupported CDP URL: {value}",
        )
    if not allow_remote and parsed.hostname.lower() not in {"localhost", "127.0.0.1", "::1"}:
        raise BrowserBootstrapError(
            BOOTSTRAP_INVALID_CONFIG,
            "Remote CDP endpoints are disabled by default",
            details={"hostname": parsed.hostname},
        )
    return value.rstrip("/")


def discover_chrome_executable(
    *,
    explicit: str | Path | None = None,
    env: dict[str, str] | None = None,
    exists: Callable[[Path], bool] | None = None,
    which: Callable[[str], str | None] | None = None,
) -> Path | None:
    exists_fn = (lambda p: p.exists()) if exists is None else exists
    which_fn = shutil.which if which is None else which
    if explicit:
        candidate = Path(explicit)
        return candidate if exists_fn(candidate) else None

    source = os.environ if env is None else env
    candidates: list[Path] = []
    for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"):
        root = source.get(key)
        if root:
            candidates.append(Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe")
    for candidate in candidates:
        if exists_fn(candidate):
            return candidate
    for name in ("chrome.exe", "chrome"):
        resolved = which_fn(name)
        if resolved:
            return Path(resolved)
    return None


def build_chrome_command(
    executable: str | Path,
    profile_dir: str | Path,
    *,
    port: int = DEFAULT_REMOTE_DEBUGGING_PORT,
    initial_url: str = CHATGPT_URL,
) -> list[str]:
    if not isinstance(port, int) or not (1 <= port <= 65535):
        raise BrowserBootstrapError(BOOTSTRAP_INVALID_CONFIG, "Invalid remote debugging port")
    profile = Path(profile_dir)
    return [
        str(Path(executable)),
        f"--remote-debugging-port={port}",
        "--remote-debugging-address=127.0.0.1",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        initial_url,
    ]


def start_dedicated_chrome(
    executable: str | Path,
    profile_dir: str | Path,
    *,
    port: int = DEFAULT_REMOTE_DEBUGGING_PORT,
    initial_url: str = CHATGPT_URL,
    popen: Callable[..., Any] = subprocess.Popen,
) -> Any:
    profile = Path(profile_dir)
    profile.mkdir(parents=True, exist_ok=True)
    command = build_chrome_command(executable, profile, port=port, initial_url=initial_url)
    kwargs: dict[str, Any] = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt" and hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    return popen(command, **kwargs)


def _fetch_json(url: str, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("CDP version response must be an object")
    return value


def wait_for_cdp(
    cdp_url: str,
    *,
    timeout_s: float = 15.0,
    interval_s: float = 0.25,
    fetch_json: Callable[[str, float], dict[str, Any]] = _fetch_json,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    normalized = normalize_cdp_url(cdp_url)
    if normalized.startswith(("ws://", "wss://")):
        return {"cdpUrl": normalized, "webSocketDebuggerUrl": normalized, "source": "direct_ws"}

    deadline = monotonic() + max(timeout_s, 0.0)
    version_url = normalized + "/json/version"
    last_error = ""
    while True:
        try:
            payload = fetch_json(version_url, min(2.0, max(timeout_s, 0.1)))
            ws_url = payload.get("webSocketDebuggerUrl")
            if isinstance(ws_url, str) and ws_url.strip():
                return {"cdpUrl": normalized, "webSocketDebuggerUrl": ws_url.strip(), "source": "json_version"}
            last_error = "webSocketDebuggerUrl missing"
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
            last_error = str(exc)
        if monotonic() >= deadline:
            raise BrowserBootstrapError(
                BOOTSTRAP_CDP_UNREACHABLE,
                "Chrome DevTools endpoint did not become ready",
                recoverable=True,
                details={"cdpUrl": normalized, "lastError": last_error},
            )
        sleep(interval_s)


def find_visible_composer(page: Any) -> tuple[Any | None, str | None]:
    for selector in COMPOSER_SELECTORS:
        try:
            locator = page.locator(selector)
            count = locator.count()
            if count <= 0:
                continue
            candidate = locator.last
            if candidate.is_visible():
                return candidate, selector
        except Exception:
            continue
    return None, None


def _body_text(page: Any) -> str:
    try:
        return str(page.locator("body").inner_text(timeout=1_000) or "")
    except Exception:
        return ""


def classify_session(page: Any) -> tuple[str, dict[str, Any]]:
    composer, selector = find_visible_composer(page)
    if composer is not None:
        return BOOTSTRAP_READY, {"composerSelector": selector}
    text = _body_text(page).casefold()
    if any(marker.casefold() in text for marker in LOGIN_TEXT_MARKERS):
        return BOOTSTRAP_LOGIN_REQUIRED, {"loginMarkerObserved": True}
    return BOOTSTRAP_COMPOSER_NOT_FOUND, {"loginMarkerObserved": False}


def wait_for_session_ready(
    page: Any,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    poll_ms: int = 250,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> tuple[str, dict[str, Any]]:
    deadline = monotonic() + max(timeout_ms, 0) / 1000.0
    last_code = BOOTSTRAP_COMPOSER_NOT_FOUND
    last_details: dict[str, Any] = {}
    while True:
        code, details = classify_session(page)
        last_code, last_details = code, details
        if code in {BOOTSTRAP_READY, BOOTSTRAP_LOGIN_REQUIRED}:
            return code, details
        if monotonic() >= deadline:
            return last_code, last_details
        sleep(max(poll_ms, 1) / 1000.0)


def attach_and_probe(
    playwright: Any,
    cdp_url: str,
    *,
    chatgpt_url: str = CHATGPT_URL,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    close_owned_page: bool = True,
    allow_remote_cdp: bool = False,
) -> dict[str, Any]:
    try:
        normalized = normalize_cdp_url(cdp_url, allow_remote=allow_remote_cdp)
    except BrowserBootstrapError as exc:
        return _result(exc.code, ok=False, recoverable=exc.recoverable, details=exc.details)

    browser = None
    context = None
    page = None
    owns_context = False
    existing_pages_before = 0
    try:
        try:
            browser = playwright.chromium.connect_over_cdp(normalized)
        except Exception as exc:
            return _result(
                BOOTSTRAP_ATTACH_FAILED,
                ok=False,
                recoverable=True,
                details={"cdpUrl": normalized, "message": str(exc)},
            )

        contexts = list(browser.contexts)
        if contexts:
            context = contexts[0]
        else:
            context = browser.new_context()
            owns_context = True
        existing_pages_before = len(list(context.pages))
        page = context.new_page()

        try:
            page.goto(chatgpt_url, wait_until="domcontentloaded", timeout=timeout_ms)
        except Exception as exc:
            return _result(
                BOOTSTRAP_NAVIGATION_FAILED,
                ok=False,
                recoverable=True,
                details={
                    "message": str(exc),
                    "ownedPageCreated": True,
                    "existingPagesBefore": existing_pages_before,
                    "ownsContext": owns_context,
                },
            )

        code, readiness = wait_for_session_ready(page, timeout_ms=timeout_ms)
        details = {
            **readiness,
            "cdpUrl": normalized,
            "pageUrl": str(getattr(page, "url", "") or ""),
            "ownedPageCreated": True,
            "existingPagesBefore": existing_pages_before,
            "ownsContext": owns_context,
            "externalBrowserClosed": False,
        }
        if code == BOOTSTRAP_READY:
            return _result(code, ok=True, details=details)
        if code == BOOTSTRAP_LOGIN_REQUIRED:
            return _result(code, ok=False, recoverable=True, details=details)
        return _result(code, ok=False, recoverable=True, details=details)
    finally:
        if close_owned_page and page is not None:
            try:
                page.close()
            except Exception:
                pass
        if close_owned_page and owns_context and context is not None:
            try:
                context.close()
            except Exception:
                pass
        # Intentionally never call browser.close(): in CDP attach mode the
        # browser is externally owned. Closing the connection must not close
        # the user's/dedicated Chrome process.


def _load_sync_playwright() -> Any:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise BrowserBootstrapError(
            BOOTSTRAP_PLAYWRIGHT_NOT_INSTALLED,
            "Python package 'playwright' is not installed in this environment",
            recoverable=True,
        ) from exc
    return sync_playwright


def run_live_probe(
    cdp_url: str,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    close_owned_page: bool = True,
    allow_remote_cdp: bool = False,
) -> dict[str, Any]:
    try:
        factory = _load_sync_playwright()
    except BrowserBootstrapError as exc:
        return _result(exc.code, ok=False, recoverable=exc.recoverable, details=exc.details)
    try:
        with factory() as playwright:
            return attach_and_probe(
                playwright,
                cdp_url,
                timeout_ms=timeout_ms,
                close_owned_page=close_owned_page,
                allow_remote_cdp=allow_remote_cdp,
            )
    except Exception as exc:
        return _result(
            BOOTSTRAP_ATTACH_FAILED,
            ok=False,
            recoverable=True,
            details={"message": str(exc)},
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Web Postman P2 Chrome/CDP bootstrap probe")
    parser.add_argument("--cdp-url", default=DEFAULT_CDP_URL)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--keep-page", action="store_true", help="Do not close the Page created by this probe")
    parser.add_argument("--allow-remote-cdp", action="store_true", help="Allow non-loopback CDP endpoint")
    parser.add_argument("--launch-chrome", action="store_true", help="Start dedicated headful Chrome before attaching")
    parser.add_argument("--chrome-executable")
    parser.add_argument("--profile-dir")
    parser.add_argument("--port", type=int, default=DEFAULT_REMOTE_DEBUGGING_PORT)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    launched_process = None
    cdp_url = args.cdp_url
    if args.launch_chrome:
        executable = discover_chrome_executable(explicit=args.chrome_executable)
        if executable is None:
            print(json.dumps(_result(BOOTSTRAP_CHROME_NOT_FOUND, ok=False, recoverable=True), ensure_ascii=False))
            return 3
        profile_dir = Path(args.profile_dir) if args.profile_dir else default_profile_dir()
        launched_process = start_dedicated_chrome(executable, profile_dir, port=args.port)
        cdp_url = f"http://127.0.0.1:{args.port}"
        try:
            wait_for_cdp(cdp_url, timeout_s=max(args.timeout_ms / 1000.0, 1.0))
        except BrowserBootstrapError as exc:
            result = _result(exc.code, ok=False, recoverable=exc.recoverable, details=exc.details)
            result["details"]["launchedPid"] = getattr(launched_process, "pid", None)
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 3

    result = run_live_probe(
        cdp_url,
        timeout_ms=args.timeout_ms,
        close_owned_page=not args.keep_page,
        allow_remote_cdp=args.allow_remote_cdp,
    )
    if launched_process is not None:
        result["details"]["launchedPid"] = getattr(launched_process, "pid", None)
        result["details"]["launchedChromeLeftRunning"] = True
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if result["ok"]:
        return 0
    if result["code"] == BOOTSTRAP_LOGIN_REQUIRED:
        return 2
    return 3


if __name__ == "__main__":
    sys.exit(main())
