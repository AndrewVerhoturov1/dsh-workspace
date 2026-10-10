#!/usr/bin/env python3
"""Resolve an existing ChatGPT conversation from a prior terminal Postman REQ.

This is intentionally local-only. It never searches ChatGPT UI and never sends a
prompt. A prior REQ is only a lookup key for a previously observed /c/... URL.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlparse

if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "web"))

import request_identity

RESULT_DURABLE = "RESULT_DURABLE"
ASSISTANT_COMPLETED_NO_ARTIFACT = "ASSISTANT_COMPLETED_NO_ARTIFACT"
ARTIFACT_REJECTED = "ARTIFACT_REJECTED"
TEXT_RESULT_DURABLE = "TEXT_RESULT_DURABLE"
_TERMINAL_CHAT_STATES = {
    RESULT_DURABLE,
    ASSISTANT_COMPLETED_NO_ARTIFACT,
    ARTIFACT_REJECTED,
    TEXT_RESULT_DURABLE,
    "IMAGE_RESULT_DURABLE",
}
_CHAT_PATH_RE = re.compile(r"^/c/([A-Za-z0-9_-]+)$")


class ChatReferenceError(ValueError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


@dataclass(frozen=True)
class ChatReference:
    request_id: str
    conversation_id: str
    conversation_url: str
    source: str
    root_request_id: str = ""
    continuation_index: int = 0
    terminal_state: str = ""
    send_proof_class: str = "UNKNOWN"
    recovery_eligible: bool = False
    recovery_root_request_id: str = ""
    automatic_recovery_used: bool = False
    image_recovery_proof: dict[str, Any] | None = None


def normalize_conversation_url(value: object) -> tuple[str, str]:
    if not isinstance(value, str) or not value.strip():
        raise ChatReferenceError("DIRECT_CHAT_REFERENCE_UNAVAILABLE", "conversation URL is missing")
    parsed = urlparse(value.strip())
    if parsed.scheme.lower() != "https" or (parsed.hostname or "").lower() not in {"chatgpt.com", "www.chatgpt.com"}:
        raise ChatReferenceError("DIRECT_CHAT_REFERENCE_INVALID", "conversation URL is not a ChatGPT HTTPS URL")
    match = _CHAT_PATH_RE.fullmatch(parsed.path or "")
    if match is None:
        raise ChatReferenceError("DIRECT_CHAT_REFERENCE_INVALID", "conversation URL is not a /c/<conversation-id> URL")
    conversation_id = match.group(1)
    return conversation_id, f"https://chatgpt.com/c/{conversation_id}"


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _nested_chat_url(value: dict[str, Any]) -> object:
    direct = value.get("conversationUrl")
    if direct:
        return direct
    worker = value.get("workerDetails")
    if isinstance(worker, dict):
        direct = worker.get("conversationUrl")
        if direct:
            return direct
        submit = worker.get("submitProof")
        if isinstance(submit, dict):
            details = submit.get("details")
            if isinstance(details, dict) and details.get("chatUrl"):
                return details.get("chatUrl")
    submit = value.get("submitProof")
    if isinstance(submit, dict):
        details = submit.get("details")
        if isinstance(details, dict) and details.get("chatUrl"):
            return details.get("chatUrl")
    return None


def _send_proof_class(value: dict[str, Any]) -> str:
    for key in ("sendProof", "submitProof"):
        proof = value.get(key)
        if isinstance(proof, dict) and proof.get("sendState") in {"PROVEN_SENT", "PROVEN_NOT_SENT", "UNKNOWN"}:
            return proof["sendState"]
    proof_class = value.get("sendProofClass")
    return proof_class if proof_class in {"PROVEN_SENT", "PROVEN_NOT_SENT", "UNKNOWN"} else "UNKNOWN"


def _reference_eligible(value: dict[str, Any], *, request_id: str, expected_repository: str) -> bool:
    if value.get("requestId") != request_id or value.get("repository") not in {None, expected_repository}:
        return False
    state = value.get("state")
    if state in _TERMINAL_CHAT_STATES:
        return value.get("code") in {None, state} and value.get("ok") is not False
    # Failed references need exact repository and conversation identity, not UI search.
    if value.get("repository") != expected_repository or not value.get("failureCode") and state not in {"FAILED", "ASK_FAILED"}:
        return False
    try:
        conversation_id, conversation_url = normalize_conversation_url(_nested_chat_url(value))
    except ChatReferenceError:
        return False
    if value.get("conversationId") != conversation_id:
        return False
    if _send_proof_class(value) == "PROVEN_SENT":
        return True
    proof = value.get("readOnlySendReproof")
    return bool(
        _send_proof_class(value) == "UNKNOWN" and isinstance(proof, dict)
        and proof.get("requestId") == request_id
        and proof.get("conversationUrl") == conversation_url
        and proof.get("conversationId") == conversation_id
        and proof.get("exactUserTurn") is True
        and proof.get("promptSha256") == value.get("promptSha256")
        and isinstance(value.get("promptSha256"), str)
        and re.fullmatch(r"[0-9a-f]{64}", value["promptSha256"])
    )


def can_continue_request(value: dict[str, Any], *, request_id: str, expected_repository: str) -> bool:
    """Automatic recovery capability; manual chat references are evaluated separately."""
    if not _reference_eligible(value, request_id=request_id, expected_repository=expected_repository):
        return False
    if value.get("state") in {RESULT_DURABLE, TEXT_RESULT_DURABLE, "IMAGE_RESULT_DURABLE"}:
        return False
    if (value.get("automaticRecoveryUsed") is True or value.get("unresolvedSendUnknown") is True
            or value.get("candidate") or value.get("choices")):
        return False
    if value.get("webResultAvailable") is True or value.get("state") == "ARTIFACT_FOUND":
        return False
    # A completed successful terminal already attests its initial Send; retain legacy references.
    return value.get("state") in {ASSISTANT_COMPLETED_NO_ARTIFACT, ARTIFACT_REJECTED} or _send_proof_class(value) == "PROVEN_SENT"


def recovery_claim_path(direct_root: str | os.PathLike[str], root_request_id: str) -> Path:
    request_identity.assert_canonical_request_id(root_request_id)
    return Path(direct_root) / "locks" / f"recovery-{root_request_id}.claim"


def claim_recovery(direct_root: str | os.PathLike[str], reference: ChatReference, new_request_id: str) -> dict[str, Any]:
    """Reserve exactly one attempt durably before publication or browser mutation."""
    request_identity.assert_canonical_request_id(new_request_id)
    root = reference.recovery_root_request_id or reference.root_request_id or reference.request_id
    path = recovery_claim_path(direct_root, root)
    if reference.automatic_recovery_used or path.exists():
        raise ChatReferenceError("POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED", "automatic recovery was already consumed")
    if not reference.recovery_eligible:
        raise ChatReferenceError("DIRECT_INVALID_CONTINUATION", "request has no automatic recovery capability")
    fields = {"recoveryOfRequestId": reference.request_id, "recoveryRootRequestId": root,
              "recoveryAttempt": 1, "automaticRecoveryUsed": True}
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8") as handle:
            json.dump({**fields, "requestId": new_request_id}, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as exc:
        raise ChatReferenceError("POSTMAN_AUTOMATIC_CONTINUATION_LIMIT_REACHED", "automatic recovery was already consumed") from exc
    return fields



def resolve_chat_reference(
    direct_root: str | os.PathLike[str],
    request_id: str,
    *,
    expected_repository: str,
) -> ChatReference:
    try:
        request_identity.assert_canonical_request_id(request_id)
    except (TypeError, ValueError) as exc:
        raise ChatReferenceError("DIRECT_CHAT_REFERENCE_INVALID", "chat request id is not canonical") from exc

    root = Path(direct_root)
    candidates = (
        ("durable_handoff", root / "results" / f"{request_id}.json"),
        ("direct_state", root / "requests" / f"{request_id}.json"),
        ("worker_state", root.parent / "workers" / f"{request_id}.json"),
    )
    seen_sources: list[str] = []
    invalid_urls: list[str] = []
    for source, path in candidates:
        value = _read_json(path)
        if value is None or not _reference_eligible(value, request_id=request_id, expected_repository=expected_repository):
            continue
        seen_sources.append(source)
        raw_url = _nested_chat_url(value)
        if raw_url is None:
            continue
        try:
            conversation_id, conversation_url = normalize_conversation_url(raw_url)
        except ChatReferenceError:
            invalid_urls.append(source)
            continue
        root_request_id = value.get("rootRequestId")
        if not isinstance(root_request_id, str) or not root_request_id:
            root_request_id = request_id
        continuation_index = value.get("continuationIndex")
        if isinstance(continuation_index, bool) or not isinstance(continuation_index, int) or continuation_index < 0:
            continuation_index = 0
        recovery_root = value.get("recoveryRootRequestId") or root_request_id
        try:
            used = value.get("automaticRecoveryUsed") is True or recovery_claim_path(root, recovery_root).exists()
        except (TypeError, ValueError):
            continue
        recovery_eligible = not used and can_continue_request(value, request_id=request_id, expected_repository=expected_repository)
        return ChatReference(
            request_id=request_id,
            conversation_id=conversation_id,
            conversation_url=conversation_url,
            source=source,
            root_request_id=root_request_id,
            continuation_index=continuation_index,
            terminal_state=str(value.get("state", "")),
            send_proof_class=_send_proof_class(value),
            recovery_eligible=recovery_eligible,
            recovery_root_request_id=recovery_root,
            automatic_recovery_used=used,
            image_recovery_proof={"observerProof": value.get("imageObserverProof"), "prompt": value.get("imageOriginalPrompt"),
                                  "anchorBinding": value.get("imageAnchorBinding")} if value.get("imageGenerated") else None,
        )

    raise ChatReferenceError(
        "DIRECT_CHAT_REFERENCE_UNAVAILABLE",
        f"no stored ChatGPT conversation URL is available for {request_id}",
        details={
            "chatRequestId": request_id,
            "checkedSources": [source for source, _ in candidates],
            "terminalSourcesFound": seen_sources,
            "invalidConversationUrlSources": invalid_urls,
            "uiSearchAttempted": False,
        },
    )


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Read-only exact recovery capability")
    parser.add_argument("--direct-root", required=True)
    parser.add_argument("--request-id", required=True)
    args = parser.parse_args()
    try:
        reference = resolve_chat_reference(args.direct_root, args.request_id,
                                           expected_repository="AndrewVerhoturov1/dsh-workspace")
        print(json.dumps({"recovery_eligible": reference.recovery_eligible,
                          "automatic_recovery_used": reference.automatic_recovery_used,
                          "conversation_url": reference.conversation_url}))
    except ChatReferenceError as exc:
        print(json.dumps({"recovery_eligible": False, "code": exc.code}))


__all__ = [
    "ChatReference",
    "ChatReferenceError",
    "normalize_conversation_url",
    "resolve_chat_reference",
]
