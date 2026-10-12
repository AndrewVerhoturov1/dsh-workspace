"""Private stage-one Direct entry. No Git publisher, uploads or alternate browser."""
from __future__ import annotations
import sys
from pathlib import Path

# Running this file as a script puts postman/devspace first in sys.path.
# Remove that entry so its signal.py cannot shadow Python's standard signal
# module, which Playwright/asyncio needs for subprocess handling.
if not __package__:
    script_dir = Path(__file__).resolve().parent
    sys.path[:] = [entry for entry in sys.path if Path(entry or '.').resolve() != script_dir]

import argparse
import base64
import json
import shlex

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "postman" / "direct"))
sys.path.insert(0, str(REPO / "postman" / "web"))
from postman.devspace.signal import load_binding, atomic_json
from postman.devspace.task import render_task
from postman.devspace.observer import DEFAULT_CHECK_INTERVAL_MS, DEFAULT_CHECK_COUNT
from postman_direct import ensure_dedicated_chrome
from web_worker_bridge import WebWorkerBridge


def run(channel, request_id, intent, *, ensure_browser=ensure_dedicated_chrome, bridge_factory=WebWorkerBridge):
    binding = load_binding(channel)
    if binding["requestId"] != request_id:
        raise ValueError("POSTMAN_DEVSPACE_REQUEST_MISMATCH")
    root = Path(channel)
    result_path = root / "result.json"
    if result_path.exists():
        return json.loads(result_path.read_text(encoding="utf-8"))
    command = "pwsh -NoProfile -NonInteractive -File " + shlex.quote(str(root / "signal.ps1"))
    prompt = render_task(binding, intent, command)
    # Task/workspace/binding stays local; only private prompt goes to its ChatGPT conversation.
    (root / "task.md").write_text(prompt, encoding="utf-8")
    try:
        browser = ensure_browser()
        bridge = bridge_factory(root=root / "web")
        observed = bridge.run_request(request_id, task_url="", prompt=prompt,
            expected_filename="", expected_request={"transportKind": "devspace", "requestId": request_id},
            artifact_mode=False, devspace_binding=binding, cdp_url=browser["cdpUrl"],
            conversation_url=binding.get("conversationUrl"),
            reminder_interval_ms=DEFAULT_CHECK_INTERVAL_MS, max_reminders=DEFAULT_CHECK_COUNT)
        details = observed.get("details", {})
        result = {"requestId": request_id, "source": "bell" if observed.get("code") == "DEVSPACE_SIGNAL_RECEIVED" else details.get("source", "transport_diagnostic"),
                  "diagnostic": details.get("diagnostic", "BLOCKED"), "assistantText": details.get("assistantText", ""),
                  "conversationRef": details.get("conversationRef"), "message": details.get("message", ""),
                  "transportDiagnostics": {key: details[key] for key in
                      ("reminderSlots", "transportEventJournal", "detectorDiagnostics") if key in details}}
    except Exception:
        # Keep private internals/capability out of model diagnostics. Host still checks bell first.
        result = {"requestId": request_id, "source": "transport_diagnostic", "diagnostic": "BLOCKED",
                  "assistantText": "Devspace browser/runtime failed; inspect owned local state. No retry or fallback."}
    atomic_json(result_path, result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--task-base64", required=True)
    parser.add_argument("--channel", required=True)
    args = parser.parse_args()
    try:
        task = base64.b64decode(args.task_base64, validate=True).decode("utf-8")
        result = run(args.channel, args.request_id, task)
    except (OSError, ValueError):
        result = {"requestId": args.request_id, "source": "transport_diagnostic", "diagnostic": "BLOCKED"}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
