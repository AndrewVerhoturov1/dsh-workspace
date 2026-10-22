"""Signal-first Devspace checks on the existing single browser transport."""
import re
import browser_observer as observer
import browser_recovery as recovery
import browser_submit as submit
import reminder_policy
import transport_control
from postman.devspace import controls, image_output
from postman.devspace.signal import read_event
from postman.devspace.publication import bound_prompt

DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000
DEFAULT_CHECK_COUNT = 3
STOP_OBSERVATION_MS = 10_000


def wait_for_image(page, prompt, chat_url, binding, *, timeout_ms, sleep, monotonic,
                   send_state="PROVEN_SENT"):
    """Read-only first image result. Never repeat Send after UNKNOWN."""
    import browser_submit as submit

    deadline = monotonic() + timeout_ms / 1000.0
    generated = False
    download_diagnostic = {}

    def blocked(reason):
        return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
            "source": "transport_diagnostic", "diagnostic": "UNKNOWN",
            "conversationRef": chat_url, "sendState": send_state,
            "generationState": "CONFIRMED" if generated else "UNPROVEN",
            "saveState": download_diagnostic.get("saveState", "NOT_ATTEMPTED" if generated else "NOT_SAVED"),
            "downloadPhase": download_diagnostic.get("downloadPhase", "NOT_STARTED"),
            "downloadState": download_diagnostic.get("downloadState", "NOT_ATTEMPTED"),
            "downloadAttempted": download_diagnostic.get("downloadAttempted", False),
            "downloadError": download_diagnostic.get("downloadError", "NONE"),
            **({"downloadExceptionType": download_diagnostic["downloadExceptionType"]}
               if "downloadExceptionType" in download_diagnostic else {}),
            "deliveryState": "UNAVAILABLE", "assistantText": "", "message": reason}}

    if binding.get("imageMode") is not True or not bound_prompt(binding, prompt):
        return blocked("Image publication binding not proved.")
    while monotonic() < deadline:
        if controls.revoked(binding):
            return blocked("Request revoked.")
        current = str(getattr(page, "url", "") or "")
        if chat_url and current != chat_url:
            return blocked("Owned chat changed.")
        if not chat_url and submit.is_bound_chat_url(current):
            try:
                turns, _ = observer.snapshot_turns(page, image_mode=True, expected_prompt=prompt)
                anchor = observer.find_user_anchor(turns, prompt)
                if anchor is not None and not any(
                        t.get("role") == "user" and t["index"] > anchor for t in turns):
                    chat_url = current
            except Exception:
                pass
        if chat_url:
            result = observer.observe_next_assistant(page, prompt, chat_url,
                image_mode=True, timeout_ms=min(1500, max(1, int((deadline-monotonic())*1000))),
                stable_ms=500, poll_ms=100, sleep=sleep, monotonic=monotonic)
            if result.get('ok') and result.get('details', {}).get('assistantImageCount') == 1:
                generated = True
                image = image_output.observe_owned_image(
                    page, prompt, chat_url, binding, diagnostic=download_diagnostic)
                if image:
                    image['details'].update(sendState=send_state, conversationRef=chat_url)
                    return image
                return blocked("Owned image completed but original download/save was not proved; no retry or resend.")
            if result.get('code') == observer.CHAT_CORRELATION_LOST:
                return blocked('Assistant image correlation lost.')
        else:
            sleep(min(0.25, max(0.0, deadline-monotonic())))
    return blocked("No completed owned image saved; no resend.")


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
        # Never infer authority from a chat URL alone. The exact Host-bound
        # task key must occur in its user turn, with no later user turn.
        if not bound_prompt(binding, prompt):
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
        outcome = "UNKNOWN"
        return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
            "source": "text_fallback", "diagnostic": outcome, "assistantText": final_text,
            "conversationRef": conversation_ref, "sendState": "UNKNOWN",
            "message": "Correlated assistant response without local bell."}}

    while True:
        received = bell()
        if received:
            return received
        if controls.revoked(binding):
            return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
                "source": "transport_diagnostic", "diagnostic": "REVOKED",
                "conversationRef": conversation_ref, "sendState": "UNKNOWN",
                "message": "Host withdrew this request; local DevSpace tools may continue."}}
        if (observable and str(getattr(page, "url", "")) == conversation_ref
                and controls.newer_user_turn(page, current_prompt)):
            return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
                "source": "transport_diagnostic", "diagnostic": "UNKNOWN", "sendState": "UNKNOWN",
                "conversationRef": conversation_ref, "assistantText": "", "supersededByUserTurn": True,
                "message": "A newer user assignment owns this chat; the old request cannot Stop or Send."}}
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
                    correlated = (isinstance(prompt, str) and bound_prompt(binding, prompt)
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
                        and isinstance(prompt, str) and bound_prompt(binding, prompt)
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
    superseded_by_user_turn = False

    def bell():
        event = read_event(binding)
        return {"ok": True, "code": "DEVSPACE_SIGNAL_RECEIVED", "details": event} if event else None

    def finish(result):
        if superseded_by_user_turn:
            result["details"]["supersededByUserTurn"] = True
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
        nonlocal superseded_by_user_turn
        # The Host binding owns this exact saved chat. Visible old turns are
        # optional correlation evidence. Positive evidence of a newer user turn
        # fences this old observer even if that newer turn is later virtualized.
        superseded_by_user_turn = (superseded_by_user_turn or
                                   controls.newer_user_turn(page, latest))
        return (not controls.revoked(binding) and str(getattr(page, "url", "")) == chat_url
                and not superseded_by_user_turn and submit.is_bound_chat_url(chat_url) and
                bound_prompt(binding, prompt))

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
            return None  # Unreadable old history is not loss of Host chat ownership.
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
            outcome = "UNKNOWN"
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
        if controls.revoked(binding):
            return finish(diagnostic("Host withdrew this request; local DevSpace tools may continue.",
                                     outcome="REVOKED"))
        if not owned_turn() and superseded_by_user_turn:
            return finish(diagnostic("A newer user assignment owns this chat; old request cannot Stop or Send.",
                                     outcome="UNKNOWN"))
        acted = controls.process_one(page, latest, chat_url, binding,
            activity=lambda p, prompt, url: activity_snapshot(p, prompt, url, anchor_binding=anchor),
            stop_control=stop_control, sleep=sleep, monotonic=monotonic)
        if bell():
            return finish(bell())
        if acted and acted.get("supersededByUserTurn"):
            superseded_by_user_turn = True
            return finish(diagnostic("A newer user assignment superseded this old control; no Stop or Send.",
                                     outcome="UNKNOWN"))
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
            outcome = "UNKNOWN"
            return finish(diagnostic("Completed response without local signal.", source="text_fallback", outcome=outcome))
        if observed.get("code") == observer.CHAT_CORRELATION_LOST and not owned_turn():
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
                intent = transport_control.make_intent(page, binding["requestId"], chat_url, latest, latest,
                                                       slot=due["slot"], anchor_binding=anchor)
            except Exception:
                # Retain a distinct durable control even if ChatGPT virtualized
                # old turns. The existing one-shot submit proves the new draft
                # and its newly appended user turn independently.
                intent = {"requestId": binding["requestId"], "conversationUrl": chat_url,
                    "slot": due["slot"], "ownedConversationOnly": True,
                    **transport_control.choose_continuation()}
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

            # Ten seconds is an observation checkpoint, not a terminal refusal.
            # Keep this single pinned continuation until the real composer is
            # ready or the task deadline/ownership changes. Never repeat Stop.
            stop_clicked = False
            partial_before_stop = ""
            completion_result = None
            reproved = reproof_result("before Stop")
            if reproved:
                return finish(bell() or reproved)
            stop_deadline = control.soft_deadline
            next_readiness_checkpoint = monotonic() + STOP_OBSERVATION_MS / 1000
            ready = False
            post = {}
            last_stop = "UNKNOWN"
            while monotonic() < stop_deadline:
                if bell():
                    break
                if controls.revoked(binding):
                    return finish(diagnostic("Host withdrew this request; local DevSpace tools may continue.",
                                             outcome="REVOKED"))
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
                        if controls.revoked(binding):
                            return finish(diagnostic("Host withdrew this request before Stop; local DevSpace tools may continue.",
                                                     outcome="REVOKED"))
                        if str(getattr(page, "url", "")) != chat_url:
                            return finish(diagnostic("Owned conversation changed before Stop; no click."))
                        if bell():
                            break
                        if not owned_turn():
                            return finish(diagnostic("Request no longer owns the active user assignment before Stop; no click.",
                                                     outcome="UNKNOWN"))
                        stop_clicked = True
                        try:
                            button.click(timeout=max(1, min(1000, int((stop_deadline-monotonic())*1000))))
                        except Exception as exc:
                            control.event("STOP_CLICK_UNKNOWN", slot=due["slot"], reason=type(exc).__name__)
                            persist(control.snapshot())
                        continue  # Never issue a second Stop regardless of click outcome.
                post = {"stopState": last_stop}
                if last_stop == "ABSENT":
                    hydration = submit.prepare_existing_chat(page, chat_url, navigate=False, timeout_ms=0)
                    post["hydration"] = hydration.get("details", {})
                    # Composer is ready before insertion; Send is proved only
                    # after text is inserted by submit_reminder.
                    ready = bool(hydration.get("ok") and owned_turn())
                    if ready:
                        break
                if monotonic() >= next_readiness_checkpoint:
                    control.event("CONTINUATION_WAITING_COMPOSER", slot=due["slot"],
                                  clicked=stop_clicked, stopState=last_stop,
                                  localOperationsMayContinue=stop_clicked)
                    persist(control.snapshot())
                    next_readiness_checkpoint = monotonic() + STOP_OBSERVATION_MS / 1000
                sleep(min(0.25, max(0, stop_deadline-monotonic())))
            if bell():
                continue
            if not ready and last_stop == "UNKNOWN":
                control.event("STOP_UNPROVED", slot=due["slot"])
            control.event("STOP_OBSERVED", slot=due["slot"], clicked=stop_clicked, ready=bool(ready), proof=post)
            persist(control.snapshot())
            if not ready:
                return finish(diagnostic("Stop disappearance/composer readiness not proven before task deadline; no Send."))
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
            if intent.get("ownedConversationOnly"):
                previous_guard = getattr(page, "_postman_action_guard", None)
                def allowed():
                    phase = continuation_phase()
                    return (owned_turn() and (previous_guard is None or previous_guard()) and
                        phase.get("phase") == observer.WORKING and not phase.get("bellReceived"))
                page._postman_action_guard = allowed
                try:
                    sent = submit.submit_existing_prompt(page, intent["exactPromptText"], chat_url,
                        navigate=False, timeout_ms=min(5000, max(1, int((control.soft_deadline-monotonic())*1000))))
                finally:
                    page._postman_action_guard = previous_guard
            else:
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
                    anchor = (None if intent.get("ownedConversationOnly") else
                              transport_control.confirmed_binding(page, intent, sent))
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
