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
import request_identity as identity

ARTIFACT_DOM_CONFIRMED = "ARTIFACT_DOM_CONFIRMED"
ARTIFACT_INVALID_CONFIG = "ARTIFACT_INVALID_CONFIG"
ARTIFACT_OBSERVER_PROOF_INVALID = "ARTIFACT_OBSERVER_PROOF_INVALID"
ARTIFACT_CHAT_CORRELATION_LOST = "ARTIFACT_CHAT_CORRELATION_LOST"
ARTIFACT_TURN_IDENTITY_MISMATCH = "ARTIFACT_TURN_IDENTITY_MISMATCH"
ARTIFACT_TURN_NOT_COMPLETED = "ARTIFACT_TURN_NOT_COMPLETED"
ARTIFACT_ENVELOPE_MISSING = "ARTIFACT_ENVELOPE_MISSING"
ARTIFACT_ENVELOPE_AMBIGUOUS = "ARTIFACT_ENVELOPE_AMBIGUOUS"
ARTIFACT_ENVELOPE_DOM_MISMATCH = "ARTIFACT_ENVELOPE_DOM_MISMATCH"
ARTIFACT_ATTACHMENT_NOT_FOUND = "ARTIFACT_ATTACHMENT_NOT_FOUND"
ARTIFACT_ATTACHMENT_OUTSIDE_ENVELOPE = "ARTIFACT_ATTACHMENT_OUTSIDE_ENVELOPE"
ARTIFACT_ATTACHMENT_AMBIGUOUS = "ARTIFACT_ATTACHMENT_AMBIGUOUS"
ARTIFACT_ATTACH_FAILED = "ARTIFACT_ATTACH_FAILED"

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# Executed only against the already-correlated assistant-turn element.
# It returns bounded metadata, never the full href/signed URL.
_DOM_CANDIDATE_JS = r"""
(root, args) => {
  const expectedFilename = String(args.expectedFilename || "");
  const beginMarker = String(args.beginMarker || "");
  const endMarker = String(args.endMarker || "");
  const normalize = (value) => String(value || "").replace(/\r\n?/g, "\n").trim();

  const visible = (el) => {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
      return el.getClientRects().length > 0;
    } catch (_) {
      return true;
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

  // Markers can be split into several text nodes by React/Markdown. Build a
  // rendered, visibility-filtered text stream and retain its DOM boundaries.
  const markerRanges = (expected) => {
    const segments = [];
    let rendered = "";
    const append = (node, value) => {
      if (!value) return;
      segments.push({ node, start: rendered.length, end: rendered.length + value.length });
      rendered += value;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE && visible(node.parentElement)) {
        append(node, String(node.nodeValue || ""));
      } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR" && visible(node)) {
        append(node, "\\n");
      }
      node = walker.nextNode();
    }
    const ranges = [];
    let from = 0;
    while (true) {
      const start = rendered.indexOf(expected, from);
      if (start < 0) break;
      const end = start + expected.length;
      const covered = segments.filter((segment) => segment.end > start && segment.start < end);
      if (covered.length) {
        ranges.push({ first: covered[0].node, last: covered[covered.length - 1].node });
      }
      from = end;
    }
    return ranges;
  };

  const beginRanges = markerRanges(beginMarker);
  const endRanges = markerRanges(endMarker);
  const before = (a, b) => Boolean(a && b && a !== b &&
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
  const between = (begin, element, end) => Boolean(
    begin && end && before(begin.last, element) && before(element, end.first)
  );

  const candidates = [];
  for (const el of root.querySelectorAll('a[href], button, [role="button"], [download]')) {
    if (!visible(el)) continue;
    const visibleLabel = normalize(el.textContent);
    if (visibleLabel !== expectedFilename) continue;
    const betweenMarkers = beginRanges.length === 1 && endRanges.length === 1 &&
      between(beginRanges[0], el, endRanges[0]);
    candidates.push({
      path: pathFromRoot(el),
      tag: String(el.tagName || "").toLowerCase(),
      role: normalize(el.getAttribute("role")),
      dataTestId: normalize(el.getAttribute("data-testid")).slice(0, 160),
      ariaLabel: normalize(el.getAttribute("aria-label")).slice(0, 160),
      title: normalize(el.getAttribute("title")).slice(0, 160),
      visibleLabelExact: true,
      visibleLabelLength: visibleLabel.length,
      downloadExact: normalize(el.getAttribute("download")) === expectedFilename,
      hrefBasename: hrefBasename(el.getAttribute("href")).slice(0, 240),
      betweenMarkers
    });
  }

  return {
    beginMarkerCount: beginRanges.length,
    endMarkerCount: endRanges.length,
    candidates
  };
}
"""


def expected_artifact_filename(request_id: str, ordinal: int | None = None) -> str:
    return identity.expected_artifact_filename(request_id, ordinal)


def result_begin_marker(request_id: str) -> str:
    return f"<<<POSTMAN_RESULT_BEGIN:{request_id}>>>"


def result_artifact_marker(filename: str) -> str:
    # The middle visible line is the real downloadable control itself.
    return filename


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
    return identity.is_canonical_request_id(value)


def parse_result_envelope(
    assistant_text: str,
    request_id: str,
    expected_filename: str,
) -> dict[str, Any]:
    """Require exactly BEGIN -> exact filename -> END and no extra visible text."""
    text = observer._normalize_text(assistant_text)
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    expected = [
        result_begin_marker(request_id),
        expected_filename,
        result_end_marker(request_id),
    ]
    if lines == expected:
        return _result(
            ARTIFACT_DOM_CONFIRMED,
            ok=True,
            details={"beginLine": 0, "artifactLine": 1, "endLine": 2},
        )
    begin_count = sum(line == expected[0] for line in lines)
    end_count = sum(line == expected[2] for line in lines)
    filename_count = sum(line == expected_filename for line in lines)
    if begin_count > 1 or end_count > 1 or filename_count > 1:
        return _result(
            ARTIFACT_ENVELOPE_AMBIGUOUS,
            ok=False,
            details={
                "beginMarkerCount": begin_count,
                "endMarkerCount": end_count,
                "filenameLineCount": filename_count,
            },
        )
    return _result(
        ARTIFACT_ENVELOPE_MISSING,
        ok=False,
        details={
            "beginFound": begin_count == 1,
            "filenameFound": filename_count == 1,
            "endFound": end_count == 1,
            "visibleLineCount": len(lines),
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


def _collect_attachment_candidates(
    turn: Any,
    request_id: str,
    expected_filename: str,
) -> dict[str, Any]:
    args = {
        "expectedFilename": expected_filename,
        "beginMarker": result_begin_marker(request_id),
        "endMarker": result_end_marker(request_id),
    }
    try:
        value = turn.evaluate(_DOM_CANDIDATE_JS, args)
    except Exception:
        return {"beginMarkerCount": 0, "endMarkerCount": 0, "candidates": []}
    if not isinstance(value, dict):
        return {"beginMarkerCount": 0, "endMarkerCount": 0, "candidates": []}
    sanitized: list[dict[str, Any]] = []
    for item in value.get("candidates", []):
        if not isinstance(item, dict):
            continue
        path = item.get("path")
        if not isinstance(path, str) or not path:
            continue
        sanitized.append({
            "path": path[:512],
            "tag": str(item.get("tag", ""))[:40],
            "role": str(item.get("role", ""))[:80],
            "dataTestId": str(item.get("dataTestId", ""))[:160],
            "ariaLabel": str(item.get("ariaLabel", ""))[:160],
            "title": str(item.get("title", ""))[:160],
            "visibleLabelExact": bool(item.get("visibleLabelExact")),
            "visibleLabelLength": int(item.get("visibleLabelLength", 0) or 0),
            "downloadExact": bool(item.get("downloadExact")),
            "hrefBasename": str(item.get("hrefBasename", ""))[:240],
            "betweenMarkers": bool(item.get("betweenMarkers")),
        })
    return {
        "beginMarkerCount": int(value.get("beginMarkerCount", 0) or 0),
        "endMarkerCount": int(value.get("endMarkerCount", 0) or 0),
        "candidates": sanitized,
    }


def select_attachment_candidate(dom_proof: dict[str, Any]) -> dict[str, Any]:
    candidates = list(dom_proof.get("candidates", []))
    inside = [item for item in candidates if item.get("betweenMarkers")]
    if not candidates:
        return _result(ARTIFACT_ATTACHMENT_NOT_FOUND, ok=False)
    if not inside:
        return _result(
            ARTIFACT_ATTACHMENT_OUTSIDE_ENVELOPE,
            ok=False,
            details={"candidateCount": len(candidates)},
        )
    unique_paths = {str(item.get("path", "")) for item in inside}
    if len(unique_paths) != 1:
        return _result(
            ARTIFACT_ATTACHMENT_AMBIGUOUS,
            ok=False,
            details={"insideCandidateCount": len(unique_paths)},
        )
    selected = inside[0]
    return _result(
        ARTIFACT_DOM_CONFIRMED,
        ok=True,
        details={"candidate": selected, "candidateCount": len(candidates)},
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
    prompt_lines = [line.strip() for line in observer._normalize_text(expected_prompt).split("\n") if line.strip()]
    required_key_line = identity.request_prompt_key_line(request_id)
    if not prompt_lines or prompt_lines[0] != required_key_line:
        return _result(
            ARTIFACT_INVALID_CONFIG,
            ok=False,
            details={
                "reason": "prompt_request_key_missing_or_not_first",
                "requiredKeyLine": required_key_line,
            },
        )
    if not submit.is_bound_chat_url(expected_chat_url):
        return _result(
            ARTIFACT_INVALID_CONFIG,
            ok=False,
            details={"reason": "expected_chat_url_invalid"},
        )

    if not identity.validate_expected_artifact_filename(request_id, expected_filename):
        return _result(
            ARTIFACT_INVALID_CONFIG,
            ok=False,
            details={
                "reason": "expected_filename_does_not_embed_request_key",
                "requestId": request_id,
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

    dom_proof = _collect_attachment_candidates(turn, request_id, expected_filename)
    if dom_proof["beginMarkerCount"] != 1 or dom_proof["endMarkerCount"] != 1:
        return _result(
            ARTIFACT_ENVELOPE_DOM_MISMATCH,
            ok=False,
            details={
                "beginMarkerCount": dom_proof["beginMarkerCount"],
                "endMarkerCount": dom_proof["endMarkerCount"],
            },
        )
    selected = select_attachment_candidate(dom_proof)
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
