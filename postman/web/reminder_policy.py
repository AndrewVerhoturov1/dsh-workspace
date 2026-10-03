#!/usr/bin/env python3
"""Absolute reminder slots and natural control Send for one ChatGPT conversation.

The reminder is transport control for the current REQ. It does not create a
new request and never navigates away from the already-proven conversation.
"""

from __future__ import annotations

import random
import time
from typing import Any, Callable

import browser_bootstrap as bootstrap
import browser_observer
import browser_submit as submit
import request_identity as identity
from continuation_prompts import choose_continuation


DEFAULT_REMINDER_INTERVAL_MS = 10 * 60 * 1000
DEFAULT_REMINDER_COUNT = 5
DEFAULT_OVERALL_TIMEOUT_MS = 60 * 60 * 1000
DEFAULT_REMINDER_SEND_WINDOW_MS = 5_000
DEFAULT_REMINDER_POLL_MS = 1_000
DEFAULT_REMINDER_CLICK_TIMEOUT_MS = 5_000
REMINDER_CONTROL = "POSTMAN_TRANSPORT_CONTROL"
REMINDER_SUPPRESSED_GENERATION_ACTIVE = "REMINDER_SUPPRESSED_GENERATION_ACTIVE"  # legacy result name
REMINDER_PHASE_PENDING = "REMINDER_PHASE_PENDING"
REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY = "REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY"
REMINDER_SUPPRESSED_SEND_NOT_READY = "REMINDER_SUPPRESSED_SEND_NOT_READY"
REMINDER_SUPPRESSION_CLEANUP_FAILED = "REMINDER_SUPPRESSION_CLEANUP_FAILED"
REMINDER_SEND_GUARD_FAILED = "REMINDER_SEND_GUARD_FAILED"


def build_reminder_prompt(
    request_id: str,
    reminder_index: int,
    *,
    total: int = DEFAULT_REMINDER_COUNT,
) -> str:
    """Choose a natural continuation; the REQ remains internal."""
    identity.assert_canonical_request_id(request_id)
    if isinstance(reminder_index, bool) or not isinstance(reminder_index, int):
        raise ValueError("reminder_index must be an integer")
    if isinstance(total, bool) or not isinstance(total, int):
        raise ValueError("total must be an integer")
    if total < 1 or reminder_index < 1 or reminder_index > total:
        raise ValueError("reminder index is outside the configured range")

    return choose_continuation()["exactPromptText"]


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
        same_chat = page_url == conversation_url
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
    return submit.clear_owned_unsent_prompt(page, prompt, timeout_ms=timeout_ms)


def random_ui_pause(*, sleep: Callable[[float], None] = time.sleep,
                    uniform: Callable[[float, float], float] = random.uniform) -> None:
    sleep(uniform(1.0, 5.0))


def _phase_suppression(phase: dict[str, Any], *, boundary: str,
                       transitions: list[str], page: Any, prompt: str | None = None,
                       timeout_ms: int = 0) -> dict[str, Any] | None:
    state = phase.get("phase", browser_observer.UNKNOWN)
    if (state not in {browser_observer.FINAL_ANSWER_STARTED, browser_observer.FINAL_ANSWER_COMPLETED,
                          browser_observer.ASSISTANT_CONNECTION_INTERRUPTED}
            and not phase.get("finalAnswerLatched")
            and phase.get("reason") not in {"control_intent_lineage_changed", "control_deadline"}):
        return None
    code = (REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY if state in
            {browser_observer.FINAL_ANSWER_STARTED, browser_observer.FINAL_ANSWER_COMPLETED}
            else REMINDER_PHASE_PENDING)
    if prompt is not None:
        return _suppression_after_insert(page, prompt, code=code, phase=boundary,
                                         transitions=transitions, timeout_ms=timeout_ms,
                                         details={"answerPhase": phase})
    return _result(code, ok=False, send_state=submit.SEND_PROVEN_NOT_SENT,
                   transitions=transitions, recoverable=True,
                   details={"answerPhase": phase, "suppressionPhase": boundary,
                            "composerUntouched": True, "unsentPromptCleared": True})


def _req_anchor_snapshot(page: Any, prompt: str, *, anchor_binding=None) -> dict[str, Any]:
    """Prove the last user anchor and its only correlated assistant turn."""
    turns, selector = browser_observer.snapshot_turns(page)
    request_key_line = submit.request_key_line_from_prompt(prompt)
    last = turns[-1] if turns else None
    if last is None:
        return {
            "safe": False,
            "reason": "conversation_turns_missing",
            "turnCount": 0,
            "turnSelector": selector,
            "fingerprint": None,
        }

    role = str(last.get("role", "") or "")
    text = str(last.get("text", "") or "")
    anchor = browser_observer.find_user_anchor(turns, prompt, anchor_binding=anchor_binding)
    anchor_turn = turns[anchor] if anchor is not None else None
    request_key_match = bool(anchor_turn and request_key_line and
                             submit._turn_contains_exact_line(str(anchor_turn.get("text", "")), request_key_line))
    exact_match = bool(anchor_turn and browser_observer._normalize_text(anchor_turn.get("text", ""))
                       == browser_observer._normalize_text(prompt))
    trusted_match = exact_match or request_key_match or (anchor_binding is not None and anchor is not None)
    if not trusted_match:
        reason = "latest_user_turn_not_current_req"
    elif any(t.get("role") == "user" and t.get("index", -1) > anchor for t in turns):
        reason = "another_user_turn"
    elif role not in {"user", "assistant"}:
        reason = "latest_turn_role_unknown"
    elif role == "assistant" and last.get("index") != anchor + 1:
        reason = "assistant_identity_unknown"
    elif role == "user" and last.get("index") != anchor:
        reason = "latest_user_turn_not_current_req"
    else:
        reason = ""
    fingerprint = {"anchorIndex": anchor, "anchorTextSha256": submit.prompt_sha256(str(anchor_turn.get("text", ""))) if anchor_turn else ""}
    return {
        "safe": not reason,
        "reason": reason,
        "turnCount": len(turns),
        "turnSelector": selector,
        "requestKeyLine": request_key_line,
        "requestKeyMatched": request_key_match,
        "fingerprint": fingerprint,
    }


def _suppression_after_insert(
    page: Any,
    prompt: str,
    *,
    code: str,
    phase: str,
    transitions: list[str],
    timeout_ms: int,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cleared = _clear_unsent_prompt(page, prompt, timeout_ms=timeout_ms)
    if not cleared:
        return _result(
            REMINDER_SUPPRESSION_CLEANUP_FAILED,
            ok=False,
            send_state=submit.SEND_PROVEN_NOT_SENT,
            transitions=transitions,
            recoverable=False,
            details={
                "suppressionPhase": phase,
                "unsentPromptCleared": False,
                **dict(details or {}),
            },
        )
    return _result(
        code,
        ok=False,
        send_state=submit.SEND_PROVEN_NOT_SENT,
        transitions=transitions,
        recoverable=True,
        details={
            "suppressionPhase": phase,
            "unsentPromptCleared": True,
            "composerUntouched": False,
            **dict(details or {}),
        },
    )


def _click_ready_reminder_once(
    page: Any,
    button: Any,
    selector: str,
    prompt: str,
    *,
    before_turn_count: int,
    transitions: list[str],
    timeout_ms: int,
    poll_ms: int,
    conversation_url: str | None = None,
    click_timeout_ms: int = DEFAULT_REMINDER_CLICK_TIMEOUT_MS,
) -> dict[str, Any]:
    """Click an already-proven Send control exactly once, then prove the user turn."""
    guard = submit.SendGuard()
    try:
        guard.begin()
    except submit.SubmitError as exc:
        return _result(
            exc.code,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            details=exc.details,
        )

    send_transitions = [*transitions, submit.PROMPT_SEND_STARTED]
    click_timeout_ms = min(max(click_timeout_ms, 1), max(timeout_ms, 1))
    transaction = getattr(page, "_postman_presend", None)
    if isinstance(transaction, dict):
        transaction["sendAttempted"] = True
    try:
        button.click(timeout=click_timeout_ms)
    except Exception as exc:
        guard.unknown()
        return _result(
            submit.PROMPT_SEND_UNKNOWN,
            ok=False,
            send_state=guard.state,
            transitions=send_transitions,
            recoverable=True,
            details={
                "message": str(exc),
                "sendControl": selector,
                "reason": "click_outcome_uncertain",
                "reminderClickTimeoutMs": click_timeout_ms,
            },
        )

    ok, proof = submit._wait_until(
        lambda: submit._observe_send_proof(page, prompt, before_turn_count, conversation_url=conversation_url),
        timeout_ms=timeout_ms,
        poll_ms=poll_ms,
    )
    proof["sendControl"] = selector
    proof["promptSha256"] = submit.prompt_sha256(prompt)
    proof["reminderProofPollMs"] = poll_ms
    if not ok:
        guard.unknown()
        return _result(
            submit.PROMPT_SEND_UNKNOWN,
            ok=False,
            send_state=guard.state,
            transitions=send_transitions,
            recoverable=True,
            details=proof,
        )

    guard.confirm()
    return _result(
        submit.PROMPT_SEND_CONFIRMED,
        ok=True,
        send_state=guard.state,
        transitions=[*send_transitions, submit.PROMPT_SEND_CONFIRMED, submit.CHAT_URL_BOUND],
        details=proof,
    )


@submit._presend_transaction
def submit_reminder(
    page: Any,
    prompt: str,
    conversation_url: str,
    *,
    timeout_ms: int = submit.DEFAULT_TIMEOUT_MS,
    send_window_ms: int = DEFAULT_REMINDER_SEND_WINDOW_MS,
    poll_ms: int = DEFAULT_REMINDER_POLL_MS,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    uniform: Callable[[float, float], float] = random.uniform,
    anchor_prompt: str | None = None,
    phase_tracker: browser_observer.AnswerPhaseTracker | None = None,
    anchor_binding: dict[str, Any] | None = None,
    operation_deadline: float | None = None,
    control_intent: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Send one reminder in the exact REQ chat, unless final answer has begun."""
    if isinstance(send_window_ms, bool) or not isinstance(send_window_ms, int) or send_window_ms < 0:
        raise ValueError("send_window_ms must be a non-negative integer")
    if isinstance(poll_ms, bool) or not isinstance(poll_ms, int) or poll_ms <= 0:
        raise ValueError("poll_ms must be a positive integer")

    page_url = str(getattr(page, "url", "") or "")
    if page_url != conversation_url:
        return _result(
            REMINDER_SUPPRESSED_SEND_NOT_READY,
            ok=False,
            send_state=submit.SEND_PROVEN_NOT_SENT,
            transitions=[submit.PAGE_OWNED],
            recoverable=True,
            details={
                "reason": "same_conversation_not_current",
                "sameConversation": False,
                "composerUntouched": True,
                "unsentPromptCleared": True,
            },
        )

    tracker = phase_tracker if phase_tracker is not None else browser_observer.AnswerPhaseTracker()
    expected_anchor = anchor_prompt or prompt
    def inspect() -> dict[str, Any]:
        if control_intent is not None:
            turns, _ = browser_observer.snapshot_turns(page)
            users = [t for t in turns if t.get("role") == "user"]
            relation = control_intent.get("expectedUserTurnRelation", {})
            if (control_intent.get("conversationUrl") != conversation_url
                    or control_intent.get("exactPromptText") != prompt
                    or relation.get("userOrdinal") != len(users)
                    or relation.get("precedingUserHashes") != [submit.prompt_sha256(t["text"]) for t in users]):
                return {"phase": browser_observer.UNKNOWN, "reason": "control_intent_lineage_changed"}
        phase = browser_observer.inspect_answer_phase(page, expected_anchor, conversation_url,
                                                     tracker=tracker, anchor_binding=anchor_binding,
                                                     ignore_system_banner=True)
        interrupted, evidence = browser_observer.connection_interrupted(page)
        if interrupted or evidence.get("confidence") == "weak":
            return {**phase, "phase": browser_observer.ASSISTANT_CONNECTION_INTERRUPTED}
        if operation_deadline is not None and monotonic() >= operation_deadline:
            return {**phase, "reason": "control_deadline"}
        return phase
    def pause():
        seconds = uniform(1.0, 5.0)
        if operation_deadline is not None:
            seconds = min(seconds, max(0.0, operation_deadline - monotonic()))
        sleep(seconds)

    early_suppressed = _phase_suppression(inspect(), boundary="before_prepare",
                                          transitions=[submit.PAGE_OWNED], page=page)
    if early_suppressed is not None:
        return early_suppressed

    baseline = _req_anchor_snapshot(page, expected_anchor, anchor_binding=anchor_binding)
    if not baseline.get("safe"):
        code = (
            REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY
            if baseline.get("reason") == "assistant_turn_present"
            else REMINDER_SUPPRESSED_SEND_NOT_READY
        )
        return _result(
            code,
            ok=False,
            send_state=submit.SEND_PROVEN_NOT_SENT,
            transitions=[submit.PAGE_OWNED],
            recoverable=True,
            details={
                **baseline,
                "suppressionPhase": "before_prepare",
                "composerUntouched": True,
                "unsentPromptCleared": True,
            },
        )

    # Reminder readiness is a checkpoint, not a 30-second wait. Check the
    # already-owned chat once; if the composer is not immediately ready, skip
    # this absolute slot rather than waiting until streaming finishes.
    prep = prepare_same_chat(page, conversation_url, timeout_ms=0)
    if not prep.get("ok"):
        return _result(
            REMINDER_SUPPRESSED_SEND_NOT_READY,
            ok=False,
            send_state=submit.SEND_PROVEN_NOT_SENT,
            transitions=[submit.PAGE_OWNED],
            recoverable=True,
            details={
                "reason": "composer_not_immediately_ready",
                "prepareCode": prep.get("code", submit.EXISTING_CHAT_NOT_CONFIRMED),
                "prepareDetails": prep.get("details", {}),
                "composerUntouched": True,
                "unsentPromptCleared": True,
            },
        )

    composer = prep["composer"]
    transaction = getattr(page, "_postman_presend", None)
    if isinstance(transaction, dict):
        transaction.update({"ownedUrl": str(page.url), "userCount": len(submit.collect_user_turn_texts(page))})
    base_transitions = [
        submit.PAGE_OWNED,
        submit.EXISTING_CHAT_CONFIRMED,
        submit.COMPOSER_EMPTY_CONFIRMED,
    ]

    pause()
    suppressed = _phase_suppression(inspect(), boundary="before_insert",
                                    transitions=base_transitions, page=page)
    if suppressed is not None:
        return suppressed

    current_anchor = _req_anchor_snapshot(page, expected_anchor, anchor_binding=anchor_binding)
    if not current_anchor.get("safe") or current_anchor.get("fingerprint") != baseline.get("fingerprint"):
        return _result(
            REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY,
            ok=False,
            send_state=submit.SEND_PROVEN_NOT_SENT,
            transitions=base_transitions,
            recoverable=True,
            details={
                "reason": current_anchor.get("reason") or "conversation_turn_changed",
                "baseline": baseline,
                "observed": current_anchor,
                "suppressionPhase": "before_insert",
                "composerUntouched": True,
                "unsentPromptCleared": True,
            },
        )

    insert_timeout_ms = min(max(timeout_ms, 1), max(send_window_ms, 1))
    if operation_deadline is not None:
        if monotonic() >= operation_deadline:
            return _phase_suppression({"phase": browser_observer.UNKNOWN, "reason": "insert_deadline"},
                                      boundary="before_insert", transitions=base_transitions,
                                      page=page)
        insert_timeout_ms = min(insert_timeout_ms, max(1, int((operation_deadline - monotonic()) * 1000)))
    inserted = submit.insert_prompt(
        page,
        composer,
        prompt,
        timeout_ms=insert_timeout_ms,
        initial_composer_selector=prep.get("details", {}).get("composerSelector"),
    )
    if not inserted.get("ok"):
        return _result(
            inserted.get("code", submit.PROMPT_INSERT_FAILED),
            ok=False,
            send_state=submit.SEND_PROVEN_NOT_SENT,
            transitions=base_transitions,
            recoverable=True,
            details={
                **inserted.get("details", {}),
                "reminderInsertTimeoutMs": insert_timeout_ms,
            },
        )

    send_transitions = [*base_transitions, submit.PROMPT_INSERTED]
    pause()
    deadline = min(monotonic() + send_window_ms / 1000.0, operation_deadline) if operation_deadline is not None else monotonic() + send_window_ms / 1000.0
    poll_count = 0

    while True:
        poll_count += 1
        current_url = str(getattr(page, "url", "") or "")
        if current_url != conversation_url:
            return _result(
                REMINDER_SEND_GUARD_FAILED,
                ok=False,
                send_state=submit.SEND_PROVEN_NOT_SENT,
                transitions=send_transitions,
                recoverable=False,
                details={
                    "reason": "conversation_changed_after_insert",
                    "observedUrl": current_url,
                    "expectedUrl": conversation_url,
                    "unsentPromptCleared": False,
                    "reminderPollCount": poll_count,
                },
            )

        suppressed = _phase_suppression(inspect(), boundary="send_window",
                                        transitions=send_transitions, page=page,
                                        prompt=prompt, timeout_ms=timeout_ms)
        if suppressed is not None:
            return suppressed

        observed_anchor = _req_anchor_snapshot(page, expected_anchor, anchor_binding=anchor_binding)
        if (
            not observed_anchor.get("safe") or observed_anchor.get("fingerprint") != baseline.get("fingerprint")
        ):
            return _suppression_after_insert(
                page,
                prompt,
                code=REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY,
                phase="send_window",
                transitions=send_transitions,
                timeout_ms=timeout_ms,
                details={
                    "reason": observed_anchor.get("reason") or "conversation_turn_changed",
                    "baseline": baseline,
                    "observed": observed_anchor,
                    "reminderPollCount": poll_count,
                },
            )

        prompt_matches, prompt_details = submit._exact_prompt_readback(page, prompt)
        if not prompt_matches:
            return _result(
                REMINDER_SEND_GUARD_FAILED,
                ok=False,
                send_state=submit.SEND_PROVEN_NOT_SENT,
                transitions=send_transitions,
                recoverable=False,
                details={
                    "reason": "exact_unsent_reminder_not_present",
                    "unsentPromptCleared": False,
                    "reminderPollCount": poll_count,
                    **prompt_details,
                },
            )

        button, selector = submit.find_send_button(page)
        if button is not None and selector:
            # Capture the pre-send user-turn count before the final re-proof so
            # the only operations between that re-proof and click are the
            # in-memory one-shot guard and the click itself.
            before_turn_count = len(submit.collect_user_turn_texts(page))
            # Re-prove all volatile facts immediately before the only allowed
            # click. This closes the old 30-second wait-after-streaming race.
            final_anchor = _req_anchor_snapshot(page, expected_anchor, anchor_binding=anchor_binding)
            final_prompt_matches, final_prompt_details = submit._exact_prompt_readback(page, prompt)
            final_button, final_selector = submit.find_send_button(page)
            final_url = str(getattr(page, "url", "") or "")
            if final_url != conversation_url:
                return _result(
                    REMINDER_SEND_GUARD_FAILED,
                    ok=False,
                    send_state=submit.SEND_PROVEN_NOT_SENT,
                    transitions=send_transitions,
                    recoverable=False,
                    details={
                        "reason": "conversation_changed_before_click",
                        "unsentPromptCleared": False,
                        "reminderPollCount": poll_count,
                    },
                )
            if (
                not final_anchor.get("safe") or final_anchor.get("fingerprint") != baseline.get("fingerprint")
            ):
                return _suppression_after_insert(
                    page,
                    prompt,
                    code=REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY,
                    phase="pre_click",
                    transitions=send_transitions,
                    timeout_ms=timeout_ms,
                    details={
                        "reason": final_anchor.get("reason") or "conversation_turn_changed",
                        "baseline": baseline,
                        "observed": final_anchor,
                        "reminderPollCount": poll_count,
                    },
                )
            if not final_prompt_matches:
                return _result(
                    REMINDER_SEND_GUARD_FAILED,
                    ok=False,
                    send_state=submit.SEND_PROVEN_NOT_SENT,
                    transitions=send_transitions,
                    recoverable=False,
                    details={
                        "reason": "exact_unsent_reminder_changed_before_click",
                        "unsentPromptCleared": False,
                        "reminderPollCount": poll_count,
                        **final_prompt_details,
                    },
                )
            if final_button is not None and final_selector:
                suppressed = _phase_suppression(inspect(), boundary="pre_click",
                                                transitions=send_transitions, page=page,
                                                prompt=prompt, timeout_ms=timeout_ms)
                if suppressed is not None:
                    return suppressed
                if str(getattr(page, "url", "") or "") != conversation_url:
                    return _result(REMINDER_SEND_GUARD_FAILED, ok=False,
                                   send_state=submit.SEND_PROVEN_NOT_SENT,
                                   transitions=send_transitions, recoverable=False,
                                   details={"reason": "conversation_changed_before_click",
                                            "unsentPromptCleared": False})
                last_match, last_readback = submit._exact_prompt_readback(page, prompt)
                if not last_match:
                    return _result(REMINDER_SEND_GUARD_FAILED, ok=False,
                                   send_state=submit.SEND_PROVEN_NOT_SENT,
                                   transitions=send_transitions, recoverable=False,
                                   details={"reason": "exact_unsent_reminder_changed_before_click",
                                            "unsentPromptCleared": False, **last_readback})
                last_button, last_selector = submit.find_send_button(page)
                if last_button is None or not last_selector:
                    return _suppression_after_insert(page, prompt,
                                                     code=REMINDER_SUPPRESSED_SEND_NOT_READY,
                                                     phase="pre_click", transitions=send_transitions,
                                                     timeout_ms=timeout_ms,
                                                     details={"reason": "send_control_disappeared_before_click"})
                if operation_deadline is not None and monotonic() >= operation_deadline:
                    return _suppression_after_insert(page, prompt,
                        code=REMINDER_PHASE_PENDING, phase="deadline_before_click",
                        transitions=send_transitions, timeout_ms=timeout_ms,
                        details={"reason": "control_deadline"})
                result = _click_ready_reminder_once(
                    page,
                    last_button,
                    last_selector,
                    prompt,
                    before_turn_count=before_turn_count,
                    transitions=send_transitions,
                    timeout_ms=min(timeout_ms, max(1, int((operation_deadline - monotonic()) * 1000) - DEFAULT_REMINDER_CLICK_TIMEOUT_MS)) if operation_deadline is not None else timeout_ms,
                    poll_ms=poll_ms,
                    conversation_url=conversation_url,
                    click_timeout_ms=min(DEFAULT_REMINDER_CLICK_TIMEOUT_MS, max(1, int((operation_deadline - monotonic()) * 1000))) if operation_deadline is not None else DEFAULT_REMINDER_CLICK_TIMEOUT_MS,
                )
                result.setdefault("details", {}).update(inserted.get("details", {}))
                result["details"]["reminderSendWindowMs"] = send_window_ms
                result["details"]["reminderPollMs"] = poll_ms
                result["details"]["reminderPollCount"] = poll_count
                return result

        now = monotonic()
        if now >= deadline:
            return _suppression_after_insert(
                page,
                prompt,
                code=REMINDER_SUPPRESSED_SEND_NOT_READY,
                phase="send_window_expired",
                transitions=send_transitions,
                timeout_ms=timeout_ms,
                details={
                    "reason": "send_control_not_ready_within_window",
                    "reminderSendWindowMs": send_window_ms,
                    "reminderPollMs": poll_ms,
                    "reminderPollCount": poll_count,
                },
            )
        remaining = max(deadline - now, 0.0)
        sleep(min(poll_ms / 1000.0, remaining))


__all__ = [
    "DEFAULT_REMINDER_INTERVAL_MS",
    "DEFAULT_REMINDER_COUNT",
    "DEFAULT_OVERALL_TIMEOUT_MS",
    "DEFAULT_REMINDER_SEND_WINDOW_MS",
    "DEFAULT_REMINDER_POLL_MS",
    "DEFAULT_REMINDER_CLICK_TIMEOUT_MS",
    "REMINDER_CONTROL",
    "REMINDER_SUPPRESSED_GENERATION_ACTIVE",
    "REMINDER_PHASE_PENDING",
    "REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY",
    "REMINDER_SUPPRESSED_SEND_NOT_READY",
    "REMINDER_SUPPRESSION_CLEANUP_FAILED",
    "REMINDER_SEND_GUARD_FAILED",
    "build_reminder_prompt",
    "scheduled_elapsed_ms",
    "prepare_same_chat",
    "random_ui_pause",
    "submit_reminder",
]
