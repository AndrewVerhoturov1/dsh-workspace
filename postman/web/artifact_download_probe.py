#!/usr/bin/env python3
"""Controlled WP-007/P6 live probe: P3 submit -> P4 observe -> P5 detect -> P6 download."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import artifact_detector as detector
import artifact_download as downloader
import browser_bootstrap as bootstrap
import browser_observer as observer
import browser_submit as submit
import request_identity as identity


def _result(code: str, *, ok: bool, recoverable: bool = False, details=None):
    return {
        "ok": ok,
        "code": code,
        "recoverable": recoverable,
        "details": dict(details or {}),
    }


def run_submit_observe_detect_download(
    cdp_url: str,
    prompt: str,
    *,
    request_id: str,
    expected_filename: str,
    repository: str,
    base_commit: str,
    allowed_paths: list[str],
    forbidden_paths: list[str],
    result_root: str | None = None,
    browser_download_dir: str = downloader.DEFAULT_BROWSER_DOWNLOAD_DIR,
    submit_timeout_ms: int = submit.DEFAULT_TIMEOUT_MS,
    assistant_timeout_ms: int = observer.DEFAULT_TIMEOUT_MS,
    stable_ms: int = observer.DEFAULT_STABLE_MS,
    download_timeout_ms: int = downloader.DEFAULT_DOWNLOAD_TIMEOUT_MS,
) -> dict[str, Any]:
    try:
        factory = bootstrap._load_sync_playwright()
    except bootstrap.BrowserBootstrapError as exc:
        return _result(exc.code, ok=False, recoverable=exc.recoverable, details=exc.details)

    expected_request = {
        "requestId": request_id,
        "repository": repository,
        "baseCommit": base_commit,
        "expectedFilename": expected_filename,
        "allowedPaths": allowed_paths,
        "forbiddenPaths": forbidden_paths,
    }

    try:
        with factory() as playwright:
            context = None
            page = None
            owns_context = False
            try:
                try:
                    normalized = bootstrap.normalize_cdp_url(cdp_url)
                    browser = playwright.chromium.connect_over_cdp(normalized)
                except Exception as exc:
                    return _result(
                        detector.ARTIFACT_ATTACH_FAILED,
                        ok=False,
                        recoverable=True,
                        details={"phase": "attach", "message": str(exc)[:500]},
                    )

                contexts = list(browser.contexts)
                if contexts:
                    context = contexts[0]
                else:
                    context = browser.new_context()
                    owns_context = True

                page = context.new_page()
                submit_result = submit.submit_fresh_prompt(
                    page,
                    prompt,
                    timeout_ms=submit_timeout_ms,
                )
                if not submit_result.get("ok"):
                    return _result(
                        submit_result.get("code", "PROMPT_SUBMIT_FAILED"),
                        ok=False,
                        recoverable=bool(submit_result.get("recoverable")),
                        details={"phase": "submit", "submitResult": submit_result},
                    )

                chat_url = str(submit_result.get("details", {}).get("chatUrl", "") or "")
                completed = observer.observe_next_assistant(
                    page,
                    prompt,
                    chat_url,
                    timeout_ms=assistant_timeout_ms,
                    stable_ms=stable_ms,
                )
                completed.setdefault("details", {})
                completed["details"].update({
                    "phase": "assistant",
                    "promptSha256": submit.prompt_sha256(prompt),
                    "submitCode": submit_result.get("code"),
                    "submitSendState": submit_result.get("sendState"),
                })
                if not completed.get("ok"):
                    return completed

                detected = detector.detect_artifact_dom(
                    page,
                    expected_prompt=prompt,
                    expected_chat_url=chat_url,
                    request_id=request_id,
                    expected_filename=expected_filename,
                    completed_observer_result=completed,
                )
                if not detected.get("ok"):
                    return detected

                result = downloader.download_validated_artifact(
                    page,
                    expected_prompt=prompt,
                    expected_chat_url=chat_url,
                    request_id=request_id,
                    expected_filename=expected_filename,
                    completed_observer_result=completed,
                    artifact_dom_result=detected,
                    expected_request=expected_request,
                    result_root=result_root,
                    browser_download_dir=browser_download_dir,
                    download_timeout_ms=download_timeout_ms,
                )
                result.setdefault("details", {})
                result["details"].update({
                    "submitCode": submit_result.get("code"),
                    "submitSendState": submit_result.get("sendState"),
                    "artifactDomCode": detected.get("code"),
                })
                return result
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
                # Never close externally-owned CDP browser.
    except Exception as exc:
        return _result(
            detector.ARTIFACT_ATTACH_FAILED,
            ok=False,
            recoverable=True,
            details={"phase": "outer", "message": str(exc)[:500]},
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Web Postman WP-007/P6 live artifact download probe")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--expected-filename")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--base-commit", required=True)
    parser.add_argument("--allowed-path", action="append", default=[])
    parser.add_argument("--forbidden-path", action="append", default=[])
    parser.add_argument("--result-root")
    parser.add_argument("--browser-download-dir", default=downloader.DEFAULT_BROWSER_DOWNLOAD_DIR)
    parser.add_argument("--cdp-url", default=bootstrap.DEFAULT_CDP_URL)
    parser.add_argument("--submit-timeout-ms", type=int, default=submit.DEFAULT_TIMEOUT_MS)
    parser.add_argument("--assistant-timeout-ms", type=int, default=observer.DEFAULT_TIMEOUT_MS)
    parser.add_argument("--stable-ms", type=int, default=observer.DEFAULT_STABLE_MS)
    parser.add_argument("--download-timeout-ms", type=int, default=downloader.DEFAULT_DOWNLOAD_TIMEOUT_MS)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    filename = args.expected_filename or identity.expected_artifact_filename(args.request_id)
    result = run_submit_observe_detect_download(
        args.cdp_url,
        args.prompt,
        request_id=args.request_id,
        expected_filename=filename,
        repository=args.repository,
        base_commit=args.base_commit,
        allowed_paths=list(args.allowed_path),
        forbidden_paths=list(args.forbidden_path),
        result_root=args.result_root,
        browser_download_dir=args.browser_download_dir,
        submit_timeout_ms=args.submit_timeout_ms,
        assistant_timeout_ms=args.assistant_timeout_ms,
        stable_ms=args.stable_ms,
        download_timeout_ms=args.download_timeout_ms,
    )
    print(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    raise SystemExit(main())
