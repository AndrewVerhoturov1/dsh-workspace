#!/usr/bin/env python3
"""Text-only Direct Web PostmanAsk transport."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
POSTMAN_DIR = SCRIPT_DIR.parent
WEB_DIR = POSTMAN_DIR / "web"
for candidate in (SCRIPT_DIR, POSTMAN_DIR, WEB_DIR):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

import browser_bootstrap as bootstrap  # noqa: E402
import chat_reference  # noqa: E402
import process_lock  # noqa: E402
import request_identity  # noqa: E402
import task_package  # noqa: E402
import text_result  # noqa: E402
import text_task_package  # noqa: E402
from postman_direct import (  # noqa: E402
    DEFAULT_BRANCH,
    DEFAULT_GH_BINARY,
    DEFAULT_REPOSITORY,
    PUBLIC_POLICY_URL,
    DirectPostmanError,
    GitHubTaskPublisher,
    _decode_task_b64,
    _decode_task_file,
    _sha256_text,
    default_direct_root,
    ensure_dedicated_chrome,
)
from web_worker_bridge import (  # noqa: E402
    ARTIFACT_REJECTED,
    ASSISTANT_COMPLETED_NO_ARTIFACT,
    RESULT_DURABLE,
    POSTMAN_TRANSPORT_FAILED,
    WebWorkerBridge,
)

ASK_DIRECT_VERSION = 1
TEXT_RESULT_DURABLE = "TEXT_RESULT_DURABLE"
STATE_INIT = "ASK_INIT"
STATE_TASK_PUBLISHED = "ASK_TASK_PUBLISHED"
STATE_BROWSER_READY = "ASK_BROWSER_READY"
STATE_WEB_RUNNING = "ASK_WEB_RUNNING"
STATE_FAILED = "ASK_FAILED"
DEFAULT_ASSISTANT_TIMEOUT_MS = 45 * 60 * 1000
INLINE_ASSISTANT_TEXT_MAX_CHARS = 4096
DELIVERY_INLINE = "inline"
DELIVERY_FILE = "file"
TEXT_RESULT_MIME_TYPE = "text/markdown"
TEXT_RESULT_ENCODING = "utf-8"


def _json_result(ok: bool, code: str, **fields: Any) -> dict[str, Any]:
    return {"ok": ok, "code": code, "askDirectVersion": ASK_DIRECT_VERSION, **fields}


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


def _atomic_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


class DirectPostmanAsk:
    def __init__(
        self,
        *,
        repository: str = DEFAULT_REPOSITORY,
        branch: str = DEFAULT_BRANCH,
        gh_binary: str = DEFAULT_GH_BINARY,
        repo_root: str | os.PathLike[str] | None = None,
        direct_root: str | os.PathLike[str] | None = None,
        publisher_factory: Callable[..., GitHubTaskPublisher] = GitHubTaskPublisher,
        bridge_factory: Callable[..., WebWorkerBridge] = WebWorkerBridge,
        ensure_browser: Callable[..., dict[str, Any]] = ensure_dedicated_chrome,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.repository = repository
        self.branch = branch
        self.gh_binary = gh_binary
        self.repo_root = Path(repo_root) if repo_root is not None else SCRIPT_DIR.parents[1]
        self.direct_root = Path(direct_root) if direct_root is not None else default_direct_root()
        self.publisher_factory = publisher_factory
        self.bridge_factory = bridge_factory
        self.ensure_browser = ensure_browser
        self.now = now
        self.publication_receipt: dict[str, str] | None = None

    def state_path(self, request_id: str) -> Path:
        request_identity.assert_canonical_request_id(request_id)
        return self.direct_root / "requests" / f"{request_id}.json"

    def result_file_path(self, request_id: str) -> Path:
        request_identity.assert_canonical_request_id(request_id)
        return (
            self.direct_root
            / "text-results"
            / request_id
            / f"POSTMAN_{request_id}_ANSWER.md"
        ).resolve()

    def _materialize_delivery(
        self,
        request_id: str,
        assistant_text: str,
        assistant_text_sha256: str,
    ) -> dict[str, Any]:
        encoded = assistant_text.encode(TEXT_RESULT_ENCODING)
        common = {
            "assistantTextLength": len(assistant_text),
            "assistantTextByteLength": len(encoded),
            "assistantTextSha256": assistant_text_sha256,
        }
        if len(assistant_text) <= INLINE_ASSISTANT_TEXT_MAX_CHARS:
            return {
                "deliveryMode": DELIVERY_INLINE,
                "assistantText": assistant_text,
                **common,
            }

        result_file = self.result_file_path(request_id)
        try:
            _atomic_bytes(result_file, encoded)
            stored = result_file.read_bytes()
        except OSError as exc:
            raise DirectPostmanError(
                "POSTMAN_ASK_RESULT_FILE_WRITE_FAILED",
                f"failed to persist PostmanAsk Markdown result: {exc}",
                details={"resultFile": str(result_file)},
            ) from exc

        stored_sha256 = hashlib.sha256(stored).hexdigest()
        if stored != encoded or stored_sha256 != assistant_text_sha256:
            raise DirectPostmanError(
                "POSTMAN_ASK_RESULT_FILE_VERIFY_FAILED",
                "persisted PostmanAsk Markdown result did not verify byte-for-byte",
                details={
                    "resultFile": str(result_file),
                    "expectedSha256": assistant_text_sha256,
                    "actualSha256": stored_sha256,
                    "expectedByteLength": len(encoded),
                    "actualByteLength": len(stored),
                },
            )

        return {
            "deliveryMode": DELIVERY_FILE,
            "resultFile": str(result_file),
            "resultFileName": result_file.name,
            "resultMimeType": TEXT_RESULT_MIME_TYPE,
            "resultEncoding": TEXT_RESULT_ENCODING,
            "resultFileSha256": stored_sha256,
            **common,
        }

    def _write_state(self, request_id: str, state: str, **fields: Any) -> dict[str, Any]:
        path = self.state_path(request_id)
        previous: dict[str, Any] = {}
        if path.exists():
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    previous = value
            except Exception:
                previous = {}
        record = {
            **previous,
            "askDirectVersion": ASK_DIRECT_VERSION,
            "requestId": request_id,
            "repository": self.repository,
            "branch": self.branch,
            "resultMode": "text",
            "state": state,
            "updatedAt": self.now(),
            **fields,
        }
        _atomic_json(path, record)
        return record

    def run(
        self,
        *,
        request_id: str,
        task: str,
        chat_request_id: str | None = None,
        cdp_url: str = bootstrap.DEFAULT_CDP_URL,
    ) -> dict[str, Any]:
        request_identity.assert_canonical_request_id(request_id)
        self.publication_receipt = None
        if not isinstance(task, str) or not task.strip():
            raise DirectPostmanError("DIRECT_INVALID_TASK", "task must be a non-empty string")
        try:
            process_lock.claim_request(self.direct_root, request_id)
        except FileExistsError as exc:
            raise DirectPostmanError("DIRECT_REQUEST_EXISTS", "request already claimed; resend forbidden") from exc
        if self.state_path(request_id).exists():
            raise DirectPostmanError(
                "DIRECT_REQUEST_EXISTS",
                f"request {request_id} already has direct transport state; automatic resend is forbidden",
                details={"statePath": str(self.state_path(request_id))},
            )

        chat_ref = None
        if chat_request_id:
            try:
                chat_ref = chat_reference.resolve_chat_reference(
                    self.direct_root,
                    chat_request_id,
                    expected_repository=self.repository,
                )
            except chat_reference.ChatReferenceError as exc:
                raise DirectPostmanError(exc.code, str(exc), details=exc.details) from exc

        conversation_fields: dict[str, Any] = {}
        if chat_ref is not None:
            conversation_fields = {
                "conversationUrl": chat_ref.conversation_url,
                "conversationId": chat_ref.conversation_id,
            }

        self._write_state(
            request_id,
            STATE_INIT,
            taskSha256=_sha256_text(task),
            parentRequestId=chat_ref.request_id if chat_ref is not None else None,
            rootRequestId=request_id,
            continuationIndex=0,
            **conversation_fields,
        )

        publisher = self.publisher_factory(
            repository=self.repository,
            branch=self.branch,
            gh_binary=self.gh_binary,
            cwd=self.repo_root,
        )
        with process_lock.lock_publication(self.direct_root, self.repository, self.branch):
            snapshot = publisher.snapshot()
            task_content = text_task_package.render_direct_text_task_manifest(
                request_id=request_id,
                user_intent=task,
                repository=self.repository,
                base_commit=snapshot.prepublication_commit,
            )
            published = publisher.publish_content(
                request_id,
                task_content,
                expected_parent=snapshot.prepublication_commit,
                root_entries=snapshot.root_entries,
            )
        expected_filename = request_identity.expected_artifact_filename(request_id)
        prompt = task_package.build_external_prompt(request_id, PUBLIC_POLICY_URL, published.task_url)
        self._write_state(
            request_id,
            STATE_TASK_PUBLISHED,
            taskUrl=published.task_url,
            prepublicationCommit=published.prepublication_commit,
            baseCommit=published.prepublication_commit,
            taskPublicationCommit=published.publication_commit,
            expectedFilename=expected_filename,
            promptSha256=_sha256_text(prompt),
            **conversation_fields,
        )
        self.publication_receipt = {
            "requestId": request_id, "repository": self.repository, "branch": self.branch,
            "taskUrl": published.task_url, "baseCommit": published.prepublication_commit,
            "taskPublicationCommit": published.publication_commit,
        }

        browser = self.ensure_browser(cdp_url=cdp_url)
        self._write_state(request_id, STATE_BROWSER_READY, browser=browser, **conversation_fields)

        bridge = self.bridge_factory(root=self.direct_root.parent)
        self._write_state(request_id, STATE_WEB_RUNNING, **conversation_fields)
        result = bridge.run_request(
            request_id,
            task_url=published.task_url,
            prompt=prompt,
            expected_filename=expected_filename,
            expected_request={
                "requestId": request_id,
                "repository": self.repository,
                "baseCommit": snapshot.prepublication_commit,
                "expectedFilename": expected_filename,
            },
            cdp_url=browser.get("cdpUrl", cdp_url),
            conversation_url=chat_ref.conversation_url if chat_ref is not None else None,
            observer_timeout_ms=DEFAULT_ASSISTANT_TIMEOUT_MS,
        )
        if not isinstance(result, dict) or result.get("ok") is not True:
            code = result.get("code", "DIRECT_WEB_FAILED") if isinstance(result, dict) else "DIRECT_WEB_FAILED"
            details = result.get("details", {}) if isinstance(result, dict) else {"result": repr(result)}
            self._write_state(request_id, STATE_FAILED, failureCode=code, failureDetails=details)
            transport_message = str(details.get("transportMessage") or details.get("reason") or code)
            transport_code = str(details.get("transportCode") or code)
            raise DirectPostmanError(
                POSTMAN_TRANSPORT_FAILED,
                transport_message,
                details={
                    "transportCode": transport_code,
                    "transportMessage": transport_message,
                    "details": details.get("details") if isinstance(details.get("details"), dict) else details,
                },
            )

        bridge_code = str(result.get("code", ""))
        details = result.get("details", {}) if isinstance(result.get("details"), dict) else {}
        if bridge_code != ASSISTANT_COMPLETED_NO_ARTIFACT:
            reason = (
                "PostmanAsk received an artifact result; text mode accepts only the completed "
                "no-artifact assistant turn after the Web Worker 10-second re-proof."
                if bridge_code in {RESULT_DURABLE, ARTIFACT_REJECTED}
                else f"PostmanAsk received unsupported Web terminal code: {bridge_code or 'missing'}"
            )
            self._write_state(request_id, STATE_FAILED, failureCode="POSTMAN_ASK_UNEXPECTED_WEB_RESULT", failureDetails=details)
            raise DirectPostmanError(
                "POSTMAN_ASK_UNEXPECTED_WEB_RESULT",
                reason,
                details={"webCode": bridge_code, "workerDetails": details},
            )

        parsed = text_result.parse_text_envelope(details.get("assistantText", ""), request_id)
        if not parsed.get("ok"):
            parse_code = str(parsed.get("code", "TEXT_RESULT_INVALID"))
            parse_details = parsed.get("details") if isinstance(parsed.get("details"), dict) else {}
            self._write_state(
                request_id,
                STATE_FAILED,
                failureCode="POSTMAN_ASK_RESULT_TRIGGER_INVALID",
                textResultCode=parse_code,
                failureDetails=parse_details,
                workerDetails=details,
            )
            raise DirectPostmanError(
                "POSTMAN_ASK_RESULT_TRIGGER_INVALID",
                f"completed assistant turn did not contain the exact PostmanAsk result trigger: {parse_code}",
                details={"textResultCode": parse_code, "textResultDetails": parse_details},
            )

        parsed_details = parsed["details"]
        conversation_url = details.get("conversationUrl")
        conversation_id = details.get("conversationId")
        final_conversation: dict[str, Any] = {}
        if isinstance(conversation_url, str) and conversation_url:
            final_conversation["conversationUrl"] = conversation_url
        if isinstance(conversation_id, str) and conversation_id:
            final_conversation["conversationId"] = conversation_id
        assistant_index = details.get("assistantIndex")
        assistant_text = str(parsed_details["assistantText"])
        assistant_text_sha256 = str(parsed_details["assistantTextSha256"])
        delivery = self._materialize_delivery(
            request_id,
            assistant_text,
            assistant_text_sha256,
        )
        terminal = _json_result(
            True,
            TEXT_RESULT_DURABLE,
            state=TEXT_RESULT_DURABLE,
            requestId=request_id,
            repository=self.repository,
            resultMode="text",
            baseCommit=published.prepublication_commit,
            taskPublicationCommit=published.publication_commit,
            taskUrl=published.task_url,
            assistantIndex=assistant_index if isinstance(assistant_index, int) and not isinstance(assistant_index, bool) else None,
            textSettleMs=int(details.get("noArtifactRecheckMs", 10_000)),
            statePath=str(self.state_path(request_id)),
            browser=browser,
            parentRequestId=chat_ref.request_id if chat_ref is not None else None,
            rootRequestId=request_id,
            continuationIndex=0,
            **delivery,
            **final_conversation,
        )
        state_delivery = dict(delivery)
        self._write_state(
            request_id,
            TEXT_RESULT_DURABLE,
            ok=True,
            code=TEXT_RESULT_DURABLE,
            assistantIndex=terminal["assistantIndex"],
            textSettleMs=terminal["textSettleMs"],
            workerEnvelopeTextSha256=str(details.get("assistantTextSha256", "")),
            **state_delivery,
            **final_conversation,
        )
        return terminal


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Direct Web PostmanAsk text bridge")
    parser.add_argument("--request-id", required=True)
    task_group = parser.add_mutually_exclusive_group(required=True)
    task_group.add_argument("--task")
    task_group.add_argument("--task-file")
    task_group.add_argument("--task-base64")
    parser.add_argument("--repository", default=DEFAULT_REPOSITORY)
    parser.add_argument("--branch", default=DEFAULT_BRANCH)
    parser.add_argument("--gh-binary", default=DEFAULT_GH_BINARY)
    parser.add_argument("--repo-root")
    parser.add_argument("--direct-root")
    parser.add_argument("--cdp-url", default=bootstrap.DEFAULT_CDP_URL)
    parser.add_argument("--chat-request-id")
    return parser


def _task_from_args(args: argparse.Namespace) -> str:
    if args.task is not None:
        return args.task
    if args.task_file is not None:
        return _decode_task_file(args.task_file)
    if args.task_base64 is not None:
        return _decode_task_b64(args.task_base64)
    raise DirectPostmanError("DIRECT_INVALID_TASK", "one task input is required")


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    direct = None
    execution_started = False
    try:
        direct = DirectPostmanAsk(
            repository=args.repository,
            branch=args.branch,
            gh_binary=args.gh_binary,
            repo_root=args.repo_root,
            direct_root=args.direct_root,
        )
        task = _task_from_args(args)
        execution_started = True
        with process_lock.lock_chat(direct.direct_root, args.chat_request_id, direct.repository):
            result = direct.run(
                request_id=args.request_id,
                task=task,
                chat_request_id=args.chat_request_id,
                cdp_url=args.cdp_url,
            )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (DirectPostmanError, ValueError, text_task_package.TextTaskPackageError,
            chat_reference.ChatReferenceError, process_lock.ResourceBusyError) as exc:
        code = ("DIRECT_CHAT_BUSY" if isinstance(exc, process_lock.ChatBusyError)
                else "DIRECT_RESOURCE_BUSY" if isinstance(exc, process_lock.ResourceBusyError)
                else exc.code if isinstance(exc, (DirectPostmanError, chat_reference.ChatReferenceError))
                else "DIRECT_INVALID_REQUEST")
        details = exc.details if isinstance(exc, DirectPostmanError) else {}
        publication_receipt = getattr(direct, "publication_receipt", None)
        publication_fields = {"publicationReceipt": publication_receipt} if (
            isinstance(publication_receipt, dict) and publication_receipt.get("requestId") == args.request_id
        ) else {}
        if execution_started:
            transport_code = str(details.get("transportCode", code))
            transport_message = str(details.get("transportMessage", str(exc)))
            transport_details = details.get("details") if isinstance(details.get("details"), dict) else details
            result = _json_result(
                False,
                POSTMAN_TRANSPORT_FAILED,
                requestId=args.request_id,
                transportCode=transport_code,
                transportMessage=transport_message,
                details=transport_details,
                **publication_fields,
            )
        else:
            result = _json_result(False, code, requestId=args.request_id, error=str(exc), details=details)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as exc:  # pragma: no cover - last-resort CLI boundary
        result = _json_result(False, "DIRECT_INTERNAL_ERROR", requestId=args.request_id, error=str(exc))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
