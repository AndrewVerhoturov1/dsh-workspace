#!/usr/bin/env python3
"""Web Postman P4 assistant-turn observer.

Scope:
- re-confirm the exact proven user turn from P3;
- bind observation to the exact /c/... chat URL;
- correlate only the first conversation turn after that user turn;
- require that turn to be authored by assistant;
- distinguish STARTED / STREAMING / COMPLETED;
- never use body-wide text as response correlation;
- never send prompts or download artifacts.

P4 completion proof is conservative: the correlated assistant turn must have
non-empty text (or, in opt-in image mode, rendered image DOM evidence),
generation controls must be inactive, and its content must remain stable for
a configured interval.
"""

from __future__ import annotations

import cdp_download

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import browser_bootstrap as bootstrap
import browser_submit as submit

DEFAULT_TIMEOUT_MS = 120_000
DEFAULT_STABLE_MS = 2_000
DEFAULT_POLL_MS = 3_000

ASSISTANT_TURN_STARTED = "ASSISTANT_TURN_STARTED"
ASSISTANT_TURN_STREAMING = "ASSISTANT_TURN_STREAMING"
ASSISTANT_TURN_COMPLETED = "ASSISTANT_TURN_COMPLETED"
ASSISTANT_CONNECTION_INTERRUPTED = "ASSISTANT_CONNECTION_INTERRUPTED"
ADDITIONAL_PROCESSING = "ADDITIONAL_PROCESSING"
WORKING = "WORKING"
FINAL_ANSWER_STARTED = "FINAL_ANSWER_STARTED"
FINAL_ANSWER_COMPLETED = "FINAL_ANSWER_COMPLETED"
UNKNOWN = "UNKNOWN"

USER_TURN_ANCHOR_MISSING = "USER_TURN_ANCHOR_MISSING"
CHAT_CORRELATION_LOST = "CHAT_CORRELATION_LOST"
ASSISTANT_NOT_STARTED = "ASSISTANT_NOT_STARTED"
ASSISTANT_STATE_UNKNOWN = "ASSISTANT_STATE_UNKNOWN"
ASSISTANT_TURN_TIMEOUT = "ASSISTANT_TURN_TIMEOUT"
OBSERVER_ATTACH_FAILED = "OBSERVER_ATTACH_FAILED"
OBSERVER_INVALID_CONFIG = "OBSERVER_INVALID_CONFIG"

TURN_CONTAINER_SELECTORS = (
    'main [data-turn-key]',
    '[data-testid^="conversation-turn-"]',
    '[data-message-author-role="user"], [data-message-author-role="assistant"]',
    # Current ChatGPT transcript markup (2026-09) exposes user bubbles and
    # assistant message ids, but neither legacy turn ids nor author roles.
    'main [data-user-message-bubble="true"], main [data-chatgpt-selection-message-id]',
)

GENERATION_CONTROL_SELECTORS = (
    'button[data-testid="stop-button"]',
    'button[data-testid="stop-generating-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
    'button[aria-label="Pause"]',
    'button[aria-label="Pause generation"]',
    'button[aria-label="Приостановить"]',
    'button[aria-label="Остановить создание"]',
    'button[aria-label="Остановить"]',
)


def _normalize_text(value: str) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def text_sha256(text: str) -> str:
    return hashlib.sha256(_normalize_text(text).encode("utf-8")).hexdigest()


def _locator_count(locator: Any) -> int:
    try:
        return int(locator.count())
    except Exception:
        return 0


def _get_attribute(locator: Any, name: str) -> str:
    try:
        value = locator.get_attribute(name)
    except Exception:
        return ""
    return str(value or "")


def _inner_text(locator: Any) -> str:
    try:
        return _normalize_text(locator.inner_text(timeout=1_000))
    except Exception:
        return ""


def _turn_message_node(turn: Any) -> Any:
    """Return semantic message content, excluding user-turn UI chrome."""
    direct_role = _get_attribute(turn, "data-message-author-role").casefold()
    if _get_attribute(turn, "data-user-message-bubble").casefold() == "true":
        semantic, _ = submit.find_user_message_content(turn)
        return semantic
    if direct_role == "user":
        semantic, _ = submit.find_user_message_content(turn)
        return semantic if semantic is not None else turn
    if direct_role == "assistant":
        # Assistant attachment controls are part of the correlated response;
        # keep the role node so its rendered text and controls remain scoped.
        return turn
    try:
        nested = turn.locator("[data-message-author-role]")
        if _locator_count(nested) > 0:
            try:
                first = nested.first
                first_role = _get_attribute(first, "data-message-author-role").casefold()
                if first_role == "user":
                    semantic, _ = submit.find_user_message_content(first)
                    return semantic if semantic is not None else first
                if first_role == "assistant":
                    return first
            except Exception:
                pass
            try:
                return nested.nth(0)
            except Exception:
                pass
    except Exception:
        pass
    return turn


def infer_turn_role(turn: Any) -> str:
    """Infer role independently from payload extraction, fail-closed."""
    direct_role = _get_attribute(turn, "data-message-author-role").casefold()
    if direct_role in {"user", "assistant"}:
        return direct_role

    # A conversation section can wrap a role node whose payload is a deeper
    # content node. Read the role-bearing node before selecting that payload.
    try:
        nested = turn.locator("[data-message-author-role]")
        if _locator_count(nested) > 0:
            for candidate in (nested.first, nested.nth(0)):
                nested_role = _get_attribute(candidate, "data-message-author-role").casefold()
                if nested_role in {"user", "assistant"}:
                    return nested_role
    except Exception:
        pass

    message = _turn_message_node(turn)
    role = _get_attribute(message, "data-message-author-role").casefold()
    if role in {"user", "assistant"}:
        return role

    if _get_attribute(turn, "data-user-message-bubble").casefold() == "true":
        return "user"
    if _get_attribute(turn, "data-chatgpt-selection-message-id") or _get_attribute(turn, "data-conversation-role").casefold() == "assistant":
        return "assistant"

    test_id = _get_attribute(turn, "data-testid").casefold()
    if "conversation-turn-user" in test_id:
        return "user"
    if "conversation-turn-assistant" in test_id:
        return "assistant"
    return "unknown"


def extract_turn_text(turn: Any) -> str:
    """Read semantic message text, preserving scoped inline-code syntax."""
    return submit.read_semantic_message_text(_turn_message_node(turn))


_IMAGE_EVIDENCE_JS = r"""
(node) => {
  // The current ChatGPT generated-image gallery is a sibling of the text
  // message, but still belongs to the same correlated conversation turn.
  const turn = node.closest('[data-content-search-turn-key]');
  const images = new Set(node.querySelectorAll('img'));
  if (turn) turn.querySelectorAll('[data-testid="generated-image-gallery"] img')
    .forEach(img => images.add(img));
  return [...images].filter(img => !img.closest('[data-user-message-bubble], [data-message-author-role="user"]') &&
    img.isConnected && img.complete &&
    img.naturalWidth >= 64 && img.naturalHeight >= 64 &&
    img.getClientRects().length > 0 &&
    getComputedStyle(img).visibility !== 'hidden').length;
}
"""


def count_turn_images(turn: Any) -> int:
    """Count decoded visible images inside the correlated assistant message."""
    try:
        return int(_turn_message_node(turn).evaluate(_IMAGE_EVIDENCE_JS))
    except Exception:
        return 0


_ASSISTANT_IDENTITY_JS = r"""
(node) => {
  // Ancestors are limited to this response's semantic turn, never main/body.
  const group = node.closest('[data-turn-key]');
  const contentTurn = node.closest('[data-content-search-turn-key]');
  const keys = new Set();
  if (contentTurn) keys.add(contentTurn.getAttribute('data-content-search-turn-key'));
  node.querySelectorAll('[data-content-search-turn-key]').forEach(el => {
    // Do not pin user-only units or transient analysis/commentary message ids.
    if (el.matches('[data-message-author-role="user"], [data-user-message-bubble]') ||
        el.querySelector('[data-message-author-role="user"], [data-user-message-bubble]')) return;
    keys.add(el.getAttribute('data-content-search-turn-key'));
  });
  keys.delete(''); keys.delete(null);
  // A grouped response can contain several internal assistant units. Their
  // message ids are not a stable response id; only direct role/message nodes
  // outside that grouped representation provide this existing identity.
  const message = !group && node.matches('[data-message-author-role="assistant"], [data-chatgpt-selection-message-id]') ? node : null;
  return {groupKey: group?.getAttribute('data-turn-key') || '',
    contentSearchTurnKey: keys.size === 1 ? [...keys][0] : '',
    assistantMessageId: message?.getAttribute('data-chatgpt-selection-message-id') || message?.getAttribute('data-message-id') || '',
    identityAmbiguous: keys.size > 1};
}
"""


def assistant_identity_evidence(turn: Any) -> dict[str, Any]:
    """Read only identity exposed by the scoped assistant/turn DOM."""
    try:
        evidence = turn.evaluate(_ASSISTANT_IDENTITY_JS)
        return evidence if isinstance(evidence, dict) else {}
    except Exception:
        return {}


def snapshot_turns(page: Any, *, image_mode: bool = False,
                   expected_prompt: str | None = None,
                   anchor_binding: dict[str, Any] | None = None) -> tuple[list[dict[str, Any]], str]:
    """Return ordered conversation turns from one selector family only.

    The first selector family that yields turns wins. This avoids double
    counting aliases that point at the same DOM nodes.
    """
    for selector in TURN_CONTAINER_SELECTORS:
        if selector == 'main [data-turn-key]':
            try:
                groups = page.locator(selector)
                turns: list[dict[str, Any]] = []
                for group_index in range(_locator_count(groups)):
                    group = groups.nth(group_index)
                    key = _get_attribute(group, 'data-turn-key')
                    if not key:
                        continue
                    users = group.locator('[data-user-message-bubble="true"]')
                    if _locator_count(users):
                        user = users.first
                        turns.append({'index': len(turns), 'nodeIndex': group_index,
                                      'role': 'user', 'text': extract_turn_text(user),
                                      'groupKey': key, 'testId': key})
                    evidence = group.evaluate(_PHASE_EVIDENCE_JS)
                    if isinstance(evidence, dict) and (evidence.get('assistantNodeFound') or evidence.get('workingControlFound')):
                        turns.append({'index': len(turns), 'nodeIndex': group_index,
                                      'role': 'assistant', 'text': str(evidence.get('finalAnswerText') or ''),
                                      'groupKey': key, 'testId': key,
                                      'imageCount': count_turn_images(group) if image_mode else 0,
                                      **assistant_identity_evidence(group)})
                has_assistant = any(t.get('role') == 'assistant' for t in turns)
                if image_mode and expected_prompt is not None:
                    # An older group's assistant must not hide the current
                    # image-only gallery, available only in fallback markup.
                    current = correlate_next_assistant(
                        turns, expected_prompt, anchor_binding=anchor_binding)
                    has_assistant = current["ok"] or current["code"] == CHAT_CORRELATION_LOST
                if turns and (not image_mode or has_assistant):
                    return turns, selector
            except Exception:
                pass
            continue
        if image_mode and selector == TURN_CONTAINER_SELECTORS[-1]:
            selector += ', main [data-testid="generated-image-gallery"]'
        try:
            locator = page.locator(selector)
            count = _locator_count(locator)
            if count <= 0:
                continue
            turns: list[dict[str, Any]] = []
            for index in range(count):
                node = locator.nth(index)
                role = ("assistant" if image_mode and _get_attribute(node, "data-testid") == "generated-image-gallery"
                        else infer_turn_role(node))
                entry = {
                    "index": index,
                    "role": role,
                    "text": extract_turn_text(node),
                    "testId": _get_attribute(node, "data-testid"),
                }
                if role == "user":
                    entry["groupKey"] = assistant_identity_evidence(_turn_message_node(node)).get("groupKey", "")
                if role == "assistant":
                    entry.update(assistant_identity_evidence(_turn_message_node(node)))
                    if image_mode:
                        entry["imageCount"] = count_turn_images(node)
                turns.append(entry)
            return turns, selector
        except Exception:
            continue
    return [], ""


def generation_active(page: Any) -> tuple[bool, str]:
    for selector in GENERATION_CONTROL_SELECTORS:
        try:
            locator = page.locator(selector)
            if _locator_count(locator) <= 0:
                continue
            candidate = locator.first
            if candidate.is_visible():
                return True, selector
        except Exception:
            continue

    try:
        semantic = page.get_by_role(
            "button",
            name=re.compile(r"^(stop|stop generating|pause|pause generation|остановить|остановить создание|приостановить)$", re.I),
        )
        if _locator_count(semantic) > 0 and semantic.first.is_visible():
            return True, "role=button[name=stop]"
    except Exception:
        pass
    return False, ""


_INTERRUPTION_SCOPE_JS = r"""
(node) => {
  const markdown = node.closest('[data-markdown-text-style="assistant-message"], .markdown, [data-testid="assistant-message"]');
  const user = node.closest('[data-user-message-bubble], [data-message-author-role="user"]');
  const quoted = node.closest('pre, code, blockquote');
  const turn = node.closest('[data-turn-key], [data-testid^="conversation-turn-"], [data-content-search-turn-key]');
  const semantic = node.closest('[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], [data-testid*="error"], [data-testid*="alert"], [data-testid*="status"]');
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  let scope = node;
  // A local banner may split headline/subtitle/controls across siblings. Do not
  // climb into the whole turn, transcript, or body merely to gather keywords.
  for (let el = node.parentElement, depth = 0; el && depth < 3; el = el.parentElement, depth++) {
    if (el === turn || el.matches('main, body') || el.querySelector('[data-user-message-bubble]')) break;
    if (String(el.innerText || '').length > 1200) break;
    scope = el;
    if (el === semantic) break;
  }
  const buttons = [...scope.querySelectorAll('button')].filter(visible);
  const retry = buttons.some(b => /retry|reconnect|try again|повтор|переподключ/i.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')));
  return {scopeText: String(scope.innerText || node.innerText || '').slice(0, 1200),
    ownText: String(node.innerText || ''), insideMarkdown: !!markdown,
    insideUser: !!user, insideQuote: !!quoted, insideTurnWrapper: !!turn,
    roleAlert: semantic?.getAttribute('role') === 'alert',
    roleStatus: semantic?.getAttribute('role') === 'status',
    ariaLive: !!semantic?.getAttribute('aria-live'), systemContainer: !!semantic,
    retryControlNearby: retry};
}
"""

_INTERRUPTION_HEAD_PATTERNS = (
    re.compile(r"Соединение\s+прервано", re.I),
    re.compile(r"Connection\s+interrupted", re.I),
)
_PROCESSING_PATTERN = re.compile(
    r"дополнительн[а-я]*\s+обработ[а-я]*|наши\s+системы[^.!?]{0,100}обрабатывают|"
    r"additional\s+processing|our\s+systems[^.!?]{0,100}(?:processing|process)", re.I)


def _normalize_ui_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _system_banner(page: Any, patterns: tuple[Any, ...], source: str) -> tuple[bool, dict[str, Any]]:
    candidates = []
    for pattern in patterns:
        try:
            matches = page.get_by_text(pattern)
            count = min(_locator_count(matches), 8)
        except Exception:
            continue
        for index in range(count):
            try:
                node = matches.nth(index)
                if not node.is_visible():
                    continue
                scope = node.evaluate(_INTERRUPTION_SCOPE_JS)
                if not isinstance(scope, dict):
                    raise ValueError("scope_unverified")
            except Exception:
                candidates.append({"accepted": False, "reason": "scope_unverified"})
                continue
            text = str(scope.get("scopeText", ""))[:1200]
            own = _normalize_ui_text(scope.get("ownText", text))
            evidence = {key: bool(scope.get(key)) for key in
                        ("roleAlert", "roleStatus", "ariaLive", "retryControlNearby",
                         "systemContainer", "insideMarkdown", "insideTurnWrapper")}
            evidence["textExact"] = bool(re.fullmatch(r"(?:соединение\s+прервано|connection\s+interrupted)[.!…]*", own))
            evidence["textVariant"] = bool(pattern.search(own))
            semantic = any(evidence[k] for k in ("roleAlert", "roleStatus", "ariaLive", "retryControlNearby", "systemContainer"))
            # Compatibility scopes from older clients explicitly identify transcript.
            transcript = scope.get("insideConversation") or scope.get("insideUser") or scope.get("insideQuote")
            if transcript or (evidence["insideMarkdown"] and not semantic):
                confidence, reason = "rejected", "transcript_or_literal_quote"
            elif not pattern.search(_normalize_ui_text(text)):
                confidence, reason = "rejected", "text_not_in_verified_scope"
            elif semantic or (not evidence["insideMarkdown"] and len(own) < 200):
                confidence, reason = "strong", "local_system_ui"
            else:
                confidence, reason = "weak", "needs_second_poll"
            item = {"matchedText": text[:500], "source": source, "evidence": evidence,
                    "confidence": confidence, "reason": reason, "accepted": confidence == "strong"}
            candidates.append(item)
    best = next((c for c in candidates if c.get("accepted")), None)
    if best is None:
        best = next((c for c in candidates if c.get("confidence") == "weak"), candidates[-1] if candidates else {})
    return bool(best.get("accepted")), {**best, "candidateCount": len(candidates), "candidates": candidates[:8]}


def connection_interrupted(page: Any) -> tuple[bool, dict[str, Any]]:
    """Headline alone suffices outside markdown; turn layouts are not transcript."""
    return _system_banner(page, _INTERRUPTION_HEAD_PATTERNS, "visible_connection_interruption_ui")


_WORKING_TURN_JS = r"""
(node) => {
  const scope = node.closest('[data-turn-key], [data-content-search-turn-key], [data-testid^="conversation-turn-"]') || node;
  return !!scope.querySelector('[data-chatgpt-agent-turn-start], [data-streaming-response-status], [data-testid*="thinking"], [data-testid*="tool"], [data-testid*="reasoning"], [data-state="thinking"], [data-state="running"], [data-stream-phase="commentary"], [data-stream-phase="analysis"]');
}
"""

_PHASE_EVIDENCE_JS = r"""
(node) => {
  const scope = node.closest('[data-turn-key], [data-content-search-turn-key], [data-testid^="conversation-turn-"]') || node;
  const modern = scope.hasAttribute('data-turn-key');
  const activity = '[data-chatgpt-agent-turn-start], [data-streaming-response-status], [data-testid*="activity"], [data-testid*="thinking"], [data-testid*="tool"], [data-testid*="reasoning"], [data-state="thinking"], [data-state="running"], [data-stream-phase="commentary"], [data-stream-phase="analysis"], [data-testid*="cot"], [data-testid*="progress"]';
  const markdown = '[data-markdown-text-style="assistant-message"], .markdown.prose, [data-testid="assistant-message"]';
  // The turn-start marker can wrap later final units. Only its progress
  // descendants (or unclassified commentary inside it) are activity text.
  const progress = '[data-streaming-response-status], [data-testid*="activity"], [data-testid*="thinking"], [data-testid*="tool"], [data-testid*="reasoning"], [data-state="thinking"], [data-state="running"], [data-stream-phase="commentary"], [data-stream-phase="analysis"], [data-testid*="cot"], [data-testid*="progress"]';
  const insideActivity = el => !!el.closest(progress) ||
    (!!el.closest('[data-chatgpt-agent-turn-start]') &&
     !el.closest('[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]'));
  const units = [...scope.querySelectorAll('[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-message-author-role="assistant"], [data-chatgpt-selection-message-id]')];
  if (node.matches('[data-message-author-role="assistant"], [data-chatgpt-selection-message-id]')) units.unshift(node);
  const unique = [...new Set(units)];
  const renderedIn = unit => [...unit.querySelectorAll(markdown)].find(m => !insideActivity(m) && !!m.innerText?.trim());
  const answer = unique.find(unit => {
    if (insideActivity(unit)) return false;
    if (modern && !(unit.matches('[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]') &&
        (unit.matches('[data-conversation-role="assistant"]') || unit.querySelector('[data-conversation-role="assistant"]')))) return false;
    if (!modern && !(unit.matches('[data-message-author-role="assistant"]') ||
        (unit.matches('[data-chatgpt-selection-message-id]') && unit.hasAttribute('data-message-model-slug')))) return false;
    return !!renderedIn(unit);
  });
  const rendered = answer && renderedIn(answer);
  const message = answer || unique[0] || null;
  const actions = [...scope.querySelectorAll('button[data-testid="copy-turn-action-button"], .turn-action-controls button')];
  const followsAnswer = b => !!answer && !b.closest(progress) &&
    !!(answer.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const complete = actions.some(followsAnswer) || [...scope.querySelectorAll('button')].some(b =>
    followsAnswer(b) && /^(оценить ответ|rate response|regenerate|сгенерировать ответ заново|прочитать вслух|read aloud)/i.test(b.getAttribute('aria-label') || ''));
  const working = insideActivity(node) || !!scope.querySelector(activity);
  const phaseNode = scope.querySelector('[data-stream-phase]');
  return {assistantNodeFound: !!message || working, assistantMessageId: message?.getAttribute('data-chatgpt-selection-message-id') || message?.getAttribute('data-message-id') || '', hasModelSlug: !!message?.getAttribute('data-message-model-slug'), modelSlugValue: message?.getAttribute('data-message-model-slug') || '', hasRenderedAnswerContainer: !!rendered, finalUnitProven: !!rendered, finalAnswerText: rendered?.innerText || '', answerContainerSelector: rendered ? (rendered.hasAttribute('data-markdown-text-style') ? '[data-markdown-text-style="assistant-message"]' : '.markdown.prose / [data-testid="assistant-message"]') : '', completionControlFound: !!answer && complete, workingControlFound: working, streamPhase: phaseNode?.getAttribute('data-stream-phase') || ''};
}
"""


def additional_processing(page: Any) -> tuple[bool, dict[str, Any]]:
    """Recognize local system processing UI across RU/EN wording variants."""
    return _system_banner(page, (_PROCESSING_PATTERN,), "visible_additional_processing_ui")


class AnswerPhaseTracker:
    """Latch the final answer for one exact user anchor and logical turn."""

    def __init__(self) -> None:
        self.anchor: tuple[str, str, tuple[str, str | int]] | None = None
        self.turn_key: str | None = None
        self.final_answer_latched = False


def inspect_answer_phase(page: Any, expected_prompt: str, expected_chat_url: str,
                         *, tracker: AnswerPhaseTracker | None = None,
                         image_mode: bool = False,
                         anchor_binding: dict[str, Any] | None = None,
                         ignore_system_banner: bool = False) -> dict[str, Any]:
    """Classify only a correlated turn using structural DOM evidence."""
    tracker = tracker if tracker is not None else AnswerPhaseTracker()
    details: dict[str, Any] = {"chatUrl": str(getattr(page, "url", "") or ""),
                               "phase": UNKNOWN, "phaseSource": "unproved",
                               "finalAnswerLatched": tracker.final_answer_latched}
    if details["chatUrl"] != expected_chat_url or not submit.is_bound_chat_url(expected_chat_url):
        details["phaseSource"] = "chat_correlation_lost"
        return details
    turns, selector = snapshot_turns(page, image_mode=image_mode, expected_prompt=expected_prompt,
                                         anchor_binding=anchor_binding)
    correlation = (correlate_next_assistant(turns, expected_prompt, anchor_binding=anchor_binding)
                   if anchor_binding is not None else correlate_next_assistant(turns, expected_prompt))
    anchor = correlation.get("anchorIndex")
    details.update(turnSelector=selector, anchorIndex=anchor,
                   assistantIndex=correlation.get("assistantIndex"),
                   correlationCode=correlation["code"], turnCount=len(turns))
    if anchor is None or correlation["code"] == CHAT_CORRELATION_LOST:
        return details
    if any(t.get("role") == "user" and t.get("index", -1) > anchor for t in turns):
        details["phaseSource"] = "another_user_turn"
        return details
    anchor_turn = turns[anchor]
    group_key = str(anchor_turn.get("groupKey") or "")
    anchor_key = (expected_chat_url, expected_prompt,
                  ("group", group_key) if group_key else ("index", anchor))
    if (group_key and tracker.turn_key and tracker.turn_key != group_key
            and tracker.anchor and tracker.anchor[:2] == anchor_key[:2]):
        details["phaseSource"] = "logical_turn_changed"
        return details
    if tracker.anchor != anchor_key:
        tracker.anchor = anchor_key
        tracker.turn_key = None
        tracker.final_answer_latched = False
    if group_key:
        if tracker.turn_key and tracker.turn_key != group_key:
            details["phaseSource"] = "logical_turn_changed"
            return details
        tracker.turn_key = group_key
    details["logicalTurnKey"] = tracker.turn_key or ""
    processing, processing_details = (additional_processing(page) if not ignore_system_banner else (False, {}))
    details["additionalProcessingDetected"] = processing
    if processing:
        details.update(phase=ADDITIONAL_PROCESSING, phaseSource="system_banner", **processing_details)
        details["finalAnswerLatched"] = tracker.final_answer_latched
        return details
    active, control = generation_active(page)
    details.update(generationActive=active, generationControl=control)
    if not correlation["ok"]:
        if tracker.final_answer_latched and correlation["code"] == ASSISTANT_NOT_STARTED:
            details.update(phase=FINAL_ANSWER_STARTED, phaseSource="final_answer_latch", finalAnswerLatched=True)
            return details
        if correlation["code"] == ASSISTANT_NOT_STARTED and anchor == len(turns) - 1:
            try:
                working = page.locator(selector).nth(anchor_turn.get("nodeIndex", anchor)).evaluate(_WORKING_TURN_JS)
            except Exception:
                working = False
            if working and not tracker.final_answer_latched:
                details.update(phase=WORKING, phaseSource="anchored_working_ui")
        return details
    index = correlation["assistantIndex"]
    assistant_turn = turns[index]
    if group_key and assistant_turn.get("groupKey") != group_key:
        details["phaseSource"] = "assistant_outside_exact_turn_group"
        return details
    try:
        evidence = page.locator(selector).nth(assistant_turn.get("nodeIndex", index)).evaluate(_PHASE_EVIDENCE_JS)
    except Exception:
        evidence = {}
    if not isinstance(evidence, dict):
        evidence = {}
    details.update(evidence)
    message_id = str(evidence.get("assistantMessageId") or "")
    if tracker.final_answer_latched:
        details.update(phase=FINAL_ANSWER_STARTED, phaseSource="final_answer_latch", finalAnswerLatched=True)
    elif evidence.get("finalUnitProven"):
        tracker.final_answer_latched = True
        details.update(phase=FINAL_ANSWER_STARTED, phaseSource="separate_final_assistant_unit", finalAnswerLatched=True)
    elif evidence.get("workingControlFound") and evidence.get("assistantNodeFound"):
        details.update(phase=WORKING, phaseSource="correlated_activity_ui")
    if tracker.final_answer_latched and details["phase"] != UNKNOWN and evidence.get("finalUnitProven") and evidence.get("completionControlFound") and not active:
        details.update(phase=FINAL_ANSWER_COMPLETED, phaseSource="response_actions_and_inactive_control")
    return details


def find_user_anchor(turns: list[dict[str, Any]], expected_prompt: str,
                     *, anchor_binding: dict[str, Any] | None = None) -> int | None:
    """Return the last correlated user turn.

    Prefer byte-equivalent rendered text. ChatGPT may render long Markdown
    differently after Send, so Postman prompts may fall back to the immutable
    first-line POSTMAN_REQUEST_ID anchor. Exact prompt bytes were already
    proven in the composer before the single Send action.
    """
    expected = _normalize_text(expected_prompt)
    if anchor_binding is not None:
        users = [t for t in turns if t.get("role") == "user"]
        ordinal = anchor_binding.get("userOrdinal")
        prefix = anchor_binding.get("precedingUserHashes")
        if (type(ordinal) is not int or ordinal < 0 or not isinstance(prefix, list)
                or len(prefix) != ordinal or len(users) <= ordinal
                or anchor_binding.get("promptSha256") != submit.prompt_sha256(expected_prompt)):
            return None
        if [submit.prompt_sha256(str(t.get("text", ""))) for t in users[:ordinal]] != prefix:
            return None
        user = users[ordinal]
        if _normalize_text(user.get("text", "")) != expected:
            return None
        key = anchor_binding.get("groupKey")
        if key and user.get("groupKey") != key:
            return None
        return user["index"]
    exact_matches = [
        turn["index"]
        for turn in turns
        if turn.get("role") == "user" and _normalize_text(turn.get("text", "")) == expected
    ]
    if exact_matches:
        return exact_matches[-1]

    request_key_line = submit.request_key_line_from_prompt(expected_prompt)
    if not request_key_line:
        return None
    key_matches = [
        turn["index"]
        for turn in turns
        if turn.get("role") == "user"
        and submit._turn_contains_exact_line(str(turn.get("text", "")), request_key_line)
    ]
    return key_matches[-1] if key_matches else None


def correlate_next_assistant(
    turns: list[dict[str, Any]],
    expected_prompt: str,
    *, anchor_binding: dict[str, Any] | None = None,
) -> dict[str, Any]:
    anchor = find_user_anchor(turns, expected_prompt, anchor_binding=anchor_binding)
    if anchor is None:
        return {
            "ok": False,
            "code": USER_TURN_ANCHOR_MISSING,
            "anchorIndex": None,
            "assistant": None,
        }

    next_index = anchor + 1
    if next_index >= len(turns):
        return {
            "ok": False,
            "code": ASSISTANT_NOT_STARTED,
            "anchorIndex": anchor,
            "assistant": None,
        }

    next_turn = turns[next_index]
    role = next_turn.get("role")
    if role == "assistant":
        return {
            "ok": True,
            "code": ASSISTANT_TURN_STARTED,
            "anchorIndex": anchor,
            "assistantIndex": next_index,
            "assistant": next_turn,
        }
    if role == "user":
        return {
            "ok": False,
            "code": CHAT_CORRELATION_LOST,
            "anchorIndex": anchor,
            "assistantIndex": None,
            "assistant": None,
            "unexpectedRole": role,
        }
    return {
        "ok": False,
        "code": ASSISTANT_STATE_UNKNOWN,
        "anchorIndex": anchor,
        "assistantIndex": None,
        "assistant": None,
        "unexpectedRole": role or "unknown",
    }


class AssistantIdentityTracker:
    """Keep response keys by namespace; DOM-family ids are only weak proof.

    Call only after exact URL/anchor/immediately-next response correlation.
    A missing pinned key never silently rebinds the response to a weak id.
    """

    def __init__(self) -> None:
        self.strong: dict[str, str] = {}
        self.pending_strong: dict[str, str] = {}
        self.weak: tuple[str, int, str] | None = None
        self.promoted = False

    def observe(self, assistant: dict[str, Any], selector: str,
                index: int) -> tuple[bool, str]:
        strong = {key: str(assistant[key]) for key in
                  ("groupKey", "contentSearchTurnKey", "assistantMessageId")
                  if assistant.get(key)}
        if assistant.get("identityAmbiguous"):
            # Multiple internal content units are not a response identity.
            strong.pop("contentSearchTurnKey", None)
        if any(key in self.strong and self.strong[key] != value
               for key, value in strong.items()):
            return False, "strong_identity_conflict"
        if assistant.get("identityAmbiguous") and not (
                strong.get("groupKey") and strong["groupKey"] == self.strong.get("groupKey")):
            return False, "assistant_identity_ambiguous"
        weak = (selector, index, str(assistant.get("testId") or ""))
        if self.strong:
            if not self.strong.keys() & strong.keys():
                # Repeated new-namespace evidence confirms semantic hydration;
                # changed/missing candidates restart confirmation, never rebind.
                if not strong or strong != self.pending_strong:
                    self.pending_strong = strong
                    return False, "identity_temporarily_unproved"
                self.strong.update(strong)
                self.pending_strong = {}
                self.promoted = True
                return True, "identity_promoted"
            self.pending_strong = {}
            self.strong.update(strong)
            return True, ""
        if self.weak and self.weak[0] == selector and self.weak != weak:
            return False, "weak_identity_changed"
        if strong:
            self.promoted = self.weak is not None
            self.strong.update(strong)
            return True, "identity_promoted" if self.promoted else ""
        if self.weak is None:
            self.weak = weak
        elif self.weak[0] != selector:
            return False, "identity_temporarily_unproved"
        return True, ""


class AssistantLifecycleTracker:
    def __init__(self, *, stable_ms: int = DEFAULT_STABLE_MS) -> None:
        self.stable_ms = max(int(stable_ms), 0)
        self.started = False
        self.streaming = False
        self.completed = False
        self.last_text: str | None = None
        self.last_image_count = 0
        self.stable_since_ms: float | None = None
        self.transitions: list[str] = []

    def observe(
        self, text: str, *, generating: bool, now_ms: float,
        image_count: int = 0, image_mode: bool = False,
    ) -> bool:
        text = _normalize_text(text)
        images = image_count if image_mode else 0
        if not self.started:
            self.started = True
            self.transitions.append(ASSISTANT_TURN_STARTED)
            self.last_text = text
            self.last_image_count = images
            self.stable_since_ms = None if generating else now_ms
            if generating:
                self.streaming = True
                self.transitions.append(ASSISTANT_TURN_STREAMING)
            return False

        if text != self.last_text or images != self.last_image_count:
            self.last_text = text
            self.last_image_count = images
            self.stable_since_ms = None if generating else now_ms
            if not self.streaming:
                self.streaming = True
                self.transitions.append(ASSISTANT_TURN_STREAMING)
        elif generating:
            self.stable_since_ms = None
            if not self.streaming:
                self.streaming = True
                self.transitions.append(ASSISTANT_TURN_STREAMING)
        elif self.stable_since_ms is None:
            self.stable_since_ms = now_ms

        stable_for = 0.0 if self.stable_since_ms is None else now_ms - self.stable_since_ms
        if (
            not generating
            and (images == 1 if image_mode else text != "")
            and self.stable_since_ms is not None
            and stable_for >= self.stable_ms
        ):
            if not self.completed:
                self.completed = True
                self.transitions.append(ASSISTANT_TURN_COMPLETED)
            return True
        return False


def _result(
    code: str,
    *,
    ok: bool,
    transitions: list[str],
    recoverable: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "code": code,
        "recoverable": recoverable,
        "transitions": list(transitions),
        "details": dict(details or {}),
    }


def _json_dumps(value: dict[str, Any]) -> str:
    """Serialize CLI JSON safely for Windows legacy console encodings."""
    # JSON escapes preserve Unicode exactly while keeping stdout ASCII-only,
    # avoiding UnicodeEncodeError on cp1251/cp866 consoles.
    return json.dumps(value, ensure_ascii=True, sort_keys=True)


def observe_next_assistant(
    page: Any,
    expected_prompt: str,
    expected_chat_url: str,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    stable_ms: int = DEFAULT_STABLE_MS,
    poll_ms: int = DEFAULT_POLL_MS,
    image_mode: bool = False,
    phase_tracker: AnswerPhaseTracker | None = None,
    anchor_binding: dict[str, Any] | None = None,
    system_probe: Callable[[], str | None] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    if not isinstance(expected_prompt, str) or expected_prompt == "":
        return _result(
            OBSERVER_INVALID_CONFIG,
            ok=False,
            transitions=[],
            details={"reason": "expected_prompt_empty"},
        )
    if not submit.is_bound_chat_url(expected_chat_url):
        return _result(
            OBSERVER_INVALID_CONFIG,
            ok=False,
            transitions=[],
            details={"reason": "expected_chat_url_invalid", "expectedChatUrl": expected_chat_url},
        )

    tracker = AssistantLifecycleTracker(stable_ms=stable_ms)
    phases = phase_tracker if phase_tracker is not None else AnswerPhaseTracker()
    deadline = monotonic() + max(timeout_ms, 0) / 1000.0
    last_code = ASSISTANT_NOT_STARTED
    last_details: dict[str, Any] = {}
    identity = AssistantIdentityTracker()
    image_anchor: tuple[str, ...] | None = None

    while True:
        current_url = str(getattr(page, "url", "") or "")
        if current_url != expected_chat_url:
            return _result(
                CHAT_CORRELATION_LOST,
                ok=False,
                transitions=tracker.transitions,
                recoverable=True,
                details={
                    "reason": "chat_url_changed",
                    "expectedChatUrl": expected_chat_url,
                    "observedChatUrl": current_url,
                },
            )

        signal = system_probe() if system_probe is not None else None
        interrupted, interruption_details = (connection_interrupted(page) if system_probe is None else (signal == ASSISTANT_CONNECTION_INTERRUPTED, {}))
        if signal == ADDITIONAL_PROCESSING:
            return _result(ADDITIONAL_PROCESSING, ok=False, transitions=tracker.transitions,
                           recoverable=True, details={"chatUrl": current_url})
        if interrupted:
            return _result(
                ASSISTANT_CONNECTION_INTERRUPTED,
                ok=False,
                transitions=tracker.transitions,
                recoverable=True,
                details={
                    "chatUrl": current_url,
                    **interruption_details,
                },
            )

        phase = inspect_answer_phase(page, expected_prompt, expected_chat_url, tracker=phases, image_mode=image_mode, anchor_binding=anchor_binding,
                                     ignore_system_banner=system_probe is not None)
        if phase["phase"] == ADDITIONAL_PROCESSING:
            last_code = ADDITIONAL_PROCESSING
            last_details = phase
            if system_probe is None:
                return _result(ADDITIONAL_PROCESSING, ok=False, transitions=tracker.transitions, recoverable=True, details=phase)
            if monotonic() >= deadline:
                return _result(ASSISTANT_TURN_TIMEOUT, ok=False, transitions=tracker.transitions, recoverable=True, details=phase)
            sleep(min(max(poll_ms, 1) / 1000.0, max(deadline - monotonic(), 0.0)))
            continue
        turns, selector = snapshot_turns(page, image_mode=image_mode, expected_prompt=expected_prompt,
                                         anchor_binding=anchor_binding)
        correlation = (correlate_next_assistant(turns, expected_prompt, anchor_binding=anchor_binding)
                   if anchor_binding is not None else correlate_next_assistant(turns, expected_prompt))
        last_code = correlation["code"]
        last_details = {
            "turnSelector": selector,
            "turnCount": len(turns),
            "anchorIndex": correlation.get("anchorIndex"),
            "assistantIndex": correlation.get("assistantIndex"),
            "chatUrl": current_url,
        }

        if correlation["code"] == CHAT_CORRELATION_LOST:
            last_details["reason"] = "another_user_turn_preceded_assistant"
            return _result(
                CHAT_CORRELATION_LOST,
                ok=False,
                transitions=tracker.transitions,
                recoverable=True,
                details=last_details,
            )
        if image_mode and not correlation["ok"]:
            tracker.stable_since_ms = None
        if correlation["code"] == ASSISTANT_STATE_UNKNOWN:
            # A new ChatGPT turn container can appear before its semantic
            # data-message-author-role is hydrated. Unknown is therefore a
            # transient observation, not proof of assistant and not an
            # immediate terminal failure. Keep polling the same immediately
            # next turn position; timeout remains fail-closed.
            last_details["reason"] = "next_turn_role_pending"

        if correlation["ok"]:
            assistant = correlation["assistant"]
            anchor_index = correlation["anchorIndex"]
            if image_mode:
                # Selector migration may renumber assistant nodes, but must not
                # select a later duplicate prompt or a response to another user.
                anchor = tuple(text_sha256(t.get("text", "")) for t in turns[:anchor_index + 1]
                               if t.get("role") == "user")
                anchor_group = turns[anchor_index].get("groupKey")
                if ((image_anchor is not None and anchor != image_anchor)
                        or any(t.get("role") == "user" for t in turns[anchor_index + 1:])
                        or (anchor_group and assistant.get("groupKey") != anchor_group)):
                    last_details["reason"] = "image_user_anchor_relation_changed"
                    return _result(CHAT_CORRELATION_LOST, ok=False,
                                   transitions=tracker.transitions, recoverable=True, details=last_details)
                image_anchor = anchor
            identity_proved, identity_reason = identity.observe(assistant, selector, correlation["assistantIndex"])
            last_details.update(assistantIdentityMode="strong" if identity.strong else "weak",
                                assistantIdentityPromoted=identity.promoted,
                                assistantIdentityProved=identity_proved)
            if identity_reason in {"strong_identity_conflict", "weak_identity_changed", "assistant_identity_ambiguous"}:
                last_details["reason"] = identity_reason
                return _result(CHAT_CORRELATION_LOST, ok=False,
                               transitions=tracker.transitions, recoverable=True, details=last_details)
            if identity_reason or not identity_proved:
                # Promotion and proof gaps require a new uninterrupted window.
                tracker.stable_since_ms = None
            if not identity_proved:
                last_details["reason"] = identity_reason

            active, control = generation_active(page)
            text = _normalize_text((phase.get("finalAnswerText", assistant.get("text", ""))
                                    if phase["phase"] in {FINAL_ANSWER_STARTED, FINAL_ANSWER_COMPLETED} else "")
                                   if not image_mode else assistant.get("text", ""))
            now_ms = monotonic() * 1000.0
            images = int(assistant.get("imageCount", 0)) if image_mode else 0
            complete = tracker.observe(
                text, generating=active or not identity_proved or (not image_mode and phase["phase"] not in {FINAL_ANSWER_STARTED, FINAL_ANSWER_COMPLETED}), now_ms=now_ms,
                image_count=images, image_mode=image_mode,
            )
            if image_mode:
                last_details["assistantImageCount"] = images
            last_details.update(
                {
                    "assistantText": text,
                    "assistantTextLength": len(text),
                    "assistantTextSha256": text_sha256(text),
                    "generationActive": active,
                    "generationControl": control,
                    "streamingObserved": tracker.streaming,
                    "answerPhase": phase,
                }
            )
            if complete:
                if not image_mode and phase["phase"] == FINAL_ANSWER_STARTED:
                    phase = {**phase, "phase": FINAL_ANSWER_COMPLETED, "phaseSource": "inactive_stable_final_fallback"}
                    last_details["answerPhase"] = phase
                return _result(
                    ASSISTANT_TURN_COMPLETED,
                    ok=True,
                    transitions=tracker.transitions,
                    details=last_details,
                )

        if monotonic() >= deadline:
            if last_code == USER_TURN_ANCHOR_MISSING:
                timeout_code = USER_TURN_ANCHOR_MISSING
            elif last_code == ASSISTANT_STATE_UNKNOWN:
                timeout_code = ASSISTANT_STATE_UNKNOWN
                last_details["reason"] = "next_turn_role_unknown_at_timeout"
            else:
                timeout_code = ASSISTANT_TURN_TIMEOUT
            last_details["lastObservedCode"] = last_code
            return _result(
                timeout_code,
                ok=False,
                transitions=tracker.transitions,
                recoverable=True,
                details=last_details,
            )
        remaining_s = max(deadline - monotonic(), 0.0)
        sleep(min(max(poll_ms, 1) / 1000.0, remaining_s))


def run_submit_and_observe(
    cdp_url: str,
    prompt: str,
    *,
    submit_timeout_ms: int = submit.DEFAULT_TIMEOUT_MS,
    assistant_timeout_ms: int = DEFAULT_TIMEOUT_MS,
    stable_ms: int = DEFAULT_STABLE_MS,
    keep_page: bool = False,
) -> dict[str, Any]:
    """Live P4 probe using the P3 submit primitive on the same owned Page."""
    try:
        factory = bootstrap._load_sync_playwright()
    except bootstrap.BrowserBootstrapError as exc:
        return _result(
            exc.code,
            ok=False,
            transitions=[],
            recoverable=exc.recoverable,
            details=exc.details,
        )

    try:
        with cdp_download.locked_playwright(factory) as playwright:
            context = None
            page = None
            owns_context = False
            try:
                try:
                    normalized = bootstrap.normalize_cdp_url(cdp_url)
                    browser = cdp_download.connect_over_cdp(playwright, normalized)
                except Exception as exc:
                    return _result(
                        OBSERVER_ATTACH_FAILED,
                        ok=False,
                        transitions=[],
                        recoverable=True,
                        details={"message": str(exc)},
                    )

                contexts = list(browser.contexts)
                if contexts:
                    context = contexts[0]
                else:
                    context = browser.new_context()
                    owns_context = True
                existing_pages_before = len(list(context.pages))
                page = context.new_page()

                submit_result = submit.submit_fresh_prompt(
                    page,
                    prompt,
                    timeout_ms=submit_timeout_ms,
                )
                if not submit_result.get("ok"):
                    return _result(
                        submit_result.get("code", ASSISTANT_STATE_UNKNOWN),
                        ok=False,
                        transitions=list(submit_result.get("transitions", [])),
                        recoverable=bool(submit_result.get("recoverable")),
                        details={
                            "phase": "submit",
                            "submitResult": submit_result,
                            "ownedPageCreated": True,
                            "existingPagesBefore": existing_pages_before,
                            "externalBrowserClosed": False,
                        },
                    )

                chat_url = str(submit_result.get("details", {}).get("chatUrl", "") or "")
                observed = observe_next_assistant(
                    page,
                    prompt,
                    chat_url,
                    timeout_ms=assistant_timeout_ms,
                    stable_ms=stable_ms,
                )
                observed["details"].update(
                    {
                        "phase": "assistant",
                        "promptSha256": submit.prompt_sha256(prompt),
                        "submitCode": submit_result.get("code"),
                        "submitSendState": submit_result.get("sendState"),
                        "ownedPageCreated": True,
                        "existingPagesBefore": existing_pages_before,
                        "externalBrowserClosed": False,
                        "ownsContext": owns_context,
                    }
                )
                return observed
            finally:
                if not keep_page and page is not None:
                    try:
                        page.close()
                    except Exception:
                        pass
                if not keep_page and owns_context and context is not None:
                    try:
                        context.close()
                    except Exception:
                        pass
                # Never close the externally-owned CDP browser.
    except Exception as exc:
        return _result(
            OBSERVER_ATTACH_FAILED,
            ok=False,
            transitions=[],
            recoverable=True,
            details={"message": str(exc)},
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Web Postman P4 assistant-turn observer probe")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--cdp-url", default=bootstrap.DEFAULT_CDP_URL)
    parser.add_argument("--submit-timeout-ms", type=int, default=submit.DEFAULT_TIMEOUT_MS)
    parser.add_argument("--assistant-timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument("--stable-ms", type=int, default=DEFAULT_STABLE_MS)
    parser.add_argument("--keep-page", action="store_true")
    parser.add_argument("--launch-chrome", action="store_true")
    parser.add_argument("--chrome-executable")
    parser.add_argument("--profile-dir")
    parser.add_argument("--port", type=int, default=bootstrap.DEFAULT_REMOTE_DEBUGGING_PORT)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    launched_process = None
    profile_dir: Path | None = None
    cdp_url = args.cdp_url

    if args.launch_chrome:
        executable = bootstrap.discover_chrome_executable(explicit=args.chrome_executable)
        if executable is None:
            result = _result(
                bootstrap.BOOTSTRAP_CHROME_NOT_FOUND,
                ok=False,
                transitions=[],
                recoverable=True,
            )
            print(_json_dumps(result))
            return 3
        profile_dir = Path(args.profile_dir) if args.profile_dir else bootstrap.default_profile_dir()
        launched_process = bootstrap.start_dedicated_chrome(executable, profile_dir, port=args.port)
        cdp_url = f"http://127.0.0.1:{args.port}"
        try:
            bootstrap.wait_for_cdp(
                cdp_url,
                timeout_s=max(args.submit_timeout_ms / 1000.0, 1.0),
            )
        except bootstrap.BrowserBootstrapError as exc:
            result = _result(
                exc.code,
                ok=False,
                transitions=[],
                recoverable=exc.recoverable,
                details=exc.details,
            )
            result["details"]["browserIdentity"] = bootstrap.describe_browser_identity(
                profile_dir,
                getattr(launched_process, "pid", None),
            )
            print(_json_dumps(result))
            return 3

    result = run_submit_and_observe(
        cdp_url,
        args.prompt,
        submit_timeout_ms=args.submit_timeout_ms,
        assistant_timeout_ms=args.assistant_timeout_ms,
        stable_ms=args.stable_ms,
        keep_page=args.keep_page,
    )
    if launched_process is not None and profile_dir is not None:
        result["details"]["browserIdentity"] = bootstrap.describe_browser_identity(
            profile_dir,
            getattr(launched_process, "pid", None),
        )
        result["details"]["launchedChromeLeftRunning"] = True

    print(_json_dumps(result))
    return 0 if result.get("ok") else 3


if __name__ == "__main__":
    sys.exit(main())
