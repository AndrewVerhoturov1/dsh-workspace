"""One request-stage's serialized transport control, slots and bounded journal."""
from __future__ import annotations

import time
import copy

import browser_observer as observer
import browser_submit as submit
from continuation_prompts import choose_continuation

RECOVERY_GRACE_MS = 45_000
RECOVERY_CYCLE_MS = 180_000
JOURNAL_LIMIT = 256


class TransportControl:
    def __init__(self, request_id, conversation_url, started_at, timeout_ms,
                 interval_ms, count, *, monotonic=time.monotonic):
        self.request_id = request_id
        self.conversation_url = conversation_url
        self.started_at = started_at
        self.soft_deadline = started_at + timeout_ms / 1000
        self.clock = monotonic
        self.phase = "WORKING"
        self.active = None
        self.slots = [{"slot": i, "scheduledElapsedMs": i * interval_ms, "status": "PENDING"}
                      for i in range(1, count + 1)]
        self.journal = []
        self.sequence = 0
        self.dropped = 0
        self.diagnostics = {}
        self.banners = {}
        self.intent = None
        self.event("STAGE_STARTED", softDeadlineElapsedMs=timeout_ms,
                   recoveryGraceMs=RECOVERY_GRACE_MS)

    def elapsed(self):
        return max(0, int((self.clock() - self.started_at) * 1000))

    def event(self, name, **fields):
        self.sequence += 1
        self.journal.append({"sequence": self.sequence, "elapsedMs": self.elapsed(),
                             "event": name, **copy.deepcopy(fields)})
        if len(self.journal) > JOURNAL_LIMIT:
            del self.journal[64]  # Retain start/intents plus the most recent tail.
            self.dropped += 1

    def transition(self, phase, **fields):
        if phase != self.phase:
            self.event("STATE_TRANSITION", previous=self.phase, phase=phase, **fields)
            self.phase = phase

    def snapshot(self):
        return copy.deepcopy({"phase": self.phase, "activeFlow": self.active, "reminderSlots": self.slots,
                "transportEventJournal": list(self.journal), "journalDroppedCount": self.dropped,
                "detectorDiagnostics": self.diagnostics, "bannerEpisodes": self.banners,
                "controlIntent": self.intent})

    def candidate(self, kind, accepted, details):
        record = self.diagnostics.setdefault(kind, {"pollCount": 0})
        record.update(pollCount=record["pollCount"] + 1, lastCandidate=details)
        if kind == observer.ADDITIONAL_PROCESSING:
            return None  # Ordinary working status, never a separate active recovery.
        banner = self.banners.setdefault(kind, {"present": False, "handled": False, "number": 0})
        present = bool(accepted or details.get("confidence") == "weak")
        if not present:
            banner.update(present=False, handled=False)
            return None
        if not banner["present"]:
            banner.update(present=True, number=banner["number"] + 1,
                          eventId=f"{self.request_id}:{kind}:{banner['number'] + 1}")
        if not self.active and not banner["handled"] and self.clock() < self.soft_deadline:
            return banner["eventId"]
        return None

    def can_begin_recovery(self, kind, event_id):
        banner = self.banners.get(kind, {})
        return bool(not self.active and banner.get("present") and not banner.get("handled")
                    and banner.get("eventId") == event_id and self.clock() < self.soft_deadline)

    def begin_recovery(self, kind, event_id):
        if not self.can_begin_recovery(kind, event_id):
            return False
        self.banners[kind]["handled"] = True
        self.active = {"kind": kind, "eventId": event_id,
                       "deadline": min(self.clock() + RECOVERY_CYCLE_MS / 1000,
                                       self.soft_deadline + RECOVERY_GRACE_MS / 1000)}
        self.transition("CONNECTION_RECOVERY")
        self.event("RECOVERY_STARTED", **self.active)
        return True

    def recovery_remaining_ms(self):
        return max(0, int((self.active["deadline"] - self.clock()) * 1000)) if self.active else 0

    def slot_status(self, index, status, **fields):
        slot = self.slots[index - 1]
        if slot["status"] != "PENDING":
            return
        slot.update(status=status, finishedElapsedMs=self.elapsed(), **fields)
        self.event("REMINDER_SLOT_" + status, **slot)

    def cancel_slots(self, status):
        for slot in self.slots:
            self.slot_status(slot["slot"], status)

    def finish_recovery(self, outcome, **fields):
        self.event("RECOVERY_FINISHED", outcome=outcome, **fields)
        self.active = None
        self.transition("WORKING")


def make_intent(page, request_id, conversation_url, original_prompt, anchor_prompt,
                *, slot=None, recovery_event_id=None, anchor_binding=None, randrange=None):
    """Capture exact visible lineage BEFORE any composer mutation or Send."""
    if str(getattr(page, "url", "")) != conversation_url:
        raise ValueError("intent_conversation_mismatch")
    turns, _ = observer.snapshot_turns(page)
    original = observer.find_user_anchor(turns, original_prompt)
    anchor = observer.find_user_anchor(turns, anchor_prompt, anchor_binding=anchor_binding)
    if original is None or anchor is None or original > anchor:
        raise ValueError("intent_task_lineage_missing")
    if any(t.get("role") == "user" and t["index"] > anchor for t in turns):
        raise ValueError("intent_foreign_user_turn")
    choice = choose_continuation(**({"randrange": randrange} if randrange is not None else {}))
    users = [t for t in turns if t.get("role") == "user"]
    return {"requestId": request_id, "conversationUrl": conversation_url,
            "conversationId": submit.conversation_id_from_url(conversation_url),
            "slot": slot, "recoveryEventId": recovery_event_id, **choice,
            "promptSha256": submit.prompt_sha256(choice["exactPromptText"]),
            "expectedUserTurnRelation": {"userOrdinal": len(users),
                                         "precedingUserHashes": [submit.prompt_sha256(t["text"]) for t in users]},
            "originalAnchorIndex": original, "previousAnchorIndex": anchor,
            "originalUserOrdinal": next(i for i, t in enumerate(users) if t["index"] == original)}


def confirmed_binding(page, intent, result):
    if result.get("sendState") != submit.SEND_PROVEN_SENT:
        raise ValueError("control_send_not_confirmed")
    relation = intent["expectedUserTurnRelation"]
    if str(getattr(page, "url", "")) != intent["conversationUrl"]:
        raise ValueError("control_send_conversation_changed")
    turns, _ = observer.snapshot_turns(page)
    binding = {**relation, "promptSha256": intent["promptSha256"]}
    anchor = observer.find_user_anchor(turns, intent["exactPromptText"], anchor_binding=binding)
    if anchor is None:
        raise ValueError("control_exact_user_turn_missing")
    users = [t for t in turns if t.get("role") == "user"]
    if len(users) != relation["userOrdinal"] + 1:
        raise ValueError("control_unexpected_user_turn_count")
    binding["groupKey"] = turns[anchor].get("groupKey", "")
    result.setdefault("details", {})["controlIntent"] = intent
    result["details"]["anchorBinding"] = binding
    return binding
