#!/usr/bin/env python3
"""Safe recovery helpers for an interrupted ChatGPT conversation Page.

Recovery is deliberately narrow:
- never creates a new request or conversation;
- never sends a prompt;
- reloads only the already-bound conversation Page;
- proves that the same conversation and trusted user anchor are hydrated;
- waits an additional settle interval before handing control back to the bridge.
"""

from __future__ import annotations

import time
from typing import Any, Callable

import browser_observer as observer
import browser_submit as submit


RECOVERY_READY = "RECOVERY_READY"
RECOVERY_NOT_READY = "RECOVERY_NOT_READY"
RECOVERY_RELOAD_FAILED = "RECOVERY_RELOAD_FAILED"
RECOVERY_EXHAUSTED = "RECOVERY_EXHAUSTED"
RECOVERY_INVALID_CONFIG = "RECOVERY_INVALID_CONFIG"
RECOVERY_BUDGET_EXHAUSTED = "RECOVERY_BUDGET_EXHAUSTED"

DEFAULT_LOAD_TIMEOUT_MS = 60_000
DEFAULT_POLL_MS = 3_000
DEFAULT_SETTLE_MS = 10_000
DEFAULT_MAX_RELOAD_ATTEMPTS = 3
DEFAULT_RETRY_DELAYS_MS = (0, 15_000, 30_000)


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


def _active_live_composer(page: Any) -> tuple[bool, dict[str, Any]]:
    snapshot = submit._active_composer_groups(page)
    groups = [group for group in snapshot["logicalCandidates"] if group["active"]]
    preferred = [group["preferred"] for group in groups if group["preferred"]]
    composer = max(preferred, key=lambda item: item["nestingDepth"], default=None)
    selector = composer["selector"] if composer else None
    if composer is None:
        return False, {
            "composerSelector": None,
            "liveComposerReady": False,
            "composerEmpty": None,
        }
    empty, empty_details = submit._composer_empty_from_snapshot(snapshot)
    live = selector != "textarea"
    return bool(live and empty), {
        "composerSelector": selector,
        "liveComposerReady": live,
        **empty_details,
    }


def chat_ready_snapshot(
    page: Any,
    conversation_url: str,
    trusted_prompt: str,
) -> dict[str, Any]:
    """Read-only proof that the same conversation is hydrated and safe to inspect."""
    if not submit.is_bound_chat_url(conversation_url):
        return _result(
            RECOVERY_INVALID_CONFIG,
            ok=False,
            details={"reason": "invalid_conversation_url"},
        )
    if not isinstance(trusted_prompt, str) or not trusted_prompt:
        return _result(
            RECOVERY_INVALID_CONFIG,
            ok=False,
            details={"reason": "trusted_prompt_empty"},
        )

    page_url = str(getattr(page, "url", "") or "")
    same_conversation = submit.same_conversation_url(page_url, conversation_url)
    composer_ready, composer_details = _active_live_composer(page)
    turns, selector = observer.snapshot_turns(page)
    anchor_index = observer.find_user_anchor(turns, trusted_prompt)
    interrupted, interruption_details = observer.connection_interrupted(page)

    details = {
        "pageUrl": page_url,
        "sameConversation": same_conversation,
        "turnSelector": selector,
        "turnCount": len(turns),
        "trustedAnchorIndex": anchor_index,
        "connectionInterrupted": interrupted,
        "interruption": interruption_details,
        **composer_details,
    }
    ready = (
        same_conversation
        and composer_ready
        and anchor_index is not None
        and not interrupted
    )
    return _result(
        RECOVERY_READY if ready else RECOVERY_NOT_READY,
        ok=ready,
        recoverable=not ready,
        details=details,
    )


def wait_for_chat_ready(
    page: Any,
    conversation_url: str,
    trusted_prompt: str,
    *,
    timeout_ms: int = DEFAULT_LOAD_TIMEOUT_MS,
    settle_ms: int = DEFAULT_SETTLE_MS,
    poll_ms: int = DEFAULT_POLL_MS,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Wait until the exact chat is hydrated, then give it an extra settle window."""
    if (
        any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in (timeout_ms, settle_ms)
        )
        or isinstance(poll_ms, bool)
        or not isinstance(poll_ms, int)
        or poll_ms <= 0
    ):
        return _result(
            RECOVERY_INVALID_CONFIG,
            ok=False,
            details={"reason": "invalid_timing_config"},
        )

    deadline = monotonic() + timeout_ms / 1000.0
    last = chat_ready_snapshot(page, conversation_url, trusted_prompt)
    while not last.get("ok"):
        if monotonic() >= deadline:
            return _result(
                RECOVERY_NOT_READY,
                ok=False,
                recoverable=True,
                details=last.get("details"),
            )
        remaining = max(deadline - monotonic(), 0.0)
        sleep(min(max(poll_ms, 1) / 1000.0, remaining))
        last = chat_ready_snapshot(page, conversation_url, trusted_prompt)

    if settle_ms > 0:
        sleep(settle_ms / 1000.0)

    final = chat_ready_snapshot(page, conversation_url, trusted_prompt)
    if not final.get("ok"):
        return _result(
            RECOVERY_NOT_READY,
            ok=False,
            recoverable=True,
            details={
                **final.get("details", {}),
                "reason": "page_changed_during_settle",
                "settleMs": settle_ms,
            },
        )
    final.setdefault("details", {})["settleMs"] = settle_ms
    return final


def recover_interrupted_chat(
    page: Any,
    conversation_url: str,
    trusted_prompt: str,
    *,
    load_timeout_ms: int = DEFAULT_LOAD_TIMEOUT_MS,
    settle_ms: int = DEFAULT_SETTLE_MS,
    poll_ms: int = DEFAULT_POLL_MS,
    max_attempts: int = DEFAULT_MAX_RELOAD_ATTEMPTS,
    retry_delays_ms: tuple[int, ...] = DEFAULT_RETRY_DELAYS_MS,
    budget_ms: int | None = None,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Reload the same bound conversation conservatively after an interruption."""
    if not submit.is_bound_chat_url(conversation_url):
        return _result(
            RECOVERY_INVALID_CONFIG,
            ok=False,
            details={"reason": "invalid_conversation_url"},
        )
    if not isinstance(trusted_prompt, str) or not trusted_prompt:
        return _result(
            RECOVERY_INVALID_CONFIG,
            ok=False,
            details={"reason": "trusted_prompt_empty"},
        )
    if (
        isinstance(max_attempts, bool)
        or not isinstance(max_attempts, int)
        or max_attempts < 1
        or isinstance(load_timeout_ms, bool)
        or not isinstance(load_timeout_ms, int)
        or load_timeout_ms <= 0
        or isinstance(settle_ms, bool)
        or not isinstance(settle_ms, int)
        or settle_ms < 0
        or isinstance(poll_ms, bool)
        or not isinstance(poll_ms, int)
        or poll_ms <= 0
        or budget_ms is not None
        and (isinstance(budget_ms, bool) or not isinstance(budget_ms, int) or budget_ms <= 0)
    ):
        return _result(
            RECOVERY_INVALID_CONFIG,
            ok=False,
            details={"reason": "invalid_recovery_config"},
        )

    budget_deadline = None if budget_ms is None else monotonic() + budget_ms / 1000.0
    attempts: list[dict[str, Any]] = []

    def remaining_budget_ms() -> int | None:
        if budget_deadline is None:
            return None
        return max(0, int((budget_deadline - monotonic()) * 1000.0))

    for attempt in range(1, max_attempts + 1):
        delay_ms = retry_delays_ms[min(attempt - 1, len(retry_delays_ms) - 1)] if retry_delays_ms else 0
        remaining = remaining_budget_ms()
        if remaining is not None and remaining <= delay_ms + settle_ms:
            return _result(
                RECOVERY_BUDGET_EXHAUSTED,
                ok=False,
                recoverable=True,
                details={"attempts": attempts, "attempt": attempt},
            )
        if delay_ms > 0:
            sleep(delay_ms / 1000.0)

        remaining = remaining_budget_ms()
        if remaining is not None and remaining <= settle_ms:
            return _result(
                RECOVERY_BUDGET_EXHAUSTED,
                ok=False,
                recoverable=True,
                details={"attempts": attempts, "attempt": attempt},
            )
        attempt_timeout_ms = load_timeout_ms
        if remaining is not None:
            attempt_timeout_ms = max(1, min(load_timeout_ms, remaining - settle_ms))

        attempt_record: dict[str, Any] = {
            "attempt": attempt,
            "delayMs": delay_ms,
            "loadTimeoutMs": attempt_timeout_ms,
        }
        try:
            page.reload(wait_until="domcontentloaded", timeout=attempt_timeout_ms)
            attempt_record["reload"] = "ok"
        except Exception as exc:
            attempt_record["reload"] = "failed"
            attempt_record["message"] = str(exc)[:500]
            attempts.append(attempt_record)
            continue

        remaining_after_reload = remaining_budget_ms()
        if remaining_after_reload is not None and remaining_after_reload <= settle_ms:
            attempts.append(attempt_record)
            return _result(
                RECOVERY_BUDGET_EXHAUSTED,
                ok=False,
                recoverable=True,
                details={"attempts": attempts, "attempt": attempt},
            )
        ready_timeout_ms = load_timeout_ms
        if remaining_after_reload is not None:
            ready_timeout_ms = max(1, min(load_timeout_ms, remaining_after_reload - settle_ms))

        ready = wait_for_chat_ready(
            page,
            conversation_url,
            trusted_prompt,
            timeout_ms=ready_timeout_ms,
            settle_ms=settle_ms,
            poll_ms=poll_ms,
            sleep=sleep,
            monotonic=monotonic,
        )
        attempt_record["readyCode"] = ready.get("code")
        attempt_record["readyDetails"] = ready.get("details", {})
        attempts.append(attempt_record)
        if ready.get("ok"):
            return _result(
                RECOVERY_READY,
                ok=True,
                details={
                    "attempt": attempt,
                    "attempts": attempts,
                    "conversationUrl": conversation_url,
                    "settleMs": settle_ms,
                },
            )

    return _result(
        RECOVERY_EXHAUSTED,
        ok=False,
        recoverable=True,
        details={"attempts": attempts, "maxAttempts": max_attempts},
    )
