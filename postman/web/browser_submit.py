#!/usr/bin/env python3
"""Web Postman P3 fresh-chat + single-submit transport.

Scope:
- connect to the dedicated headful Chrome through CDP;
- create one owned Page;
- prove a fresh ChatGPT chat before inserting anything;
- prove an empty composer;
- insert exactly one prompt;
- initiate exactly one Send action;
- prove the new user turn, empty composer, and bound /c/... URL;
- return PROMPT_SEND_UNKNOWN after any uncertain post-click state.

This module intentionally does NOT observe assistant turns, detect/download
artifacts, route results, type credentials, solve 2FA/CAPTCHA, or retry an
uncertain Send.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import browser_bootstrap as bootstrap

CHATGPT_URL = bootstrap.CHATGPT_URL
DEFAULT_CDP_URL = bootstrap.DEFAULT_CDP_URL
DEFAULT_TIMEOUT_MS = 30_000

PAGE_OWNED = "PAGE_OWNED"
FRESH_CHAT_CONFIRMED = "FRESH_CHAT_CONFIRMED"
COMPOSER_EMPTY_CONFIRMED = "COMPOSER_EMPTY_CONFIRMED"
PROMPT_INSERTED = "PROMPT_INSERTED"
PROMPT_SEND_STARTED = "PROMPT_SEND_STARTED"
PROMPT_SEND_CONFIRMED = "PROMPT_SEND_CONFIRMED"
CHAT_URL_BOUND = "CHAT_URL_BOUND"

FRESH_CHAT_NOT_CONFIRMED = "FRESH_CHAT_NOT_CONFIRMED"
COMPOSER_NOT_EMPTY = "COMPOSER_NOT_EMPTY"
PROMPT_INSERT_FAILED = "PROMPT_INSERT_FAILED"
PROMPT_MISMATCH = "PROMPT_MISMATCH"
SEND_CONTROL_NOT_FOUND = "SEND_CONTROL_NOT_FOUND"
PROMPT_SEND_UNKNOWN = "PROMPT_SEND_UNKNOWN"
PROMPT_RESEND_BLOCKED = "PROMPT_RESEND_BLOCKED"
SUBMIT_ATTACH_FAILED = "SUBMIT_ATTACH_FAILED"
SUBMIT_NAVIGATION_FAILED = "SUBMIT_NAVIGATION_FAILED"
SUBMIT_INVALID_CONFIG = "SUBMIT_INVALID_CONFIG"

SEND_PROVEN_NOT_SENT = "PROVEN_NOT_SENT"
SEND_STARTED = "SEND_STARTED"
SEND_PROVEN_SENT = "PROVEN_SENT"
# Public protocol name consumed by P5/P6 proof validation.
PROVEN_SENT = SEND_PROVEN_SENT
SEND_UNKNOWN = "UNKNOWN"

TURN_SELECTORS = (
    '[data-testid^="conversation-turn-"]',
    '[data-message-author-role="user"]',
    'article[data-testid^="conversation-turn-"]',
)

USER_TURN_SELECTORS = (
    # Prefer the semantic role node. The test-id alias is a fallback only;
    # aliases are never combined into one count.
    '[data-message-author-role="user"]',
    '[data-testid="conversation-turn-user"]',
)

# ChatGPT may put controls (for example the collapsible-message toggle) inside
# the role-bearing user turn. These selectors identify the message payload,
# rather than the surrounding turn chrome.
USER_MESSAGE_CONTENT_SELECTORS = (
    '[data-testid="collapsible-user-message-content"]',
    '[data-testid="user-message-content"]',
    '[data-testid="message-content"]',
    '[data-message-content]',
)

# User-message rendering converts Markdown inline-code delimiters into a
# semantic <code> element. Reconstruct those delimiters only inside the
# already-scoped payload node; never normalize arbitrary lines or page text.
_SEMANTIC_MESSAGE_TEXT_JS = r"""
(root) => {
  const chunks = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const inlineCode = node.matches("code.user-message-inline-code");
    if (inlineCode) chunks.push("`");
    for (const child of node.childNodes) walk(child);
    if (inlineCode) chunks.push("`");
  };
  walk(root);
  return chunks.join("");
}
"""

# ProseMirror stores each entered line in a paragraph. innerText inserts
# browser-dependent extra spacing between those blocks, while paragraph
# boundaries reproduce the exact text submitted by fill().
_COMPOSER_TEXT_JS = r"""
(root) => {
  if (root.getAttribute("contenteditable") !== "true") return null;
  const blocks = Array.from(root.children);
  if (!blocks.length) return root.textContent || "";
  return blocks.map((block) => block.textContent ?? block.innerText ?? "").join("\n");
}
"""

# One DOM read supplies metadata for every plausible composer node. The
# resulting path lets Python merge wrapper/contenteditable aliases without
# treating a hidden textarea or an unrelated textbox as the active composer.
_COMPOSER_METADATA_JS = r"""
(root) => {
  const plausible = '#prompt-textarea,[data-testid="composer-text-input"],textarea,.ProseMirror,[contenteditable="true"],[role="textbox"]';
  const path = [];
  for (let node = root; node && node.parentElement; node = node.parentElement) {
    path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
  }
  const visible = (() => {
    const rect = root.getBoundingClientRect();
    const style = getComputedStyle(root);
    return !!(rect.width || rect.height || root.getClientRects().length)
      && style.visibility !== 'hidden' && style.display !== 'none';
  })();
  const semanticText = (() => {
    const chunks = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { chunks.push(node.nodeValue || ''); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return chunks.join('');
  })();
  const paragraphText = root.getAttribute('contenteditable') === 'true'
    ? (root.children.length
      ? Array.from(root.children).map((block) => block.textContent ?? block.innerText ?? '').join('\n')
      : (root.textContent || ''))
    : null;
  const ancestor = root.parentElement && root.parentElement.closest(plausible);
  const ancestorPath = ancestor ? (() => {
    const result = [];
    for (let node = ancestor; node && node.parentElement; node = node.parentElement) {
      result.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    return result;
  })() : null;
  return {
    tag: root.tagName,
    id: root.id || '',
    dataTestId: root.getAttribute('data-testid') || '',
    role: root.getAttribute('role') || '',
    contenteditable: root.getAttribute('contenteditable') || '',
    ariaLabel: root.getAttribute('aria-label') || '',
    visible,
    enabled: !root.disabled,
    domPath: path,
    nestingDepth: path.length,
    ancestorComposerPath: ancestorPath,
    inputValue: 'value' in root ? String(root.value ?? '') : null,
    innerText: root.innerText || '',
    textContent: root.textContent || '',
    semanticText,
    paragraphText,
    children: Array.from(root.children).map((child) => ({
      tag: child.tagName,
      id: child.id || '',
      dataTestId: child.getAttribute('data-testid') || '',
      contenteditable: child.getAttribute('contenteditable') || '',
      text: child.textContent || '',
    })),
  };
}
"""

SEND_BUTTON_SELECTORS = (
    'button[data-testid="send-button"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
    'button[aria-label="Отправить"]',
)


class SubmitError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


class SendGuard:
    """One-shot in-memory Send guard for a single owned Page attempt.

    Persistence/restart recovery belongs to later milestones. P3 nevertheless
    must never retry after uncertainty inside the same attempt.
    """

    def __init__(self) -> None:
        self.state = SEND_PROVEN_NOT_SENT

    def begin(self) -> None:
        if self.state != SEND_PROVEN_NOT_SENT:
            raise SubmitError(
                PROMPT_RESEND_BLOCKED,
                "Send is not allowed after a previous start/unknown/success state",
                details={"sendState": self.state},
            )
        self.state = SEND_STARTED

    def confirm(self) -> None:
        self.state = SEND_PROVEN_SENT

    def unknown(self) -> None:
        self.state = SEND_UNKNOWN


def prompt_sha256(prompt: str) -> str:
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def _result(
    code: str,
    *,
    ok: bool,
    send_state: str,
    transitions: list[str],
    recoverable: bool = False,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "ok": ok,
        "code": code,
        "recoverable": recoverable,
        "sendState": send_state,
        "transitions": list(transitions),
        "details": dict(details or {}),
    }


def is_chatgpt_root_url(url: str) -> bool:
    try:
        parsed = urlparse(str(url or ""))
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    if host not in {"chatgpt.com", "www.chatgpt.com"}:
        return False
    return parsed.path in {"", "/"}


def is_bound_chat_url(url: str) -> bool:
    try:
        parsed = urlparse(str(url or ""))
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    if host not in {"chatgpt.com", "www.chatgpt.com"}:
        return False
    return bool(re.fullmatch(r"/c/[A-Za-z0-9_-]+", parsed.path or ""))


def _locator_count(locator: Any) -> int:
    try:
        return int(locator.count())
    except Exception:
        return 0


def count_conversation_turns(page: Any) -> int:
    # The first selector is the preferred current ChatGPT contract. Fallbacks
    # are only consulted if it is absent, avoiding double-counting aliases.
    for selector in TURN_SELECTORS:
        try:
            locator = page.locator(selector)
            count = _locator_count(locator)
            if count:
                return count
        except Exception:
            continue
    return 0


def _normalize_text(value: str) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def request_key_line_from_prompt(prompt: str) -> str:
    """Return the immutable Postman request-key line when it is the first non-empty line."""
    lines = [line.strip() for line in _normalize_text(prompt).split("\n") if line.strip()]
    if not lines:
        return ""
    first = lines[0]
    if re.fullmatch(r"POSTMAN_REQUEST_ID: REQ_\d{8}T\d{6}Z_\d{4}", first):
        return first
    return ""


def _turn_contains_exact_line(text: str, expected_line: str) -> bool:
    if not expected_line:
        return False
    return any(line.strip() == expected_line for line in _normalize_text(text).split("\n"))


def read_composer_text(composer: Any) -> str:
    try:
        value = composer.evaluate(_COMPOSER_TEXT_JS)
        if isinstance(value, str):
            return _normalize_text(value)
    except Exception:
        pass
    try:
        return _normalize_text(composer.input_value(timeout=500))
    except Exception:
        pass
    try:
        return _normalize_text(composer.inner_text(timeout=500))
    except Exception:
        pass
    try:
        return _normalize_text(composer.text_content(timeout=500))
    except Exception:
        return ""


COMPOSER_SNAPSHOT_SELECTORS = tuple(dict.fromkeys((*bootstrap.COMPOSER_SELECTORS, ".ProseMirror")))


def _path_is_prefix(prefix: tuple[int, ...], value: tuple[int, ...]) -> bool:
    return len(prefix) <= len(value) and value[: len(prefix)] == prefix


def _first_difference(expected: str, actual: str) -> dict[str, Any]:
    expected = _normalize_text(expected)
    actual = _normalize_text(actual)
    index = 0
    while index < min(len(expected), len(actual)) and expected[index] == actual[index]:
        index += 1
    exact = index == len(expected) == len(actual)
    return {
        "exactMatch": exact,
        "firstDifferenceIndex": None if exact else index,
        "expectedCharacter": None if index >= len(expected) else expected[index],
        "expectedCodepoint": None if index >= len(expected) else ord(expected[index]),
        "actualCharacter": None if index >= len(actual) else actual[index],
        "actualCodepoint": None if index >= len(actual) else ord(actual[index]),
        "expectedContext": expected[max(0, index - 100) : index + 100],
        "actualContext": actual[max(0, index - 100) : index + 100],
    }


def _snapshot_metadata(candidate: Any) -> dict[str, Any]:
    try:
        metadata = candidate.evaluate(_COMPOSER_METADATA_JS)
        if isinstance(metadata, dict):
            return metadata
    except Exception:
        pass
    inner = ""
    content = ""
    input_value: str | None = None
    try:
        input_value = _normalize_text(candidate.input_value(timeout=500))
    except Exception:
        pass
    try:
        inner = _normalize_text(candidate.inner_text(timeout=500))
    except Exception:
        pass
    try:
        content = _normalize_text(candidate.text_content(timeout=500))
    except Exception:
        pass
    text = read_composer_text(candidate)
    return {
        "tag": "",
        "id": "",
        "dataTestId": "",
        "role": "",
        "contenteditable": "",
        "ariaLabel": "",
        "visible": _visible(candidate),
        "enabled": True,
        "domPath": [],
        "nestingDepth": 0,
        "ancestorComposerPath": None,
        "inputValue": input_value,
        "innerText": inner,
        "textContent": content,
        "semanticText": text,
        "paragraphText": text,
        "children": [],
    }


def _representation(name: str, value: Any, expected: str | None) -> dict[str, Any]:
    text = _normalize_text(value if isinstance(value, str) else "")
    result: dict[str, Any] = {
        "strategy": name,
        "textLength": len(text),
        "textSha256": prompt_sha256(text),
        "textStart": text[:100],
        "textEnd": text[-100:],
    }
    if expected is not None:
        result.update(_first_difference(expected, text))
    result["_text"] = text
    return result


def _merge_composer_aliases(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for item in raw:
        path = tuple(item.get("domPath") or ())
        group = next(
            (
                candidate
                for candidate in groups
                if _path_is_prefix(tuple(candidate["path"]), path)
                or _path_is_prefix(path, tuple(candidate["path"]))
            ),
            None,
        )
        if group is None:
            group = {"path": path, "aliases": [], "logicalId": f"composer-{len(groups)}"}
            groups.append(group)
        elif len(path) < len(group["path"]):
            group["path"] = path
        group["aliases"].append(item)
    for group in groups:
        aliases = group["aliases"]
        active = [item for item in aliases if item["visible"] and item["enabled"]]
        editable = [item for item in active if item["contenteditable"] == "true"]
        preferred = max(editable or active, key=lambda item: item["nestingDepth"], default=None)
        representations: list[dict[str, Any]] = []
        for item in aliases:
            representations.extend(item["representations"])
        group.update({
            "active": bool(active),
            "preferred": preferred,
            "representations": representations,
            "candidateCount": len(aliases),
            "descendantAliasCount": max(0, len(aliases) - 1),
        })
    return groups


def collect_composer_snapshots(page: Any, expected_prompt: str | None = None) -> dict[str, Any]:
    """Collect one logical composer tree and every exact read representation."""
    raw: list[dict[str, Any]] = []
    for selector in COMPOSER_SNAPSHOT_SELECTORS:
        try:
            locator = page.locator(selector)
            count = _locator_count(locator)
        except Exception:
            continue
        for index in range(count):
            try:
                candidate = locator.last if count == 1 else locator.nth(index)
                metadata = _snapshot_metadata(candidate)
            except Exception:
                continue
            values = [
                ("paragraph_text", metadata.get("paragraphText")),
                ("input_value", metadata.get("inputValue")),
                ("inner_text", metadata.get("innerText")),
                ("text_content", metadata.get("textContent")),
                ("semantic_text", metadata.get("semanticText")),
            ]
            representations = [
                _representation(name, value, expected_prompt)
                for name, value in values
                if value is not None
            ]
            path = tuple(metadata.get("domPath") or (selector, index))
            ancestor_path = tuple(metadata.get("ancestorComposerPath") or ())
            raw.append({
                "selector": selector,
                "index": index,
                "tag": metadata.get("tag", ""),
                "id": metadata.get("id", ""),
                "dataTestId": metadata.get("dataTestId", ""),
                "role": metadata.get("role", ""),
                "contenteditable": metadata.get("contenteditable", ""),
                "ariaLabel": metadata.get("ariaLabel", ""),
                "visible": bool(metadata.get("visible")),
                "enabled": bool(metadata.get("enabled", True)),
                "nestingDepth": int(metadata.get("nestingDepth", 0) or 0),
                "domPath": path,
                "ancestorComposerPath": ancestor_path,
                "descendantOfComposerCandidate": bool(ancestor_path),
                "inputValue": metadata.get("inputValue"),
                "innerText": metadata.get("innerText", ""),
                "textContent": metadata.get("textContent", ""),
                "semanticText": metadata.get("semanticText", ""),
                "children": metadata.get("children", []),
                "representations": representations,
                "locator": candidate,
            })
    groups = _merge_composer_aliases(raw)
    return {"logicalCandidates": groups, "allCandidates": raw}


def _active_composer_groups(page: Any, expected_prompt: str | None = None) -> dict[str, Any]:
    snapshot = collect_composer_snapshots(page, expected_prompt)
    return snapshot


def find_composer(page: Any) -> tuple[Any | None, str | None]:
    snapshot = _active_composer_groups(page)
    preferred = [group["preferred"] for group in snapshot["logicalCandidates"] if group["preferred"] is not None]
    if not preferred:
        return None, None
    winner = max(preferred, key=lambda item: item["nestingDepth"])
    return winner["locator"], winner["selector"]


def _visible_composer_snapshots(page: Any) -> list[dict[str, Any]]:
    return [
        item
        for item in collect_composer_snapshots(page)["allCandidates"]
        if item["visible"] and item["enabled"]
    ]


def _composer_empty_from_snapshot(snapshot: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    groups = [group for group in snapshot["logicalCandidates"] if group["active"]]
    if not groups:
        return False, {"composerCandidateCount": 0, "composerEmpty": False}
    nonempty = [
        group
        for group in groups
        if any(rep["_text"] != "" for rep in group["representations"])
    ]
    preferred = next((group["preferred"] for group in groups if group["preferred"]), None)
    return not nonempty, {
        "composerCandidateCount": len(snapshot["allCandidates"]),
        "logicalComposerCount": len(groups),
        "composerEmpty": not nonempty,
        "nonemptyComposerCandidateCount": len(nonempty),
        "composerSelector": preferred["selector"] if preferred else "",
    }


def _composer_empty_proof(page: Any) -> tuple[bool, dict[str, Any]]:
    return _composer_empty_from_snapshot(_active_composer_groups(page))


def _exact_prompt_readback(page: Any, prompt: str) -> tuple[bool, dict[str, Any]]:
    snapshot = _active_composer_groups(page, prompt)
    groups = [group for group in snapshot["logicalCandidates"] if group["active"]]
    exact: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for group in groups:
        for representation in group["representations"]:
            if representation.get("exactMatch"):
                exact.append((group, representation))
    if exact:
        group, winner = exact[0]
        preferred = group["preferred"] or group["aliases"][0]
        return True, {
            "composerFoundAfterFill": True,
            "composerSelectorAfterFill": preferred["selector"],
            "composerCandidateCountAfterFill": len(snapshot["allCandidates"]),
            "logicalComposerCountAfterFill": len(groups),
            "composerAliasCountAfterFill": group["candidateCount"],
            "composerProofStrategy": winner["strategy"],
            "observedTextLength": winner["textLength"],
            "observedTextSha256": winner["textSha256"],
        }
    representations = [rep for group in groups for rep in group["representations"]]
    longest = max(representations, key=lambda item: item["textLength"], default=None)
    preferred = groups[0]["preferred"] if groups else None
    details = {
        "composerFoundAfterFill": bool(groups),
        "composerSelectorAfterFill": preferred["selector"] if preferred else "",
        "composerCandidateCountAfterFill": len(snapshot["allCandidates"]),
        "logicalComposerCountAfterFill": len(groups),
        "observedTextLength": longest["textLength"] if longest else 0,
        "observedTextSha256": longest["textSha256"] if longest else prompt_sha256(""),
    }
    if longest:
        details.update({key: value for key, value in longest.items() if key in {
            "strategy", "exactMatch", "firstDifferenceIndex", "expectedCharacter",
            "expectedCodepoint", "actualCharacter", "actualCodepoint",
            "expectedContext", "actualContext",
        }})
    return False, details


def _attribute(locator: Any, name: str) -> str:
    try:
        return str(locator.get_attribute(name) or "")
    except Exception:
        return ""


def _visible(locator: Any) -> bool:
    try:
        return bool(locator.is_visible())
    except Exception:
        return False


def find_user_message_content(turn: Any) -> tuple[Any | None, str | None]:
    """Find the payload node inside a role-bearing user turn.

    The role node is deliberately not trusted when it contains interactive
    controls: ChatGPT currently renders a collapsible toggle beside the exact
    prompt. Known payload contracts are tried in order, and a plain role node
    is used only when it has no UI-control descendants.
    """
    if _attribute(turn, "data-message-author-role").casefold() != "user":
        return turn, None

    for selector in USER_MESSAGE_CONTENT_SELECTORS:
        try:
            locator = turn.locator(selector)
            count = _locator_count(locator)
            for index in range(count):
                candidate = locator.nth(index)
                if _visible(candidate):
                    return candidate, selector
        except Exception:
            continue

    # Older ChatGPT markup has no dedicated content test id. Do not fall back
    # to a container that visibly owns controls; that would reintroduce UI
    # labels into exact prompt proof.
    for selector in ('button', '[role="button"]', '[data-collapsed]'):
        try:
            if _locator_count(turn.locator(selector)):
                return None, None
        except Exception:
            continue
    return turn, None


def read_semantic_message_text(locator: Any) -> str:
    """Read scoped payload text while preserving rendered inline-code syntax."""
    try:
        value = locator.evaluate(_SEMANTIC_MESSAGE_TEXT_JS)
        if isinstance(value, str):
            return _normalize_text(value)
    except Exception:
        pass
    try:
        return _normalize_text(locator.inner_text(timeout=1_000))
    except Exception:
        return ""


def collect_user_turn_details(page: Any) -> list[dict[str, Any]]:
    """Collect one logical user-turn selector family, never selector aliases."""
    for selector in USER_TURN_SELECTORS:
        try:
            locator = page.locator(selector)
            count = _locator_count(locator)
            if count <= 0:
                continue
            values: list[dict[str, Any]] = []
            for index in range(count):
                item = locator.nth(index)
                semantic, semantic_selector = find_user_message_content(item)
                text = read_semantic_message_text(semantic) if semantic is not None else ""
                values.append({
                    "selector": selector,
                    "index": index,
                    "semanticSelector": semantic_selector or "",
                    "text": text,
                    "textLength": len(text),
                    "textSha256": prompt_sha256(text),
                    "textStart": text[:120],
                    "textEnd": text[-120:],
                })
            return values
        except Exception:
            continue
    return []


def collect_user_turn_texts(page: Any) -> list[str]:
    return [item["text"] for item in collect_user_turn_details(page)]


def find_send_button(page: Any) -> tuple[Any | None, str | None]:
    for selector in SEND_BUTTON_SELECTORS:
        try:
            locator = page.locator(selector)
            if _locator_count(locator) <= 0:
                continue
            candidate = locator.last
            if candidate.is_visible() and candidate.is_enabled():
                return candidate, selector
        except Exception:
            continue

    # Semantic fallback is still pre-send. It may locate a localized button,
    # but once a click is attempted there is never a second transport fallback.
    try:
        locator = page.get_by_role("button", name=re.compile(r"^(send|send prompt|отправить)$", re.I))
        if _locator_count(locator) > 0:
            candidate = locator.last
            if candidate.is_visible() and candidate.is_enabled():
                return candidate, "role=button[name=send]"
    except Exception:
        pass
    return None, None


def _wait_until(
    predicate: Callable[[], tuple[bool, dict[str, Any]]],
    *,
    timeout_ms: int,
    poll_ms: int = 100,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> tuple[bool, dict[str, Any]]:
    deadline = monotonic() + max(timeout_ms, 0) / 1000.0
    last: dict[str, Any] = {}
    while True:
        ok, details = predicate()
        last = dict(details or {})
        if ok:
            return True, last
        if monotonic() >= deadline:
            return False, last
        sleep(max(poll_ms, 1) / 1000.0)


def prepare_fresh_chat(page: Any, *, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> dict[str, Any]:
    try:
        page.goto(CHATGPT_URL, wait_until="domcontentloaded", timeout=timeout_ms)
    except Exception as exc:
        return {
            "ok": False,
            "code": SUBMIT_NAVIGATION_FAILED,
            "details": {"message": str(exc)},
        }

    def predicate() -> tuple[bool, dict[str, Any]]:
        snapshot = _active_composer_groups(page)
        groups = [group for group in snapshot["logicalCandidates"] if group["active"]]
        preferred = [group["preferred"] for group in groups if group["preferred"]]
        composer = max(preferred, key=lambda item: item["nestingDepth"], default=None)
        selector = composer["selector"] if composer else None
        page_url = str(getattr(page, "url", "") or "")
        turns = count_conversation_turns(page)
        if composer is None:
            session_code, session_details = bootstrap.classify_session(page)
            return False, {
                "sessionCode": session_code,
                "pageUrl": page_url,
                "turnCount": turns,
                **session_details,
            }
        empty, empty_details = _composer_empty_from_snapshot(snapshot)
        fresh = is_chatgpt_root_url(page_url) and turns == 0
        # The visible textarea is only a temporary fallback while the live
        # ProseMirror composer hydrates. Do not declare a fresh chat ready on
        # that node; filling it can duplicate the prompt during the swap.
        live_composer_ready = composer["selector"] != "textarea"
        return fresh and empty and live_composer_ready, {
            "pageUrl": page_url,
            "turnCount": turns,
            "composerSelector": selector,
            "liveComposerReady": live_composer_ready,
            **empty_details,
            "composer": composer["locator"],
        }

    ok, details = _wait_until(predicate, timeout_ms=timeout_ms)
    composer = details.pop("composer", None)
    if not ok:
        if details.get("composerEmpty") is False:
            code = COMPOSER_NOT_EMPTY
        else:
            code = FRESH_CHAT_NOT_CONFIRMED
        return {"ok": False, "code": code, "details": details}
    return {"ok": True, "code": FRESH_CHAT_CONFIRMED, "composer": composer, "details": details}


def insert_prompt(
    page: Any,
    composer: Any,
    prompt: str,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    initial_composer_selector: str | None = None,
) -> dict[str, Any]:
    if not isinstance(prompt, str) or not prompt:
        return {"ok": False, "code": SUBMIT_INVALID_CONFIG, "details": {"reason": "prompt_empty"}}

    # prepare_fresh_chat can observe the temporary visible textarea fallback
    # before the live ProseMirror node appears. Prefer that specific node when
    # it is already available, without performing a second fill.
    if initial_composer_selector in {"textarea", '[role="textbox"]'}:
        resolved, resolved_selector = find_composer(page)
        if resolved is not None and resolved_selector not in {"textarea", '[role="textbox"]'}:
            composer = resolved

    try:
        composer.fill(prompt, timeout=timeout_ms)
    except Exception as exc:
        return {"ok": False, "code": PROMPT_INSERT_FAILED, "details": {"message": str(exc)}}

    # fill() is one-shot. Readback may come from a different visible composer
    # candidate after React/ProseMirror hydration, but this function never fills
    # or types a second time.
    matched, observed = _wait_until(
        lambda: _exact_prompt_readback(page, prompt),
        timeout_ms=timeout_ms,
    )
    if not matched:
        return {
            "ok": False,
            "code": PROMPT_MISMATCH,
            "details": {
                "expectedSha256": prompt_sha256(prompt),
                **observed,
            },
        }
    return {
        "ok": True,
        "code": PROMPT_INSERTED,
        "details": {
            "promptSha256": prompt_sha256(prompt),
            "promptLength": len(prompt),
            **observed,
        },
    }


def _observe_send_proof(page: Any, prompt: str, before_user_turn_count: int) -> tuple[bool, dict[str, Any]]:
    user_turn_details = collect_user_turn_details(page)
    user_turns = [item["text"] for item in user_turn_details]
    page_url = str(getattr(page, "url", "") or "")
    composer_snapshot = _active_composer_groups(page)
    active_groups = [group for group in composer_snapshot["logicalCandidates"] if group["active"]]
    preferred = [group["preferred"] for group in active_groups if group["preferred"]]
    composer = max(preferred, key=lambda item: item["nestingDepth"], default=None)
    selector = composer["selector"] if composer else None
    composer_empty, empty_details = _composer_empty_from_snapshot(composer_snapshot)
    new_turn = len(user_turns) == before_user_turn_count + 1
    rendered_last = _normalize_text(user_turns[-1]) if user_turns else ""
    exact_turn = new_turn and rendered_last == _normalize_text(prompt)
    request_key_line = request_key_line_from_prompt(prompt)
    request_key_turn = new_turn and _turn_contains_exact_line(rendered_last, request_key_line)
    correlated_turn = exact_turn or request_key_turn
    correlation_mode = "exact" if exact_turn else ("request_key" if request_key_turn else "none")
    chat_bound = is_bound_chat_url(page_url)
    last_turn = user_turn_details[-1] if user_turn_details else {}
    return correlated_turn and composer_empty and chat_bound, {
        "userTurnCountBefore": before_user_turn_count,
        "userTurnCountNow": len(user_turns),
        "userTurnSelector": last_turn.get("selector", ""),
        "userTurnIndex": last_turn.get("index"),
        "userTurnSemanticSelector": last_turn.get("semanticSelector", ""),
        "userTurnTextLength": last_turn.get("textLength", 0),
        "userTurnTextSha256": last_turn.get("textSha256", prompt_sha256("")),
        "userTurnTextStart": last_turn.get("textStart", ""),
        "userTurnTextEnd": last_turn.get("textEnd", ""),
        "exactUserTurn": exact_turn,
        "requestKeyLine": request_key_line,
        "requestKeyUserTurn": request_key_turn,
        "userTurnCorrelated": correlated_turn,
        "userTurnCorrelationMode": correlation_mode,
        "composerEmpty": composer_empty,
        "composerSelector": selector,
        **empty_details,
        "chatUrlBound": chat_bound,
        "chatUrl": page_url if chat_bound else "",
    }


def submit_once(
    page: Any,
    composer: Any,
    prompt: str,
    guard: SendGuard,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    transitions: list[str] = [PAGE_OWNED, FRESH_CHAT_CONFIRMED, COMPOSER_EMPTY_CONFIRMED, PROMPT_INSERTED]
    before_turns = collect_user_turn_texts(page)

    def send_control_ready() -> tuple[bool, dict[str, Any]]:
        button, selector = find_send_button(page)
        return button is not None, {"button": button, "selector": selector}

    found, send_control = _wait_until(send_control_ready, timeout_ms=timeout_ms)
    button = send_control.pop("button", None)
    selector = send_control.get("selector")
    if not found or button is None:
        return _result(
            SEND_CONTROL_NOT_FOUND,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            recoverable=True,
            details={"sendControl": selector or ""},
        )

    try:
        guard.begin()
    except SubmitError as exc:
        return _result(
            exc.code,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            details=exc.details,
        )

    transitions.append(PROMPT_SEND_STARTED)
    try:
        button.click(timeout=timeout_ms)
    except Exception as exc:
        guard.unknown()
        return _result(
            PROMPT_SEND_UNKNOWN,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            recoverable=True,
            details={"message": str(exc), "sendControl": selector, "reason": "click_outcome_uncertain"},
        )

    ok, proof = _wait_until(
        lambda: _observe_send_proof(page, prompt, len(before_turns)),
        timeout_ms=timeout_ms,
    )
    proof["sendControl"] = selector
    proof["promptSha256"] = prompt_sha256(prompt)
    if not ok:
        guard.unknown()
        return _result(
            PROMPT_SEND_UNKNOWN,
            ok=False,
            send_state=guard.state,
            transitions=transitions,
            recoverable=True,
            details=proof,
        )

    guard.confirm()
    transitions.extend([PROMPT_SEND_CONFIRMED, CHAT_URL_BOUND])
    return _result(
        PROMPT_SEND_CONFIRMED,
        ok=True,
        send_state=guard.state,
        transitions=transitions,
        details=proof,
    )


def submit_fresh_prompt(page: Any, prompt: str, *, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> dict[str, Any]:
    prep = prepare_fresh_chat(page, timeout_ms=timeout_ms)
    if not prep["ok"]:
        return _result(
            prep["code"],
            ok=False,
            send_state=SEND_PROVEN_NOT_SENT,
            transitions=[PAGE_OWNED],
            recoverable=True,
            details=prep.get("details"),
        )
    composer = prep["composer"]
    inserted = insert_prompt(
        page,
        composer,
        prompt,
        timeout_ms=timeout_ms,
        initial_composer_selector=prep.get("details", {}).get("composerSelector"),
    )
    if not inserted["ok"]:
        return _result(
            inserted["code"],
            ok=False,
            send_state=SEND_PROVEN_NOT_SENT,
            transitions=[PAGE_OWNED, FRESH_CHAT_CONFIRMED, COMPOSER_EMPTY_CONFIRMED],
            recoverable=True,
            details=inserted.get("details"),
        )
    guard = SendGuard()
    result = submit_once(page, composer, prompt, guard, timeout_ms=timeout_ms)
    result["details"].update(inserted.get("details", {}))
    return result


def run_live_submit(
    cdp_url: str,
    prompt: str,
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    keep_page: bool = False,
) -> dict[str, Any]:
    try:
        factory = bootstrap._load_sync_playwright()
    except bootstrap.BrowserBootstrapError as exc:
        return _result(
            exc.code,
            ok=False,
            send_state=SEND_PROVEN_NOT_SENT,
            transitions=[],
            recoverable=exc.recoverable,
            details=exc.details,
        )

    try:
        with factory() as playwright:
            browser = None
            context = None
            page = None
            owns_context = False
            try:
                try:
                    normalized = bootstrap.normalize_cdp_url(cdp_url)
                    browser = playwright.chromium.connect_over_cdp(normalized)
                except Exception as exc:
                    return _result(
                        SUBMIT_ATTACH_FAILED,
                        ok=False,
                        send_state=SEND_PROVEN_NOT_SENT,
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
                result = submit_fresh_prompt(page, prompt, timeout_ms=timeout_ms)
                result["details"].update({
                    "ownedPageCreated": True,
                    "existingPagesBefore": existing_pages_before,
                    "externalBrowserClosed": False,
                    "ownsContext": owns_context,
                })
                return result
            finally:
                # Clean up while Playwright is still alive. Only resources
                # created by this invocation may be closed.
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
                # Never call browser.close() for CDP-attached external Chrome.
    except Exception as exc:
        return _result(
            SUBMIT_ATTACH_FAILED,
            ok=False,
            send_state=SEND_PROVEN_NOT_SENT,
            transitions=[],
            recoverable=True,
            details={"message": str(exc)},
        )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Web Postman P3 fresh-chat single-submit probe")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--cdp-url", default=DEFAULT_CDP_URL)
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
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
                send_state=SEND_PROVEN_NOT_SENT,
                transitions=[],
                recoverable=True,
            )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 3
        profile_dir = Path(args.profile_dir) if args.profile_dir else bootstrap.default_profile_dir()
        launched_process = bootstrap.start_dedicated_chrome(executable, profile_dir, port=args.port)
        cdp_url = f"http://127.0.0.1:{args.port}"
        try:
            bootstrap.wait_for_cdp(cdp_url, timeout_s=max(args.timeout_ms / 1000.0, 1.0))
        except bootstrap.BrowserBootstrapError as exc:
            result = _result(
                exc.code,
                ok=False,
                send_state=SEND_PROVEN_NOT_SENT,
                transitions=[],
                recoverable=exc.recoverable,
                details=exc.details,
            )
            if launched_process is not None and profile_dir is not None:
                result["details"]["browserIdentity"] = bootstrap.describe_browser_identity(
                    profile_dir, getattr(launched_process, "pid", None)
                )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return 3

    result = run_live_submit(
        cdp_url,
        args.prompt,
        timeout_ms=args.timeout_ms,
        keep_page=args.keep_page,
    )
    if launched_process is not None and profile_dir is not None:
        result["details"]["browserIdentity"] = bootstrap.describe_browser_identity(
            profile_dir, getattr(launched_process, "pid", None)
        )
        result["details"]["launchedChromeLeftRunning"] = True
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if result["ok"]:
        return 0
    if result["code"] == PROMPT_SEND_UNKNOWN:
        return 4
    return 3


if __name__ == "__main__":
    sys.exit(main())
