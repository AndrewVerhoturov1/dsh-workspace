#!/usr/bin/env python3
"""Web Postman P5 artifact DOM detector.

Scope:
- accept only a trusted, completed WP-005 assistant-turn proof;
- re-confirm the same chat/user/assistant correlation in the current DOM;
- require an exact machine-readable result envelope in that assistant turn;
- require the exact trusted artifact filename;
- locate a download/attachment control only inside the same assistant turn;
- never search the whole page for ZIPs or Download buttons;
- never click or download anything.

P6 owns browser download lifecycle and artifact validation.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import browser_bootstrap as bootstrap
import browser_observer as observer
import browser_submit as submit

ARTIFACT_DOM_CONFIRMED = "ARTIFACT_DOM_CONFIRMED"
ARTIFACT_INVALID_CONFIG = "ARTIFACT_INVALID_CONFIG"
ARTIFACT_OBSERVER_PROOF_INVALID = "ARTIFACT_OBSERVER_PROOF_INVALID"
ARTIFACT_CHAT_CORRELATION_LOST = "ARTIFACT_CHAT_CORRELATION_LOST"
ARTIFACT_TURN_IDENTITY_MISMATCH = "ARTIFACT_TURN_IDENTITY_MISMATCH"
ARTIFACT_TURN_NOT_COMPLETED = "ARTIFACT_TURN_NOT_COMPLETED"
ARTIFACT_ENVELOPE_MISSING = "ARTIFACT_ENVELOPE_MISSING"
ARTIFACT_ENVELOPE_AMBIGUOUS = "ARTIFACT_ENVELOPE_AMBIGUOUS"
ARTIFACT_ATTACHMENT_NOT_FOUND = "ARTIFACT_ATTACHMENT_NOT_FOUND"
ARTIFACT_ATTACHMENT_AMBIGUOUS = "ARTIFACT_ATTACHMENT_AMBIGUOUS"
ARTIFACT_ATTACH_FAILED = "ARTIFACT_ATTACH_FAILED"

REQUEST_ID_RE = re.compile(r"^REQ_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ARTIFACT_LINE_PREFIX = "POSTMAN_ARTIFACT:"

# Executed only against the already-correlated assistant-turn element.
# It returns bounded metadata, never the full href/signed URL.
_DOM_CANDIDATE_JS = r"""
(root, expectedFilename) => {
  const normalize = (value) =>
    String(value || "").replace(/\r\n?/g, "\n").trim();

  const lines = (value) =>
    normalize(value).split("\n").map((line) => line.trim()).filter(Boolean);

  const lower = (value) => normalize(value).toLocaleLowerCase();

  const hrefBasename = (href) => {
    if (!href) return "";
    try {
      const url = new URL(href, document.baseURI);
      const decoded = decodeURIComponent(url.pathname || "");
      const parts = decoded.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "";
    } catch (_) {
      return "";
    }
  };

  const pathFromRoot = (el) => {
    const parts = [];
    let current = el;
    while (current && current !== root) {
      const parent = current.parentElement;
      if (!parent) return "";
      const index = Array.prototype.indexOf.call(parent.children, current);
      if (index < 0) return "";
      parts.push(index);
      current = parent;
    }
    if (current !== root) return "";
    return parts.reverse().join("/");
  };

  const visible = (el) => {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      return el.getClientRects().length > 0;
    } catch (_) {
      return true;
    }
  };

  const controlish = (el) => {
    if (!el || !el.matches) return false;
    const testId = lower(el.getAttribute("data-testid"));
    return (
      el.matches('a[href], button, [role="button"], [download]') ||
      testId.includes("download")
    );
  };

  const downloadish = (el) => {
    if (!controlish(el)) return false;
    const download = normalize(el.getAttribute("download"));
    const hrefBase = hrefBasename(el.getAttribute("href"));
    const blob = lower([
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("data-testid"),
      el.textContent
    ].join("\n"));
    return (
      download === expectedFilename ||
      hrefBase === expectedFilename ||
      blob.includes("download") ||
      blob.includes("скач") ||
      blob.includes("save file")
    );
  };

  const records = new Map();

  const add = (el, score, evidence) => {
    if (!el || !visible(el)) return;
    const path = pathFromRoot(el);
    if (!path) return;
    const existing = records.get(path);
    if (existing && existing.score >= score) return;
    records.set(path, {
      path,
      score,
      evidence: Array.from(new Set(evidence)),
      tag: String(el.tagName || "").toLowerCase(),
      role: normalize(el.getAttribute("role")),
      dataTestId: normalize(el.getAttribute("data-testid")).slice(0, 160),
      ariaLabel: normalize(el.getAttribute("aria-label")).slice(0, 160),
      title: normalize(el.getAttribute("title")).slice(0, 160),
      downloadExact: normalize(el.getAttribute("download")) === expectedFilename,
      hrefBasename: hrefBasename(el.getAttribute("href")).slice(0, 240),
      textLength: normalize(el.textContent).length
    });
  };

  for (const el of root.querySelectorAll('*')) {
    if (!controlish(el) || !visible(el)) continue;

    let score = 0;
    const evidence = [];
    const download = normalize(el.getAttribute("download"));
    const hrefBase = hrefBasename(el.getAttribute("href"));
    const aria = normalize(el.getAttribute("aria-label"));
    const title = normalize(el.getAttribute("title"));
    const textLines = lines(el.textContent);

    if (download === expectedFilename) {
      score = Math.max(score, 100);
      evidence.push("download_attr_exact");
    }
    if (hrefBase === expectedFilename) {
      score = Math.max(score, 95);
      evidence.push("href_basename_exact");
    }
    if (aria === expectedFilename || title === expectedFilename) {
      score = Math.max(score, 92);
      evidence.push("control_label_exact");
    }
    if (textLines.includes(expectedFilename)) {
      score = Math.max(score, 90);
      evidence.push("control_text_line_exact");
    }
    if (
      (aria.includes(expectedFilename) || title.includes(expectedFilename)) &&
      downloadish(el)
    ) {
      score = Math.max(score, 88);
      evidence.push("download_label_contains_exact_filename");
    }

    if (score > 0) add(el, score, evidence);
  }

  // Common attachment-card shape:
  // filename text is a sibling of an icon-only Download button. Search only a
  // small ancestor radius around an exact filename text node and accept only a
  // download-ish control.
  const filenameNodes = Array.from(root.querySelectorAll('*')).filter((el) => {
    if (!visible(el)) return false;
    const text = normalize(el.textContent);
    const textLines = lines(text);
    return text === expectedFilename ||
      (el.childElementCount <= 2 && textLines.includes(expectedFilename));
  });

  for (const filenameNode of filenameNodes) {
    let container = filenameNode;
    for (let depth = 0; depth <= 4 && container && container !== root; depth += 1) {
      const controls = [];
      if (downloadish(container)) controls.push(container);
      for (const el of container.querySelectorAll('a[href], button, [role="button"], [download], [data-testid*="download"]')) {
        if (downloadish(el) && visible(el)) controls.push(el);
      }
      const unique = Array.from(new Set(controls));
      if (unique.length) {
        for (const control of unique) {
          add(
            control,
            80 - depth,
            ["exact_filename_near_download_control", `ancestor_depth_${depth}`]
          );
        }
        break;
      }
      container = container.parentElement;
    }
  }

  return Array.from(records.values()).sort((a, b) =>
    (b.score - a.score) || a.path.localeCompare(b.path)
  );
}
"""


def expected_artifact_filename(request_id: str) -> str:
    return f"POSTMAN_{request_id}_RESULT.zip"


def result_begin_marker(request_id: str) -> str:
    return f"<<<POSTMAN_RESULT_BEGIN:{request_id}>>>"


def result_artifact_marker(filename: str) -> str:
    return f"{ARTIFACT_LINE_PREFIX}{filename}"


def result_end_marker(request_id: str) -> str:
    return f"<<<POSTMAN_RESULT_END:{request_id}>>>"


def _result(
    code: str,
    *,
    ok: bool,
    recoverable: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "code": code,
        "recoverable": recoverable,
        "details": dict(details or {}),
    }


def _valid_request_id(value: Any) -> bool:
    return isinstance(value, str) and bool(REQUEST_ID_RE.fullmatch(value))


def parse_result_envelope(
    assistant_text: str,
    request_id: str,
    expected_filename: str,
) -> dict[str, Any]:
    """Require one exact BEGIN -> ARTIFACT -> END envelope.

    Markers are model-written correlation signals, never routing authority.
    """
    text = observer._normalize_text(assistant_text)
    lines = [line.strip() for line in text.split("\n")]

    begin = result_begin_marker(request_id)
    artifact = result_artifact_marker(expected_filename)
    end = result_end_marker(request_id)

    begin_like = [i for i, line in enumerate(lines) if line.startswith("<<<POSTMAN_RESULT_BEGIN:")]
    end_like = [i for i, line in enumerate(lines) if line.startswith("<<<POSTMAN_RESULT_END:")]
    expected_begin = [i for i, line in enumerate(lines) if line == begin]
    expected_end = [i for i, line in enumerate(lines) if line == end]

    if not expected_begin or not expected_end:
        return _result(
            ARTIFACT_ENVELOPE_MISSING,
            ok=False,
            details={
                "beginFound": bool(expected_begin),
                "endFound": bool(expected_end),
            },
        )

    if len(begin_like) != 1 or len(end_like) != 1 or len(expected_begin) != 1 or len(expected_end) != 1:
        return _result(
            ARTIFACT_ENVELOPE_AMBIGUOUS,
            ok=False,
            details={
                "beginMarkerCount": len(begin_like),
                "endMarkerCount": len(end_like),
            },
        )

    begin_index = expected_begin[0]
    end_index = expected_end[0]
    if begin_index >= end_index:
        return _result(
            ARTIFACT_ENVELOPE_AMBIGUOUS,
            ok=False,
            details={"reason": "marker_order_invalid"},
        )

    declared = [
        (i, line[len(ARTIFACT_LINE_PREFIX):])
        for i, line in enumerate(lines[begin_index + 1 : end_index], start=begin_index + 1)
        if line.startswith(ARTIFACT_LINE_PREFIX)
    ]

    if len(declared) != 1:
        return _result(
            ARTIFACT_ENVELOPE_AMBIGUOUS if declared else ARTIFACT_ENVELOPE_MISSING,
            ok=False,
            details={
                "reason": "artifact_declaration_count",
                "artifactDeclarationCount": len(declared),
            },
        )

    artifact_index, declared_filename = declared[0]
    if declared_filename != expected_filename or lines[artifact_index] != artifact:
        return _result(
            ARTIFACT_ENVELOPE_MISSING,
            ok=False,
            details={
                "reason": "expected_filename_not_declared",
                "declaredFilenameLength": len(declared_filename),
            },
        )

    return _result(
        ARTIFACT_DOM_CONFIRMED,
        ok=True,
        details={
            "beginLine": begin_index,
            "artifactLine": artifact_index,
            "endLine": end_index,
        },
    )


def _validate_completed_observer_result(
    completed: Any,
    *,
    expected_prompt: str,
    expected_chat_url: str,
) -> dict[str, Any]:
    if not isinstance(completed, dict):
        return _result(
            ARTIFACT_OBSERVER_PROOF_INVALID,
            ok=False,
            details={"reason": "observer_result_not_object"},
        )

    details = completed.get("details")
    if not isinstance(details, dict):
        return _result(
            ARTIFACT_OBSERVER_PROOF_INVALID,
            ok=False,
            details={"reason": "observer_details_missing"},
        )

    if not completed.get("ok") or completed.get("code") != observer.ASSISTANT_TURN_COMPLETED:
        return _result(
            ARTIFACT_TURN_NOT_COMPLETED,
            ok=False,
            details={"observerCode": completed.get("code")},
        )

    if details.get("submitCode") != submit.PROMPT_SEND_CONFIRMED:
        return _result(
            ARTIFACT_OBSERVER_PROOF_INVALID,
            ok=False,
            details={
                "reason": "submit_not_confirmed",
                "submitCode": details.get("submitCode"),
            },
        )

    if details.get("submitSendState") != submit.PROVEN_SENT:
        return _result(
            ARTIFACT_OBSERVER_PROOF_INVALID,
            ok=False,
            details={
                "reason": "send_state_not_proven",
                "submitSendState": details.get("submitSendState"),
            },
        )

    if details.get("chatUrl") != expected_chat_url:
        return _result(
            ARTIFACT_CHAT_CORRELATION_LOST,
            ok=False,
            details={"reason": "observer_chat_url_mismatch"},
        )

    if details.get("promptSha256") != submit.prompt_sha256(expected_prompt):
        return _result(
            ARTIFACT_OBSERVER_PROOF_INVALID,
            ok=False,
            details={"reason": "prompt_sha_mismatch"},
        )

    assistant_index = details.get("assistantIndex")
    if isinstance(assistant_index, bool) or not isinstance(assistant_index, int) or assistant_index < 0:
        return _result(
            ARTIFACT_OBSERVER_PROOF_INVALID,
            ok=False,
            details={"reason": "assistant_index_invalid"},
        )

    assistant_sha = details.get("assistantTextSha256")
    if not isinstance(assistant_sha, str) or not SHA256_RE.fullmatch(assistant_sha):
        return _result(
            ARTIFACT_OBSERVER_PROOF_INVALID,
            ok=False,
            details={"reason": "assistant_text_sha_invalid"},
        )

    return _result(
        ARTIFACT_DOM_CONFIRMED,
        ok=True,
        details={
            "assistantIndex": assistant_index,
            "assistantTextSha256": assistant_sha,
        },
    )


def _collect_attachment_candidates(turn: Any, expected_filename: str) -> list[dict[str, Any]]:
    try:
        value = turn.evaluate(_DOM_CANDIDATE_JS, expected_filename)
    except Exception:
        return []
    if not isinstance(value, list):
        return []

    sanitized: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        score = item.get("score")
        if not isinstance(path, str) or not path:
            continue
        if isinstance(score, bool) or not isinstance(score, int) or score <= 0:
            continue
        sanitized.append(
            {
                "path": path[:512],
                "score": score,
                "evidence": [
                    str(entry)[:120]
                    for entry in item.get("evidence", [])
                    if isinstance(entry, str)
                ][:12],
                "tag": str(item.get("tag", ""))[:40],
                "role": str(item.get("role", ""))[:80],
                "dataTestId": str(item.get("dataTestId", ""))[:160],
                "ariaLabel": str(item.get("ariaLabel", ""))[:160],
                "title": str(item.get("title", ""))[:160],
                "downloadExact": bool(item.get("downloadExact")),
                "hrefBasename": str(item.get("hrefBasename", ""))[:240],
                "textLength": int(item.get("textLength", 0) or 0),
            }
        )
    return sanitized


def select_attachment_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    if not candidates:
        return _result(ARTIFACT_ATTACHMENT_NOT_FOUND, ok=False)

    best_score = max(int(item.get("score", 0)) for item in candidates)
    best = [item for item in candidates if int(item.get("score", 0)) == best_score]

    # The JS collector deduplicates the same DOM element by root-relative path.
    unique_paths = {str(item.get("path", "")) for item in best}
    if len(unique_paths) != 1:
        return _result(
            ARTIFACT_ATTACHMENT_AMBIGUOUS,
            ok=False,
            details={
                "bestScore": best_score,
                "bestCandidateCount": len(unique_paths),
            },
        )

    selected = best[0]
    return _result(
        ARTIFACT_DOM_CONFIRMED,
        ok=True,
        details={
            "candidate": selected,
            "candidateCount": len(candidates),
        },
    )


def detect_artifact_dom(
    page: Any,
    *,
    expected_prompt: str,
    expected_chat_url: str,
    request_id: str,
    expected_filename: str,
    completed_observer_result: dict[str, Any],
) -> dict[str, Any]:
    """Confirm exact P5 artifact DOM proof without clicking or downloading."""
    if not isinstance(expected_prompt, str) or expected_prompt == "":
        return _result(
            ARTIFACT_INVALID_CONFIG,
            ok=False,
            details={"reason": "expected_prompt_empty"},
        )
    if not _valid_request_id(request_id):
        return _result(
            ARTIFACT_INVALID_CONFIG,
            ok=False,
            details={"reason": "request_id_invalid"},
        )
    if not submit.is_bound_chat_url(expected_chat_url):
        return _result(
            ARTIFACT_INVALID_CONFIG,
            ok=False,
            details={"reason": "expected_chat_url_invalid"},
        )

    trusted_filename = expected_artifact_filename(request_id)
    if expected_filename != trusted_filename:
        return _result(
            ARTIFACT_INVALID_CONFIG,
            ok=False,
            details={
                "reason": "expected_filename_not_runtime_derived",
                "trustedFilename": trusted_filename,
            },
        )

    proof = _validate_completed_observer_result(
        completed_observer_result,
        expected_prompt=expected_prompt,
        expected_chat_url=expected_chat_url,
    )
    if not proof["ok"]:
        return proof

    current_url = str(getattr(page, "url", "") or "")
    if current_url != expected_chat_url:
        return _result(
            ARTIFACT_CHAT_CORRELATION_LOST,
            ok=False,
            recoverable=True,
            details={"reason": "page_url_changed"},
        )

    turns, selector = observer.snapshot_turns(page)
    correlation = observer.correlate_next_assistant(turns, expected_prompt)
    if not correlation.get("ok"):
        return _result(
            ARTIFACT_CHAT_CORRELATION_LOST,
            ok=False,
            recoverable=True,
            details={
                "reason": "assistant_turn_no_longer_correlated",
                "observerCode": correlation.get("code"),
            },
        )

    assistant = correlation.get("assistant") or {}
    assistant_index = correlation.get("assistantIndex")
    expected_index = proof["details"]["assistantIndex"]
    if assistant_index != expected_index:
        return _result(
            ARTIFACT_TURN_IDENTITY_MISMATCH,
            ok=False,
            recoverable=True,
            details={
                "expectedAssistantIndex": expected_index,
                "observedAssistantIndex": assistant_index,
            },
        )

    current_text = observer._normalize_text(assistant.get("text", ""))
    current_sha = observer.text_sha256(current_text)
    if current_sha != proof["details"]["assistantTextSha256"]:
        return _result(
            ARTIFACT_TURN_IDENTITY_MISMATCH,
            ok=False,
            recoverable=True,
            details={
                "reason": "assistant_text_changed_after_completed_proof",
                "observedTextSha256": current_sha,
            },
        )

    generating, generation_control = observer.generation_active(page)
    if generating:
        return _result(
            ARTIFACT_TURN_NOT_COMPLETED,
            ok=False,
            recoverable=True,
            details={
                "reason": "generation_control_active",
                "generationControl": generation_control,
            },
        )

    envelope = parse_result_envelope(
        current_text,
        request_id,
        expected_filename,
    )
    if not envelope["ok"]:
        return envelope

    if not selector:
        return _result(
            ARTIFACT_CHAT_CORRELATION_LOST,
            ok=False,
            details={"reason": "turn_selector_missing"},
        )

    try:
        turn = page.locator(selector).nth(expected_index)
    except Exception as exc:
        return _result(
            ARTIFACT_CHAT_CORRELATION_LOST,
            ok=False,
            recoverable=True,
            details={
                "reason": "assistant_turn_locator_failed",
                "message": str(exc)[:240],
            },
        )

    candidates = _collect_attachment_candidates(turn, expected_filename)
    selected = select_attachment_candidate(candidates)
    if not selected["ok"]:
        selected["details"].update(
            {
                "requestId": request_id,
                "expectedFilename": expected_filename,
                "assistantIndex": expected_index,
            }
        )
        return selected

    candidate = selected["details"]["candidate"]
    return _result(
        ARTIFACT_DOM_CONFIRMED,
        ok=True,
        details={
            "requestId": request_id,
            "expectedFilename": expected_filename,
            "chatUrl": expected_chat_url,
            "assistantIndex": expected_index,
            "assistantTextSha256": current_sha,
            "turnSelector": selector,
            "envelope": envelope["details"],
            "attachment": candidate,
            "candidateCount": selected["details"]["candidateCount"],
            "downloadStarted": False,
        },
    )


def run_submit_observe_detect(
    cdp_url: str,
    prompt: str,
    *,
    request_id: str,
    expected_filename: str,
    submit_timeout_ms: int = submit.DEFAULT_TIMEOUT_MS,
    assistant_timeout_ms: int = observer.DEFAULT_TIMEOUT_MS,
    stable_ms: int = observer.DEFAULT_STABLE_MS,
) -> dict[str, Any]:
    """One live P5 probe on a single owned Page; never click/download artifact."""
    try:
        factory = bootstrap._load_sync_playwright()
    except bootstrap.BrowserBootstrapError as exc:
        return _result(
            exc.code,
            ok=False,
            recoverable=exc.recoverable,
            details=exc.details,
        )

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
                        ARTIFACT_ATTACH_FAILED,
                        ok=False,
                        recoverable=True,
                        details={"message": str(exc)[:240]},
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
                        submit_result.get("code", ARTIFACT_CHAT_CORRELATION_LOST),
                        ok=False,
                        recoverable=bool(submit_result.get("recoverable")),
                        details={
                            "phase": "submit",
                            "submitResult": submit_result,
                        },
                    )

                chat_url = str(
                    submit_result.get("details", {}).get("chatUrl", "") or ""
                )
                completed = observer.observe_next_assistant(
                    page,
                    prompt,
                    chat_url,
                    timeout_ms=assistant_timeout_ms,
                    stable_ms=stable_ms,
                )
                completed.setdefault("details", {})
                completed["details"].update(
                    {
                        "phase": "assistant",
                        "promptSha256": submit.prompt_sha256(prompt),
                        "submitCode": submit_result.get("code"),
                        "submitSendState": submit_result.get("sendState"),
                    }
                )
                if not completed.get("ok"):
                    return completed

                detected = detect_artifact_dom(
                    page,
                    expected_prompt=prompt,
                    expected_chat_url=chat_url,
                    request_id=request_id,
                    expected_filename=expected_filename,
                    completed_observer_result=completed,
                )
                detected["details"].update(
                    {
                        "phase": "artifact_dom",
                        "submitCode": submit_result.get("code"),
                        "submitSendState": submit_result.get("sendState"),
                    }
                )
                return detected
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
            ARTIFACT_ATTACH_FAILED,
            ok=False,
            recoverable=True,
            details={"message": str(exc)[:240]},
        )


def _json_dumps(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Web Postman P5 artifact DOM detector probe"
    )
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--request-id", required=True)
    parser.add_argument("--expected-filename")
    parser.add_argument("--cdp-url", default=bootstrap.DEFAULT_CDP_URL)
    parser.add_argument(
        "--submit-timeout-ms",
        type=int,
        default=submit.DEFAULT_TIMEOUT_MS,
    )
    parser.add_argument(
        "--assistant-timeout-ms",
        type=int,
        default=observer.DEFAULT_TIMEOUT_MS,
    )
    parser.add_argument(
        "--stable-ms",
        type=int,
        default=observer.DEFAULT_STABLE_MS,
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    filename = args.expected_filename or expected_artifact_filename(args.request_id)
    result = run_submit_observe_detect(
        args.cdp_url,
        args.prompt,
        request_id=args.request_id,
        expected_filename=filename,
        submit_timeout_ms=args.submit_timeout_ms,
        assistant_timeout_ms=args.assistant_timeout_ms,
        stable_ms=args.stable_ms,
    )
    print(_json_dumps(result))
    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    raise SystemExit(main())
