#!/usr/bin/env python3
"""Web Postman P4 assistant-turn observer.

Scope:
- re-confirm the exact proven user turn from P3;
- bind observation to the exact /c/... chat URL;
- correlate only the first conversation turn after that user turn;
- require that turn to be authored by assistant;
- distinguish STARTED / STREAMING / COMPLETED;
- never use body-wide text as response correlation;
- never send prompts or download artifacts.

P4 completion proof is conservative: the correlated assistant turn must be
non-empty, generation controls must be inactive, and its text must remain
stable for a configured interval.
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

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import browser_bootstrap as bootstrap
import browser_submit as submit

DEFAULT_TIMEOUT_MS = 120_000
DEFAULT_STABLE_MS = 2_000
DEFAULT_POLL_MS = 100

ASSISTANT_TURN_STARTED = "ASSISTANT_TURN_STARTED"
ASSISTANT_TURN_STREAMING = "ASSISTANT_TURN_STREAMING"
ASSISTANT_TURN_COMPLETED = "ASSISTANT_TURN_COMPLETED"

USER_TURN_ANCHOR_MISSING = "USER_TURN_ANCHOR_MISSING"
CHAT_CORRELATION_LOST = "CHAT_CORRELATION_LOST"
ASSISTANT_NOT_STARTED = "ASSISTANT_NOT_STARTED"
ASSISTANT_STATE_UNKNOWN = "ASSISTANT_STATE_UNKNOWN"
ASSISTANT_TURN_TIMEOUT = "ASSISTANT_TURN_TIMEOUT"
OBSERVER_ATTACH_FAILED = "OBSERVER_ATTACH_FAILED"
OBSERVER_INVALID_CONFIG = "OBSERVER_INVALID_CONFIG"

TURN_CONTAINER_SELECTORS = (
    '[data-testid^="conversation-turn-"]',
    '[data-message-author-role="user"], [data-message-author-role="assistant"]',
)

GENERATION_CONTROL_SELECTORS = (
    'button[data-testid="stop-button"]',
    'button[data-testid="stop-generating-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
    'button[aria-label="Остановить создание"]',
    'button[aria-label="Остановить"]',
)


def _normalize_text(value: str) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def text_sha256(text: str) -> str:
    return hashlib.sha256(_normalize_text(text).encode("utf-8")).hexdigest()


def _locator_count(locator: Any) -> int:
    try:
        return int(locator.count())
    except Exception:
        return 0


def _get_attribute(locator: Any, name: str) -> str:
    try:
        value = locator.get_attribute(name)
    except Exception:
        return ""
    return str(value or "")


def _inner_text(locator: Any) -> str:
    try:
        return _normalize_text(locator.inner_text(timeout=1_000))
    except Exception:
        return ""


def _turn_message_node(turn: Any) -> Any:
    """Return the semantic message node inside a conversation-turn container."""
    direct_role = _get_attribute(turn, "data-message-author-role").casefold()
    if direct_role in {"user", "assistant"}:
        return turn
    try:
        nested = turn.locator("[data-message-author-role]")
        if _locator_count(nested) > 0:
            try:
                first = nested.first
                first_role = _get_attribute(first, "data-message-author-role").casefold()
                if first_role in {"user", "assistant"}:
                    return first
            except Exception:
                pass
            try:
                return nested.nth(0)
            except Exception:
                pass
    except Exception:
        pass
    return turn


def infer_turn_role(turn: Any) -> str:
    """Infer role from a single conversation-turn container, fail-closed."""
    message = _turn_message_node(turn)
    role = _get_attribute(message, "data-message-author-role").casefold()
    if role in {"user", "assistant"}:
        return role

    test_id = _get_attribute(turn, "data-testid").casefold()
    if "conversation-turn-user" in test_id:
        return "user"
    if "conversation-turn-assistant" in test_id:
        return "assistant"
    return "unknown"


def extract_turn_text(turn: Any) -> str:
    """Read only the semantic message text, not outer turn controls/UI labels."""
    return _inner_text(_turn_message_node(turn))


def snapshot_turns(page: Any) -> tuple[list[dict[str, Any]], str]:
    """Return ordered conversation turns from one selector family only.

    The first selector family that yields turns wins. This avoids double
    counting aliases that point at the same DOM nodes.
    """
    for selector in TURN_CONTAINER_SELECTORS:
        try:
            locator = page.locator(selector)
            count = _locator_count(locator)
            if count <= 0:
                continue
            turns: list[dict[str, Any]] = []
            for index in range(count):
                node = locator.nth(index)
                turns.append(
                    {
                        "index": index,
                        "role": infer_turn_role(node),
                        "text": extract_turn_text(node),
                        "testId": _get_attribute(node, "data-testid"),
                    }
                )
            return turns, selector
        except Exception:
            continue
    return [], ""


def generation_active(page: Any) -> tuple[bool, str]:
    for selector in GENERATION_CONTROL_SELECTORS:
        try:
            locator = page.locator(selector)
            if _locator_count(locator) <= 0:
                continue
            candidate = locator.first
            if candidate.is_visible():
                return True, selector
        except Exception:
            continue

    try:
        semantic = page.get_by_role(
            "button",
            name=re.compile(r"^(stop|stop generating|остановить|остановить создание)$", re.I),
        )
        if _locator_count(semantic) > 0 and semantic.first.is_visible():
            return True, "role=button[name=stop]"
    except Exception:
        pass
    return False, ""


def find_user_anchor(turns: list[dict[str, Any]], expected_prompt: str) -> int | None:
    """Return the last exact matching user turn.

    Exact means line-ending normalization only. Leading/trailing whitespace is
    significant because P3 also proves the exact prompt text.
    """
    expected = _normalize_text(expected_prompt)
    matches = [
        turn["index"]
        for turn in turns
        if turn.get("role") == "user" and _normalize_text(turn.get("text", "")) == expected
    ]
    return matches[-1] if matches else None


def correlate_next_assistant(
    turns: list[dict[str, Any]],
    expected_prompt: str,
) -> dict[str, Any]:
    anchor = find_user_anchor(turns, expected_prompt)
    if anchor is None:
        return {
            "ok": False,
            "code": USER_TURN_ANCHOR_MISSING,
            "anchorIndex": None,
            "assistant": None,
        }

    next_index = anchor + 1
    if next_index >= len(turns):
        return {
            "ok": False,
            "code": ASSISTANT_NOT_STARTED,
            "anchorIndex": anchor,
            "assistant": None,
        }

    next_turn = turns[next_index]
    role = next_turn.get("role")
    if role == "assistant":
        return {
            "ok": True,
            "code": ASSISTANT_TURN_STARTED,
            "anchorIndex": anchor,
            "assistantIndex": next_index,
            "assistant": next_turn,
        }
    if role == "user":
        return {
            "ok": False,
            "code": CHAT_CORRELATION_LOST,
            "anchorIndex": anchor,
            "assistantIndex": None,
            "assistant": None,
            "unexpectedRole": role,
        }
    return {
        "ok": False,
        "code": ASSISTANT_STATE_UNKNOWN,
        "anchorIndex": anchor,
        "assistantIndex": None,
        "assistant": None,
        "unexpectedRole": role or "unknown",
    }


class AssistantLifecycleTracker:
    def __init__(self, *, stable_ms: int = DEFAULT_STABLE_MS) -> None:
        self.stable_ms = max(int(stable_ms), 0)
        self.started = False
        self.streaming = False
        self.completed = False
        self.last_text: str | None = None
        self.stable_since_ms: float | None = None
        self.transitions: list[str] = []

    def observe(self, text: str, *, generating: bool, now_ms: float) -> bool:
        text = _normalize_text(text)
        if not self.started:
            self.started = True
            self.transitions.append(ASSISTANT_TURN_STARTED)
            self.last_text = text
            self.stable_since_ms = None if generating else now_ms
            if generating:
                self.streaming = True
                self.transitions.append(ASSISTANT_TURN_STREAMING)
            return False

        if text != self.last_text:
            self.last_text = text
            self.stable_since_ms = None if generating else now_ms
            if not self.streaming:
                self.streaming = True
                self.transitions.append(ASSISTANT_TURN_STREAMING)
        elif generating:
            self.stable_since_ms = None
            if not self.streaming:
                self.streaming = True
                self.transitions.append(ASSISTANT_TURN_STREAMING)
        elif self.stable_since_ms is None:
            self.stable_since_ms = now_ms

        stable_for = 0.0 if self.stable_since_ms is None else now_ms - self.stable_since_ms
        if (
            not generating
            and text != ""
            and self.stable_since_ms is not None
            and stable_for >= self.stable_ms
        ):
            if not self.completed:
                self.completed = True
                self.transitions.append(ASSISTANT_TURN_COMPLETED)
            return True
        return False


def _result(
    code: str,
    *,
    ok: bool,
    transitions: list[str],
    recoverable: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "code": code,
        "recoverable": recoverable,
        "transitions": list(transitions),
        "details": dict(details or {}),
    }


def observe_next_assistant(
    page: Any,
    expected_prompt: str,
    expected_chat_url: str,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    stable_ms: int = DEFAULT_STABLE_MS,
    poll_ms: int = DEFAULT_POLL_MS,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    if not isinstance(expected_prompt, str) or expected_prompt == "":
        return _result(
            OBSERVER_INVALID_CONFIG,
            ok=False,
            transitions=[],
            details={"reason": "expected_prompt_empty"},
        )
    if not submit.is_bound_chat_url(expected_chat_url):
        return _result(
            OBSERVER_INVALID_CONFIG,
            ok=False,
            transitions=[],
            details={"reason": "expected_chat_url_invalid", "expectedChatUrl": expected_chat_url},
        )

    tracker = AssistantLifecycleTracker(stable_ms=stable_ms)
    deadline = monotonic() + max(timeout_ms, 0) / 1000.0
    last_code = ASSISTANT_NOT_STARTED
    last_details: dict[str, Any] = {}
    assistant_identity: tuple[int, str] | None = None

    while True:
        current_url = str(getattr(page, "url", "") or "")
        if current_url != expected_chat_url:
            return _result(
                CHAT_CORRELATION_LOST,
                ok=False,
                transitions=tracker.transitions,
                recoverable=True,
                details={
                    "reason": "chat_url_changed",
                    "expectedChatUrl": expected_chat_url,
                    "observedChatUrl": current_url,
                },
            )

        turns, selector = snapshot_turns(page)
        correlation = correlate_next_assistant(turns, expected_prompt)
        last_code = correlation["code"]
        last_details = {
            "turnSelector": selector,
            "turnCount": len(turns),
            "anchorIndex": correlation.get("anchorIndex"),
            "assistantIndex": correlation.get("assistantIndex"),
            "chatUrl": current_url,
        }

        if correlation["code"] == CHAT_CORRELATION_LOST:
            last_details["reason"] = "another_user_turn_preceded_assistant"
            return _result(
                CHAT_CORRELATION_LOST,
                ok=False,
                transitions=tracker.transitions,
                recoverable=True,
                details=last_details,
            )
        if correlation["code"] == ASSISTANT_STATE_UNKNOWN:
            last_details["reason"] = "next_turn_role_unknown"
            return _result(
                ASSISTANT_STATE_UNKNOWN,
                ok=False,
                transitions=tracker.transitions,
                recoverable=True,
                details=last_details,
            )

        if correlation["ok"]:
            assistant = correlation["assistant"]
            identity = (correlation["assistantIndex"], assistant.get("testId", ""))
            if assistant_identity is None:
                assistant_identity = identity
            elif identity != assistant_identity:
                last_details["reason"] = "assistant_turn_identity_changed"
                return _result(
                    CHAT_CORRELATION_LOST,
                    ok=False,
                    transitions=tracker.transitions,
                    recoverable=True,
                    details=last_details,
                )

            active, control = generation_active(page)
            text = _normalize_text(assistant.get("text", ""))
            now_ms = monotonic() * 1000.0
            complete = tracker.observe(text, generating=active, now_ms=now_ms)
            last_details.update(
                {
                    "assistantText": text,
                    "assistantTextLength": len(text),
                    "assistantTextSha256": text_sha256(text),
                    "generationActive": active,
                    "generationControl": control,
                    "streamingObserved": tracker.streaming,
                }
            )
            if complete:
                return _result(
                    ASSISTANT_TURN_COMPLETED,
                    ok=True,
                    transitions=tracker.transitions,
                    details=last_details,
                )

        if monotonic() >= deadline:
            timeout_code = (
                USER_TURN_ANCHOR_MISSING
                if last_code == USER_TURN_ANCHOR_MISSING
                else ASSISTANT_TURN_TIMEOUT
            )
            last_details["lastObservedCode"] = last_code
            return _result(
                timeout_code,
                ok=False,
                transitions=tracker.transitions,
                recoverable=True,
                details=last_details,
            )
        sleep(max(poll_ms, 1) / 1000.0)


def run_submit_and_observe(
    cdp_url: str,
    prompt: str,
    *,
    submit_timeout_ms: int = submit.DEFAULT_TIMEOUT_MS,
    assistant_timeout_ms: int = DEFAULT_TIMEOUT_MS,
    stable_ms: int = DEFAULT_STABLE_MS,
    keep_page: bool = False,
) -> dict[str, Any]:
    """Live P4 probe using the P3 submit primitive on the same owned Page."""
    try:
        factory = bootstrap._load_sync_playwright()
    except bootstrap.BrowserBootstrapError as exc:
        return _result(
            exc.code,
            ok=False,
            transitions=[],
            recoverable=exc.recoverable,
            details=exc.details,
        )

    try:
        with factory() as playwright:
            context = None
            page = None
            owns_context = False
            try:
                try:
                    normalized = bootstrap.normalize_cdp_url(cdp_url)
                    browser = playwright.chromium.connect_over_cdp(normalized)
                except Exception as exc:
                    return _result(
                        OBSERVER_ATTACH_FAILED,
                        ok=False,
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

                submit_result = submit.submit_fresh_prompt(
                    page,
                    prompt,
                    timeout_ms=submit_timeout_ms,
                )
                if not submit_result.get("ok"):
                    return _result(
                        submit_result.get("code", ASSISTANT_STATE_UNKNOWN),
                        ok=False,
                        transitions=list(submit_result.get("transitions", [])),
                        recoverable=bool(submit_result.get("recoverable")),
                        details={
                            "phase": "submit",
                            "submitResult": submit_result,
                            "ownedPageCreated": True,
                            "existingPagesBefore": existing_pages_before,
                            "externalBrowserClosed": False,
                        },
                    )

                chat_url = str(submit_result.get("details", {}).get("chatUrl", "") or "")
                observed = observe_next_assistant(
                    page,
                    prompt,
                    chat_url,
                    timeout_ms=assistant_timeout_ms,
                    stable_ms=stable_ms,
                )
                observed["details"].update(
                    {
                        "phase": "assistant",
                        "promptSha256": submit.prompt_sha256(prompt),
                        "submitCode": submit_result.get("code"),
                        "submitSendState": submit_result.get("sendState"),
                        "ownedPageCreated": True,
                        "existingPagesBefore": existing_pages_before,
                        "externalBrowserClosed": False,
                        "ownsContext": owns_context,
                    }
                )
                return observed
            finally:
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
                # Never close the externally-owned CDP browser.
    except Exception as exc:
        return _result(
            OBSERVER_ATTACH_FAILED,
            ok=False,
            transitions=[],
            recoverable=True,
            details={"message": str(exc)},
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Web Postman P4 assistant-turn observer probe")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--cdp-url", default=bootstrap.DEFAULT_CDP_URL)
    parser.add_argument("--submit-timeout-ms", type=int, default=submit.DEFAULT_TIMEOUT_MS)
    parser.add_argument("--assistant-timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--stable-ms", type=int, default=DEFAULT_STABLE_MS)
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
                transitions=[],
                recoverable=True,
            )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 3
        profile_dir = Path(args.profile_dir) if args.profile_dir else bootstrap.default_profile_dir()
        launched_process = bootstrap.start_dedicated_chrome(executable, profile_dir, port=args.port)
        cdp_url = f"http://127.0.0.1:{args.port}"
        try:
            bootstrap.wait_for_cdp(
                cdp_url,
                timeout_s=max(args.submit_timeout_ms / 1000.0, 1.0),
            )
        except bootstrap.BrowserBootstrapError as exc:
            result = _result(
                exc.code,
                ok=False,
                transitions=[],
                recoverable=exc.recoverable,
                details=exc.details,
            )
            result["details"]["browserIdentity"] = bootstrap.describe_browser_identity(
                profile_dir,
                getattr(launched_process, "pid", None),
            )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 3

    result = run_submit_and_observe(
        cdp_url,
        args.prompt,
        submit_timeout_ms=args.submit_timeout_ms,
        assistant_timeout_ms=args.assistant_timeout_ms,
        stable_ms=args.stable_ms,
        keep_page=args.keep_page,
    )
    if launched_process is not None and profile_dir is not None:
        result["details"]["browserIdentity"] = bootstrap.describe_browser_identity(
            profile_dir,
            getattr(launched_process, "pid", None),
        )
        result["details"]["launchedChromeLeftRunning"] = True

    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    sys.exit(main())
