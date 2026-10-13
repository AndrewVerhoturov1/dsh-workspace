"""Extract the actual generated image bytes from one correlated ChatGPT assistant turn.

No screenshots, canvas drawing, synthetic editing, GitHub uploads or prompt resend.
Only the exact assistant turn immediately after the pinned Devspace user request
can supply one image. A failed extraction is not a completed image result.
"""
from __future__ import annotations

import base64
import hashlib
import io
import os
from pathlib import Path
import warnings

import browser_observer as observer

MAX_IMAGE_BYTES = 48 * 1024 * 1024
MIMES = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"),
         "WEBP": ("webp", "image/webp")}

# Native generated image content may be blob/data or ChatGPT's own image/CDN URL.
# The browser must successfully fetch this very src; the Host never interpolates
# an arbitrary URL from assistant text, and never fetches file:// or localhost.
_IMAGE_SOURCE_JS = r"""
async img => {
  if (!img.isConnected || !img.complete ||
      img.naturalWidth < 64 || img.naturalHeight < 64 ||
      !img.getClientRects().length || getComputedStyle(img).visibility === 'hidden')
    return {ok:false,reason:'image_unready'};
  const source = img.currentSrc || img.src || '';
  let url;
  try { url = new URL(source, location.href) } catch { return {ok:false,reason:'invalid_url'} }
  const safe = url.protocol === 'blob:' && url.origin === location.origin ||
    url.protocol === 'data:' && /^data:image\/(?:png|jpeg|webp);base64,/i.test(source) ||
    url.protocol === 'https:' &&
      (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.oaiusercontent.com') ||
       url.hostname === 'oaiusercontent.com');
  if (!safe) return {ok:false,reason:'image_source_not_authorized'};
  try {
    const result = await fetch(source, {credentials:'include'});
    if (!result.ok) return {ok:false,reason:'image_fetch_unavailable'};
    const bytes = await result.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 50331648)
      return {ok:false,reason:'image_too_large'};
    const value = new Uint8Array(bytes);
    let text = '';
    // Streamed chunk conversion avoids JS stack overflow for large images.
    for (let i=0; i<value.length; i+=8192)
      text += String.fromCharCode(...value.subarray(i,i+8192));
    return {ok:true,data: btoa(text),mime:result.headers.get('content-type') || '',
      width:img.naturalWidth,height:img.naturalHeight};
  } catch { return {ok:false,reason:'image_fetch_unavailable'} }
}
"""


def _store(binding, encoded: str) -> dict:
    if not isinstance(encoded, str) or len(encoded) > MAX_IMAGE_BYTES * 2:
        raise ValueError("DEVSPACE_IMAGE_DATA_INVALID")
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
        if not 0 < len(image_bytes) <= MAX_IMAGE_BYTES:
            raise ValueError("DEVSPACE_IMAGE_TOO_LARGE")
        from PIL import Image, UnidentifiedImageError
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as img:
                img.verify()
            with Image.open(io.BytesIO(image_bytes)) as img:
                img.load()
                fmt, width, height = img.format, img.width, img.height
        if fmt not in MIMES or width < 64 or height < 64:
            raise ValueError("DEVSPACE_IMAGE_FORMAT_INVALID")
    except (ValueError, OSError, Image.DecompressionBombError,
            Image.DecompressionBombWarning, UnidentifiedImageError) as error:
        raise ValueError("DEVSPACE_IMAGE_DECODE_FAILED") from error
    extension, mime = MIMES[fmt]
    root = Path(binding["channel"])
    filename = "POSTMAN_IMAGE_" + binding["requestId"] + "." + extension
    target = root / filename
    if target.is_symlink() or root.is_symlink():
        raise ValueError("DEVSPACE_IMAGE_TARGET_REDIRECTED")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(target, flags, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(image_bytes)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        raise ValueError("DEVSPACE_IMAGE_ALREADY_RECORDED")
    except OSError as error:
        raise ValueError("DEVSPACE_IMAGE_SAVE_FAILED") from error
    return {"resultImage": str(target.resolve()), "imageSha256": hashlib.sha256(image_bytes).hexdigest(),
            "imageWidth": width, "imageHeight": height, "imageByteLength": len(image_bytes),
            "imageMimeType": mime, "imageFormat": extension, "evidenceState": "BROWSER_VERIFIED_IMAGE"}


def observe_owned_image(page, prompt, chat_url: str, binding):
    """Attempt one read-only correlated capture; return None for unproved input.

    Exact matching URL + request key + the immediately subsequent assistant
    are mandatory. Never select a later gallery from body/global DOM.
    """
    if str(getattr(page, 'url', '')) != chat_url:
        return None
    expected = 'POSTMAN_REQUEST_ID: ' + binding["requestId"]
    if not isinstance(prompt, str) or not prompt.startswith(expected + '\n'):
        return None
    turns, selector = observer.snapshot_turns(page, image_mode=True,
                                               expected_prompt=prompt)
    correlated = observer.correlate_next_assistant(turns, prompt)
    if not correlated.get("ok"):
        return None
    index = correlated["assistantIndex"]
    if any(turn.get("role") == "user" for turn in turns[index + 1:]):
        return None
    assistant = correlated["assistant"]
    if assistant.get("imageCount") != 1:
        return None
    try:
        scope = page.locator(selector).nth(assistant.get("nodeIndex", assistant["index"]))
        images = scope.locator('[data-testid="generated-image-gallery"] img')
        if not images.count() and scope.get_attribute("data-testid") == "generated-image-gallery":
            images = scope.locator("img")
        # Never capture user-supplied image, icons or ambiguous multiple outputs.
        if images.count() != 1:
            return None
        source = images.nth(0).evaluate(_IMAGE_SOURCE_JS)
        if not isinstance(source, dict) or source.get("ok") is not True:
            return None
        info = _store(binding, source.get("data"))
    except (OSError, ValueError, AttributeError, TypeError):
        return None
    return {"ok": True, "code": "DEVSPACE_IMAGE_RESULT_DURABLE",
            "details": {"source": "image_result", "diagnostic": "UNKNOWN",
                        "reportedOutcome": "UNKNOWN", **info}}
