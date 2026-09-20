#!/usr/bin/env python3
"""WP-011 bridge from a durable Runtime request to the existing Web pipeline.

This module is an orchestration boundary only. Browser behaviour remains in
WP-003--WP-007 modules; the bridge owns request correlation, state persistence,
fixed service reminders, and the hand-off back to Runtime after RESULT_DURABLE.
"""

from __future__ import annotations

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
import browser_submit
import reminder_policy
import request_identity


ACCEPTED = "ACCEPTED"
WEB_STARTING = "WEB_STARTING"
PROMPT_SENT = "PROMPT_SENT"
WAITING_ASSISTANT = "WAITING_ASSISTANT"
ARTIFACT_FOUND = "ARTIFACT_FOUND"
RESULT_DURABLE = "RESULT_DURABLE"

BRIDGE_INVALID_REQUEST = "BRIDGE_INVALID_REQUEST"
BRIDGE_INVALID_TASK_URL = "BRIDGE_INVALID_TASK_URL"
BRIDGE_INVALID_CONFIG = "BRIDGE_INVALID_CONFIG"
BRIDGE_PIPELINE_FAILED = "BRIDGE_PIPELINE_FAILED"

_STATE_ORDER = (ACCEPTED, WEB_STARTING, PROMPT_SENT, WAITING_ASSISTANT, ARTIFACT_FOUND, RESULT_DURABLE)
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
}


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
        "externalBrowserClosed": False,
    }
    if page is None:
        return cleanup
    try:
        page.close()
        checker = getattr(page, "is_closed", None)
        cleanup["ownedPageClosed"] = bool(checker()) if callable(checker) else True
    except Exception as exc:
        cleanup["ownedPageClosed"] = False
        cleanup["closeError"] = str(exc)[:500]
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
        try:
            with factory() as playwright:
                normalized = browser_bootstrap.normalize_cdp_url(cdp_url)
                browser = playwright.chromium.connect_over_cdp(normalized)
                contexts = list(browser.contexts)
                if contexts:
                    context = contexts[0]
                else:
                    context = browser.new_context()
                    owns_context = True
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
                current_prompt = prompt
                current_submit = submitted
                current_turn_processed = False
                last_observer_code = ""
                last_artifact_code = ""
                reminder_policy_record = {
                    "intervalMs": reminder_interval_ms,
                    "maxReminders": max_reminders,
                    "overallTimeoutMs": observer_timeout_ms,
                }
                self._write_state(
                    request,
                    WAITING_ASSISTANT,
                    reminderPolicy=reminder_policy_record,
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
                                "reminderPolicy": reminder_policy_record,
                                "reminders": reminder_records,
                            },
                        )
                        return terminal_result

                    next_due = None
                    if reminder_index < max_reminders:
                        next_due = started_at + (
                            reminder_policy.scheduled_elapsed_ms(
                                reminder_index + 1,
                                interval_ms=reminder_interval_ms,
                            )
                            / 1000.0
                        )
                    slice_deadline = min(deadline, next_due) if next_due is not None else deadline

                    if current_turn_processed:
                        delay = max(slice_deadline - now, 0.0)
                        if delay > 0:
                            self.sleep(delay)
                    else:
                        slice_timeout_ms = max(1, int(max(slice_deadline - now, 0.0) * 1000.0))
                        completed = browser_observer.observe_next_assistant(
                            page,
                            current_prompt,
                            chat_url,
                            timeout_ms=slice_timeout_ms,
                            stable_ms=stable_ms,
                            sleep=self.sleep,
                            monotonic=self.monotonic,
                        )
                        completed = _attach_submit_proof(
                            completed,
                            prompt=current_prompt,
                            submitted=current_submit,
                        )
                        last_observer_code = str(completed.get("code", ""))

                        if completed.get("ok"):
                            detected = artifact_detector.detect_artifact_dom(
                                page,
                                expected_prompt=current_prompt,
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
                                    reminders=reminder_records,
                                )

                                durable = artifact_download.download_validated_artifact(
                                    page,
                                    expected_prompt=current_prompt,
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
                                    if (
                                        durable.get("code") == artifact_download.ARTIFACT_INVALID
                                        and durable.get("recoverable") is True
                                    ):
                                        # A downloaded ZIP with rejected contents is a model/result
                                        # failure, not a failed REQ. The next scheduled reminder may
                                        # establish a fresh P5/P6 attempt; all other download errors
                                        # remain fail-closed.
                                        self._write_state(
                                            request,
                                            ARTIFACT_FOUND,
                                            artifactValidation=durable,
                                            reminderPolicy=reminder_policy_record,
                                            reminders=reminder_records,
                                        )
                                        current_turn_processed = True
                                        continue
                                    return self._fail(request, durable.get("code", "download_failed"), details=durable)
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
                                    reminders=reminder_records,
                                )
                                terminal_result = {"ok": True, "code": RESULT_DURABLE, "details": record}
                                if self.on_result_durable is not None:
                                    self.on_result_durable(terminal_result)
                                return terminal_result

                            artifact_code = detected.get("code")
                            if artifact_code in _FATAL_ARTIFACT_CODES:
                                return self._fail(
                                    request,
                                    artifact_code or "artifact_not_found",
                                    details=detected,
                                )
                            if artifact_code not in _REMINDER_ELIGIBLE_ARTIFACT_CODES:
                                return self._fail(
                                    request,
                                    artifact_code or "artifact_not_found",
                                    details=detected,
                                )

                            # Only known model-output/result-shape failures are
                            # eligible for the next scheduled reminder. Unknown
                            # or internal detector failures stop immediately so
                            # existing fail-closed tests and diagnostics never
                            # wait for a real ten-minute reminder window.
                            current_turn_processed = True
                        elif completed.get("code") not in _NONTERMINAL_OBSERVER_CODES:
                            return self._fail(
                                request,
                                completed.get("code", "observer_failed"),
                                details=completed,
                            )

                    now = self.monotonic()
                    if now >= deadline:
                        continue

                    if reminder_index < max_reminders:
                        scheduled_elapsed = reminder_policy.scheduled_elapsed_ms(
                            reminder_index + 1,
                            interval_ms=reminder_interval_ms,
                        )
                        due = started_at + scheduled_elapsed / 1000.0
                        if now >= due:
                            index = reminder_index + 1
                            reminder_prompt = reminder_policy.build_reminder_prompt(
                                request_id,
                                index,
                                total=max_reminders,
                            )
                            attempted_elapsed = max(0, int((now - started_at) * 1000.0))
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
                                    scheduled_elapsed_ms=scheduled_elapsed,
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
                                self._write_state(
                                    request,
                                    WAITING_ASSISTANT,
                                    reminderPolicy=reminder_policy_record,
                                    reminders=reminder_records,
                                    lastObserverCode=last_observer_code,
                                    lastArtifactCode=last_artifact_code,
                                )
                                current_prompt = reminder_prompt
                                current_submit = reminder_submit
                                current_turn_processed = False
                                continue
                            if (
                                send_state == browser_submit.SEND_PROVEN_NOT_SENT
                                and reminder_submit.get("details", {}).get("unsentPromptCleared") is True
                            ):
                                reminder_index += 1
                                self._write_state(
                                    request,
                                    WAITING_ASSISTANT,
                                    reminderPolicy=reminder_policy_record,
                                    reminders=reminder_records,
                                    lastObserverCode=last_observer_code,
                                    lastArtifactCode=last_artifact_code,
                                )
                                continue
                            return self._fail(
                                request,
                                "reminder send result was not safely continuable",
                                details={"reminderSubmit": reminder_submit, "reminders": reminder_records},
                            )
        except Exception as exc:
            return self._fail(request, str(exc), code=BRIDGE_PIPELINE_FAILED)
        finally:
            cleanup = _close_owned_page(page)
            if owns_context and context is not None:
                try:
                    context.close()
                    cleanup["ownedContextClosed"] = True
                except Exception as exc:
                    cleanup["ownedContextClosed"] = False
                    cleanup["contextCloseError"] = str(exc)[:500]
            else:
                cleanup["ownedContextClosed"] = False
            # The CDP-attached browser is externally owned and is never closed.
            if terminal_result is not None and terminal_result.get("code") == RESULT_DURABLE:
                terminal_result.setdefault("details", {})["browserCleanup"] = cleanup
                try:
                    self._write_state(request, RESULT_DURABLE, browserCleanup=cleanup)
                except Exception:
                    pass

    def _fail(self, request: BridgeRequest, reason: str, *, code: str = BRIDGE_PIPELINE_FAILED, details: Any = None) -> dict[str, Any]:
        record = self._write_state(request, self.read_state(request.request_id).get("state", ACCEPTED) if self.read_state(request.request_id) else ACCEPTED, lastError=str(reason)[:1000], failureCode=code)
        if isinstance(details, dict):
            record["failureDetails"] = details
            _atomic_json(self.state_path(request.request_id), record)
        return _result(code, ok=False, details={"requestId": request.request_id, "workerJobId": request.worker_job_id, "state": record["state"], "resultPath": record["resultPath"], "reason": str(reason)[:1000]})


__all__ = [
    "ACCEPTED",
    "WEB_STARTING",
    "PROMPT_SENT",
    "WAITING_ASSISTANT",
    "ARTIFACT_FOUND",
    "RESULT_DURABLE",
    "BRIDGE_INVALID_REQUEST",
    "BRIDGE_INVALID_TASK_URL",
    "BRIDGE_INVALID_CONFIG",
    "BRIDGE_PIPELINE_FAILED",
    "BridgeRequest",
    "WebWorkerBridge",
]
