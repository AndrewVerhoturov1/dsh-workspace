"""Signal-first Devspace checks on the existing single browser transport."""
import re
import browser_observer as observer
import browser_recovery as recovery
import browser_submit as submit
import reminder_policy
import transport_control
from postman.devspace import controls, image_output
from postman.devspace.signal import read_event

DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000
DEFAULT_CHECK_COUNT = 3
STOP_OBSERVATION_MS = 10_000


def wait_for_bell_after_unknown_send(binding, *, timeout_ms, sleep, monotonic,
                                     conversation_ref=None, page=None, prompt=None,
                                     interval_ms=None, count=None, persist=None):
    """Signal-first wait after UNKNOWN Send; never repeat the original browser Send.

    Only an exact, same-chat user turn can authorize a *different* Host-owned
    controlId or observation of a completed assistant response. If the DOM is
    unprovable, this remains the old bell-only, read-only wait.
    """
    started_at = monotonic()
    deadline = started_at + timeout_ms / 1000.0
    observable = page is not None and bool(conversation_ref) and isinstance(prompt, str) and bool(prompt)
    current_prompt = prompt
    controls_allowed = observable
    next_probe = monotonic()
    final_text = ""
    final_since = None
    control_error = False

    def recover_late_chat_ref():
        nonlocal conversation_ref, observable, controls_allowed
        if conversation_ref or page is None or not isinstance(prompt, str):
            return
        # Never infer authority from a URL alone. The exact fresh REQ key must
        # occur in the Host-owned page's user turn, with no later user turn.
        if not prompt.startswith("POSTMAN_REQUEST_ID: " + binding["requestId"] + chr(10)):
            return
        try:
            url = str(page.url)
            if not submit.is_bound_chat_url(url):
                return
            turns, _ = observer.snapshot_turns(page)
            anchor = observer.find_user_anchor(turns, current_prompt)
            if anchor is None or any(
                    t.get("role") == "user" and t["index"] > anchor for t in turns):
                return
        except Exception:
            return  # UI read uncertainty never delays or suppresses a private bell.
        conversation_ref = url
        observable = True
        controls_allowed = True

    def bell():
        event = read_event(binding)
        if not event:
            return None
        if not conversation_ref:
            recover_late_chat_ref()  # one read-only last chance before returning bell
        return {"ok": True, "code": "DEVSPACE_SIGNAL_RECEIVED", "details": {
            **event, "conversationRef": conversation_ref, "sendState": "UNKNOWN"}}

    def text_result():
        marker = re.search(r"\b(CAPABILITY[ _-]*UNAVAILABLE|BLOCKED)\b", final_text, re.I)
        outcome = ("CAPABILITY_UNAVAILABLE" if marker[1].upper().startswith("CAPABILITY")
                   else "BLOCKED") if marker else "UNKNOWN"
        return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
            "source": "text_fallback", "diagnostic": outcome, "assistantText": final_text,
            "conversationRef": conversation_ref, "sendState": "UNKNOWN",
            "message": "Correlated assistant response without local bell."}}

    while True:
        received = bell()
        if received:
            return received
        now = monotonic()
        # Bell gets a short grace period after a correlated final text.
        if final_since is not None and now - final_since >= 12:
            return text_result()
        remaining = deadline - now
        if remaining <= 0:
            if final_text:
                return text_result()
            return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
                "source": "transport_diagnostic", "diagnostic": "BLOCKED", "sendState": "UNKNOWN",
                "conversationRef": conversation_ref, "assistantText": "",
                "message": "Unproven browser Send; no local bell before deadline. No resend.",
                **({"controlDiagnostic": "CONTROL_PROOF_UNKNOWN"} if control_error else {})}}

        if not observable and now >= next_probe:
            next_probe = now + 1.0
            recover_late_chat_ref()
        if observable and now >= next_probe:
            next_probe = now + 1.0
            # URL plus exact rendered turn/request-key and no later user turn
            # are prerequisites. An UNKNOWN Send by itself grants no UI control.
            correlated = False
            try:
                if str(page.url) == conversation_ref:
                    turns, _ = observer.snapshot_turns(page)
                    anchor = observer.find_user_anchor(turns, current_prompt)
                    correlated = (isinstance(prompt, str) and prompt.startswith(
                        'POSTMAN_REQUEST_ID: ' + binding['requestId'] + '\n')
                        and anchor is not None and not any(
                            t.get("role") == "user" and t["index"] > anchor for t in turns))
            except Exception:
                correlated = False

            if correlated:
                image = image_output.observe_owned_image(page, current_prompt, conversation_ref, binding)
                if image:
                    return image
                # The original browser click may be UNKNOWN, but an exact
                # rendered REQ user turn in this same chat proves which task
                # is running. Promote its observer to the normal timed policy
                # without repeating the original Send or changing its proof.
                # A different/newer user turn or unproved REQ stays bell-only.
                if (persist is not None and interval_ms is not None and count is not None
                        and isinstance(prompt, str) and prompt.startswith(
                            'POSTMAN_REQUEST_ID: ' + binding['requestId'] + '\n')
                        and current_prompt == prompt):
                    outcome = wait_for_signal(page, prompt, conversation_ref, binding,
                        timeout_ms=timeout_ms, interval_ms=interval_ms, count=count,
                        sleep=sleep, monotonic=monotonic, persist=persist,
                        started_at=started_at)
                    outcome.setdefault('details', {})['sendState'] = 'UNKNOWN'
                    return outcome
                if controls_allowed:
                    try:
                        action = controls.process_one(page, current_prompt, conversation_ref, binding,
                            activity=lambda p, text, url: activity_snapshot(p, text, url),
                            stop_control=stop_control, sleep=sleep, monotonic=monotonic)
                    except Exception:
                        # Preserve bell monitoring; never retry a possibly acted
                        # control after an unproved local/browser outcome.
                        controls_allowed = False
                        control_error = True
                        action = None
                    received = bell()
                    if received:
                        return received
                    if action and action.get("sendUnknown"):
                        controls_allowed = False
                    if action and action.get("newPrompt"):
                        current_prompt = action["newPrompt"]
                        final_since = None
                        final_text = ""
                    if action and action.get("kind") == "stop":
                        return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
                            "source": "transport_diagnostic", "diagnostic": "PARTIAL",
                            "conversationRef": conversation_ref, "sendState": "UNKNOWN",
                            "assistantText": "", "message": "Leader requested Stop; browser UI: " +
                            action.get("status", "UNKNOWN") + ". Local DevSpace tools may continue."}}

                if final_since is None:
                    try:
                        observed = observer.observe_next_assistant(page, current_prompt, conversation_ref,
                            timeout_ms=min(400, max(1, int((deadline-monotonic())*1000))),
                            stable_ms=250, poll_ms=100, external_result_probe=bell,
                            sleep=sleep, monotonic=monotonic)
                        if observed.get("code") == "DEVSPACE_SIGNAL_RECEIVED":
                            return observed
                        candidate = observed.get("details", {}).get("assistantText", "")
                        if observed.get("ok") and isinstance(candidate, str) and candidate:
                            final_text = candidate
                            final_since = monotonic()
                    except Exception:
                        pass  # Correlation or observer uncertainty never suppresses a late bell.

        received = bell()
        if received:
            return received
        sleep(min(0.25, max(0.0, deadline-monotonic())))

# Read UI state only in the correlated turn, never treat assistant prose as proof.
# A tool card with an unknown state is not proof that a local operation is idle.
_ACTIVITY_JS = r"""
(node) => {
  const scope = node.closest('[data-turn-key], [data-content-search-turn-key], [data-testid^="conversation-turn-"]') || node;
  const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const prose = el => !!el.closest('[data-markdown-text-style="assistant-message"], .markdown, [data-testid="assistant-message"], [data-user-message-bubble]');
  const tools = [...scope.querySelectorAll('[data-tool-name], [data-testid*="tool"], [data-testid*="devspace"], [data-tool-call-id]')].filter(el => visible(el) && !prose(el));
  const statuses = [...scope.querySelectorAll('[role="status"], [aria-live], [data-streaming-response-status], [data-testid*="activity"]')].filter(el => visible(el) && !prose(el));
  const active = /^(running|pending|executing|in-progress|loading|started)$/i;
  const finished = /^(completed|complete|done|success|succeeded|failed|cancelled|canceled)$/i;
  const state = el => el.getAttribute('data-state') || el.getAttribute('data-status') || el.getAttribute('data-tool-state') || '';
  const operations = statuses.filter(el => /devspace|read_file|write_file|open_workspace|bash|shell|тест|чтен|запис|выполня|calling|executing|running/i.test(el.innerText || el.getAttribute('aria-label') || ''));
  const activeTool = tools.some(el => active.test(state(el)) || el.getAttribute('aria-busy') === 'true') || operations.some(el => !finished.test(state(el)));
  const unknownTool = tools.some(el => !finished.test(state(el)) && !active.test(state(el)) && el.getAttribute('aria-busy') !== 'true');
  const thinking = [...scope.querySelectorAll('[data-testid*="thinking"], [data-testid*="reasoning"], [data-state="thinking"], [data-stream-phase="analysis"]')].some(el => visible(el) && !prose(el));
  return {scopeConnected: scope.isConnected, activeTool, unknownTool, thinking, toolCount: tools.length,
          operationLabels: operations.slice(0, 4).map(el => (el.innerText || el.getAttribute('aria-label') || '').slice(0, 200))};
}
"""


def stop_control(page):
    """Unlike generation_active, failures are UNKNOWN, not affirmative absence."""
    try:
        # Playwright's CSS union deduplicates a single Stop button matching
        # both data-testid and aria-label. An unrestricted per-selector scan
        # mistakenly counts that *one* button multiple times as ambiguous.
        matched = page.locator(", ".join(observer.GENERATION_CONTROL_SELECTORS))
        visible = [matched.nth(i) for i in range(matched.count())
                   if matched.nth(i).is_visible()]
        if len(visible) > 1:
            return "UNKNOWN", None  # Two different visible Stop buttons.
        # Some ChatGPT builds have only an accessible-name Stop button.
        semantic = page.get_by_role("button", name=re.compile(
            r"^(stop|stop generating|pause|pause generation|остановить|остановить создание|приостановить)$", re.I))
        semantic_visible = [semantic.nth(i) for i in range(semantic.count())
                            if semantic.nth(i).is_visible()]
        if len(semantic_visible) > 1:
            return "UNKNOWN", None
        if len(visible) == 1:
            # A separate semantic-only Stop is a second visible control, not
            # another alias of the known one; never guess which to click.
            if semantic_visible and not semantic_visible[0].evaluate(
                    "(node, selectors) => node.matches(selectors)",
                    ", ".join(observer.GENERATION_CONTROL_SELECTORS)):
                return "UNKNOWN", None
            return ("PRESENT", visible[0]) if visible[0].is_enabled() else ("UNKNOWN", None)
        if len(semantic_visible) == 1:
            return ("PRESENT", semantic_visible[0]) if semantic_visible[0].is_enabled() else ("UNKNOWN", None)
        return "ABSENT", None
    except Exception:
        return "UNKNOWN", None


def activity_snapshot(page, prompt, chat_url, *, anchor_binding=None):
    evidence = {"state": "UNKNOWN", "reason": "activity_unproved"}
    if str(getattr(page, "url", "")) != chat_url:
        return {**evidence, "reason": "conversation_changed"}
    turns, selector = observer.snapshot_turns(page)
    anchor = observer.find_user_anchor(turns, prompt, anchor_binding=anchor_binding)
    if anchor is None or any(t.get("role") == "user" and t["index"] > anchor for t in turns):
        return {**evidence, "reason": "task_lineage_unproved"}
    related = [t for t in turns if t["index"] >= anchor]
    try:
        # Modern wrappers contain the tool UI; legacy layouts use the last correlated node.
        node = related[-1]
        ui = page.locator(selector).nth(node.get("nodeIndex", node["index"])).evaluate(_ACTIVITY_JS)
        if not isinstance(ui, dict) or not ui.get("scopeConnected"):
            return evidence
    except Exception:
        return evidence
    stop, _ = stop_control(page)
    evidence.update(ui, stopState=stop)
    if ui.get("activeTool"):
        return {**evidence, "state": "ACTIVE_TOOL", "reason": "visible_operation_active"}
    if ui.get("unknownTool"):
        return {**evidence, "reason": "tool_state_unproved"}
    if stop == "PRESENT" and ui.get("thinking"):
        return {**evidence, "state": "SAFE_GENERATION", "reason": "thinking_and_no_unresolved_tool"}
    if stop == "ABSENT":
        return {**evidence, "state": "IDLE", "reason": "no_generation_control"}
    return {**evidence, "reason": "generation_safety_unproved"}


def wait_for_signal(page, prompt, chat_url, binding, *, timeout_ms, interval_ms, count,
                    sleep, monotonic, persist, started_at=None):
    start = monotonic() if started_at is None else started_at
    control = transport_control.TransportControl(binding["requestId"], chat_url, start,
        timeout_ms, interval_ms, count, monotonic=monotonic)
    latest = prompt
    anchor = None
    latest_text = ""

    def bell():
        event = read_event(binding)
        return {"ok": True, "code": "DEVSPACE_SIGNAL_RECEIVED", "details": event} if event else None

    def finish(result):
        completed = (result["code"] != "DEVSPACE_DIAGNOSTIC" or
                     result.get("details", {}).get("source") == "text_fallback")
        if completed:
            control.cancel_slots("CANCELLED_RESULT_READY")
        else:
            for slot in control.slots:
                if slot["status"] == "ATTEMPTING":
                    control.slot_status(slot["slot"], "BLOCKED_UNKNOWN")
        control.transition(result["code"])
        persist(control.snapshot())
        result["details"].update(conversationRef=chat_url, **control.snapshot())
        return result

    def diagnostic(message, *, source="transport_diagnostic", outcome="BLOCKED"):
        return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
            "source": source, "diagnostic": outcome, "assistantText": latest_text,
            "message": message}}

    def owned_turn():
        # Generation/activity markers are not ownership proof. Verify the exact
        # original REQ, current last user turn and unchanged user-turn lineage.
        if (str(getattr(page, "url", "")) != chat_url or not submit.is_bound_chat_url(chat_url)
                or submit.request_key_line_from_prompt(prompt) !=
                "POSTMAN_REQUEST_ID: " + binding["requestId"]):
            return False
        try:
            turns, _ = observer.snapshot_turns(page)
            original = observer.find_user_anchor(turns, prompt)
            current = observer.find_user_anchor(turns, latest, anchor_binding=anchor)
            if (original is None or current is None or original > current or
                    any(t.get("role") == "user" and t["index"] > current for t in turns)):
                return False
            if (control.intent and control.intent["exactPromptText"] != latest
                    and any(s["status"] == "ATTEMPTING" for s in control.slots)):
                relation = control.intent["expectedUserTurnRelation"]
                users = [t for t in turns if t.get("role") == "user"]
                if (len(users) != relation["userOrdinal"] or
                        [submit.prompt_sha256(t["text"]) for t in users] != relation["precedingUserHashes"]):
                    return False
            return True
        except Exception:
            return False

    completion_result = None
    stop_clicked = False
    partial_before_stop = ""

    def reproof_result(stage):
        # The existing observer correlates the result with this REQ's exact
        # assistant turn. A stopped partial answer is not a completed result:
        # require positive structural completion, not mere Stop disappearance
        # or the observer's inactive/stable fallback.
        nonlocal latest_text, partial_before_stop
        received = bell()
        if received:
            return received
        if not owned_turn():
            return diagnostic("REQ lineage changed during " + stage + "; no continuation.")
        fresh = observer.observe_next_assistant(page, latest, chat_url,
            timeout_ms=1, stable_ms=0, poll_ms=100, anchor_binding=anchor,
            external_result_probe=bell, sleep=sleep, monotonic=monotonic)
        if fresh.get("code") == "DEVSPACE_SIGNAL_RECEIVED":
            return fresh
        if fresh.get("code") == observer.CHAT_CORRELATION_LOST:
            return diagnostic("Chat correlation lost during " + stage + "; no continuation.")
        details = fresh.get("details", {})
        text = details.get("assistantText", "")
        if isinstance(text, str) and text.strip():
            latest_text = text
            if not stop_clicked and not fresh.get("ok"):
                partial_before_stop = text
        phase = details.get("answerPhase", {})
        explicit_completion = (fresh.get("ok") and fresh.get("code") == observer.ASSISTANT_TURN_COMPLETED
            and isinstance(phase, dict) and phase.get("phase") == observer.FINAL_ANSWER_COMPLETED
            and phase.get("phaseSource") == "response_actions_and_inactive_control"
            and phase.get("finalUnitProven") is True
            and phase.get("completionControlFound") is True)
        if explicit_completion and isinstance(text, str) and text.strip():
            if stop_clicked and partial_before_stop and text == partial_before_stop:
                # Stop can expose actions for the same truncated text. Do not
                # promote the pre-Stop partial into a terminal result.
                return None
            marker = re.search(r"\b(CAPABILITY[ _-]*UNAVAILABLE|BLOCKED)\b", text, re.I)
            outcome = ("CAPABILITY_UNAVAILABLE" if marker[1].upper().startswith("CAPABILITY")
                       else "BLOCKED") if marker else "UNKNOWN"
            return diagnostic("Completed REQ-bound response during " + stage + ".",
                              source="text_fallback", outcome=outcome)
        return None

    def continuation_phase():
        nonlocal completion_result
        # Pre-insert and pre-click guards in submit_reminder call this after
        # proving the exact composer and before the sole Send mutation.
        if bell():
            return {"phase": observer.UNKNOWN, "reason": "external_action_not_safe", "bellReceived": True}
        stop, _ = stop_control(page)
        if stop != "ABSENT" or not owned_turn():
            return {"phase": observer.UNKNOWN, "reason": "external_action_not_safe", "stopState": stop}
        reproved = reproof_result("continuation Send")
        if reproved:
            if reproved.get("code") == "DEVSPACE_SIGNAL_RECEIVED":
                return {"phase": observer.UNKNOWN, "reason": "external_action_not_safe", "bellReceived": True}
            if reproved.get("details", {}).get("source") == "text_fallback":
                completion_result = reproved
                return {"phase": observer.FINAL_ANSWER_COMPLETED, "finalAnswerLatched": True}
            return {"phase": observer.UNKNOWN, "reason": "external_action_not_safe"}
        return {"phase": observer.WORKING, "stopState": stop}

    while monotonic() < control.soft_deadline:
        received = bell()
        if received:
            return finish(received)
        acted = controls.process_one(page, latest, chat_url, binding,
            activity=lambda p, prompt, url: activity_snapshot(p, prompt, url, anchor_binding=anchor),
            stop_control=stop_control, sleep=sleep, monotonic=monotonic)
        if bell():
            return finish(bell())
        if acted and acted.get('kind') == 'stop':
            return finish(diagnostic('Stop requested by Leader. UI: ' + acted['status'] +
                '. Any local DevSpace commands may still be running.', outcome='PARTIAL'))
        if acted and acted.get('sendUnknown'):
            received = wait_for_bell_after_unknown_send(binding,
                timeout_ms=max(1, int((control.soft_deadline-monotonic())*1000)),
                sleep=sleep, monotonic=monotonic, conversation_ref=chat_url)
            return finish(received)
        if acted and acted.get('newPrompt'):
            latest = acted['newPrompt']
            anchor = None
            latest_text = ''
            for slot in control.slots:
                if slot['status'] == 'PENDING':
                    slot['scheduledElapsedMs'] = control.elapsed() + interval_ms
            persist(control.snapshot())
            continue
        observed = observer.observe_next_assistant(page, latest, chat_url,
            timeout_ms=min(3000, max(1, int((control.soft_deadline-monotonic())*1000))), stable_ms=500,
            poll_ms=250, anchor_binding=anchor, external_result_probe=bell,
            sleep=sleep, monotonic=monotonic)
        received = bell()
        if received:
            return finish(received)
        if observed.get("code") == "DEVSPACE_SIGNAL_RECEIVED":
            return finish(observed)
        # The same observer may see one generated image instead of a text
        # response. Never claim GPT Image from an unrelated assistant/gallery.
        image = image_output.observe_owned_image(page, latest, chat_url, binding)
        if image:
            return finish(image)
        text = observed.get("details", {}).get("assistantText", "")
        if text:
            latest_text = text
        if observed.get("ok"):
            # Completed arbitrary text is deliverable evidence, not engineering PASS.
            marker = re.search(r"\b(CAPABILITY[ _-]*UNAVAILABLE|BLOCKED)\b", latest_text, re.I)
            outcome = ("CAPABILITY_UNAVAILABLE" if marker[1].upper().startswith("CAPABILITY") else "BLOCKED") if marker else "UNKNOWN"
            return finish(diagnostic("Completed response without local signal.", source="text_fallback", outcome=outcome))
        if observed.get("code") == observer.CHAT_CORRELATION_LOST:
            return finish(diagnostic("Chat correlation lost; no resend."))
        interrupted, evidence = observer.connection_interrupted(page)
        episode = control.candidate(observer.ASSISTANT_CONNECTION_INTERRUPTED, interrupted, evidence)
        if episode and control.begin_recovery(observer.ASSISTANT_CONNECTION_INTERRUPTED, episode):
            if bell():
                continue
            persist(control.snapshot())
            result = recovery.recover_interrupted_chat(page, chat_url, latest, original_prompt=prompt,
                anchor_binding=anchor, budget_ms=max(1, control.recovery_remaining_ms()), max_attempts=1,
                settle_ms=0, retry_delays_ms=(), sleep=sleep, monotonic=monotonic,
                external_result_probe=bell)
            if bell():
                continue
            control.finish_recovery(result.get("code"))
            persist(control.snapshot())
            if not result.get("ok"):
                return finish(diagnostic("Same-chat recovery not proven; no continuation."))
            continue
        due = next((slot for slot in control.slots if slot["status"] == "PENDING" and
                    control.elapsed() >= slot["scheduledElapsedMs"]), None)
        if due:
            # Activity is diagnostic, never a reason to consume or defer a slot.
            state = activity_snapshot(page, latest, chat_url, anchor_binding=anchor)
            control.event("DEVSPACE_CHECK", activity=state, slot=due["slot"])
            if bell():
                continue
            if not owned_turn():
                return finish(diagnostic("Original REQ/current user turn or conversation not proven; no Stop or Send."))
            try:
                intent = transport_control.make_intent(page, binding["requestId"], chat_url, prompt, latest,
                                                       slot=due["slot"], anchor_binding=anchor)
            except ValueError:
                return finish(diagnostic("Exact task lineage not proven; no Stop or Send."))
            # One random selection per durable slot. Pin the final bytes/hash,
            # including bell and no-replay context, before any browser mutation.
            intent["controlId"] = binding["requestId"] + ":reminder:" + str(due["slot"])
            intent["exactPromptText"] += (
                " Не начинай исходную задачу заново, не повторяй уже выполненные действия. "
                "Если результат готов, используй ранее предоставленный local bell; "
                "не отправляй исходный запрос повторно.")
            intent["promptSha256"] = submit.prompt_sha256(intent["exactPromptText"])
            control.intent = intent
            control.slot_status(due["slot"], "ATTEMPTING", activity=state,
                                controlId=intent["controlId"], templateId=intent["templateId"],
                                promptSha256=intent["promptSha256"])
            persist(control.snapshot())
            if bell():
                continue

            # Reserve one original 10-second window for transient UNKNOWN,
            # the one permitted Stop click, and read-only composer readiness.
            # Never restart that window or extend the original task deadline.
            stop_clicked = False
            partial_before_stop = ""
            completion_result = None
            reproved = reproof_result("before Stop")
            if reproved:
                return finish(bell() or reproved)
            stop_deadline = min(monotonic() + STOP_OBSERVATION_MS / 1000, control.soft_deadline)
            ready = False
            post = {}
            last_stop = "UNKNOWN"
            while monotonic() < stop_deadline:
                if bell():
                    break
                reproved = reproof_result("after Stop" if stop_clicked else "before Stop")
                if reproved:
                    return finish(bell() or reproved)
                if monotonic() >= stop_deadline:
                    break
                last_stop, button = stop_control(page)
                if last_stop == "PRESENT" and not stop_clicked and button is not None:
                    if bell():
                        break
                    if not owned_turn():
                        return finish(diagnostic("Stop ownership not proven before click."))
                    # A transient or duplicated control is not proof; keep
                    # observing rather than risking a wrong/second click.
                    last_stop, button = stop_control(page)
                    if last_stop == "PRESENT" and button is not None:
                        reproved = reproof_result("immediately before Stop")
                        if reproved:
                            return finish(bell() or reproved)
                        if monotonic() >= stop_deadline:
                            break
                        control.event("STOP_REQUESTED", slot=due["slot"], controlId=intent["controlId"])
                        persist(control.snapshot())
                        stop_clicked = True
                        try:
                            button.click(timeout=max(1, min(1000, int((stop_deadline-monotonic())*1000))))
                        except Exception as exc:
                            control.event("STOP_CLICK_UNKNOWN", slot=due["slot"], reason=type(exc).__name__)
                            persist(control.snapshot())
                        continue  # Never issue a second Stop regardless of click outcome.
                post = {"stopState": last_stop}
                if last_stop == "ABSENT":
                    hydration = recovery.chat_ready_snapshot(page, chat_url, latest,
                        original_prompt=prompt, anchor_binding=anchor)
                    post["hydration"] = hydration.get("details", {})
                    # Composer is ready before insertion; Send is proved only
                    # after text is inserted by submit_reminder.
                    ready = bool(hydration.get("ok") and owned_turn())
                    if ready:
                        break
                sleep(min(0.25, max(0, stop_deadline-monotonic())))
            if bell():
                continue
            if not ready and last_stop == "UNKNOWN":
                control.event("STOP_UNPROVED", slot=due["slot"])
            control.event("STOP_OBSERVED", slot=due["slot"], clicked=stop_clicked, ready=bool(ready), proof=post)
            persist(control.snapshot())
            if not ready:
                return finish(diagnostic("Stop disappearance/composer readiness not proven within bounded observation; no Send."))
            if not stop_clicked:
                control.event("STOP_ABSENT_DIRECT", slot=due["slot"])
                persist(control.snapshot())
            reproved = reproof_result("before composer insertion")
            if reproved:
                return finish(bell() or reproved)
            if bell() or not owned_turn():
                if bell():
                    continue
                return finish(diagnostic("REQ lineage changed before Send; no continuation."))
            sent = reminder_policy.submit_reminder(page, intent["exactPromptText"], chat_url,
                anchor_prompt=latest, anchor_binding=anchor, control_intent=intent,
                operation_deadline=control.soft_deadline, sleep=sleep, monotonic=monotonic,
                phase_probe=continuation_phase)
            if completion_result is not None and sent.get("sendState") != submit.SEND_PROVEN_SENT:
                # The real Send guard has suppressed the draft (and attempts to
                # clear it after insertion). Deliver the completed REQ result.
                return finish(bell() or completion_result)
            if sent.get("sendState") == submit.SEND_PROVEN_SENT:
                try:
                    anchor = transport_control.confirmed_binding(page, intent, sent)
                except ValueError:
                    control.event("CONTINUATION_PROOF_UNKNOWN", slot=due["slot"], proof=sent)
                    return finish(diagnostic("Exact reminder user-turn confirmation lost; no resend."))
                latest = intent["exactPromptText"]
                control.slot_status(due["slot"], "SENT_CONFIRMED")
                # Reschedule only proven reminders, relative to the confirmation.
                pending = [s for s in control.slots if s["status"] == "PENDING"]
                for i, slot in enumerate(pending, 1):
                    slot["scheduledElapsedMs"] = control.elapsed() + i * interval_ms
                persist(control.snapshot())
            else:
                control.event("CONTINUATION_NOT_CONFIRMED", slot=due["slot"],
                              sendState=sent.get("sendState"), details=sent.get("details", {}))
                persist(control.snapshot())
                if bell():
                    continue
                return finish(diagnostic("Continuation SEND_UNKNOWN; no resend." if sent.get("sendState") == submit.SEND_UNKNOWN
                                         else "Continuation unready; no Send confirmed."))
        persist(control.snapshot())
        sleep(min(0.25, max(0, control.soft_deadline-monotonic())))
    received = bell()
    return finish(received or diagnostic("Local signal wait timed out; no completion claimed.",
        outcome="PARTIAL" if latest_text else "BLOCKED"))
