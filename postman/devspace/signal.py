"""Stage-one local bell. Routing is from Host binding, never message/report prose."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import tempfile
import secrets
import re

OUTCOMES = {"done": "DONE", "need-decision": "NEED_DECISION", "blocked": "BLOCKED"}
IDENTITY = ("jobId", "requestId", "leaderSessionId", "lunaSessionId", "capability")


def private_root():
    local = os.environ.get("LOCALAPPDATA")
    return Path(local) / "DSH" / "Postman" / "devspace" if local else Path.home() / ".dsh" / "postman" / "devspace"


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def load_binding(channel, *, root=None):
    channel = Path(channel)
    root = Path(root) if root is not None else private_root()
    if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", channel.name) or channel.is_symlink() or channel.resolve() != root.resolve() / channel.name:
        raise ValueError("POSTMAN_DEVSPACE_CHANNEL_REJECTED")
    path = channel / "binding.json"
    if path.is_symlink() or path.stat().st_size > 65536:
        raise ValueError("POSTMAN_DEVSPACE_BINDING_REJECTED")
    binding = json.loads(path.read_text(encoding="utf-8"))
    if (binding.get("version") != 1 or not re.fullmatch(r"REQ_\d{8}T\d{6}Z_\d{4}", binding.get("requestId", "")) or binding.get("jobId") != channel.name or
            Path(binding.get("channel", "")).resolve() != channel.resolve() or
            binding.get("mode") not in {"READ_ONLY", "WRITE_TEST", "WRITE_ISOLATED", "WRITE_APPROVED_TARGET"} or
            not all(isinstance(binding.get(key), str) and binding[key] for key in IDENTITY)):
        raise ValueError("POSTMAN_DEVSPACE_BINDING_REJECTED")
    return binding


def read_event(binding):
    path = Path(binding["channel"]) / "event.json"
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ValueError("POSTMAN_DEVSPACE_EVENT_REJECTED")
    event = json.loads(path.read_text(encoding="utf-8"))
    if any(event.get(key) != binding[key] for key in IDENTITY):
        raise ValueError("POSTMAN_DEVSPACE_EVENT_OWNER_MISMATCH")
    if event.get("version") != 1 or event.get("reportedOutcome") not in OUTCOMES.values():
        raise ValueError("POSTMAN_DEVSPACE_EVENT_REJECTED")
    return {key: event.get(key) for key in ("reportedOutcome", "message", "reportRef")}


def signal(channel, capability, outcome, *, message="", report="", request=None, root=None):
    binding = load_binding(channel, root=root)
    if not secrets.compare_digest(binding["capability"], capability) or (request is not None and request != binding["requestId"]):
        raise ValueError("POSTMAN_DEVSPACE_SIGNAL_REJECTED")
    if outcome not in OUTCOMES or len(message) > 16000:
        raise ValueError("POSTMAN_DEVSPACE_SIGNAL_REJECTED")
    report_ref = None
    if report:
        target = Path(report)
        allowed = Path(binding["writeRoot"] or binding["workspaceRef"]).resolve()
        target = (allowed / target).resolve() if not target.is_absolute() else target.resolve()
        if target.is_relative_to(allowed):
            report_ref = str(target)  # Foreign report is ignored, never opens foreign data or destroys the bell.
    event = {"version": 1, **{key: binding[key] for key in IDENTITY},
             "reportedOutcome": OUTCOMES[outcome], "message": message, "reportRef": report_ref}
    path = Path(binding["channel"]) / "event.json"
    # Stage 1 is one substantive bell, not persistent episode/control management.
    # Atomic exclusive link: repeated same signals succeed, contradictory calls retain the first.
    fd, temporary = tempfile.mkstemp(prefix=".bell-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(event, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if read_event(binding) != {key: event[key] for key in ("reportedOutcome", "message", "reportRef")}:
                raise ValueError("POSTMAN_DEVSPACE_SIGNAL_ALREADY_RECORDED")
    finally:
        os.unlink(temporary)
    return {"ok": True, "requestId": binding["requestId"], "reportedOutcome": event["reportedOutcome"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("outcome", choices=OUTCOMES)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--capability", required=True)
    parser.add_argument("--request")
    parser.add_argument("--message", default="")
    parser.add_argument("--report", default="")
    args = parser.parse_args()
    try:
        print(json.dumps(signal(args.channel, args.capability, args.outcome, message=args.message,
                                report=args.report, request=args.request), ensure_ascii=False))
        return 0
    except (OSError, ValueError):
        print(json.dumps({"ok": False, "code": "POSTMAN_DEVSPACE_SIGNAL_REJECTED"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
