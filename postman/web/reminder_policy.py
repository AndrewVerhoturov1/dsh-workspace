#!/usr/bin/env python3
"""Fixed Postman reminder policy for one ChatGPT conversation.

The reminder is transport control for the current REQ. It does not create a
new request and never navigates away from the already-proven conversation.
"""

from __future__ import annotations

from typing import Any

import browser_bootstrap as bootstrap
import browser_observer
import browser_submit as submit
import request_identity as identity


DEFAULT_REMINDER_INTERVAL_MS = 10 * 60 * 1000
DEFAULT_REMINDER_COUNT = 3
DEFAULT_OVERALL_TIMEOUT_MS = 45 * 60 * 1000
REMINDER_CONTROL = "POSTMAN_TRANSPORT_CONTROL"
REMINDER_SUPPRESSED_GENERATION_ACTIVE = "REMINDER_SUPPRESSED_GENERATION_ACTIVE"
REMINDER_SUPPRESSION_CLEANUP_FAILED = "REMINDER_SUPPRESSION_CLEANUP_FAILED"


def build_reminder_prompt(
    request_id: str,
    reminder_index: int,
    *,
    total: int = DEFAULT_REMINDER_COUNT,
) -> str:
    """Build one deterministic service reminder for the current REQ."""
    identity.assert_canonical_request_id(request_id)
    if isinstance(reminder_index, bool) or not isinstance(reminder_index, int):
        raise ValueError("reminder_index must be an integer")
    if isinstance(total, bool) or not isinstance(total, int):
        raise ValueError("total must be an integer")
    if total < 1 or reminder_index < 1 or reminder_index > total:
        raise ValueError("reminder index is outside the configured range")

    return "\n".join(
        (
            identity.request_prompt_key_line(request_id),
            f"{REMINDER_CONTROL}: REMINDER {reminder_index}/{total}",
            "Продолжай выполнение исходной задачи, если она ещё не завершена.",
            "Не начинай исходную задачу заново.",
            "Не отвечай отдельно на это служебное сообщение.",
            "Итоговый результат выдай строго по правилам исходной задачи.",
        )
    )


def scheduled_elapsed_ms(
    reminder_index: int,
    *,
    interval_ms: int = DEFAULT_REMINDER_INTERVAL_MS,
) -> int:
    if isinstance(reminder_index, bool) or not isinstance(reminder_index, int) or reminder_index < 1:
        raise ValueError("reminder_index must be a positive integer")
    if isinstance(interval_ms, bool) or not isinstance(interval_ms, int) or interval_ms <= 0:
        raise ValueError("interval_ms must be a positive integer")
    return reminder_index * interval_ms


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
        "sendState": send_state,
        "recoverable": recoverable,
        "transitions": list(transitions),
        "details": dict(details or {}),
    }


def prepare_same_chat(
    page: Any,
    conversation_url: str,
    *,
    timeout_ms: int = submit.DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    """Confirm the current proven chat without page.goto()."""
    if not submit.is_bound_chat_url(conversation_url):
        return {
            "ok": False,
            "code": submit.SUBMIT_INVALID_CONFIG,
            "details": {"reason": "invalid_conversation_url"},
        }

    def predicate() -> tuple[bool, dict[str, Any]]:
        snapshot = submit._active_composer_groups(page)
        groups = [group for group in snapshot["logicalCandidates"] if group["active"]]
        preferred = [group["preferred"] for group in groups if group["preferred"]]
        composer = max(preferred, key=lambda item: item["nestingDepth"], default=None)
        selector = composer["selector"] if composer else None
        page_url = str(getattr(page, "url", "") or "")
        turns = submit.count_conversation_turns(page)
        if composer is None:
            session_code, session_details = bootstrap.classify_session(page)
            return False, {
                "sessionCode": session_code,
                "pageUrl": page_url,
                "turnCount": turns,
                **session_details,
            }
        empty, empty_details = submit._composer_empty_from_snapshot(snapshot)
        live_composer_ready = composer["selector"] != "textarea"
        same_chat = submit.same_conversation_url(page_url, conversation_url)
        return same_chat and empty and live_composer_ready, {
            "pageUrl": page_url,
            "turnCount": turns,
            "composerSelector": selector,
            "liveComposerReady": live_composer_ready,
            "sameConversation": same_chat,
            **empty_details,
            "composer": composer["locator"],
        }

    ok, details = submit._wait_until(predicate, timeout_ms=timeout_ms)
    composer = details.pop("composer", None)
    if not ok:
        code = submit.COMPOSER_NOT_EMPTY if details.get("composerEmpty") is False else submit.EXISTING_CHAT_NOT_CONFIRMED
        return {"ok": False, "code": code, "details": details}
    return {
        "ok": True,
        "code": submit.EXISTING_CHAT_CONFIRMED,
        "composer": composer,
        "details": details,
    }


def _clear_unsent_prompt(page: Any, prompt: str, *, timeout_ms: int) -> bool:
    """Clear only a prompt that is still visibly present and proven unsent."""
    matched, _ = submit._exact_prompt_readback(page, prompt)
    if not matched:
        return False
    composer, _ = submit.find_composer(page)
    if composer is None:
        return False
    try:
        composer.fill("", timeout=min(max(timeout_ms, 1), 2_000))
    except Exception:
        return False
    empty, _ = submit._composer_empty_proof(page)
    return bool(empty)


def _generation_active_suppression(
    page: Any,
    *,
    phase: str,
    transitions: list[str],
    unsent_prompt_cleared: bool,
    composer_untouched: bool,
) -> dict[str, Any] | None:
    """Return a safe suppression result while ChatGPT is still generating."""
    active, control = browser_observer.generation_active(page)
    if not active:
        return None
    return _result(
        REMINDER_SUPPRESSED_GENERATION_ACTIVE,
        ok=False,
        send_state=submit.SEND_PROVEN_NOT_SENT,
        transitions=transitions,
        recoverable=True,
        details={
            "generationActive": True,
            "generationControl": control,
            "suppressionPhase": phase,
            "unsentPromptCleared": unsent_prompt_cleared,
            "composerUntouched": composer_untouched,
        },
    )


def submit_reminder(
    page: Any,
    prompt: str,
    conversation_url: str,
    *,
    timeout_ms: int = submit.DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    """Send or safely suppress one reminder in the already-proven chat."""
    # During streaming the live composer itself may be temporarily unavailable.
    # If the owned Page is still on the exact conversation and generation is
    # visibly active, suppress before asking composer readiness to prove itself.
    page_url = str(getattr(page, "url", "") or "")
    if submit.same_conversation_url(page_url, conversation_url):
        early_suppressed = _generation_active_suppression(
            page,
            phase="before_prepare",
            transitions=[submit.PAGE_OWNED],
            unsent_prompt_cleared=True,
            composer_untouched=True,
        )
        if early_suppressed is not None:
            early_suppressed["details"]["sameConversation"] = True
            return early_suppressed

    prep = prepare_same_chat(page, conversation_url, timeout_ms=timeout_ms)
    if not prep.get("ok"):
        return _result(
            prep.get("code", submit.EXISTING_CHAT_NOT_CONFIRMED),
            ok=False,
            send_state=submit.SEND_PROVEN_NOT_SENT,
            transitions=[submit.PAGE_OWNED],
            recoverable=True,
            details=prep.get("details"),
        )

    composer = prep["composer"]
    base_transitions = [
        submit.PAGE_OWNED,
        submit.EXISTING_CHAT_CONFIRMED,
        submit.COMPOSER_EMPTY_CONFIRMED,
    ]

    # A due reminder is a checkpoint, not an obligation to interrupt an
    # assistant that is visibly still generating. Suppress the checkpoint
    # before mutating the composer. The bridge already treats PROVEN_NOT_SENT
    # plus a clean composer as safely continuable and advances to the next
    # absolute 10/20/30-minute slot, so suppressed reminders never accumulate.
    suppressed = _generation_active_suppression(
        page,
        phase="before_insert",
        transitions=base_transitions,
        unsent_prompt_cleared=True,
        composer_untouched=True,
    )
    if suppressed is not None:
        return suppressed

    inserted = submit.insert_prompt(
        page,
        composer,
        prompt,
        timeout_ms=timeout_ms,
        initial_composer_selector=prep.get("details", {}).get("composerSelector"),
    )
    if not inserted.get("ok"):
        return _result(
            inserted.get("code", submit.PROMPT_INSERT_FAILED),
            ok=False,
            send_state=submit.SEND_PROVEN_NOT_SENT,
            transitions=base_transitions,
            recoverable=True,
            details=inserted.get("details"),
        )

    # Close the race between the pre-insert check and Send. If generation
    # becomes active after fill(), never click anything. Clear only the exact
    # proven-unsent reminder; failure to prove cleanup stays fail-closed.
    post_insert = _generation_active_suppression(
        page,
        phase="after_insert",
        transitions=[*base_transitions, submit.PROMPT_INSERTED],
        unsent_prompt_cleared=False,
        composer_untouched=False,
    )
    if post_insert is not None:
        cleared = _clear_unsent_prompt(page, prompt, timeout_ms=timeout_ms)
        if not cleared:
            return _result(
                REMINDER_SUPPRESSION_CLEANUP_FAILED,
                ok=False,
                send_state=submit.SEND_PROVEN_NOT_SENT,
                transitions=[*base_transitions, submit.PROMPT_INSERTED],
                recoverable=False,
                details={
                    **post_insert.get("details", {}),
                    "unsentPromptCleared": False,
                },
            )
        post_insert["details"]["unsentPromptCleared"] = True
        return post_insert

    result = submit.submit_once(
        page,
        composer,
        prompt,
        submit.SendGuard(),
        chat_confirmed_state=submit.EXISTING_CHAT_CONFIRMED,
        timeout_ms=timeout_ms,
    )
    result.setdefault("details", {}).update(inserted.get("details", {}))

    # If no click was attempted, leaving the reminder text in the composer
    # would block the next scheduled reminder. Clear only the proven-unsent
    # text. UNKNOWN send state remains untouched and is never blindly retried.
    if not result.get("ok") and result.get("sendState") == submit.SEND_PROVEN_NOT_SENT:
        result["details"]["unsentPromptCleared"] = _clear_unsent_prompt(
            page,
            prompt,
            timeout_ms=timeout_ms,
        )
    return result


__all__ = [
    "DEFAULT_REMINDER_INTERVAL_MS",
    "DEFAULT_REMINDER_COUNT",
    "DEFAULT_OVERALL_TIMEOUT_MS",
    "REMINDER_CONTROL",
    "REMINDER_SUPPRESSED_GENERATION_ACTIVE",
    "REMINDER_SUPPRESSION_CLEANUP_FAILED",
    "build_reminder_prompt",
    "scheduled_elapsed_ms",
    "prepare_same_chat",
    "submit_reminder",
]
