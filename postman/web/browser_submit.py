#!/usr/bin/env python3
"""Web Postman P3 fresh-chat + single-submit transport.

Scope:
- connect to the dedicated headful Chrome through CDP;
- create one owned Page;
- prove a fresh ChatGPT chat before inserting anything;
- prove an empty composer;
- insert exactly one prompt;
- initiate exactly one Send action;
- prove the new user turn, empty composer, and bound /c/... URL;
- return PROMPT_SEND_UNKNOWN after any uncertain post-click state.

This module intentionally does NOT observe assistant turns, detect/download
artifacts, route results, type credentials, solve 2FA/CAPTCHA, or retry an
uncertain Send.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import browser_bootstrap as bootstrap

CHATGPT_URL = bootstrap.CHATGPT_URL
DEFAULT_CDP_URL = bootstrap.DEFAULT_CDP_URL
DEFAULT_TIMEOUT_MS = 30_000

PAGE_OWNED = "PAGE_OWNED"
FRESH_CHAT_CONFIRMED = "FRESH_CHAT_CONFIRMED"
COMPOSER_EMPTY_CONFIRMED = "COMPOSER_EMPTY_CONFIRMED"
PROMPT_INSERTED = "PROMPT_INSERTED"
PROMPT_SEND_STARTED = "PROMPT_SEND_STARTED"
PROMPT_SEND_CONFIRMED = "PROMPT_SEND_CONFIRMED"
CHAT_URL_BOUND = "CHAT_URL_BOUND"

FRESH_CHAT_NOT_CONFIRMED = "FRESH_CHAT_NOT_CONFIRMED"
COMPOSER_NOT_EMPTY = "COMPOSER_NOT_EMPTY"
PROMPT_INSERT_FAILED = "PROMPT_INSERT_FAILED"
PROMPT_MISMATCH = "PROMPT_MISMATCH"
SEND_CONTROL_NOT_FOUND = "SEND_CONTROL_NOT_FOUND"
PROMPT_SEND_UNKNOWN = "PROMPT_SEND_UNKNOWN"
PROMPT_RESEND_BLOCKED = "PROMPT_RESEND_BLOCKED"
SUBMIT_ATTACH_FAILED = "SUBMIT_ATTACH_FAILED"
SUBMIT_NAVIGATION_FAILED = "SUBMIT_NAVIGATION_FAILED"
SUBMIT_INVALID_CONFIG = "SUBMIT_INVALID_CONFIG"

SEND_PROVEN_NOT_SENT = "PROVEN_NOT_SENT"
SEND_STARTED = "SEND_STARTED"
SEND_PROVEN_SENT = "PROVEN_SENT"
SEND_UNKNOWN = "UNKNOWN"

TURN_SELECTORS = (
    '[data-testid^="conversation-turn-"]',
    '[data-message-author-role="user"]',
    'article[data-testid^="conversation-turn-"]',
)

USER_TURN_SELECTORS = (
    '[data-testid="conversation-turn-user"]',
    '[data-message-author-role="user"]',
)

SEND_BUTTON_SELECTORS = (
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
    'button[aria-label="Отправить"]',
)


class SubmitError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


class SendGuard:
    """One-shot in-memory Send guard for a single owned Page attempt.

    Persistence/restart recovery belongs to later milestones. P3 nevertheless
    must never retry after uncertainty inside the same attempt.
    """

    def __init__(self) -> None:
        self.state = SEND_PROVEN_NOT_SENT

    def begin(self) -> None:
        if self.state != SEND_PROVEN_NOT_SENT:
            raise SubmitError(
                PROMPT_RESEND_BLOCKED,
                "Send is not allowed after a previous start/unknown/success state",
                details={"sendState": self.state},
            )
        self.state = SEND_STARTED

    def confirm(self) -> None:
        self.state = SEND_PROVEN_SENT

    def unknown(self) -> None:
        self.state = SEND_UNKNOWN


def prompt_sha256(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def _result(
    code: str,
    *,
    ok: bool,
    send_state: str,
    transitions: list[str],
    recoverable: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "code": code,
        "recoverable": recoverable,
        "sendState": send_state,
        "transitions": list(transitions),
        "details": dict(details or {}),
    }


def is_chatgpt_root_url(url: str) -> bool:
    try:
        parsed = urlparse(str(url or ""))
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    if host not in {"chatgpt.com", "www.chatgpt.com"}:
        return False
    return parsed.path in {"", "/"}


def is_bound_chat_url(url: str) -> bool:
    try:
        parsed = urlparse(str(url or ""))
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    if host not in {"chatgpt.com", "www.chatgpt.com"}:
        return False
    return bool(re.fullmatch(r"/c/[A-Za-z0-9_-]+", parsed.path or ""))


def _locator_count(locator: Any) -> int:
    try:
        return int(locator.count())
    except Exception:
        return 0


def count_conversation_turns(page: Any) -> int:
    # The first selector is the preferred current ChatGPT contract. Fallbacks
    # are only consulted if it is absent, avoiding double-counting aliases.
    for selector in TURN_SELECTORS:
        try:
            locator = page.locator(selector)
            count = _locator_count(locator)
            if count:
                return count
        except Exception:
            continue
    return 0


def _normalize_text(value: str) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def read_composer_text(composer: Any) -> str:
    try:
        return _normalize_text(composer.input_value(timeout=500))
    except Exception:
        pass
    try:
        return _normalize_text(composer.inner_text(timeout=500))
    except Exception:
        pass
    try:
        return _normalize_text(composer.text_content(timeout=500))
    except Exception:
        return ""


def find_composer(page: Any) -> tuple[Any | None, str | None]:
    return bootstrap.find_visible_composer(page)


def collect_user_turn_texts(page: Any) -> list[str]:
    for selector in USER_TURN_SELECTORS:
        try:
            locator = page.locator(selector)
            count = _locator_count(locator)
            if count <= 0:
                continue
            values: list[str] = []
            for index in range(count):
                item = locator.nth(index)
                try:
                    values.append(_normalize_text(item.inner_text(timeout=1_000)))
                except Exception:
                    values.append("")
            return values
        except Exception:
            continue
    return []


def find_send_button(page: Any) -> tuple[Any | None, str | None]:
    for selector in SEND_BUTTON_SELECTORS:
        try:
            locator = page.locator(selector)
            if _locator_count(locator) <= 0:
                continue
            candidate = locator.last
            if candidate.is_visible() and candidate.is_enabled():
                return candidate, selector
        except Exception:
            continue

    # Semantic fallback is still pre-send. It may locate a localized button,
    # but once a click is attempted there is never a second transport fallback.
    try:
        locator = page.get_by_role("button", name=re.compile(r"^(send|send prompt|отправить)$", re.I))
        if _locator_count(locator) > 0:
            candidate = locator.last
            if candidate.is_visible() and candidate.is_enabled():
                return candidate, "role=button[name=send]"
    except Exception:
        pass
    return None, None


def _wait_until(
    predicate: Callable[[], tuple[bool, dict[str, Any]]],
    *,
    timeout_ms: int,
    poll_ms: int = 100,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> tuple[bool, dict[str, Any]]:
    deadline = monotonic() + max(timeout_ms, 0) / 1000.0
    last: dict[str, Any] = {}
    while True:
        ok, details = predicate()
        last = dict(details or {})
        if ok:
            return True, last
        if monotonic() >= deadline:
            return False, last
        sleep(max(poll_ms, 1) / 1000.0)


def prepare_fresh_chat(page: Any, *, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> dict[str, Any]:
    try:
        page.goto(CHATGPT_URL, wait_until="domcontentloaded", timeout=timeout_ms)
    except Exception as exc:
        return {
            "ok": False,
            "code": SUBMIT_NAVIGATION_FAILED,
            "details": {"message": str(exc)},
        }

    def predicate() -> tuple[bool, dict[str, Any]]:
        composer, selector = find_composer(page)
        page_url = str(getattr(page, "url", "") or "")
        turns = count_conversation_turns(page)
        if composer is None:
            session_code, session_details = bootstrap.classify_session(page)
            return False, {
                "sessionCode": session_code,
                "pageUrl": page_url,
                "turnCount": turns,
                **session_details,
            }
        composer_text = read_composer_text(composer)
        fresh = is_chatgpt_root_url(page_url) and turns == 0
        empty = composer_text == ""
        return fresh and empty, {
            "pageUrl": page_url,
            "turnCount": turns,
            "composerSelector": selector,
            "composerEmpty": empty,
            "composer": composer,
        }

    ok, details = _wait_until(predicate, timeout_ms=timeout_ms)
    composer = details.pop("composer", None)
    if not ok:
        if details.get("composerEmpty") is False:
            code = COMPOSER_NOT_EMPTY
        else:
            code = FRESH_CHAT_NOT_CONFIRMED
        return {"ok": False, "code": code, "details": details}
    return {"ok": True, "code": FRESH_CHAT_CONFIRMED, "composer": composer, "details": details}


def insert_prompt(composer: Any, prompt: str, *, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> dict[str, Any]:
    if not isinstance(prompt, str) or not prompt:
        return {"ok": False, "code": SUBMIT_INVALID_CONFIG, "details": {"reason": "prompt_empty"}}
    try:
        composer.fill(prompt, timeout=timeout_ms)
    except Exception as exc:
        return {"ok": False, "code": PROMPT_INSERT_FAILED, "details": {"message": str(exc)}}
    actual = read_composer_text(composer)
    if _normalize_text(actual) != _normalize_text(prompt):
        return {
            "ok": False,
            "code": PROMPT_MISMATCH,
            "details": {"expectedSha256": prompt_sha256(prompt), "observedTextLength": len(actual)},
        }
    return {
        "ok": True,
        "code": PROMPT_INSERTED,
        "details": {"promptSha256": prompt_sha256(prompt), "promptLength": len(prompt)},
    }


def _observe_send_proof(page: Any, prompt: str, before_user_turn_count: int) -> tuple[bool, dict[str, Any]]:
    user_turns = collect_user_turn_texts(page)
    page_url = str(getattr(page, "url", "") or "")
    composer, selector = find_composer(page)
    composer_empty = composer is not None and read_composer_text(composer) == ""
    new_turn = len(user_turns) == before_user_turn_count + 1
    exact_turn = new_turn and _normalize_text(user_turns[-1]) == _normalize_text(prompt)
    chat_bound = is_bound_chat_url(page_url)
    return exact_turn and composer_empty and chat_bound, {
        "userTurnCountBefore": before_user_turn_count,
        "userTurnCountNow": len(user_turns),
        "exactUserTurn": exact_turn,
        "composerEmpty": composer_empty,
        "composerSelector": selector,
        "chatUrlBound": chat_bound,
        "chatUrl": page_url if chat_bound else "",
    }


def submit_once(
    page: Any,
    composer: Any,
    prompt: str,
    guard: SendGuard,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    transitions: list[str] = [PAGE_OWNED, FRESH_CHAT_CONFIRMED, COMPOSER_EMPTY_CONFIRMED, PROMPT_INSERTED]
    before_turns = collect_user_turn_texts(page)

    def send_control_ready() -> tuple[bool, dict[str, Any]]:
        button, selector = find_send_button(page)
        return button is not None, {"button": button, "selector": selector}

    found, send_control = _wait_until(send_control_ready, timeout_ms=timeout_ms)
    button = send_control.pop("button", None)
    selector = send_control.get("selector")
    if not found or button is None:
        return _result(
            SEND_CONTROL_NOT_FOUND,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            recoverable=True,
            details={"sendControl": selector or ""},
        )

    try:
        guard.begin()
    except SubmitError as exc:
        return _result(
            exc.code,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            details=exc.details,
        )

    transitions.append(PROMPT_SEND_STARTED)
    try:
        button.click(timeout=timeout_ms)
    except Exception as exc:
        guard.unknown()
        return _result(
            PROMPT_SEND_UNKNOWN,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            recoverable=True,
            details={"message": str(exc), "sendControl": selector, "reason": "click_outcome_uncertain"},
        )

    ok, proof = _wait_until(
        lambda: _observe_send_proof(page, prompt, len(before_turns)),
        timeout_ms=timeout_ms,
    )
    proof["sendControl"] = selector
    proof["promptSha256"] = prompt_sha256(prompt)
    if not ok:
        guard.unknown()
        return _result(
            PROMPT_SEND_UNKNOWN,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            recoverable=True,
            details=proof,
        )

    guard.confirm()
    transitions.extend([PROMPT_SEND_CONFIRMED, CHAT_URL_BOUND])
    return _result(
        PROMPT_SEND_CONFIRMED,
        ok=True,
        send_state=guard.state,
        transitions=transitions,
        details=proof,
    )


def submit_fresh_prompt(page: Any, prompt: str, *, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> dict[str, Any]:
    prep = prepare_fresh_chat(page, timeout_ms=timeout_ms)
    if not prep["ok"]:
        return _result(
            prep["code"],
            ok=False,
            send_state=SEND_PROVEN_NOT_SENT,
            transitions=[PAGE_OWNED],
            recoverable=True,
            details=prep.get("details"),
        )
    composer = prep["composer"]
    inserted = insert_prompt(composer, prompt, timeout_ms=timeout_ms)
    if not inserted["ok"]:
        return _result(
            inserted["code"],
            ok=False,
            send_state=SEND_PROVEN_NOT_SENT,
            transitions=[PAGE_OWNED, FRESH_CHAT_CONFIRMED, COMPOSER_EMPTY_CONFIRMED],
            recoverable=True,
            details=inserted.get("details"),
        )
    guard = SendGuard()
    result = submit_once(page, composer, prompt, guard, timeout_ms=timeout_ms)
    result["details"].update(inserted.get("details", {}))
    return result


def run_live_submit(
    cdp_url: str,
    prompt: str,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    keep_page: bool = False,
) -> dict[str, Any]:
    try:
        factory = bootstrap._load_sync_playwright()
    except bootstrap.BrowserBootstrapError as exc:
        return _result(
            exc.code,
            ok=False,
            send_state=SEND_PROVEN_NOT_SENT,
            transitions=[],
            recoverable=exc.recoverable,
            details=exc.details,
        )

    try:
        with factory() as playwright:
            browser = None
            context = None
            page = None
            owns_context = False
            try:
                try:
                    normalized = bootstrap.normalize_cdp_url(cdp_url)
                    browser = playwright.chromium.connect_over_cdp(normalized)
                except Exception as exc:
                    return _result(
                        SUBMIT_ATTACH_FAILED,
                        ok=False,
                        send_state=SEND_PROVEN_NOT_SENT,
                        transitions=[],
                        recoverable=True,
                        details={"message": str(exc)},
                    )
                contexts = list(browser.contexts)
                if contexts:
                    context = contexts[0]
                else:
                    context = browser.new_context()
                    owns_context = True
                existing_pages_before = len(list(context.pages))
                page = context.new_page()
                result = submit_fresh_prompt(page, prompt, timeout_ms=timeout_ms)
                result["details"].update({
                    "ownedPageCreated": True,
                    "existingPagesBefore": existing_pages_before,
                    "externalBrowserClosed": False,
                    "ownsContext": owns_context,
                })
                return result
            finally:
                # Clean up while Playwright is still alive. Only resources
                # created by this invocation may be closed.
                if not keep_page and page is not None:
                    try:
                        page.close()
                    except Exception:
                        pass
                if not keep_page and owns_context and context is not None:
                    try:
                        context.close()
                    except Exception:
                        pass
                # Never call browser.close() for CDP-attached external Chrome.
    except Exception as exc:
        return _result(
            SUBMIT_ATTACH_FAILED,
            ok=False,
            send_state=SEND_PROVEN_NOT_SENT,
            transitions=[],
            recoverable=True,
            details={"message": str(exc)},
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Web Postman P3 fresh-chat single-submit probe")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--cdp-url", default=DEFAULT_CDP_URL)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--keep-page", action="store_true")
    parser.add_argument("--launch-chrome", action="store_true")
    parser.add_argument("--chrome-executable")
    parser.add_argument("--profile-dir")
    parser.add_argument("--port", type=int, default=bootstrap.DEFAULT_REMOTE_DEBUGGING_PORT)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    launched_process = None
    profile_dir: Path | None = None
    cdp_url = args.cdp_url
    if args.launch_chrome:
        executable = bootstrap.discover_chrome_executable(explicit=args.chrome_executable)
        if executable is None:
            result = _result(
                bootstrap.BOOTSTRAP_CHROME_NOT_FOUND,
                ok=False,
                send_state=SEND_PROVEN_NOT_SENT,
                transitions=[],
                recoverable=True,
            )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 3
        profile_dir = Path(args.profile_dir) if args.profile_dir else bootstrap.default_profile_dir()
        launched_process = bootstrap.start_dedicated_chrome(executable, profile_dir, port=args.port)
        cdp_url = f"http://127.0.0.1:{args.port}"
        try:
            bootstrap.wait_for_cdp(cdp_url, timeout_s=max(args.timeout_ms / 1000.0, 1.0))
        except bootstrap.BrowserBootstrapError as exc:
            result = _result(
                exc.code,
                ok=False,
                send_state=SEND_PROVEN_NOT_SENT,
                transitions=[],
                recoverable=exc.recoverable,
                details=exc.details,
            )
            if launched_process is not None and profile_dir is not None:
                result["details"]["browserIdentity"] = bootstrap.describe_browser_identity(
                    profile_dir, getattr(launched_process, "pid", None)
                )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 3

    result = run_live_submit(
        cdp_url,
        args.prompt,
        timeout_ms=args.timeout_ms,
        keep_page=args.keep_page,
    )
    if launched_process is not None and profile_dir is not None:
        result["details"]["browserIdentity"] = bootstrap.describe_browser_identity(
            profile_dir, getattr(launched_process, "pid", None)
        )
        result["details"]["launchedChromeLeftRunning"] = True
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if result["ok"]:
        return 0
    if result["code"] == PROMPT_SEND_UNKNOWN:
        return 4
    return 3


if __name__ == "__main__":
    sys.exit(main())
