#!/usr/bin/env python3
"""WP-011 bridge from a durable Runtime request to the existing Web pipeline.

This module is an orchestration boundary only. Browser behaviour remains in
WP-003--WP-007 modules; the bridge owns request correlation, state persistence,
and the hand-off back to Runtime after RESULT_DURABLE.
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
        on_result_durable: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        postman_root = Path(root) if root is not None else default_postman_root()
        self.state_root = postman_root / "workers"
        self.result_root = Path(result_root) if result_root is not None else postman_root / "results"
        self.now = now
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
            if previous in _STATE_ORDER and _STATE_ORDER.index(state) < _STATE_ORDER.index(previous):
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
        cdp_url: str = browser_bootstrap.DEFAULT_CDP_URL,
        timeout_ms: int = browser_submit.DEFAULT_TIMEOUT_MS,
        observer_timeout_ms: int = browser_observer.DEFAULT_TIMEOUT_MS,
        stable_ms: int = browser_observer.DEFAULT_STABLE_MS,
        download_timeout_ms: int = artifact_download.DEFAULT_DOWNLOAD_TIMEOUT_MS,
        click_timeout_ms: int = artifact_download.DEFAULT_CLICK_TIMEOUT_MS,
        browser_download_dir: str = artifact_download.DEFAULT_BROWSER_DOWNLOAD_DIR,
        playwright_factory: Callable[[], Any] | None = None,
        validator_runner: Callable[[Path, dict[str, Any]], dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Run WP-003--WP-007 once and return the terminal bridge proof."""
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

        self._write_state(request, WEB_STARTING)
        factory = playwright_factory
        if factory is None:
            try:
                factory = browser_bootstrap._load_sync_playwright()
            except Exception as exc:
                return self._fail(request, str(exc), code=BRIDGE_PIPELINE_FAILED)

        browser = context = page = None
        owns_context = False
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

                submitted = browser_submit.submit_fresh_prompt(page, prompt, timeout_ms=timeout_ms)
                if not submitted.get("ok"):
                    return self._fail(request, submitted.get("code", "submit_failed"), details=submitted)
                self._write_state(request, PROMPT_SENT, submitProof=submitted)
                chat_url = submitted.get("details", {}).get("chatUrl")
                if not isinstance(chat_url, str) or not browser_submit.is_bound_chat_url(chat_url):
                    return self._fail(request, "submit did not bind a chat URL", details=submitted)

                self._write_state(request, WAITING_ASSISTANT)
                completed = browser_observer.observe_next_assistant(
                    page,
                    prompt,
                    chat_url,
                    timeout_ms=observer_timeout_ms,
                    stable_ms=stable_ms,
                )
                if not completed.get("ok"):
                    return self._fail(request, completed.get("code", "observer_failed"), details=completed)

                detected = artifact_detector.detect_artifact_dom(
                    page,
                    expected_prompt=prompt,
                    expected_chat_url=chat_url,
                    request_id=request_id,
                    expected_filename=expected_filename,
                    completed_observer_result=completed,
                )
                if not detected.get("ok"):
                    return self._fail(request, detected.get("code", "artifact_not_found"), details=detected)
                self._write_state(request, ARTIFACT_FOUND, observerProof=completed, artifactProof=detected)

                durable = artifact_download.download_validated_artifact(
                    page,
                    expected_prompt=prompt,
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
                    return self._fail(request, durable.get("code", "download_failed"), details=durable)
                record = self._write_state(
                    request,
                    RESULT_DURABLE,
                    resultPath=durable.get("details", {}).get("resultDirectory", request.result_path),
                    resultZip=durable.get("details", {}).get("resultZip"),
                    resultSha256=durable.get("details", {}).get("sha256"),
                    durableProof=durable,
                )
                result = {"ok": True, "code": RESULT_DURABLE, "details": record}
                if self.on_result_durable is not None:
                    self.on_result_durable(result)
                return result
        except Exception as exc:
            return self._fail(request, str(exc), code=BRIDGE_PIPELINE_FAILED)
        finally:
            if page is not None:
                try:
                    page.close()
                except Exception:
                    pass
            if owns_context and context is not None:
                try:
                    context.close()
                except Exception:
                    pass
            # The CDP-attached browser is externally owned and is never closed.

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
