#!/usr/bin/env python3
"""WP-011 bridge from a durable Runtime request to the existing Web pipeline.

This module is an orchestration boundary only. Browser behaviour remains in
WP-003--WP-007 modules; the bridge owns request correlation, state persistence,
serialized recovery/natural continuation, and the hand-off back to Runtime after RESULT_DURABLE.
"""

from __future__ import annotations

import cdp_download

from contextlib import ExitStack
from dataclasses import dataclass
import json
import os
import random
from pathlib import Path
import tempfile
import time
from typing import Any, Callable
from urllib.parse import urlparse

import artifact_detector
import artifact_download
import browser_bootstrap
import browser_observer
import browser_recovery
import browser_submit
import input_bundle
import reminder_policy
import request_identity
import transport_control


ACCEPTED = "ACCEPTED"
WEB_STARTING = "WEB_STARTING"
PROMPT_SENT = "PROMPT_SENT"
WAITING_ASSISTANT = "WAITING_ASSISTANT"
ARTIFACT_FOUND = "ARTIFACT_FOUND"
ASSISTANT_COMPLETED_NO_ARTIFACT = "ASSISTANT_COMPLETED_NO_ARTIFACT"
IMAGE_TURN_COMPLETED = "IMAGE_TURN_COMPLETED"
ARTIFACT_REJECTED = "ARTIFACT_REJECTED"
RESULT_DURABLE = "RESULT_DURABLE"
POSTMAN_TRANSPORT_FAILED = "POSTMAN_TRANSPORT_FAILED"

BRIDGE_INVALID_REQUEST = "BRIDGE_INVALID_REQUEST"
BRIDGE_INVALID_TASK_URL = "BRIDGE_INVALID_TASK_URL"
BRIDGE_INVALID_CONFIG = "BRIDGE_INVALID_CONFIG"
BRIDGE_PIPELINE_FAILED = "BRIDGE_PIPELINE_FAILED"

_STATE_ORDER = (
    ACCEPTED,
    WEB_STARTING,
    PROMPT_SENT,
    WAITING_ASSISTANT,
    IMAGE_TURN_COMPLETED,
    ARTIFACT_FOUND,
    ASSISTANT_COMPLETED_NO_ARTIFACT,
    ARTIFACT_REJECTED,
    RESULT_DURABLE,
)
_TERMINAL_SUCCESS_CODES = {RESULT_DURABLE, ASSISTANT_COMPLETED_NO_ARTIFACT, ARTIFACT_REJECTED}
_FATAL_ARTIFACT_CODES = {
    artifact_detector.ARTIFACT_INVALID_CONFIG,
    artifact_detector.ARTIFACT_OBSERVER_PROOF_INVALID,
    artifact_detector.ARTIFACT_CHAT_CORRELATION_LOST,
    artifact_detector.ARTIFACT_TURN_IDENTITY_MISMATCH,
}
_REMINDER_ELIGIBLE_ARTIFACT_CODES = {
    artifact_detector.ARTIFACT_TURN_NOT_COMPLETED,
    artifact_detector.ARTIFACT_ENVELOPE_MISSING,
    artifact_detector.ARTIFACT_ENVELOPE_AMBIGUOUS,
    artifact_detector.ARTIFACT_ENVELOPE_DOM_MISMATCH,
    artifact_detector.ARTIFACT_ATTACHMENT_NOT_FOUND,
    artifact_detector.ARTIFACT_ATTACHMENT_OUTSIDE_ENVELOPE,
    artifact_detector.ARTIFACT_ATTACHMENT_AMBIGUOUS,
}
_NONTERMINAL_OBSERVER_CODES = {
    browser_observer.ASSISTANT_TURN_TIMEOUT,
    browser_observer.ASSISTANT_NOT_STARTED,
    browser_observer.ASSISTANT_STATE_UNKNOWN,
    browser_observer.USER_TURN_ANCHOR_MISSING,
}
_RESULT_RECHECK_INTERVAL_MS = 10_000
_REPROVE_TIMEOUT_MIN_MS = 6_000


def default_postman_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "DSH" / "Postman"
    return Path.home() / ".dsh" / "postman"


def _job_id(request_id: str) -> str:
    return f"WEB_{request_id}"


def _result(code: str, *, ok: bool, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"ok": ok, "code": code, "details": dict(details or {})}


def _valid_task_url(value: object) -> bool:
    if not isinstance(value, str) or not value.strip() or "\r" in value or "\n" in value:
        return False
    parsed = urlparse(value.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def _attach_submit_proof(
    completed: dict[str, Any],
    *,
    prompt: str,
    submitted: dict[str, Any],
) -> dict[str, Any]:
    completed.setdefault("details", {})
    completed["details"].update(
        {
            "promptSha256": browser_submit.prompt_sha256(prompt),
            "submitCode": submitted.get("code"),
            "submitSendState": submitted.get("sendState"),
            "submitCorrelationMode": submitted.get("details", {}).get("userTurnCorrelationMode", ""),
        }
    )
    return completed


def _compact_reminder_record(
    *,
    index: int,
    scheduled_elapsed_ms: int,
    attempted_elapsed_ms: int,
    finished_elapsed_ms: int,
    prompt: str,
    submitted: dict[str, Any],
) -> dict[str, Any]:
    details = submitted.get("details") if isinstance(submitted.get("details"), dict) else {}
    return {
        "index": index,
        "scheduledElapsedMs": scheduled_elapsed_ms,
        "attemptedElapsedMs": attempted_elapsed_ms,
        "finishedElapsedMs": finished_elapsed_ms,
        "ok": submitted.get("ok") is True,
        "code": str(submitted.get("code", "")),
        "sendState": str(submitted.get("sendState", "")),
        "promptSha256": browser_submit.prompt_sha256(prompt),
        "userTurnCorrelationMode": str(details.get("userTurnCorrelationMode", "")),
        "unsentPromptCleared": bool(details.get("unsentPromptCleared", False)),
    }


def _close_owned_page(page: Any) -> dict[str, Any]:
    cleanup = {
        "ownedPageCreated": page is not None,
        "ownedPageClosed": page is None,
        "closeAttempts": 0,
        "externalBrowserClosed": False,
    }
    if page is None:
        return cleanup

    checker = getattr(page, "is_closed", None)
    last_error = ""
    for attempt in (1, 2):
        cleanup["closeAttempts"] = attempt
        try:
            if callable(checker) and bool(checker()):
                cleanup["ownedPageClosed"] = True
                break
        except Exception:
            pass

        try:
            page.close()
        except Exception as exc:
            last_error = str(exc)[:500]

        try:
            cleanup["ownedPageClosed"] = bool(checker()) if callable(checker) else True
        except Exception:
            cleanup["ownedPageClosed"] = not bool(last_error)

        if cleanup["ownedPageClosed"]:
            break

    if not cleanup["ownedPageClosed"] and last_error:
        cleanup["closeError"] = last_error
    return cleanup


@dataclass(frozen=True)
class BridgeRequest:
    request_id: str
    task_url: str
    result_path: str
    worker_job_id: str


class WebWorkerBridge:
    """Correlate one Runtime request with one existing browser pipeline run."""

    def __init__(
        self,
        *,
        root: str | os.PathLike[str] | None = None,
        result_root: str | os.PathLike[str] | None = None,
        now: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        uniform: Callable[[float, float], float] = random.uniform,
        randrange: Callable[[int], int] = random.randrange,
        on_result_durable: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        postman_root = Path(root) if root is not None else default_postman_root()
        self.state_root = postman_root / "workers"
        self.result_root = Path(result_root) if result_root is not None else postman_root / "results"
        self.now = now
        self.monotonic = monotonic
        self.sleep = sleep
        self.uniform = uniform
        self.randrange = randrange
        self.on_result_durable = on_result_durable

    def random_pause(self) -> None:
        """Pause at image-flow human action boundaries only."""
        self.sleep(random.uniform(3.0, 7.0))

    def state_path(self, request_id: str) -> Path:
        request_identity.assert_canonical_request_id(request_id)
        return self.state_root / f"{request_id}.json"

    def result_path(self, request_id: str) -> Path:
        request_identity.assert_canonical_request_id(request_id)
        return self.result_root / request_id

    def read_state(self, request_id: str) -> dict[str, Any] | None:
        path = self.state_path(request_id)
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        if not isinstance(value, dict):
            raise ValueError("worker state must be an object")
        return value

    def _write_state(self, request: BridgeRequest, state: str, **fields: Any) -> dict[str, Any]:
        if state not in _STATE_ORDER:
            raise ValueError(f"unknown Web Worker state: {state}")
        current = self.read_state(request.request_id)
        if current is not None:
            previous = current.get("state")
            retry_after_rejected_artifact = (
                previous == ARTIFACT_FOUND
                and state == WAITING_ASSISTANT
                and isinstance(current.get("artifactValidation"), dict)
                and current["artifactValidation"].get("code") == artifact_download.ARTIFACT_INVALID
                and current["artifactValidation"].get("recoverable") is True
            )
            if (
                previous in _STATE_ORDER
                and _STATE_ORDER.index(state) < _STATE_ORDER.index(previous)
                and not retry_after_rejected_artifact
                and not (previous == IMAGE_TURN_COMPLETED and state == WAITING_ASSISTANT)
            ):
                raise ValueError(f"state cannot move backwards from {previous} to {state}")
        record = {
            **(current or {}),
            "protocolVersion": 1,
            "requestId": request.request_id,
            "workerJobId": request.worker_job_id,
            "taskUrl": request.task_url,
            "resultPath": str(self.result_path(request.request_id)),
            "state": state,
            "updatedAt": self.now(),
            **fields,
        }
        _atomic_json(self.state_path(request.request_id), record)
        return record

    def accept_request(self, request_id: str, task_url: str) -> dict[str, Any]:
        """Persist ACCEPTED before a browser job is started.

        The planned request-scoped result path is returned immediately. It is a
        path, not proof of completion; RESULT_DURABLE is recorded only after P6
        has published the validated result.
        """
        try:
            request_identity.assert_canonical_request_id(request_id)
        except (TypeError, ValueError) as exc:
            return _result(BRIDGE_INVALID_REQUEST, ok=False, details={"reason": str(exc)})
        if not _valid_task_url(task_url):
            return _result(BRIDGE_INVALID_TASK_URL, ok=False)

        request = BridgeRequest(
            request_id=request_id,
            task_url=task_url.strip(),
            result_path=str(self.result_path(request_id)),
            worker_job_id=_job_id(request_id),
        )
        existing = self.read_state(request_id)
        if existing is not None:
            return {
                "ok": existing.get("state") in _STATE_ORDER,
                "code": existing.get("state", BRIDGE_INVALID_CONFIG),
                "details": existing,
            }
        record = self._write_state(request, ACCEPTED)
        return {
            "ok": True,
            "code": ACCEPTED,
            "details": {
                "requestId": request_id,
                "workerJobId": request.worker_job_id,
                "state": ACCEPTED,
                "resultPath": record["resultPath"],
                "resultDurableState": RESULT_DURABLE,
            },
        }

    def run_request(
        self,
        request_id: str,
        *,
        task_url: str,
        prompt: str,
        expected_filename: str,
        expected_request: dict[str, Any],
        conversation_url: str | None = None,
        cdp_url: str = browser_bootstrap.DEFAULT_CDP_URL,
        timeout_ms: int = browser_submit.DEFAULT_TIMEOUT_MS,
        observer_timeout_ms: int = reminder_policy.DEFAULT_OVERALL_TIMEOUT_MS,
        stable_ms: int = browser_observer.DEFAULT_STABLE_MS,
        reminder_interval_ms: int = reminder_policy.DEFAULT_REMINDER_INTERVAL_MS,
        max_reminders: int = reminder_policy.DEFAULT_REMINDER_COUNT,
        download_timeout_ms: int = artifact_download.DEFAULT_DOWNLOAD_TIMEOUT_MS,
        click_timeout_ms: int = artifact_download.DEFAULT_CLICK_TIMEOUT_MS,
        browser_download_dir: str = artifact_download.DEFAULT_BROWSER_DOWNLOAD_DIR,
        playwright_factory: Callable[[], Any] | None = None,
        validator_runner: Callable[[Path, dict[str, Any]], dict[str, Any]] | None = None,
        image_prepare: Callable[[], dict[str, Any]] | None = None,
        input_attachment=None,
        resume_image: bool = False,
        image_recovery_proof: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Run one browser page; image mode continues to ZIP on that same page."""
        if input_attachment is not None and (input_attachment.request_id != request_id or
                (image_prepare is not None and input_attachment.media_type not in input_bundle.IMAGE_EXTENSIONS)):
            return _result(BRIDGE_INVALID_CONFIG, ok=False, details={"reason": "input_attachment_binding_invalid"})
        image_stage = image_prepare is not None
        image_flow = image_stage or image_recovery_proof is not None
        if image_stage:
            try:
                request_identity.assert_canonical_request_id(request_id)
            except (TypeError, ValueError) as exc:
                return _result(BRIDGE_INVALID_REQUEST, ok=False, details={"reason": str(exc)})
            # No task URL exists yet, but the preparatory turn owns this
            # persisted worker identity. Never resend after restart or uncertainty.
            existing = self.read_state(request_id)
            if resume_image:
                failure = (existing or {}).get("imageResumeOriginalFailure") or (existing or {}).get("failureDetails", {})
                retry_read = (existing or {}).get("lastError") == "image_resume_send_unproven"
                proof = failure if retry_read else failure.get("details", {})
                if (not input_attachment or not conversation_url or not existing
                        or existing.get("exactPromptText") != prompt
                        or (not retry_read and failure.get("code") != browser_submit.PROMPT_SEND_UNKNOWN)
                        or (not retry_read and failure.get("sendState") != browser_submit.SEND_UNKNOWN)
                        or proof.get("chatUrl") != conversation_url
                        or proof.get("exactUserTurn") is not True
                        or proof.get("userTurnCountBefore") != 0
                        or proof.get("userTurnCountNow") != 1
                        or proof.get("inputBundle") != input_attachment.metadata()):
                    return _result(BRIDGE_INVALID_CONFIG, ok=False,
                                   details={"reason": "image_resume_binding_invalid"})
            elif existing is not None:
                return {"ok": existing.get("state") in _STATE_ORDER,
                        "code": existing.get("state", BRIDGE_INVALID_CONFIG), "details": existing}
            request = BridgeRequest(request_id, "", str(self.result_path(request_id)), _job_id(request_id))
            if not resume_image:
                self._write_state(request, ACCEPTED)
        else:
            accepted = self.accept_request(request_id, task_url)
            if not accepted["ok"]:
                return accepted
            if accepted["details"].get("state") != ACCEPTED:
                return accepted
            request = BridgeRequest(request_id, task_url.strip(), accepted["details"]["resultPath"], accepted["details"]["workerJobId"])
        if not isinstance(prompt, str) or not prompt:
            return _result(BRIDGE_INVALID_CONFIG, ok=False, details={"reason": "prompt_empty"})
        if not isinstance(expected_request, dict):
            return _result(BRIDGE_INVALID_CONFIG, ok=False, details={"reason": "expected_request_not_object"})
        if conversation_url is not None and not browser_submit.is_bound_chat_url(conversation_url):
            return _result(BRIDGE_INVALID_CONFIG, ok=False, details={"reason": "invalid_conversation_url"})
        if isinstance(observer_timeout_ms, bool) or not isinstance(observer_timeout_ms, int) or observer_timeout_ms <= 0:
            return _result(BRIDGE_INVALID_CONFIG, ok=False, details={"reason": "observer_timeout_ms_invalid"})
        if isinstance(reminder_interval_ms, bool) or not isinstance(reminder_interval_ms, int) or reminder_interval_ms <= 0:
            return _result(BRIDGE_INVALID_CONFIG, ok=False, details={"reason": "reminder_interval_ms_invalid"})
        if isinstance(max_reminders, bool) or not isinstance(max_reminders, int) or max_reminders < 0:
            return _result(BRIDGE_INVALID_CONFIG, ok=False, details={"reason": "max_reminders_invalid"})

        self._write_state(request, WEB_STARTING, exactPromptText=prompt,
                          repository=expected_request.get("repository"),
                          promptSha256=browser_submit.prompt_sha256(prompt))
        factory = playwright_factory
        if factory is None:
            try:
                factory = browser_bootstrap._load_sync_playwright()
            except Exception as exc:
                return self._fail(request, str(exc), code=BRIDGE_PIPELINE_FAILED)

        browser = context = page = None
        owns_context = False
        terminal_result: dict[str, Any] | None = None
        control = None
        cleanup: dict[str, Any] = {}
        try:
            with ExitStack() as stack:
                artifacts_dir = stack.enter_context(cdp_download.temporary_artifacts_dir())
                playwright = stack.enter_context(cdp_download.locked_playwright(factory))
                normalized = browser_bootstrap.normalize_cdp_url(cdp_url)
                browser = cdp_download.connect_over_cdp(playwright, normalized, artifacts_dir=artifacts_dir)
                contexts = list(browser.contexts)
                if contexts:
                    context = contexts[0]
                else:
                    context = browser.new_context()
                    owns_context = True

                def close_owned_resources() -> None:
                    diagnostic = getattr(page, "_postman_page_diagnostic", None)
                    if isinstance(diagnostic, dict):
                        diagnostic = {**diagnostic, "url": str(getattr(page, "url", "") or "")}
                    cleanup.clear()
                    cleanup.update(_close_owned_page(page))
                    if isinstance(diagnostic, dict):
                        diagnostic = {**diagnostic, "closedAt": time.time(), "ownedPageClosed": cleanup["ownedPageClosed"]}
                        cleanup["pageDiagnostic"] = diagnostic
                        stored = self.read_state(request_id) or {}
                        _atomic_json(self.state_path(request_id), {**stored, "browserCleanup": cleanup, "pageDiagnostic": diagnostic})
                    if owns_context and context is not None:
                        try:
                            context.close()
                            cleanup["ownedContextClosed"] = True
                        except Exception as exc:
                            cleanup["ownedContextClosed"] = False
                            cleanup["contextCloseError"] = str(exc)[:500]
                    else:
                        cleanup["ownedContextClosed"] = False

                # Registered after Playwright enter_context: LIFO cleanup closes the
                # owned Page/context while the CDP connection is still alive.
                stack.callback(close_owned_resources)
                page = context.new_page()
                diagnostic = browser_submit._page_diagnostic(page)
                diagnostic["requestId"] = request_id
                try:
                    page._postman_page_diagnostic = diagnostic
                except (AttributeError, TypeError):
                    pass
                self._write_state(request, WEB_STARTING, pageDiagnostic=diagnostic)

                if image_recovery_proof is not None:
                    # Re-prove the original image read-only; never adopt the latest image.
                    prepared = browser_submit.prepare_existing_chat(page, conversation_url, timeout_ms=timeout_ms)
                    saved = image_recovery_proof.get("observerProof", {})
                    saved_details = saved.get("details", {})
                    original_prompt = image_recovery_proof.get("prompt")
                    binding = image_recovery_proof.get("anchorBinding")
                    if not prepared.get("ok") or not isinstance(original_prompt, str) or not saved_details.get("assistantIdentity"):
                        return self._fail(request, "IMAGE_PACKAGING_REPROOF_FAILED")
                    observed = browser_observer.observe_next_assistant(page, original_prompt, conversation_url,
                        image_mode=True, historical_image=True, anchor_binding=binding, timeout_ms=timeout_ms, stable_ms=stable_ms,
                        sleep=self.sleep, monotonic=self.monotonic)
                    observed_details = observed.get("details", {})
                    identity = saved_details["assistantIdentity"]
                    if (not observed.get("ok") or observed_details.get("assistantImageCount") != 1
                            or observed_details.get("assistantIndex") != saved_details.get("assistantIndex")
                            or any(observed_details.get("assistantIdentity", {}).get(key) != value for key, value in identity.items())):
                        return self._fail(request, "IMAGE_PACKAGING_REPROOF_FAILED")
                    self._write_state(request, WEB_STARTING, imageObserverProof=observed,
                                      imageOriginalPrompt=original_prompt, imageAnchorBinding=binding)
                if resume_image:
                    # Explicit recovery only: no upload, fill or Send on the first turn.
                    prepared = browser_submit.prepare_existing_chat(
                        page, conversation_url, timeout_ms=timeout_ms)
                    if not prepared.get("ok"):
                        return self._fail(request, prepared.get("code", "image_resume_chat_unproven"),
                                          details=prepared)
                    self._write_state(request, WEB_STARTING, imageResumeOriginalFailure=failure)
                    proven, reproved = browser_submit._wait_until(
                        lambda: browser_submit._observe_send_proof(
                            page, prompt, 0, conversation_url=conversation_url,
                            input_attachment=input_attachment), timeout_ms=timeout_ms)
                    if not proven:
                        return self._fail(request, "image_resume_send_unproven", details=reproved)
                    submitted = {"ok": True, "code": browser_submit.PROMPT_SEND_CONFIRMED,
                                 "sendState": browser_submit.SEND_PROVEN_SENT,
                                 "transitions": [browser_submit.PROMPT_SEND_CONFIRMED],
                                 "details": {**reproved, "resumeReadOnly": True,
                                             "promptSha256": browser_submit.prompt_sha256(prompt)}}
                elif conversation_url is None:
                    # Image creation can delay the first /c/... URL after the user turn appears.
                    submitted = browser_submit.submit_fresh_prompt(
                        page, prompt, **({"input_attachment": input_attachment} if input_attachment else {}),
                        timeout_ms=max(timeout_ms, 90_000) if image_stage else timeout_ms)
                else:
                    submitted = browser_submit.submit_existing_prompt(
                        page, prompt, conversation_url, timeout_ms=timeout_ms,
                        **({"input_attachment": input_attachment} if input_attachment else {})
                    )
                self._write_state(request, WEB_STARTING, submitProof=submitted)
                if not submitted.get("ok"):
                    evidence = submitted.get("details", {})
                    bound = evidence.get("chatUrl")
                    before = evidence.get("userTurnCountBefore")
                    if (submitted.get("sendState") == browser_submit.SEND_UNKNOWN and type(before) is int
                            and browser_submit.is_bound_chat_url(bound)):
                        # One read-only reproof; no upload, fill, click, or repeat Send.
                        proven, proof = browser_submit._wait_until(lambda: browser_submit._observe_send_proof(
                            page, prompt, before, conversation_url=bound, input_attachment=input_attachment),
                            timeout_ms=min(timeout_ms, 5000))
                        if proven:
                            self._write_state(request, WEB_STARTING, readOnlySendReproof={
                                "requestId": request_id, "conversationUrl": bound,
                                "conversationId": browser_submit.conversation_id_from_url(bound),
                                "promptSha256": browser_submit.prompt_sha256(prompt), "exactUserTurn": True})
                    return self._fail(request, submitted.get("code", "submit_failed"), details=submitted)
                if input_attachment and (submitted.get("sendState") != browser_submit.SEND_PROVEN_SENT or
                        submitted.get("details", {}).get("sentAttachmentConfirmed") is not True):
                    return self._fail(request, "POSTMAN_SENT_ATTACHMENT_PROOF_UNKNOWN", details={
                        **submitted, "sendState": browser_submit.SEND_UNKNOWN})
                chat_url = submitted.get("details", {}).get("chatUrl")
                if not isinstance(chat_url, str) or not browser_submit.is_bound_chat_url(chat_url):
                    return self._fail(request, "submit did not bind a chat URL", details=submitted)
                conversation_id = browser_submit.conversation_id_from_url(chat_url)
                self._write_state(
                    request,
                    PROMPT_SENT,
                    submitProof=submitted,
                    conversationUrl=chat_url,
                    conversationId=conversation_id,
                    continuedConversation=conversation_url is not None,
                )

                started_at = self.monotonic()
                deadline = started_at + observer_timeout_ms / 1000.0
                reminder_records: list[dict[str, Any]] = []
                reminder_index = 0
                next_reminder_retry = 0.0
                phase_tracker = browser_observer.AnswerPhaseTracker()
                last_answer_phase: dict[str, Any] = {}
                followup_reminders = max_reminders
                if image_stage:
                    max_reminders = 0
                initial_binding = None
                if image_stage:
                    turns, _ = browser_observer.snapshot_turns(page, image_mode=True)
                    users = [t for t in turns if t.get("role") == "user"]
                    ordinal = submitted.get("details", {}).get("userTurnCountBefore")
                    if type(ordinal) is int and ordinal == len(users) - 1:
                        initial_binding = {"userOrdinal": ordinal, "precedingUserHashes": [browser_submit.prompt_sha256(t["text"]) for t in users[:ordinal]],
                                           "promptSha256": browser_submit.prompt_sha256(prompt), "groupKey": users[ordinal].get("groupKey", "")}
                watched_turns: list[dict[str, Any]] = [
                    {
                        "prompt": prompt,
                        "submit": submitted,
                        "anchorBinding": initial_binding,
                        "proof": None,
                        "everProved": False,
                        "artifactRejected": False,
                        "noArtifactSince": None,
                    }
                ]
                next_result_recheck = started_at + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                control = transport_control.TransportControl(
                    request_id, chat_url, started_at, observer_timeout_ms,
                    reminder_interval_ms, max_reminders, monotonic=self.monotonic)
                pending_control = None
                result_scan_only = False
                last_recovery: dict[str, Any] | None = None
                last_observer_code = ""
                last_artifact_code = ""
                reminder_policy_record = {
                    "intervalMs": reminder_interval_ms,
                    "maxReminders": max_reminders,
                    "overallTimeoutMs": observer_timeout_ms,
                }
                recovery_policy_record = {
                    "generationPollMs": browser_observer.DEFAULT_POLL_MS,
                    "resultRecheckMs": _RESULT_RECHECK_INTERVAL_MS,
                    "reloadLoadTimeoutMs": browser_recovery.DEFAULT_LOAD_TIMEOUT_MS,
                    "reloadSettleMs": 0,
                    "reloadMaxAttempts": 1,
                    "recoveryGraceMs": transport_control.RECOVERY_GRACE_MS,
                    "recoveryCycleMs": transport_control.RECOVERY_CYCLE_MS,
                }

                def remaining_ms() -> int:
                    return control.recovery_remaining_ms() if control.active else max(0, int((deadline - self.monotonic()) * 1000.0))

                def clear_observer_proofs() -> None:
                    for watch in watched_turns:
                        if not watch.get("artifactRejected"):
                            watch["proof"] = None
                            watch["noArtifactSince"] = None

                def waiting_state() -> None:
                    fields: dict[str, Any] = {
                        "reminderPolicy": reminder_policy_record,
                        "browserRecoveryPolicy": recovery_policy_record,
                        "reminders": reminder_records,
                        "lastObserverCode": last_observer_code,
                        "answerPhase": last_answer_phase,
                        "lastArtifactCode": last_artifact_code,
                        **control.snapshot(),
                    }
                    if last_recovery is not None:
                        fields["lastBrowserRecovery"] = last_recovery
                    self._write_state(request, WAITING_ASSISTANT, **fields)

                def recovery_event(name, **fields):
                    control.event(name, **fields)
                    waiting_state()

                def probe_system():
                    nonlocal pending_control
                    if result_scan_only:
                        return None
                    if pending_control and not control.active:
                        return pending_control[0]
                    selected = None
                    for kind, detector in ((browser_observer.ASSISTANT_CONNECTION_INTERRUPTED, browser_observer.connection_interrupted),
                                           (browser_observer.ADDITIONAL_PROCESSING, browser_observer.additional_processing)):
                        accepted, evidence = detector(page)
                        event_id = control.candidate(kind, accepted, evidence)
                        if event_id and selected is None:
                            selected = (kind, event_id)
                    if selected and not control.active:
                        pending_control = selected
                        return selected[0]
                    return None

                def add_control_watch(intent, sent):
                    nonlocal phase_tracker
                    binding = transport_control.confirmed_binding(page, intent, sent)
                    watched_turns.append({"prompt": intent["exactPromptText"], "submit": sent,
                                          "anchorBinding": binding, "controlIntent": intent,
                                          "proof": None, "everProved": False,
                                          "artifactRejected": False, "noArtifactSince": None})
                    phase_tracker = browser_observer.AnswerPhaseTracker()
                    control.event("CONTROL_SEND_CONFIRMED", slot=intent.get("slot"),
                                  recoveryEventId=intent.get("recoveryEventId"),
                                  proof=sent, anchorBinding=binding)

                def observe_watch(watch: dict[str, Any], timeout_for_observer_ms: int) -> dict[str, Any]:
                    nonlocal last_observer_code, last_answer_phase, pending_control
                    if watch.get("artifactRejected"):
                        return {"kind": "no_result"}
                    if timeout_for_observer_ms <= 0:
                        return {"kind": "pending"}
                    completed = browser_observer.observe_next_assistant(
                        page,
                        str(watch["prompt"]),
                        chat_url,
                        timeout_ms=timeout_for_observer_ms,
                        stable_ms=stable_ms,
                        sleep=self.sleep,
                        monotonic=self.monotonic,
                        system_probe=probe_system,
                        **({"anchor_binding": watch["anchorBinding"]} if watch.get("anchorBinding") else {}),
                        **({"image_mode": True} if image_stage else {"phase_tracker": phase_tracker if watch is watched_turns[-1] else watch.setdefault("phaseTracker", browser_observer.AnswerPhaseTracker())}),
                    )
                    completed = _attach_submit_proof(
                        completed,
                        prompt=str(watch["prompt"]),
                        submitted=watch["submit"],
                    )
                    if watch.get("controlIntent"):
                        completed["details"]["controlIntent"] = watch["controlIntent"]
                        completed["details"]["anchorBinding"] = watch["anchorBinding"]
                    last_observer_code = str(completed.get("code", ""))
                    observed_details = completed.get("details") if isinstance(completed.get("details"), dict) else {}
                    if isinstance(observed_details.get("answerPhase"), dict):
                        last_answer_phase = observed_details["answerPhase"]
                        if last_answer_phase.get("phase") in {browser_observer.FINAL_ANSWER_STARTED, browser_observer.FINAL_ANSWER_COMPLETED}:
                            if not control.active:
                                control.transition(last_answer_phase["phase"])
                            control.cancel_slots("SUPPRESSED_FINAL")
                    elif completed.get("code") == browser_observer.ADDITIONAL_PROCESSING:
                        last_answer_phase = observed_details
                    if completed.get("code") in {browser_observer.ASSISTANT_CONNECTION_INTERRUPTED, browser_observer.ADDITIONAL_PROCESSING}:
                        if not control.active:
                            if pending_control is None:
                                # The observer may have detected an event between outer polls.
                                kind = completed["code"]
                                event_id = control.candidate(kind, True, {"candidateCount": 1, "source": "observer_signal"})
                                if event_id:
                                    pending_control = (kind, event_id)
                            return {"kind": "interrupted", "details": completed}
                        return {"kind": "pending"}
                    if completed.get("ok"):
                        watch["proof"] = completed
                        watch["everProved"] = True
                        watch["noArtifactSince"] = None
                        return {"kind": "proof"}
                    if completed.get("code") in _NONTERMINAL_OBSERVER_CODES or completed.get("code") == browser_observer.ADDITIONAL_PROCESSING:
                        return {"kind": "pending"}
                    return {
                        "kind": "fatal",
                        "result": self._fail(
                            request,
                            completed.get("code", "observer_failed"),
                            details=completed,
                        ),
                    }

                def completed_turn_fields(completed: dict[str, Any]) -> dict[str, Any]:
                    details = completed.get("details") if isinstance(completed.get("details"), dict) else {}
                    assistant_index = details.get("assistantIndex")
                    return {
                        "assistantText": str(details.get("assistantText", "")),
                        "assistantTextSha256": str(details.get("assistantTextSha256", "")),
                        "assistantIndex": assistant_index if isinstance(assistant_index, int) and not isinstance(assistant_index, bool) else None,
                        "conversationUrl": chat_url,
                        "conversationId": conversation_id,
                        "expectedFilename": expected_filename,
                    }

                def observer_proof_sha(proof: object) -> str:
                    if not isinstance(proof, dict):
                        return ""
                    details = proof.get("details") if isinstance(proof.get("details"), dict) else {}
                    value = details.get("assistantTextSha256")
                    return value if isinstance(value, str) else ""

                def inspect_watch(watch: dict[str, Any]) -> dict[str, Any]:
                    nonlocal last_artifact_code, terminal_result, image_stage, request, prompt
                    nonlocal expected_filename, expected_request, max_reminders, reminder_index
                    nonlocal started_at, deadline, next_result_recheck, control, phase_tracker, pending_control
                    completed = watch.get("proof")
                    if watch.get("artifactRejected") or not isinstance(completed, dict):
                        return {"kind": "no_result"}

                    if image_stage:
                        image_details = completed.get("details") if isinstance(completed.get("details"), dict) else {}
                        if (type(image_details.get("assistantImageCount")) is not int
                                or image_details["assistantImageCount"] != 1):
                            return {"kind": "fatal", "result": self._fail(
                                request, "image preparatory turn did not prove exactly one ready image",
                                details={"imageObserverProof": completed})}
                        self._write_state(request, IMAGE_TURN_COMPLETED,
                                          imageObserverProof=completed, imageOriginalPrompt=prompt,
                                          imageAnchorBinding=watch.get("anchorBinding"), conversationUrl=chat_url,
                                          conversationId=conversation_id)
                        try:
                            packaging = image_prepare()
                        except Exception as exc:
                            return {"kind": "fatal", "result": self._fail(
                                request, "image packaging task preparation failed",
                                details={"reason": str(exc)[:500]})}
                        if not isinstance(packaging, dict):
                            return {"kind": "fatal", "result": self._fail(
                                request, "image packaging config is not an object")}
                        packaging_task_url = packaging.get("task_url")
                        packaging_prompt = packaging.get("prompt")
                        packaging_filename = packaging.get("expected_filename")
                        packaging_expected = packaging.get("expected_request")
                        if (not _valid_task_url(packaging_task_url)
                                or not isinstance(packaging_prompt, str) or not packaging_prompt
                                or not isinstance(packaging_filename, str) or not packaging_filename
                                or not isinstance(packaging_expected, dict)
                                or packaging_expected.get("requestId") != request_id):
                            return {"kind": "fatal", "result": self._fail(
                                request, "image packaging config is invalid", details={"packaging": packaging})}
                        request = BridgeRequest(
                            request_id, str(packaging_task_url), str(self.result_path(request_id)), _job_id(request_id))
                        self._write_state(request, WAITING_ASSISTANT, exactPromptText=packaging_prompt,
                                          promptSha256=browser_submit.prompt_sha256(packaging_prompt))
                        self.random_pause()  # Published task and prompt are ready; next action is Web send.
                        followup_submit = browser_submit.submit_existing_prompt(
                            page, packaging_prompt, chat_url, timeout_ms=timeout_ms,
                            navigate=False,
                        )
                        if not followup_submit.get("ok"):
                            return {"kind": "fatal", "result": self._fail(
                                request, followup_submit.get("code", "image_packaging_submit_failed"),
                                details=followup_submit)}
                        followup_url = followup_submit.get("details", {}).get("chatUrl")
                        if followup_url != chat_url:
                            return {"kind": "fatal", "result": self._fail(
                                request, "image follow-up changed conversation", details=followup_submit)}
                        image_stage = False
                        prompt = packaging_prompt
                        expected_filename = packaging_filename
                        expected_request = packaging_expected
                        max_reminders = followup_reminders
                        reminder_index = 0
                        phase_tracker = browser_observer.AnswerPhaseTracker()
                        started_at = self.monotonic()
                        deadline = started_at + observer_timeout_ms / 1000.0
                        previous_journal = control.snapshot()
                        control = transport_control.TransportControl(
                            request_id, chat_url, started_at, observer_timeout_ms,
                            reminder_interval_ms, max_reminders, monotonic=self.monotonic)
                        control.event("PREVIOUS_STAGE", summary=previous_journal)
                        pending_control = None
                        next_result_recheck = started_at + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                        reminder_policy_record["maxReminders"] = max_reminders
                        watched_turns[:] = [{"prompt": prompt, "submit": followup_submit,
                                             "proof": None, "everProved": False,
                                             "artifactRejected": False, "noArtifactSince": None}]
                        self._write_state(request, WAITING_ASSISTANT,
                                          followupSubmitProof=followup_submit,
                                          imageObserverProof=completed)
                        return {"kind": "continued"}

                    reproofed = False
                    proof_changed = False
                    no_artifact_since = watch.get("noArtifactSince")
                    if no_artifact_since is not None and (
                        self.monotonic() - float(no_artifact_since) >= _RESULT_RECHECK_INTERVAL_MS / 1000.0
                    ):
                        previous_proof = watch.get("proof")
                        watch["proof"] = None
                        observed = observe_watch(watch, min(_REPROVE_TIMEOUT_MIN_MS, remaining_ms()))
                        if observed["kind"] in {"fatal", "interrupted"}:
                            return observed
                        if observed["kind"] != "proof":
                            return {"kind": "no_result"}
                        completed = watch.get("proof")
                        if not isinstance(completed, dict):
                            return {"kind": "no_result"}
                        reproofed = True
                        proof_changed = (
                            bool(observer_proof_sha(previous_proof))
                            and observer_proof_sha(previous_proof) != observer_proof_sha(completed)
                        )

                    detected = artifact_detector.detect_artifact_dom(
                        page,
                        expected_prompt=str(watch["prompt"]),
                        expected_chat_url=chat_url,
                        request_id=request_id,
                        expected_filename=expected_filename,
                        completed_observer_result=completed,
                    )
                    last_artifact_code = str(detected.get("code", ""))
                    if detected.get("ok"):
                        self._write_state(
                            request,
                            ARTIFACT_FOUND,
                            observerProof=completed,
                            artifactProof=detected,
                            reminderPolicy=reminder_policy_record,
                            browserRecoveryPolicy=recovery_policy_record,
                            reminders=reminder_records,
                        )
                        if image_flow:
                            self.random_pause()  # Exactly one pause after ZIP-ready proof, before download.
                        durable = artifact_download.download_validated_artifact(
                            page,
                            expected_prompt=str(watch["prompt"]),
                            expected_chat_url=chat_url,
                            request_id=request_id,
                            expected_filename=expected_filename,
                            completed_observer_result=completed,
                            artifact_dom_result=detected,
                            expected_request=expected_request,
                            result_root=self.result_root,
                            browser_download_dir=browser_download_dir,
                            cdp_artifacts_dir=artifacts_dir,
                            download_timeout_ms=download_timeout_ms,
                            click_timeout_ms=click_timeout_ms,
                            validator_runner=validator_runner,
                        )
                        if durable.get("code") != artifact_download.RESULT_DURABLE:
                            durable_details = durable.get("details") if isinstance(durable.get("details"), dict) else {}
                            if (
                                durable.get("code") == artifact_download.ARTIFACT_INVALID
                                and durable_details.get("phase") == "validator"
                            ):
                                validation_code = str(durable_details.get("validatorCode", artifact_download.ARTIFACT_INVALID))
                                validation_message = str(
                                    durable_details.get("validationMessage")
                                    or durable_details.get("reason")
                                    or validation_code
                                )
                                record = self._write_state(
                                    request,
                                    ARTIFACT_REJECTED,
                                    artifactValidation=durable,
                                    validationCode=validation_code,
                                    validationMessage=validation_message,
                                    validationDetails=durable_details.get("validationDetails", {}),
                                    reminderPolicy=reminder_policy_record,
                                    browserRecoveryPolicy=recovery_policy_record,
                                    reminders=reminder_records,
                                    **completed_turn_fields(completed),
                                )
                                terminal_result = {"ok": True, "code": ARTIFACT_REJECTED, "details": record}
                                return {"kind": "terminal", "result": terminal_result}
                            return {
                                "kind": "fatal",
                                "result": self._fail(
                                    request,
                                    durable.get("code", "download_failed"),
                                    details=durable,
                                ),
                            }

                        if control.active:
                            control.finish_recovery(RESULT_DURABLE, status="ABORTED", reason="result_preempted_recovery")
                        control.cancel_slots("CANCELLED_RESULT_READY")
                        control.transition("FINAL_ANSWER_COMPLETED")
                        control.event("RESULT_DURABLE_FOUND", result=durable)
                        record = self._write_state(
                            request,
                            RESULT_DURABLE,
                            resultPath=durable.get("details", {}).get("resultDirectory", request.result_path),
                            resultZip=durable.get("details", {}).get("resultZip"),
                            resultSha256=durable.get("details", {}).get("sha256"),
                            durableProof=durable,
                            **control.snapshot(),
                            conversationUrl=chat_url,
                            conversationId=conversation_id,
                            reminderPolicy=reminder_policy_record,
                            browserRecoveryPolicy=recovery_policy_record,
                            reminders=reminder_records,
                        )
                        terminal_result = {"ok": True, "code": RESULT_DURABLE, "details": record}
                        if self.on_result_durable is not None and not image_flow:
                            self.on_result_durable(terminal_result)
                        return {"kind": "terminal", "result": terminal_result}

                    artifact_code = detected.get("code")
                    artifact_details = detected.get("details") if isinstance(detected.get("details"), dict) else {}
                    if (
                        artifact_code == artifact_detector.ARTIFACT_TURN_IDENTITY_MISMATCH
                        and artifact_details.get("reason") == "assistant_text_changed_after_completed_proof"
                    ):
                        watch["proof"] = None
                        watch["noArtifactSince"] = None
                        return {"kind": "stale_proof"}
                    if artifact_code == artifact_detector.ARTIFACT_TURN_NOT_COMPLETED:
                        watch["proof"] = None
                        watch["noArtifactSince"] = None
                        return {"kind": "pending"}
                    if (
                        artifact_code == artifact_detector.ARTIFACT_CHAT_CORRELATION_LOST
                        and artifact_details.get("observerCode") in {
                            browser_observer.USER_TURN_ANCHOR_MISSING,
                            browser_observer.ASSISTANT_NOT_STARTED,
                            browser_observer.ASSISTANT_STATE_UNKNOWN,
                        }
                    ):
                        watch["proof"] = None
                        watch["noArtifactSince"] = None
                        return {"kind": "pending"}
                    if artifact_code in _FATAL_ARTIFACT_CODES:
                        return {
                            "kind": "fatal",
                            "result": self._fail(
                                request,
                                artifact_code or "artifact_not_found",
                                details=detected,
                            ),
                        }
                    if artifact_code in _REMINDER_ELIGIBLE_ARTIFACT_CODES:
                        now = self.monotonic()
                        no_artifact_since = watch.get("noArtifactSince")
                        if proof_changed:
                            watch["noArtifactSince"] = now
                            return {"kind": "no_result"}
                        if no_artifact_since is None and not reproofed:
                            watch["noArtifactSince"] = now
                            return {"kind": "no_result"}
                        if not reproofed and now - float(no_artifact_since) < _RESULT_RECHECK_INTERVAL_MS / 1000.0:
                            return {"kind": "no_result"}
                        record = self._write_state(
                            request,
                            ASSISTANT_COMPLETED_NO_ARTIFACT,
                            lastArtifactCode=last_artifact_code,
                            noArtifactRecheckMs=_RESULT_RECHECK_INTERVAL_MS,
                            reminderPolicy=reminder_policy_record,
                            browserRecoveryPolicy=recovery_policy_record,
                            reminders=reminder_records,
                            **completed_turn_fields(completed),
                        )
                        terminal_result = {
                            "ok": True,
                            "code": ASSISTANT_COMPLETED_NO_ARTIFACT,
                            "details": record,
                        }
                        return {"kind": "terminal", "result": terminal_result}
                    return {
                        "kind": "fatal",
                        "result": self._fail(
                            request,
                            artifact_code or "artifact_not_found",
                            details=detected,
                        ),
                    }

                def scan_watches(*, skip_latest_missing: bool) -> dict[str, Any]:
                    latest = watched_turns[-1]
                    reprove_timeout_ms = max(
                        _REPROVE_TIMEOUT_MIN_MS,
                        int(stable_ms) + browser_observer.DEFAULT_POLL_MS,
                    )
                    for watch in reversed(watched_turns):
                        if watch.get("artifactRejected"):
                            continue
                        outcome = inspect_watch(watch)
                        if outcome["kind"] in {"terminal", "fatal", "interrupted", "continued"}:
                            return outcome
                        if watch.get("proof") is None:
                            if skip_latest_missing and watch is latest:
                                continue
                            # An older anchor that never produced a completed assistant turn
                            # has nothing to re-prove. Re-observing it at reminder time only
                            # delays the absolute 10/20/30 schedule. Previously proved turns
                            # remain eligible for re-proof after reload/text changes.
                            if watch is not latest and not watch.get("everProved"):
                                continue
                            timeout_for_watch = min(reprove_timeout_ms, remaining_ms())
                            observed = observe_watch(watch, timeout_for_watch)
                            if observed["kind"] in {"fatal", "interrupted"}:
                                return observed
                            if observed["kind"] == "proof":
                                outcome = inspect_watch(watch)
                                if outcome["kind"] in {"terminal", "fatal", "interrupted", "continued"}:
                                    return outcome
                    return {"kind": "no_result"}

                self._write_state(
                    request,
                    WAITING_ASSISTANT,
                    reminderPolicy=reminder_policy_record,
                    browserRecoveryPolicy=recovery_policy_record,
                    reminders=reminder_records,
                )

                while True:
                    now = self.monotonic()
                    pending_eligible = pending_control and control.can_begin_recovery(*pending_control)
                    if now >= deadline and not pending_eligible and not (control.active and remaining_ms() > 0):
                        control.transition("TIMEOUT")
                        control.event("SOFT_DEADLINE_TIMEOUT")
                        terminal_result = self._fail(
                            request,
                            browser_observer.ASSISTANT_TURN_TIMEOUT,
                            details={
                                "lastObserverCode": last_observer_code,
                                "lastArtifactCode": last_artifact_code,
                                "lastBrowserRecovery": last_recovery,
                                "reminderPolicy": reminder_policy_record,
                                "browserRecoveryPolicy": recovery_policy_record,
                                "reminders": reminder_records,
                                **control.snapshot(),
                            },
                        )
                        return terminal_result

                    signal = probe_system()
                    if signal and pending_control:
                        kind, event_id = pending_control
                        pending_control = None
                        if not control.begin_recovery(kind, event_id):
                            continue
                        latest = watched_turns[-1]
                        # Result always wins before reload. One best-effort reload per banner.
                        result_scan_only = True
                        try:
                            scanned = scan_watches(skip_latest_missing=False)
                        finally:
                            result_scan_only = False
                        if scanned["kind"] in {"terminal", "fatal"}:
                            return scanned["result"]
                        last_recovery = browser_recovery.recover_interrupted_chat(
                            page, chat_url, str(latest["prompt"]), original_prompt=prompt,
                            anchor_binding=latest.get("anchorBinding"), budget_ms=max(1, remaining_ms()),
                            max_attempts=1, settle_ms=0, retry_delays_ms=(),
                            sleep=self.sleep, monotonic=self.monotonic, on_event=recovery_event)
                        clear_observer_proofs()
                        control.finish_recovery(last_recovery.get("code"))
                        next_result_recheck = self.monotonic()
                        waiting_state()
                        continue

                    while reminder_index < max_reminders and control.slots[reminder_index]["status"] != "PENDING":
                        reminder_index += 1

                    next_due = None
                    if reminder_index < max_reminders:
                        next_due = max(next_reminder_retry, started_at + (
                            reminder_policy.scheduled_elapsed_ms(
                                reminder_index + 1,
                                interval_ms=reminder_interval_ms,
                            )
                            / 1000.0
                        ))

                    latest_watch = watched_turns[-1]
                    latest_observed_this_cycle = False
                    now = self.monotonic()
                    next_event = min(
                        deadline,
                        next_result_recheck,
                        next_due if next_due is not None else deadline,
                    )

                    if latest_watch.get("proof") is None and not latest_watch.get("artifactRejected") and next_event > now:
                        timeout_for_latest = max(1, int((next_event - now) * 1000.0))
                        observed = observe_watch(latest_watch, timeout_for_latest)
                        latest_observed_this_cycle = True
                        if observed["kind"] == "fatal":
                            return observed["result"]
                        if observed["kind"] == "interrupted":
                            continue
                        if observed["kind"] == "proof":
                            inspected = inspect_watch(latest_watch)
                            if inspected["kind"] == "continued":
                                continue
                            if inspected["kind"] == "terminal":
                                return inspected["result"]
                            if inspected["kind"] == "fatal":
                                return inspected["result"]
                            if inspected["kind"] == "no_result":
                                next_result_recheck = self.monotonic() + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                    elif next_event > now:
                        self.sleep(next_event - now)

                    now = self.monotonic()
                    if now >= deadline:
                        continue

                    due_now = next_due is not None and now >= next_due
                    if due_now:
                        pre_reminder = scan_watches(skip_latest_missing=latest_observed_this_cycle)
                        if pre_reminder["kind"] == "continued":
                            continue
                        if pre_reminder["kind"] == "terminal":
                            return pre_reminder["result"]
                        if pre_reminder["kind"] == "fatal":
                            return pre_reminder["result"]
                        if pre_reminder["kind"] == "interrupted":
                            continue
                        grace_deadlines = [float(w["noArtifactSince"]) + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                                           for w in watched_turns if w.get("proof") is not None and w.get("noArtifactSince") is not None and not w.get("artifactRejected")]
                        if grace_deadlines:
                            self.sleep(min(max(min(grace_deadlines) - self.monotonic(), 0.0), max(deadline - self.monotonic(), 0.0)))
                            continue
                        if probe_system():
                            continue
                        control.event("REMINDER_SLOT_DUE", slot=reminder_index + 1)
                        last_answer_phase = browser_observer.inspect_answer_phase(
                            page, str(watched_turns[-1]["prompt"]), chat_url, tracker=phase_tracker,
                            anchor_binding=watched_turns[-1].get("anchorBinding"))
                        waiting_state()
                        if last_answer_phase["phase"] in {browser_observer.FINAL_ANSWER_STARTED, browser_observer.FINAL_ANSWER_COMPLETED}:
                            next_reminder_retry = self.monotonic() + browser_observer.DEFAULT_POLL_MS / 1000.0
                            if last_answer_phase["phase"] in {browser_observer.FINAL_ANSWER_STARTED, browser_observer.FINAL_ANSWER_COMPLETED}:
                                control.transition(last_answer_phase["phase"])
                                control.cancel_slots("SUPPRESSED_FINAL")
                                next_reminder_retry = deadline
                            else:
                                self.sleep(min(browser_observer.DEFAULT_POLL_MS / 1000.0, max(deadline - self.monotonic(), 0.0)))
                            continue
                        no_artifact_deadlines = [
                            float(watch["noArtifactSince"]) + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                            for watch in watched_turns
                            if watch.get("proof") is not None
                            and watch.get("noArtifactSince") is not None
                            and not watch.get("artifactRejected")
                        ]
                        if no_artifact_deadlines:
                            grace_due = min(no_artifact_deadlines)
                            delay = min(
                                max(grace_due - self.monotonic(), 0.0),
                                max(deadline - self.monotonic(), 0.0),
                            )
                            if delay > 0:
                                self.sleep(delay)
                            continue

                        if last_observer_code in {
                            browser_observer.USER_TURN_ANCHOR_MISSING,
                            browser_observer.ASSISTANT_STATE_UNKNOWN,
                        }:
                            ready = browser_recovery.chat_ready_snapshot(
                                page,
                                chat_url,
                                str(watched_turns[-1]["prompt"]),
                            )
                            if not ready.get("ok"):
                                if ready.get("details", {}).get("connectionInterrupted"):
                                    continue
                                delay = min(
                                    browser_observer.DEFAULT_POLL_MS / 1000.0,
                                    max(deadline - self.monotonic(), 0.0),
                                )
                                if delay > 0:
                                    self.sleep(delay)
                                continue

                        index = reminder_index + 1
                        latest = watched_turns[-1]
                        intent = transport_control.make_intent(
                            page, request_id, chat_url, prompt, str(latest["prompt"]),
                            slot=index, anchor_binding=latest.get("anchorBinding"), randrange=self.randrange)
                        control.intent = intent
                        control.event("REMINDER_SELECTED", **intent)
                        waiting_state()
                        reminder_prompt = intent["exactPromptText"]
                        attempted_elapsed = max(0, int((self.monotonic() - started_at) * 1000.0))
                        reminder_submit = reminder_policy.submit_reminder(
                            page,
                            reminder_prompt,
                            chat_url,
                            timeout_ms=min(timeout_ms, remaining_ms()),
                            sleep=self.sleep, monotonic=self.monotonic, uniform=self.uniform,
                            anchor_prompt=str(watched_turns[-1]["prompt"]),
                            anchor_binding=watched_turns[-1].get("anchorBinding"),
                            phase_tracker=phase_tracker, operation_deadline=deadline, control_intent=intent,
                        )
                        finished_elapsed = max(0, int((self.monotonic() - started_at) * 1000.0))
                        reminder_records.append(
                            _compact_reminder_record(
                                index=index,
                                scheduled_elapsed_ms=reminder_policy.scheduled_elapsed_ms(
                                    index,
                                    interval_ms=reminder_interval_ms,
                                ),
                                attempted_elapsed_ms=attempted_elapsed,
                                finished_elapsed_ms=finished_elapsed,
                                prompt=reminder_prompt,
                                submitted=reminder_submit,
                            )
                        )
                        reminder_records[-1].update(intent)
                        reminder_records[-1]["sendProof"] = reminder_submit
                        control.event("REMINDER_SEND_OUTCOME", slot=index, proof=reminder_submit)
                        waiting_state()
                        send_state = reminder_submit.get("sendState")
                        if (
                            send_state == browser_submit.SEND_UNKNOWN
                            or reminder_submit.get("code") == browser_submit.PROMPT_SEND_UNKNOWN
                        ):
                            return self._fail(
                                request,
                                "reminder send state is UNKNOWN",
                                details={"reminderSubmit": reminder_submit, "reminders": reminder_records},
                            )
                        if send_state == browser_submit.SEND_PROVEN_SENT:
                            reminder_index += 1
                            next_reminder_retry = 0.0
                            add_control_watch(intent, reminder_submit)
                            control.slot_status(index, "SENT", templateId=intent["templateId"], promptSha256=intent["promptSha256"])

                            next_result_recheck = self.monotonic() + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                            waiting_state()
                            continue
                        if (
                            send_state == browser_submit.SEND_PROVEN_NOT_SENT
                            and reminder_submit.get("details", {}).get("unsentPromptCleared") is True
                        ):
                            phase_after_attempt = reminder_submit.get("details", {}).get("answerPhase", {}).get("phase")
                            next_reminder_retry = (deadline if phase_after_attempt in {browser_observer.FINAL_ANSWER_STARTED, browser_observer.FINAL_ANSWER_COMPLETED}
                                                   else self.monotonic() + browser_observer.DEFAULT_POLL_MS / 1000.0)
                            next_result_recheck = self.monotonic() + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                            waiting_state()
                            continue
                        return self._fail(
                            request,
                            "reminder send result was not safely continuable",
                            details={"reminderSubmit": reminder_submit, "reminders": reminder_records},
                        )

                    if now >= next_result_recheck:
                        rescanned = scan_watches(skip_latest_missing=latest_observed_this_cycle)
                        next_result_recheck = self.monotonic() + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                        if rescanned["kind"] == "continued":
                            continue
                        if rescanned["kind"] == "terminal":
                            return rescanned["result"]
                        if rescanned["kind"] == "fatal":
                            return rescanned["result"]
                        if rescanned["kind"] == "interrupted":
                            continue
        except Exception as exc:
            return self._fail(request, str(exc), code=BRIDGE_PIPELINE_FAILED)
        finally:
            if control is not None:
                stored = self.read_state(request_id) or {}
                if control.active:
                    timed_out = stored.get("lastError") == browser_observer.ASSISTANT_TURN_TIMEOUT
                    status = "FAILED" if stored.get("failureCode") and not timed_out else "ABORTED"
                    control.finish_recovery(stored.get("lastError") or stored.get("state", "cleanup"),
                                            status=status, code=stored.get("failureCode"),
                                            reason="request_timeout" if timed_out else stored.get("lastError") or "terminal_or_cleanup")
                if stored.get("failureCode"):
                    control.transition("TIMEOUT" if stored.get("lastError") == browser_observer.ASSISTANT_TURN_TIMEOUT else "FAILED")
                elif stored.get("state") in _TERMINAL_SUCCESS_CODES:
                    control.cancel_slots("CANCELLED_RESULT_READY")
                    control.transition("FINAL_ANSWER_COMPLETED")
                    control.event("RESULT_TERMINAL", result=stored.get("state"))
                snapshot = control.snapshot()
                _atomic_json(self.state_path(request_id), {**stored, **snapshot})
                if terminal_result is not None and terminal_result.get("code") in _TERMINAL_SUCCESS_CODES:
                    terminal_result.setdefault("details", {}).update(snapshot)
            # ExitStack runs owned Page/context cleanup before the Playwright/CDP
            # context exits. This outer finally only records the already-finished
            # cleanup in the durable terminal state.
            if not cleanup:
                cleanup = {
                    "ownedPageCreated": page is not None,
                    "ownedPageClosed": page is None,
                    "closeAttempts": 0,
                    "externalBrowserClosed": False,
                    "ownedContextClosed": False,
                }
            if terminal_result is not None and terminal_result.get("code") in _TERMINAL_SUCCESS_CODES:
                terminal_result.setdefault("details", {})["browserCleanup"] = cleanup
                try:
                    self._write_state(request, str(terminal_result.get("code")), browserCleanup=cleanup)
                except Exception:
                    pass

    def _fail(self, request: BridgeRequest, reason: str, *, code: str = BRIDGE_PIPELINE_FAILED, details: Any = None) -> dict[str, Any]:
        transport_message = str(reason)[:1000]
        transport_details = dict(details) if isinstance(details, dict) else {"value": details}
        record = self._write_state(request, self.read_state(request.request_id).get("state", ACCEPTED) if self.read_state(request.request_id) else ACCEPTED, lastError=transport_message, failureCode=code)
        record["failureDetails"] = transport_details
        submit_proof = record.get("submitProof") if isinstance(record.get("submitProof"), dict) else {}
        send_state = submit_proof.get("sendState")
        send_proof_class = ("PROVEN_SENT" if send_state == browser_submit.SEND_PROVEN_SENT else
                            "PROVEN_NOT_SENT" if send_state == browser_submit.SEND_PROVEN_NOT_SENT else "UNKNOWN")
        conversation_url = record.get("conversationUrl") or submit_proof.get("details", {}).get("chatUrl")
        conversation_id = (browser_submit.conversation_id_from_url(conversation_url)
                           if browser_submit.is_bound_chat_url(conversation_url) else None)
        uncertain = transport_details.get("sendState") == "UNKNOWN" or any(
            isinstance(transport_details.get(key), dict) and transport_details[key].get("sendState") == "UNKNOWN"
            for key in ("reminderSubmit", "submit", "followupSubmit"))
        if uncertain and record.get("readOnlySendReproof") and transport_details is not None and transport_details.get("code") == browser_submit.PROMPT_SEND_UNKNOWN:
            uncertain = False
        recovery_evidence = {
            "readOnlySendReproof": record.get("readOnlySendReproof"),
            "promptSha256": record.get("promptSha256") or submit_proof.get("details", {}).get("promptSha256"),
            "unresolvedSendUnknown": uncertain,
            "webResultAvailable": bool(record.get("artifactProof")),
            "imageGenerated": isinstance(record.get("imageObserverProof"), dict),
            "imageObserverProof": record.get("imageObserverProof"),
            "imageOriginalPrompt": record.get("imageOriginalPrompt"),
            "imageAnchorBinding": record.get("imageAnchorBinding"),
            "sendProof": {"sendState": send_state, "proofClass": send_proof_class}
                if send_state else {"proofClass": "UNKNOWN"},
            "sendProofClass": send_proof_class,
            "conversationUrl": conversation_url if isinstance(conversation_url, str) else None,
            "conversationId": conversation_id if isinstance(conversation_id, str) else None,
        }
        record.update(recovery_evidence)
        _atomic_json(self.state_path(request.request_id), record)
        return _result(
            POSTMAN_TRANSPORT_FAILED,
            ok=False,
            details={
                "requestId": request.request_id,
                "workerJobId": request.worker_job_id,
                "state": record["state"],
                "resultPath": record["resultPath"],
                "transportCode": code,
                "transportMessage": transport_message,
                **recovery_evidence,
                "details": transport_details,
            },
        )


__all__ = [
    "ACCEPTED",
    "WEB_STARTING",
    "PROMPT_SENT",
    "WAITING_ASSISTANT",
    "ARTIFACT_FOUND",
    "ASSISTANT_COMPLETED_NO_ARTIFACT",
    "IMAGE_TURN_COMPLETED",
    "ARTIFACT_REJECTED",
    "RESULT_DURABLE",
    "BRIDGE_INVALID_REQUEST",
    "BRIDGE_INVALID_TASK_URL",
    "BRIDGE_INVALID_CONFIG",
    "BRIDGE_PIPELINE_FAILED",
    "POSTMAN_TRANSPORT_FAILED",
    "BridgeRequest",
    "WebWorkerBridge",
]
