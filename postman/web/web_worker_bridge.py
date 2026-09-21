#!/usr/bin/env python3
"""WP-011 bridge from a durable Runtime request to the existing Web pipeline.

This module is an orchestration boundary only. Browser behaviour remains in
WP-003--WP-007 modules; the bridge owns request correlation, state persistence,
fixed service reminders, and the hand-off back to Runtime after RESULT_DURABLE.
"""

from __future__ import annotations

from contextlib import ExitStack
from dataclasses import dataclass
import json
import os
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
import reminder_policy
import request_identity


ACCEPTED = "ACCEPTED"
WEB_STARTING = "WEB_STARTING"
PROMPT_SENT = "PROMPT_SENT"
WAITING_ASSISTANT = "WAITING_ASSISTANT"
ARTIFACT_FOUND = "ARTIFACT_FOUND"
ASSISTANT_COMPLETED_NO_ARTIFACT = "ASSISTANT_COMPLETED_NO_ARTIFACT"
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
        on_result_durable: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        postman_root = Path(root) if root is not None else default_postman_root()
        self.state_root = postman_root / "workers"
        self.result_root = Path(result_root) if result_root is not None else postman_root / "results"
        self.now = now
        self.monotonic = monotonic
        self.sleep = sleep
        self.on_result_durable = on_result_durable

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
    ) -> dict[str, Any]:
        """Run the browser pipeline once, with up to three fixed reminders."""
        accepted = self.accept_request(request_id, task_url)
        if not accepted["ok"]:
            return accepted
        if accepted["details"].get("state") != ACCEPTED:
            # A restart must not blindly resend a prompt after a proven or
            # uncertain browser action. Recovery of those states belongs to a
            # future durable browser-state milestone.
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

        self._write_state(request, WEB_STARTING)
        factory = playwright_factory
        if factory is None:
            try:
                factory = browser_bootstrap._load_sync_playwright()
            except Exception as exc:
                return self._fail(request, str(exc), code=BRIDGE_PIPELINE_FAILED)

        browser = context = page = None
        owns_context = False
        terminal_result: dict[str, Any] | None = None
        cleanup: dict[str, Any] = {}
        try:
            with ExitStack() as stack:
                playwright = stack.enter_context(factory())
                normalized = browser_bootstrap.normalize_cdp_url(cdp_url)
                browser = playwright.chromium.connect_over_cdp(normalized)
                contexts = list(browser.contexts)
                if contexts:
                    context = contexts[0]
                else:
                    context = browser.new_context()
                    owns_context = True

                def close_owned_resources() -> None:
                    cleanup.clear()
                    cleanup.update(_close_owned_page(page))
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

                if conversation_url is None:
                    submitted = browser_submit.submit_fresh_prompt(page, prompt, timeout_ms=timeout_ms)
                else:
                    submitted = browser_submit.submit_existing_prompt(
                        page, prompt, conversation_url, timeout_ms=timeout_ms
                    )
                if not submitted.get("ok"):
                    return self._fail(request, submitted.get("code", "submit_failed"), details=submitted)
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
                watched_turns: list[dict[str, Any]] = [
                    {
                        "prompt": prompt,
                        "submit": submitted,
                        "proof": None,
                        "everProved": False,
                        "artifactRejected": False,
                        "noArtifactSince": None,
                    }
                ]
                next_result_recheck = started_at + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                recovery_exhausted = False
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
                    "reloadSettleMs": browser_recovery.DEFAULT_SETTLE_MS,
                    "reloadMaxAttempts": browser_recovery.DEFAULT_MAX_RELOAD_ATTEMPTS,
                }

                def remaining_ms() -> int:
                    return max(0, int((deadline - self.monotonic()) * 1000.0))

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
                        "lastArtifactCode": last_artifact_code,
                    }
                    if last_recovery is not None:
                        fields["lastBrowserRecovery"] = last_recovery
                    self._write_state(request, WAITING_ASSISTANT, **fields)

                def observe_watch(watch: dict[str, Any], timeout_for_observer_ms: int) -> dict[str, Any]:
                    nonlocal last_observer_code
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
                    )
                    completed = _attach_submit_proof(
                        completed,
                        prompt=str(watch["prompt"]),
                        submitted=watch["submit"],
                    )
                    last_observer_code = str(completed.get("code", ""))
                    if completed.get("code") == browser_observer.ASSISTANT_CONNECTION_INTERRUPTED:
                        return {"kind": "interrupted", "details": completed}
                    if completed.get("ok"):
                        watch["proof"] = completed
                        watch["everProved"] = True
                        watch["noArtifactSince"] = None
                        return {"kind": "proof"}
                    if completed.get("code") in _NONTERMINAL_OBSERVER_CODES:
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

                def inspect_watch(watch: dict[str, Any]) -> dict[str, Any]:
                    nonlocal last_artifact_code, terminal_result
                    completed = watch.get("proof")
                    if watch.get("artifactRejected") or not isinstance(completed, dict):
                        return {"kind": "no_result"}

                    reproofed = False
                    no_artifact_since = watch.get("noArtifactSince")
                    if no_artifact_since is not None and (
                        self.monotonic() - float(no_artifact_since) >= _RESULT_RECHECK_INTERVAL_MS / 1000.0
                    ):
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

                        record = self._write_state(
                            request,
                            RESULT_DURABLE,
                            resultPath=durable.get("details", {}).get("resultDirectory", request.result_path),
                            resultZip=durable.get("details", {}).get("resultZip"),
                            resultSha256=durable.get("details", {}).get("sha256"),
                            durableProof=durable,
                            conversationUrl=chat_url,
                            conversationId=conversation_id,
                            reminderPolicy=reminder_policy_record,
                            browserRecoveryPolicy=recovery_policy_record,
                            reminders=reminder_records,
                        )
                        terminal_result = {"ok": True, "code": RESULT_DURABLE, "details": record}
                        if self.on_result_durable is not None:
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
                        if outcome["kind"] in {"terminal", "fatal", "interrupted"}:
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
                                if outcome["kind"] in {"terminal", "fatal", "interrupted"}:
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
                    if now >= deadline:
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
                            },
                        )
                        return terminal_result

                    interrupted, interruption_details = browser_observer.connection_interrupted(page)
                    if interrupted:
                        last_observer_code = browser_observer.ASSISTANT_CONNECTION_INTERRUPTED
                        if not recovery_exhausted:
                            recovery = browser_recovery.recover_interrupted_chat(
                                page,
                                chat_url,
                                str(watched_turns[-1]["prompt"]),
                                budget_ms=remaining_ms(),
                                sleep=self.sleep,
                                monotonic=self.monotonic,
                            )
                            last_recovery = recovery
                            waiting_state()
                            if recovery.get("ok"):
                                recovery_exhausted = False
                                clear_observer_proofs()
                                next_result_recheck = self.monotonic()
                                continue
                            recovery_exhausted = True
                        delay = min(
                            _RESULT_RECHECK_INTERVAL_MS / 1000.0,
                            max(deadline - self.monotonic(), 0.0),
                        )
                        if delay > 0:
                            self.sleep(delay)
                        continue
                    if recovery_exhausted:
                        recovery_exhausted = False
                        clear_observer_proofs()
                        next_result_recheck = self.monotonic()

                    next_due = None
                    if reminder_index < max_reminders:
                        next_due = started_at + (
                            reminder_policy.scheduled_elapsed_ms(
                                reminder_index + 1,
                                interval_ms=reminder_interval_ms,
                            )
                            / 1000.0
                        )

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
                        if pre_reminder["kind"] == "terminal":
                            return pre_reminder["result"]
                        if pre_reminder["kind"] == "fatal":
                            return pre_reminder["result"]
                        if pre_reminder["kind"] == "interrupted":
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
                        reminder_prompt = reminder_policy.build_reminder_prompt(
                            request_id,
                            index,
                            total=max_reminders,
                        )
                        attempted_elapsed = max(0, int((self.monotonic() - started_at) * 1000.0))
                        reminder_submit = reminder_policy.submit_reminder(
                            page,
                            reminder_prompt,
                            chat_url,
                            timeout_ms=timeout_ms,
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
                            watched_turns.append(
                                {
                                    "prompt": reminder_prompt,
                                    "submit": reminder_submit,
                                    "proof": None,
                                    "everProved": False,
                                    "artifactRejected": False,
                                    "noArtifactSince": None,
                                }
                            )
                            next_result_recheck = self.monotonic() + _RESULT_RECHECK_INTERVAL_MS / 1000.0
                            waiting_state()
                            continue
                        if (
                            send_state == browser_submit.SEND_PROVEN_NOT_SENT
                            and reminder_submit.get("details", {}).get("unsentPromptCleared") is True
                        ):
                            reminder_index += 1
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
                        if rescanned["kind"] == "terminal":
                            return rescanned["result"]
                        if rescanned["kind"] == "fatal":
                            return rescanned["result"]
                        if rescanned["kind"] == "interrupted":
                            continue
        except Exception as exc:
            return self._fail(request, str(exc), code=BRIDGE_PIPELINE_FAILED)
        finally:
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
