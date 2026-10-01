"""Additional Processing's bounded Stop -> reload -> re-proof -> wait flow.

Continuation Send is owned by the bridge, after it has re-scanned for results.
"""
from __future__ import annotations

import random
import re
import time

import browser_observer as observer
import browser_recovery as recovery
import browser_submit as submit


def stop_once(page, *, timeout_ms, on_event):
    control = None
    selector = ""
    for candidate_selector in observer.GENERATION_CONTROL_SELECTORS:
        try:
            matches = page.locator(candidate_selector)
            if matches.count() == 1 and matches.first.is_visible() and matches.first.is_enabled():
                control, selector = matches.first, candidate_selector
                break
        except Exception:
            continue
    if control is None:
        try:
            matches = page.get_by_role("button", name=re.compile(
                r"^(stop|stop generating|pause|pause generation|остановить|остановить создание|приостановить)$", re.I))
            if matches.count() == 1 and matches.first.is_visible() and matches.first.is_enabled():
                control, selector = matches.first, "role=button[name=stop/pause]"
        except Exception:
            pass
    on_event("STOP_CONTROL_FOUND" if control is not None else "STOP_CONTROL_ABSENT", selector=selector)
    if control is None:
        return {"outcome": "ABSENT", "clickCount": 0}
    outcome = "CONFIRMED"
    try:
        control.click(timeout=min(max(timeout_ms, 1), 1000))
    except Exception as exc:
        outcome = "UNKNOWN"
        on_event("STOP_CLICK", outcome=outcome, message=str(exc)[:300], selector=selector)
    else:
        on_event("STOP_CLICK", outcome=outcome, selector=selector)
    return {"outcome": outcome, "clickCount": 1, "selector": selector}


def prepare_additional_processing(page, conversation_url, original_prompt, anchor_prompt,
                                  *, anchor_binding=None, deadline, on_event,
                                  sleep=time.sleep, monotonic=time.monotonic,
                                  uniform=random.uniform):
    def remaining():
        return max(0, int((deadline - monotonic()) * 1000))

    # Never click Stop in a chat whose active task lineage was lost.
    proof = recovery.chat_ready_snapshot(page, conversation_url, anchor_prompt,
                                        original_prompt=original_prompt,
                                        anchor_binding=anchor_binding, allow_interrupted=True)
    if not proof.get("ok") or remaining() <= 0:
        return {"ok": False, "code": "SYSTEM_PRESTOP_REPROOF_FAILED", "details": proof}
    on_event("SYSTEM_STOP")
    stop = stop_once(page, timeout_ms=remaining(), on_event=on_event)
    on_event("SYSTEM_RELOAD")
    if remaining() <= 0:
        return {"ok": False, "code": recovery.RECOVERY_BUDGET_EXHAUSTED, "details": {"stop": stop}}
    reloaded = recovery.recover_interrupted_chat(
        page, conversation_url, anchor_prompt, original_prompt=original_prompt,
        anchor_binding=anchor_binding, budget_ms=max(1, remaining()),
        max_attempts=1, settle_ms=0, on_event=on_event,
        sleep=sleep, monotonic=monotonic)
    if not reloaded.get("ok"):
        return {"ok": False, "code": reloaded.get("code"), "details": {"stop": stop, "reload": reloaded}}
    seconds = uniform(10.0, 17.0)
    on_event("SYSTEM_WAIT", seconds=seconds)
    if seconds * 1000 >= remaining():
        sleep(remaining() / 1000)
        return {"ok": False, "code": recovery.RECOVERY_BUDGET_EXHAUSTED, "details": {"stop": stop, "waitSeconds": seconds}}
    sleep(seconds)
    final = recovery.chat_ready_snapshot(page, conversation_url, anchor_prompt,
                                        original_prompt=original_prompt, anchor_binding=anchor_binding)
    on_event("POST_WAIT_REPROOF", proof=final)
    return {"ok": bool(final.get("ok")), "code": final.get("code"),
            "details": {"stop": stop, "reload": reloaded, "waitSeconds": seconds, "proof": final}}
