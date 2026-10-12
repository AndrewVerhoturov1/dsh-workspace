"""Host-owned queued controls for one exact PostmanDevspace browser request.

Only the Host can create immutable control intents inside its private channel.
The Web observer serializes UI actions and records one durable outcome per ID.
A pending urgent instruction is not a Send; it waits until the same chat is idle.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

from postman.devspace.signal import IDENTITY, atomic_json, read_event
import browser_submit as submit

CONTROL_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")


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
        if ack.exists():
            continue  # One irreversible UI mutation per controlId.
        entry = json.loads(path.read_text(encoding="utf-8"))
        if (entry.get("version") != 1 or entry.get("controlId") != path.stem or
                entry.get("kind") not in {"steer", "preempt", "stop"} or
                entry.get("priority") not in {"normal", "urgent"} or
                not isinstance(entry.get("message"), str) or len(entry["message"]) > 6000 or
                any(entry.get(key) != binding[key] for key in IDENTITY)):
            raise ValueError("POSTMAN_DEVSPACE_CONTROL_OWNER_MISMATCH")
        controls.append(entry)
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
    if read_event(binding):
        return None
    commands = pending(binding)
    if not commands:
        return None
    intent = commands[0]
    if str(getattr(page, "url", "")) != chat_url:
        acknowledge(binding, intent, "PROVEN_NOT_SENT")
        return {"kind": "control", "status": "PROVEN_NOT_SENT"}
    mode = intent["kind"]
    state = activity(page, prompt, chat_url)
    if mode == "steer" and state["state"] != "IDLE":
        return None  # Keep in the Host queue; never type with Stop-only UI.
    stop_status = None
    if mode in {"preempt", "stop"}:
        condition, button = stop_control(page)
        if condition == "UNKNOWN" or state["state"] == "UNKNOWN":
            return None
        if condition == "PRESENT":
            # Commit an uncertain receipt before an irreversible click: a crash
            # must not replay the Stop. The same live attempt may refine it.
            acknowledge(binding, intent, "STOP_UNKNOWN", stop_state="CLICK_PENDING")
            try:
                button.click(timeout=1500)
            except Exception:
                return {"kind": "control", "status": "STOP_UNKNOWN", "stopState": "CLICK_UNKNOWN"}
            deadline = monotonic() + 10
            while monotonic() < deadline:
                if read_event(binding):
                    break
                condition, _ = stop_control(page)
                if condition == "ABSENT":
                    stop_status = "STOP_UI_PROVEN"
                    break
                sleep(min(0.25, max(0, deadline - monotonic())))
            if stop_status is None:
                return {"kind": "control", "status": "STOP_UNKNOWN", "stopState": "CLICKED"}
        else:
            if state['state'] != 'IDLE':
                return None  # A missing Stop button is not proof an active tool is idle.
            stop_status = "ALREADY_IDLE"
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
        if read_event(binding):
            return None
        if stop_status == "STOP_UI_PROVEN":
            # UI must have settled; Stop disappearance alone is not send proof.
            state = activity(page, prompt, chat_url)
            if state["state"] != "IDLE":
                return {"kind": "control", "status": "STOP_UNKNOWN"}
        elif stop_status != "ALREADY_IDLE":
            return None

    if read_event(binding):
        return None
    if state["state"] != "IDLE":
        return None
    # Commit an unknown Send intent before entering the one-shot browser mutation.
    # If the process dies after clicking but before a final receipt, there is no
    # automatic replay of this controlId on a later observation.
    if mode == 'steer':
        acknowledge(binding, intent, 'SEND_UNKNOWN', send_state='UNKNOWN')
    # An unknown prior Send is NEVER retried; this is a distinct authorized
    # Host control with its own controlId and a proved idle same-chat composer.
    result = submit.submit_existing_prompt(page, intent["message"], chat_url,
                                            navigate=False, timeout_ms=10000)
    send_state = result.get("sendState", submit.SEND_UNKNOWN)
    verdict = ("SENT_CONFIRMED" if send_state == submit.SEND_PROVEN_SENT else
               "SEND_UNKNOWN" if send_state == submit.SEND_UNKNOWN else "PROVEN_NOT_SENT")
    ack_path = Path(binding["channel"]) / "controls" / (intent["controlId"] + ".ack.json")
    atomic_json(ack_path, {
        "version": 1, "controlId": intent["controlId"], "requestId": binding["requestId"],
        "state": verdict, "stopState": stop_status, "sendState": send_state,
    })
    return {"kind": "control", "status": verdict,
            "newPrompt": intent["message"] if verdict == "SENT_CONFIRMED" else None,
            "sendUnknown": verdict == "SEND_UNKNOWN"}
