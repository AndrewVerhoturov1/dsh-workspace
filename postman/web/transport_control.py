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
        record = self.diagnostics.setdefault(kind, {"candidateSeenCount": 0, "confirmedCount": 0,
                                                    "pollCount": 0, "lastCandidate": {}})
        record["pollCount"] += 1
        seen = details.get("candidateCount", int(bool(details.get("matchedText"))))
        confidence = details.get("confidence", "strong" if accepted else "rejected")
        compact = {k: details.get(k) for k in ("matchedText", "evidence", "reason", "confidence", "candidates") if k in details}
        if seen:
            record["candidateSeenCount"] += seen
            if compact != record["lastCandidate"]:
                self.event("SYSTEM_CANDIDATE", kind=kind, **compact)
            record["lastCandidate"] = compact
            record["lastRejectReason"] = details.get("reason") if not accepted else None
        if self.active:
            if accepted:
                self.event("SYSTEM_SIGNAL_DEFERRED", kind=kind, activeEventId=self.active["eventId"])
            return None
        episode = self.banners.setdefault(kind, {"present": False, "handled": False, "number": 0})
        present = bool(accepted or confidence == "weak")
        if not present:
            if episode["present"]:
                self.event("SYSTEM_BANNER_ABSENT", kind=kind, eventId=episode.get("eventId"))
            episode.update(present=False, handled=False, weakSince=None)
            return None
        if not episode["present"]:
            episode.update(present=True, handled=False, confirmed=False, number=episode["number"] + 1,
                           eventId=f"{self.request_id}:{kind}:{episode['number'] + 1}",
                           weakSince=self.clock(), weakText=details.get("matchedText"))
        if confidence == "weak" and not accepted:
            if episode.get("weakText") != details.get("matchedText"):
                episode.update(weakSince=self.clock(), weakText=details.get("matchedText"))
            accepted = self.clock() - float(episode.get("weakSince") or 0) >= 1.0
            if accepted:
                compact["confirmedOnSecondPoll"] = True
        confirmed_at = self.clock()
        if accepted and not episode["handled"] and confirmed_at < self.soft_deadline:
            if not episode.get("confirmed"):
                record["confirmedCount"] += 1
                episode.update(confirmed=True, eventConfirmedAt=confirmed_at,
                               eventConfirmedElapsedMs=self.elapsed())
                self.event("SYSTEM_CONFIRMED", kind=kind, eventId=episode["eventId"],
                           eventConfirmedAt=episode["eventConfirmedAt"],
                           eventConfirmedElapsedMs=episode["eventConfirmedElapsedMs"], **compact)
            return episode["eventId"]
        return None

    def can_begin_recovery(self, kind, event_id):
        episode = self.banners.get(kind, {})
        confirmed_at = episode.get("eventConfirmedAt")
        return bool(not self.active and episode.get("confirmed") and not episode.get("handled")
                    and episode.get("eventId") == event_id and confirmed_at is not None
                    and confirmed_at < self.soft_deadline
                    and self.clock() < min(confirmed_at + RECOVERY_CYCLE_MS / 1000,
                                           self.soft_deadline + RECOVERY_GRACE_MS / 1000))

    def begin_recovery(self, kind, event_id):
        if not self.can_begin_recovery(kind, event_id):
            return False
        episode = self.banners[kind]
        episode["handled"] = True
        self.active = {"kind": kind, "eventId": event_id, "startedElapsedMs": self.elapsed(),
                       "eventConfirmedAt": episode["eventConfirmedAt"],
                       "eventConfirmedElapsedMs": episode["eventConfirmedElapsedMs"],
                       "deadline": min(episode["eventConfirmedAt"] + RECOVERY_CYCLE_MS / 1000,
                                       self.soft_deadline + RECOVERY_GRACE_MS / 1000)}
        self.transition(kind, eventId=event_id)
        self.event("RECOVERY_STARTED", **self.active)
        self.consume_slots()
        return True

    def recovery_remaining_ms(self):
        if not self.active:
            return 0
        return max(0, int((self.active["deadline"] - self.clock()) * 1000))

    def consume_slots(self):
        if self.active:
            for slot in self.slots:
                if slot["status"] == "PENDING" and slot["scheduledElapsedMs"] <= self.elapsed():
                    self.slot_status(slot["slot"], "CONSUMED_BY_RECOVERY", recoveryEventId=self.active["eventId"])

    def slot_status(self, index, status, **fields):
        slot = self.slots[index - 1]
        if slot["status"] != "PENDING":
            return
        slot.update(status=status, finishedElapsedMs=self.elapsed(), **fields)
        self.event("REMINDER_SLOT_" + status, **slot)

    def cancel_slots(self, status):
        for slot in self.slots:
            self.slot_status(slot["slot"], status)

    def wait_for_connection(self, outcome):
        """No more mutations for this episode; passive observation keeps request time."""
        self.consume_slots()
        self.active["reloadOutcome"] = outcome
        self.active["waitingSinceElapsedMs"] = self.elapsed()
        # Exhaustion before soft timeout enters ordinary passive request time.
        # If already in grace, retain only the existing cycle deadline.
        if self.clock() < self.soft_deadline:
            self.active["deadline"] = self.soft_deadline
        self.transition("CONNECTION_WAITING", eventId=self.active["eventId"])
        self.event("CONNECTION_RELOADS_EXHAUSTED", eventId=self.active["eventId"], outcome=outcome)

    def finish_recovery(self, outcome, *, status="COMPLETED", **fields):
        if status not in {"COMPLETED", "FAILED", "ABORTED"}:
            raise ValueError("invalid_recovery_terminal_status")
        if not self.active:
            return
        self.consume_slots()
        self.event("RECOVERY_" + status, eventId=self.active["eventId"],
                   kind=self.active["kind"], outcome=outcome, **fields)
        self.active = None
        if status == "COMPLETED":
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
