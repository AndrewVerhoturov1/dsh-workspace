"""Host-owned universal Devspace Direct transport. No Git publisher or alternate browser."""
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
from postman.devspace.publication import publish_assignment, read_publication
from postman.devspace.observer import DEFAULT_CHECK_INTERVAL_MS, DEFAULT_CHECK_COUNT
from postman import input_bundle
from postman_direct import ensure_dedicated_chrome
from web_worker_bridge import WebWorkerBridge, browser_submit


# Project diagnostic only: never forward raw submitProof, URL, prompt or exception
# message from the browser's private state into the DevSpace terminal.
_SAFE_CODES = frozenset(value for key, value in vars(browser_submit).items()
                        if key.isupper() and isinstance(value, str) and value.isupper()
                        and 0 < len(value) <= 80) | {
    "BRIDGE_PIPELINE_FAILED", "POSTMAN_SENT_ATTACHMENT_PROOF_UNKNOWN",
    "image_resume_send_unproven", "submit_failed",
    "POSTMAN_DEVSPACE_REVOKED", "POSTMAN_DEVSPACE_RECOVERY_INVALID",
    "POSTMAN_DEVSPACE_RECOVERY_OWNER_MISMATCH", "POSTMAN_DEVSPACE_RECOVERY_CHAT_MISMATCH",
}
_SAFE_REASONS = {"invalid_conversation_url", "current_chat_mismatch", "prompt_empty",
                 "chat_changed_before_fill", "presend_ownership_or_prompt_changed",
                 "attachment_chat_changed_before_send", "click_outcome_uncertain",
                 "submit_exception", "fresh_presend_lock_timeout",
                 "invalid_prior_request_id", "prior_history_unproven",
                 "history_count_failed", "history_traversal_failed",
                 "history_semantic_unrecognized", "history_text_read_failed",
                 "history_changed_during_read", "history_prior_anchor_missing",
                 "history_prior_anchor_ambiguous", "history_turns_unrecognized", "history_changed"}
_SAFE_SEND_STATES = {"PROVEN_NOT_SENT", "PROVEN_SENT", "UNKNOWN", "SEND_STARTED"}


def _allowed(value, choices):
    return isinstance(value, str) and value in choices


def _safe_transport_evidence(details):
    if not isinstance(details, dict):
        return {}
    result = {}
    if details.get("recoverySourceCompleted") is True:
        if _allowed(details.get("recoverySourceOutcome"), {"DONE", "BLOCKED", "NEED_DECISION"}):
            result["recoverySourceOutcome"] = details["recoverySourceOutcome"]
        if isinstance(details.get("recoverySourceMessage"), str):
            result["recoverySourceMessage"] = details["recoverySourceMessage"][:2000]
    code = details.get("transportCode")
    if _allowed(code, _SAFE_CODES):
        result["transportCode"] = code
    message = details.get("transportMessage")
    if isinstance(message, str) and (message == result.get("transportCode") or
                                      message == "submit did not bind a chat URL"):
        result["transportMessage"] = message
    proof = details.get("sendProof")
    if isinstance(proof, dict):
        safe = {key: proof[key] for key in ("sendState", "proofClass")
                if _allowed(proof.get(key), _SAFE_SEND_STATES)}
        if safe:
            result["sendProof"] = safe
    if _allowed(details.get("sendProofClass"), _SAFE_SEND_STATES):
        result["sendProofClass"] = details["sendProofClass"]
    submitted = details.get("details")
    if isinstance(submitted, dict):
        safe = {}
        if _allowed(submitted.get("code"), _SAFE_CODES):
            safe["code"] = submitted["code"]
        if _allowed(submitted.get("sendState"), _SAFE_SEND_STATES):
            safe["sendState"] = submitted["sendState"]
        diagnostic = submitted.get("details")
        if isinstance(diagnostic, dict):
            if _allowed(diagnostic.get("priorHistoryReason"), _SAFE_REASONS):
                safe["priorHistoryReason"] = diagnostic["priorHistoryReason"]
            if _allowed(diagnostic.get("reason"), _SAFE_REASONS):
                safe["reason"] = diagnostic["reason"]
            for key in ("exactPromptReadback", "singleLogicalComposer", "historyReady"):
                if type(diagnostic.get(key)) is bool:
                    safe[key] = diagnostic[key]
            ownership = diagnostic.get("presendOwnership")
            if isinstance(ownership, dict):
                bounded = {key: ownership[key] for key in
                           ("sendNotAttempted", "ownedUrlEqual", "userTurnCountEqual",
                            "historyReadConfirmed", "historyEqual")
                           if type(ownership.get(key)) is bool}
                for key in ("expectedUserTurnCount", "observedUserTurnCount"):
                    value = ownership.get(key)
                    if type(value) is int and 0 <= value <= 100_000:
                        bounded[key] = value
                if _allowed(ownership.get("userTurnSelectorFamily"), {"none", "author-role", "test-id", "bubble"}):
                    bounded["userTurnSelectorFamily"] = ownership["userTurnSelectorFamily"]
                if _allowed(ownership.get("historyReason"), _SAFE_REASONS):
                    bounded["historyReason"] = ownership["historyReason"]
                if bounded:
                    safe["presendOwnership"] = bounded
        if safe:
            result["submitProof"] = safe
    return result


def run(channel, request_id, intent, *, image_mode=False,
        input_bundle_manifest=None, input_files_base64=None,
        ensure_browser=ensure_dedicated_chrome, bridge_factory=WebWorkerBridge):
    if type(image_mode) is not bool or (image_mode and (input_bundle_manifest or input_files_base64)):
        raise ValueError("POSTMAN_DEVSPACE_IMAGE_INPUT_INVALID")
    binding = load_binding(channel)
    if image_mode:
        binding = {**binding, "imageMode": True}
    if binding["requestId"] != request_id:
        raise ValueError("POSTMAN_DEVSPACE_REQUEST_MISMATCH")
    root = Path(channel)
    result_path = root / "result.json"
    if result_path.exists():
        if image_mode and not (root / "publication.json").exists():
            raise ValueError("POSTMAN_DEVSPACE_PUBLICATION_BINDING_CHANGED")
        if (root / "publication.json").exists():
            read_publication(binding)  # Reject cross-mode reuse of an earlier REQ.
        return json.loads(result_path.read_text(encoding="utf-8"))
    command = "pwsh -NoProfile -NonInteractive -File " + shlex.quote(str(root / "signal.ps1"))
    attachment = None
    if input_bundle_manifest or input_files_base64:
        if not input_bundle_manifest or not input_files_base64:
            raise ValueError("POSTMAN_INPUT_BUNDLE_HANDOFF_INVALID")
        descriptors = input_bundle.normalize_input_files(json.loads(
            base64.b64decode(input_files_base64, validate=True).decode("utf-8")))
        image = bool(descriptors) and len(descriptors) <= 7 and all(d.get("media_type") in input_bundle.IMAGE_EXTENSIONS
                                          for d in descriptors)
        attachment = input_bundle.read_handoff(
            input_bundle_manifest, request_id, descriptors, image=image)
        intent += ("\nHost-закреплённые файлы приложены автоматически к этому сообщению."
                   " Используй их как входные данные; не требуй ручного прикрепления"
                   " и не ищи копии в других папках.")
    try:
        publication = publish_assignment(binding, intent, command,
            **({"image_mode": True} if image_mode else {}))
        prompt = publication["prompt"]
    except Exception as error:
        code = str(error).split(":", 1)[0]
        if not code.startswith("POSTMAN_DEVSPACE_"):
            code = "POSTMAN_DEVSPACE_PUBLICATION_UNAVAILABLE"
        result = {"requestId": request_id, "source": "transport_diagnostic",
                  "diagnostic": "CAPABILITY_UNAVAILABLE",
                  "message": str(error) if code == "POSTMAN_DEVSPACE_INSTRUCTION_UNAVAILABLE" else code,
                  "assistantText": code}
        atomic_json(result_path, result)
        return result
    # Browser text has only the human invitation and the two public links.
    (root / "task.md").write_text(prompt, encoding="utf-8")
    try:
        browser = ensure_browser()
        bridge = bridge_factory(root=root / "web")
        observed = bridge.run_request(request_id, task_url=publication["taskUrl"], prompt=prompt,
            expected_filename="", expected_request={"transportKind": "devspace", "requestId": request_id},
            artifact_mode=False, devspace_binding=binding, cdp_url=browser["cdpUrl"],
            input_attachment=attachment,
            conversation_url=binding.get("conversationUrl"),
            reminder_interval_ms=DEFAULT_CHECK_INTERVAL_MS,
            max_reminders=0 if image_mode else DEFAULT_CHECK_COUNT)
        details = observed.get("details", {})
        stored = bridge.read_state(request_id) if callable(getattr(bridge, "read_state", None)) else {}
        recovery_diagnostics = {}
        observation = (stored or {}).get("recoveryObservation")
        if isinstance(observation, dict):
            recovery_diagnostics["recoveryObservation"] = {key: observation[key] for key in (
                "sourceRequestId", "attempt", "messageObserved", "historyReadable",
                "newMessageSent", "localOperationsMayContinue", "observationReason", "sendState") if key in observation}
        if details.get("recoverySourceCompleted") is True:
            recovery_diagnostics["recoverySourceCompleted"] = True
        if details.get("supersededByUserTurn") is True:
            recovery_diagnostics["supersededByUserTurn"] = True
        ui_stop = (stored or {}).get("recoveryUiStop")
        if isinstance(ui_stop, dict):
            recovery_diagnostics["recoveryUiStop"] = {key: ui_stop[key] for key in
                ("state", "localOperationsMayContinue") if key in ui_stop}
        result = {"requestId": request_id, "source": "bell" if observed.get("code") == "DEVSPACE_SIGNAL_RECEIVED" else details.get("source", "transport_diagnostic"),
                  "diagnostic": details.get("diagnostic", "BLOCKED"), "assistantText": details.get("assistantText", ""),
                  "conversationRef": details.get("conversationRef"), "message": details.get("message", ""),
                  **{key: details[key] for key in ("resultImage", "imageSha256", "imageWidth",
                      "imageHeight", "imageMimeType", "imageByteLength", "imageFormat",
                      "evidenceState", "sendState", "generationState", "saveState", "deliveryState",
                      "imageSource", "assistantIdentity", "reportedOutcome") if key in details},
                  "transportDiagnostics": {**{key: details[key] for key in
                      ("reminderSlots", "transportEventJournal", "detectorDiagnostics") if key in details},
                      **recovery_diagnostics,
                      **_safe_transport_evidence(details)}}
    except Exception:
        # Keep private internals/capability out of model diagnostics. Host still checks bell first.
        result = {"requestId": request_id, "source": "transport_diagnostic", "diagnostic": "BLOCKED",
                  "assistantText": "Devspace browser/runtime failed; inspect owned local state before a separate recovery attempt."}
    atomic_json(result_path, result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--task-base64", required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--input-files-base64")
    parser.add_argument("--input-bundle-manifest")
    parser.add_argument("--image-mode", action="store_true")
    args = parser.parse_args()
    try:
        task = base64.b64decode(args.task_base64, validate=True).decode("utf-8")
        result = run(args.channel, args.request_id, task, image_mode=args.image_mode,
                     input_files_base64=args.input_files_base64,
                     input_bundle_manifest=args.input_bundle_manifest)
    except (OSError, ValueError):
        result = {"requestId": args.request_id, "source": "transport_diagnostic", "diagnostic": "BLOCKED"}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
