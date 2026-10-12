"""Signal-first stage-one observation using the existing proven browser transport."""
import re
import browser_observer as observer
import browser_recovery as recovery
import browser_submit as submit
import reminder_policy
import transport_control
from postman.devspace.signal import read_event


def wait_for_signal(page, prompt, chat_url, binding, *, timeout_ms, interval_ms, count,
                    sleep, monotonic, persist):
    start = monotonic()
    control = transport_control.TransportControl(binding["requestId"], chat_url, start,
        timeout_ms, interval_ms, count, monotonic=monotonic)
    latest = prompt
    anchor = None

    def bell():
        event = read_event(binding)
        return {"ok": True, "code": "DEVSPACE_SIGNAL_RECEIVED", "details": event} if event else None

    def finish(result):
        control.cancel_slots("CANCELLED_RESULT_READY")
        control.transition(result["code"])
        persist(control.snapshot())
        result["details"].update(conversationRef=chat_url, **control.snapshot())
        return result

    while monotonic() < control.soft_deadline:
        received = bell()
        if received:
            return finish(received)
        observed = observer.observe_next_assistant(page, latest, chat_url,
            timeout_ms=min(3000, max(1, int((control.soft_deadline-monotonic())*1000))), stable_ms=500,
            poll_ms=250, anchor_binding=anchor, external_result_probe=bell,
            sleep=sleep, monotonic=monotonic)
        received = bell()  # Bell wins even if browser diagnostic raced it.
        if received:
            return finish(received)
        if observed.get("code") == "DEVSPACE_SIGNAL_RECEIVED":
            return finish(observed)
        if observed.get("ok"):
            text = observed.get("details", {}).get("assistantText", "")
            # Only minimal stage-one diagnostic; arbitrary DONE text does not prove a bell.
            diagnostic = re.search(r"\b(CAPABILITY[ _-]*UNAVAILABLE|BLOCKED)\b", text, re.I)
            if diagnostic:
                return finish({"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
                    "source": "text_fallback", "diagnostic": "CAPABILITY_UNAVAILABLE" if diagnostic[1].upper().startswith("CAPABILITY") else "BLOCKED",
                    "assistantText": text}})
        if observed.get("code") == observer.CHAT_CORRELATION_LOST:
            return finish({"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
                "source": "transport_diagnostic", "diagnostic": "BLOCKED", "assistantText": "Chat correlation lost; no resend."}})
        interrupted, evidence = observer.connection_interrupted(page)
        episode = control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, interrupted, evidence)
        if episode and control.begin_recovery(observer.ASSISTANT_CONNECTION_INTERRUPTED, episode):
            persist(control.snapshot())
            result = recovery.recover_interrupted_chat(page, chat_url, latest, original_prompt=prompt,
                anchor_binding=anchor, budget_ms=max(1, control.recovery_remaining_ms()), max_attempts=1,
                settle_ms=0, retry_delays_ms=(), sleep=sleep, monotonic=monotonic)
            control.finish_recovery(result.get("code"))
            persist(control.snapshot())
            continue
        due = next((slot for slot in control.slots if slot["status"] == "PENDING" and
                    control.elapsed() >= slot["scheduledElapsedMs"]), None)
        if due and not observed.get("ok") and not interrupted:
            # Existing intent/lineage and one-shot Send semantics, no competing controls.
            intent = transport_control.make_intent(page, binding["requestId"], chat_url, prompt, latest,
                                                   slot=due["slot"], anchor_binding=anchor)
            control.intent = intent
            persist(control.snapshot())
            if bell():
                continue
            sent = reminder_policy.submit_reminder(page, intent["exactPromptText"], chat_url,
                anchor_prompt=latest, anchor_binding=anchor, control_intent=intent,
                operation_deadline=control.soft_deadline, sleep=sleep, monotonic=monotonic)
            if sent.get("sendState") == submit.SEND_PROVEN_SENT:
                anchor = transport_control.confirmed_binding(page, intent, sent)
                latest = intent["exactPromptText"]
                control.slot_status(due["slot"], "SENT_CONFIRMED")
            elif sent.get("sendState") == submit.SEND_UNKNOWN:
                return finish({"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
                    "source": "transport_diagnostic", "diagnostic": "BLOCKED", "assistantText": "Reminder Send unknown; no resend."}})
        persist(control.snapshot())
        sleep(min(0.25, max(0, control.soft_deadline-monotonic())))
    received = bell()
    return finish(received or {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
        "source": "transport_diagnostic", "diagnostic": "BLOCKED", "assistantText": "Local signal wait timed out; no completion claimed."}})
