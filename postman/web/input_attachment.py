#!/usr/bin/env python3
"""Narrow native ZIP/image upload/proof helpers, not an arbitrary-files API.

Composer scope, ready cards and an existing sent ZIP resource card were
read/probed live without Send. Selectors stay isolated: unknown markup is NEVER
upload/Send success.
"""
from __future__ import annotations

from pathlib import Path
import sys

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import input_bundle

ATTACHMENT_UPLOAD_STARTED = "ATTACHMENT_UPLOAD_STARTED"
ATTACHMENT_READY_CONFIRMED = "ATTACHMENT_READY_CONFIRMED"
ATTACHMENT_CONTROL_UNAVAILABLE = "POSTMAN_ATTACHMENT_CONTROL_UNAVAILABLE"
ATTACHMENT_UPLOAD_FAILED = "POSTMAN_ATTACHMENT_UPLOAD_FAILED"
ATTACHMENT_UPLOAD_TIMEOUT = "POSTMAN_ATTACHMENT_UPLOAD_TIMEOUT"
ATTACHMENT_NOT_READY = "POSTMAN_ATTACHMENT_NOT_READY"
ATTACHMENT_LOST = "POSTMAN_ATTACHMENT_LOST_BEFORE_SEND"
SENT_ATTACHMENT_UNKNOWN = "POSTMAN_SENT_ATTACHMENT_PROOF_UNKNOWN"

# No filename is interpolated into a selector. Names are compared as data.
_PROOF_JS = r"""
(root, options) => {
  const visible = e => {
    const style = getComputedStyle(e), rect = e.getBoundingClientRect();
    return !e.hidden && !e.closest('[hidden],[aria-hidden="true"]') &&
      style.display !== 'none' && style.visibility !== 'hidden' &&
      !!(rect.width || rect.height || e.getClientRects().length);
  };
  let scope = root;
  if (options.sent) {
    // Never climb to a container with multiple user bubbles or an assistant turn.
    const turn = root.closest('[data-chatgpt-search-unit-key$=":user"]') ||
      root.closest('[data-content-search-unit-key$=":user"],[data-message-author-role="user"],[data-testid="conversation-turn-user"]');
    if (!turn && root.getAttribute('data-message-author-role') !== 'user' &&
        root.getAttribute('data-testid') !== 'conversation-turn-user')
      return {known:false, reason:'user_attachment_scope_missing'};
    if (turn) {
      if (turn.querySelectorAll('[data-user-message-bubble="true"]').length > 1 ||
          turn.querySelector('[data-message-author-role="assistant"],[data-conversation-role="assistant"]'))
        return {known:false, reason:'ambiguous_user_turn_scope'};
      scope = turn;
    }
  } else {
    const containers = [...root.querySelectorAll('[data-composer-attachments],[data-testid="composer-attachments"]')].filter(visible);
    if (containers.length !== 1) return {known:containers.length === 0, count:0, names:[], pending:false, error:false, settled:false};
    scope = containers[0];
  }
  const observedPreCards = !options.sent
    ? [...scope.querySelectorAll(':scope > * > *')].filter(e =>
        [...e.querySelectorAll('button[aria-label]')].some(b => /^(Remove|Удалить) /i.test(b.getAttribute('aria-label') || '')))
    : [];
  const observedSentCards = options.sent
    ? [...scope.querySelectorAll('button[aria-label]')].filter(b =>
        !b.closest('[data-user-message-bubble="true"]') &&
        [...b.parentElement.querySelectorAll('[title]')].some(n => n.getAttribute('title') === b.getAttribute('aria-label')))
        .map(b => b.parentElement)
    : [];
  const imageCards = options.image
    ? [...scope.querySelectorAll('[data-testid="image-attachment"],[data-file-id]')].filter(e =>
        e.querySelector('img[alt],img[title]') && !e.closest('[data-user-message-bubble="true"]')) : [];
  const candidates = [...new Set([...observedPreCards, ...observedSentCards, ...imageCards,
    ...scope.querySelectorAll('[data-testid="file-upload-preview"],[data-testid="image-upload-preview"]')])].filter(visible);
  const cards = candidates.filter(e => !candidates.some(parent => parent !== e && parent.contains(e)));
  const names = cards.map(e => {
    const named = e.querySelector('[data-testid="file-name"],[data-filename]');
    const image = options.image ? e.querySelector('img[alt],img[title]') : null;
    return e.getAttribute('data-filename') || named?.getAttribute('data-filename') ||
      named?.textContent?.trim() || image?.getAttribute('alt') || image?.getAttribute('title') ||
      [...e.querySelectorAll('[title]')].map(n => n.getAttribute('title')).find(title => title === options.name) ||
      [...e.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label')).find(label => label === options.name) ||
      (options.image && !options.sent ? [...e.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label'))
        .filter(label => /^(Remove|Удалить) /.test(label || '')).map(label => label.replace(/^(Remove|Удалить) /, '')).find(label => label === options.name) : '') || '';
  });
  const pending = [...scope.querySelectorAll('[role="progressbar"],progress,[aria-busy="true"],[data-upload-state="pending"],[data-upload-state="uploading"]')].some(visible);
  const error = [...scope.querySelectorAll('[role="alert"],[data-upload-state="error"],[data-testid="upload-error"]')].some(visible) ||
    (!options.sent && /upload failed|could not upload|unable to upload|ошибка|не удалось/i.test(scope.innerText || ''));
  const settled = cards.length === 1 && (options.sent || cards[0].getAttribute('data-upload-state') === 'ready' ||
    [...cards[0].querySelectorAll('button[aria-label]')].some(b =>
      b.getAttribute('aria-label') === options.name && b.getAttribute('aria-busy') !== 'true' && !b.disabled) ||
    (options.image && [...cards[0].querySelectorAll('img')].some(i => i.complete && i.naturalWidth > 0) &&
      [...cards[0].querySelectorAll('button[aria-label]')].some(b =>
        ['Remove ' + options.name, 'Удалить ' + options.name].includes(b.getAttribute('aria-label')) && !b.disabled)));
  const ids = cards.map(e => e.getAttribute('data-file-id') || '');
  // A file-card is required. Text that merely mentions the filename is not proof.
  return {known:cards.length > 0, count:cards.length, names, ids, pending, error, settled};
}
"""


def snapshot(root, name, *, sent=False):
    try:
        value = root.evaluate(_PROOF_JS, {"name": name, "sent": sent, "image": name.startswith("POSTMAN_REFERENCE_")})
        if isinstance(value, dict):
            return value
    except Exception:
        pass
    return {"known": False, "reason": "attachment_dom_unreadable"}


def ready(proof, name, expected_id=None):
    return (proof.get("known") is True and proof.get("count") == 1 and proof.get("names") == [name]
            and proof.get("pending") is False and proof.get("error") is False and proof.get("settled") is True
            and (not expected_id or not any(proof.get("ids", [])) or proof.get("ids") == [expected_id]))


def composer_scope(composer):
    try:
        scope = composer.locator('xpath=ancestor::form[1]')
        if scope.count() == 1 and scope.is_visible():
            return scope
    except Exception:
        pass
    return None


def upload(page, composer, attachment, *, timeout_ms, wait_until):
    scope = composer_scope(composer)
    if scope is None:
        return {"ok": False, "code": ATTACHMENT_CONTROL_UNAVAILABLE, "details": {"reason": "composer_scope_missing"}}
    initial = snapshot(scope, attachment.name)
    # This attempt owns an initially empty attachment surface.
    if initial.get("known") is not True or initial.get("count") != 0 or initial.get("pending") or initial.get("error"):
        return {"ok": False, "code": ATTACHMENT_NOT_READY, "details": initial}
    selection = {}
    try:
        inputs = scope.locator('input[type="file"]')
        selection = {"fileInputCount": page.locator('input[type="file"]').count(),
                     "container": "active-composer-form", "scopeFileInputCount": inputs.count(),
                     "fileInputs": [], "eligibleCount": 0}
        eligible = []
        image_only = []
        media = getattr(attachment, 'media_type', 'application/zip')
        for i in range(inputs.count()):
            node = inputs.nth(i)
            accept = (node.get_attribute('accept') or '').lower()
            selection["fileInputs"].append({"accept": accept, "container": "active-composer-form"})
            if not node.is_enabled():
                continue
            accepted = [token.strip() for token in accept.split(',')]
            if not accept or '*/*' in accepted or media in accepted or Path(attachment.name).suffix.lower() in accepted or (media.startswith('image/') and 'image/*' in accepted):
                eligible.append(node)
                if media.startswith('image/') and accepted == ['image/*']:
                    image_only.append(node)
        # Current composer owns photo/video, photo-only and generic file controls.
        # Prefer its dedicated photo control, never the first broadly accepting input.
        if image_only:
            eligible = image_only
        selection["eligibleCount"] = len(eligible)
        if len(eligible) != 1:
            return {"ok": False, "code": ATTACHMENT_CONTROL_UNAVAILABLE,
                    "details": {"reason": "ambiguous_or_missing_file_input", **selection}}
        # Use freshly hash-verified bytes as a native FilePayload. Passing a pathname
        # here would permit a final TOCTOU between verification and browser file read.
        data = attachment.upload_bytes()
        eligible[0].set_input_files({"name": attachment.name, "mimeType": getattr(attachment, "media_type", "application/zip"), "buffer": data}, timeout=timeout_ms)
    except input_bundle.InputBundleError as exc:
        return {"ok": False, "code": exc.code, "details": selection}
    except Exception:
        return {"ok": False, "code": ATTACHMENT_UPLOAD_FAILED, "details": selection}

    def check():
        proof = {**snapshot(scope, attachment.name), **selection}
        return ready(proof, attachment.name) or proof.get('error') is True, proof

    matched, proof = wait_until(check, timeout_ms=timeout_ms)
    if proof.get('error') is True:
        return {"ok": False, "code": ATTACHMENT_UPLOAD_FAILED, "details": proof}
    if not matched or not ready(proof, attachment.name):
        return {"ok": False, "code": ATTACHMENT_UPLOAD_TIMEOUT, "details": proof}
    return {"ok": True, "code": ATTACHMENT_READY_CONFIRMED, "details": proof}


def before_send(composer, attachment, expected_id=None):
    scope = composer_scope(composer)
    proof = snapshot(scope, attachment.name) if scope is not None else {"known": False}
    return ready(proof, attachment.name, expected_id), proof
