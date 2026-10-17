"""Host-owned queued controls for one exact PostmanDevspace browser request.

Only the Host can create immutable control intents inside its private channel.
The Web observer serializes UI actions and records one durable outcome per ID.
A pending urgent instruction is not a Send; the real composer must be ready.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

from postman.devspace.signal import IDENTITY, atomic_json, read_event
import browser_submit as submit
import browser_observer as observer

CONTROL_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


def revoked(binding):
    """A Host withdrawal fences UI actions without claiming local tools stopped."""
    path = Path(binding["channel"]) / "revoked.json"
    if not path.exists():
        return False
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 16000:
        raise ValueError("POSTMAN_DEVSPACE_REVOCATION_REJECTED")
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if any(receipt.get(key) != binding[key] for key in IDENTITY if key != "capability"):
        raise ValueError("POSTMAN_DEVSPACE_REVOCATION_OWNER_MISMATCH")
    return True


def newer_user_turn(page, prompt):
    """Only positive visible ordering withdraws an old request's UI rights.

    A missing/virtualized old anchor is not evidence of a newer assignment.
    """
    try:
        turns, _ = observer.snapshot_turns(page)
        anchor = observer.find_user_anchor(turns, prompt)
        return anchor is not None and any(
            turn.get("role") == "user" and turn["index"] > anchor for turn in turns)
    except Exception:
        return False  # Unreadable history must not reinstate the prior-history gate.


def supersede_for_user_turn(binding, intent):
    path = Path(binding["channel"]) / "controls" / (intent["controlId"] + ".ack.json")
    receipt = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {
        "version": 1, "controlId": intent["controlId"], "requestId": binding["requestId"]}
    atomic_json(path, {**receipt, "state": "SUPERSEDED", "previousState": receipt.get("state"),
                       "supersededByUserTurn": True})
    return {"kind": "control", "status": "SUPERSEDED", "supersededByUserTurn": True}


def pending(binding):
    folder = Path(binding["channel"]) / "controls"
    if not folder.exists() or folder.is_symlink() or not folder.is_dir():
        return []
    controls = []
    for path in folder.iterdir():
        if not CONTROL_ID.fullmatch(path.stem) or path.suffix != ".json" or path.name.endswith(".ack.json"):
            continue
        if path.is_symlink() or path.stat().st_size > 16000:
            raise ValueError("POSTMAN_DEVSPACE_CONTROL_REJECTED")
        ack = folder / (path.stem + ".ack.json")
        receipt = None
        if ack.exists():
            if ack.is_symlink() or ack.stat().st_size > 16000:
                raise ValueError("POSTMAN_DEVSPACE_CONTROL_REJECTED")
            receipt = json.loads(ack.read_text(encoding="utf-8"))
            if receipt.get("controlId") != path.stem or receipt.get("requestId") != binding["requestId"]:
                raise ValueError("POSTMAN_DEVSPACE_CONTROL_OWNER_MISMATCH")
            if receipt.get("state") not in {"STOP_UNKNOWN", "WAITING_COMPOSER"}:
                continue  # A Send that may have happened must never be replayed.
        entry = json.loads(path.read_text(encoding="utf-8"))
        if (entry.get("version") != 1 or entry.get("controlId") != path.stem or
                entry.get("kind") not in {"steer", "preempt", "stop"} or
                entry.get("priority") not in {"normal", "urgent"} or
                not isinstance(entry.get("message"), str) or len(entry["message"]) > 6000 or
                any(entry.get(key) != binding[key] for key in IDENTITY)):
            raise ValueError("POSTMAN_DEVSPACE_CONTROL_OWNER_MISMATCH")
        controls.append({**entry, "receipt": receipt})
    return sorted(controls, key=lambda x: (
        x["priority"] != "urgent" and x["kind"] not in {"preempt", "stop"},
        x.get("issuedAt", ""), x["controlId"]))


def acknowledge(binding, intent, state, *, stop_state=None, send_state=None):
    path = Path(binding["channel"]) / "controls" / (intent["controlId"] + ".ack.json")
    if path.exists():  # A prior irreversible attempt is authoritative.
        return
    atomic_json(path, {"version": 1, "controlId": intent["controlId"],
                       "requestId": binding["requestId"], "state": state,
                       "stopState": stop_state, "sendState": send_state})


def process_one(page, prompt, chat_url, binding, *, activity, stop_control, sleep, monotonic):
    """Attempt at most one owned pending control. Return None when only queued."""
    if read_event(binding) or revoked(binding):
        return None
    commands = pending(binding)
    if not commands:
        return None
    intent = commands[0]
    if str(getattr(page, "url", "")) != chat_url:
        acknowledge(binding, intent, "PROVEN_NOT_SENT")
        return {"kind": "control", "status": "PROVEN_NOT_SENT"}
    if newer_user_turn(page, prompt):
        return supersede_for_user_turn(binding, intent)
    if intent.get("receipt"):
        replacement = next((command for command in commands[1:]
            if command["kind"] in {"preempt", "stop"} and command.get("receipt") is None
            and command.get("issuedAt", "") > intent.get("issuedAt", "")), None)
        if replacement is not None:
            # A new explicit Leader attempt may supersede read-only waiting
            # after an old uncertain click. Preserve the old proof; never
            # replay its Stop or later send its now-obsolete continuation.
            for stale in commands:
                receipt = stale.get("receipt")
                if receipt and stale.get("issuedAt", "") < replacement.get("issuedAt", ""):
                    atomic_json(Path(binding["channel"]) / "controls" / (stale["controlId"] + ".ack.json"), {
                        **receipt, "state": "SUPERSEDED", "previousState": receipt["state"],
                        "supersededByControlId": replacement["controlId"]})
            intent = replacement
    mode = intent["kind"]
    state = activity(page, prompt, chat_url)
    if mode == "steer" and state["state"] != "IDLE":
        return None  # Keep in the Host queue; never type with Stop-only UI.
    stop_status = None
    if mode in {"preempt", "stop"}:
        # Leader explicitly authorizes UI Stop, including ACTIVE_TOOL/UNKNOWN.
        # The receipt fences a possibly clicked Stop across crash/restart.
        stop_attempted = bool(intent.get("receipt"))
        condition, button = stop_control(page)
        if condition == "UNKNOWN":
            return None
        if condition == "PRESENT" and not stop_attempted:
            # Commit an uncertain receipt before an irreversible click: a crash
            # must not replay the Stop. The same live attempt may refine it.
            acknowledge(binding, intent, "STOP_UNKNOWN", stop_state="CLICK_PENDING")
            if revoked(binding) or str(getattr(page, "url", "")) != chat_url or read_event(binding):
                return None
            if newer_user_turn(page, prompt):
                return supersede_for_user_turn(binding, intent)
            try:
                button.click(timeout=1500)
            except Exception:
                return {"kind": "control", "status": "STOP_UNKNOWN", "stopState": "CLICK_UNKNOWN"}
            stop_attempted = True
        if condition == "PRESENT":
            deadline = monotonic() + 10
            while monotonic() < deadline:
                if read_event(binding) or revoked(binding) or str(getattr(page, "url", "")) != chat_url:
                    break
                if newer_user_turn(page, prompt):
                    return supersede_for_user_turn(binding, intent)
                condition, _ = stop_control(page)
                if condition == "ABSENT":
                    stop_status = "STOP_UI_PROVEN"
                    break
                sleep(min(0.25, max(0, deadline - monotonic())))
            if stop_status is None:
                return {"kind": "control", "status": "WAITING_COMPOSER", "stopState": "CLICK_UNKNOWN"}
        else:
            stop_status = "STOP_UI_PROVEN" if stop_attempted else "ALREADY_IDLE"
        if mode == "stop":
            # No Send after explicit stop. Never claim a DevSpace shell stopped.
            if stop_status != "ALREADY_IDLE":
                atomic_json(Path(binding["channel"]) / "controls" /
                    (intent["controlId"] + ".ack.json"), {
                    "version": 1, "controlId": intent["controlId"],
                    "requestId": binding["requestId"], "state": stop_status,
                    "stopState": stop_status, "sendState": None})
            else:
                acknowledge(binding, intent, "ALREADY_IDLE", stop_state=stop_status)
            return {"kind": "stop", "status": stop_status}
        if read_event(binding) or revoked(binding):
            return None

    if read_event(binding) or revoked(binding) or str(getattr(page, "url", "")) != chat_url:
        return None
    if newer_user_turn(page, prompt):
        return supersede_for_user_turn(binding, intent)
    # Commit an unknown Send intent before entering the one-shot browser mutation.
    # If the process dies after clicking but before a final receipt, there is no
    # automatic replay of this controlId on a later observation.
    if mode in {'steer', 'preempt'}:
        # For preempt with an already-idle chat this is the first mutation.
        # If Stop was clicked earlier, the STOP_UNKNOWN receipt already
        # prevents replay; acknowledge() never overwrites it.
        atomic_json(Path(binding["channel"]) / "controls" / (intent["controlId"] + ".ack.json"), {
            "version": 1, "controlId": intent["controlId"], "requestId": binding["requestId"],
            "state": "SEND_UNKNOWN", "stopState": stop_status, "sendState": "UNKNOWN"})
    # An unknown prior Send is NEVER retried; this is a distinct authorized
    # Host control with its own controlId and a proved idle same-chat composer.
    previous_guard = getattr(page, "_postman_action_guard", None)
    superseded = False
    def allowed():
        nonlocal superseded
        superseded = superseded or newer_user_turn(page, prompt)
        return (not superseded and not revoked(binding) and str(getattr(page, "url", "")) == chat_url
                and (previous_guard is None or previous_guard()))
    page._postman_action_guard = allowed
    try:
        result = submit.submit_existing_prompt(page, intent["message"], chat_url,
                                                navigate=False, timeout_ms=10000)
    finally:
        page._postman_action_guard = previous_guard
    send_state = result.get("sendState", submit.SEND_UNKNOWN)
    if superseded and send_state == submit.SEND_PROVEN_NOT_SENT:
        return supersede_for_user_turn(binding, intent)
    verdict = ("SENT_CONFIRMED" if send_state == submit.SEND_PROVEN_SENT else
               "SEND_UNKNOWN" if send_state == submit.SEND_UNKNOWN else "WAITING_COMPOSER")
    ack_path = Path(binding["channel"]) / "controls" / (intent["controlId"] + ".ack.json")
    atomic_json(ack_path, {
        "version": 1, "controlId": intent["controlId"], "requestId": binding["requestId"],
        "state": verdict, "stopState": stop_status, "sendState": send_state,
    })
    return {"kind": "control", "status": verdict,
            "newPrompt": intent["message"] if verdict == "SENT_CONFIRMED" else None,
            "sendUnknown": verdict == "SEND_UNKNOWN"}
