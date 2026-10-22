"""Extract the actual generated image bytes from one correlated ChatGPT assistant turn.

No screenshots, canvas drawing, synthetic editing, GitHub uploads or prompt resend.
Only the exact assistant turn immediately after the pinned Devspace user request
can supply one image. A failed extraction is not a completed image result.
"""
from __future__ import annotations

import re
import hashlib
import io
import os
from pathlib import Path
import warnings

import browser_observer as observer
from postman.devspace.publication import bound_prompt

MAX_IMAGE_BYTES = 48 * 1024 * 1024
MIMES = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"),
         "WEBP": ("webp", "image/webp")}

# Only ChatGPT's native Download image action supplies the original asset.
# The displayed img/currentSrc may be a resized preview and is never an output.
def _store(binding, image_bytes: bytes) -> dict:
    if not isinstance(image_bytes, bytes) or not 0 < len(image_bytes) <= MAX_IMAGE_BYTES:
        raise ValueError("DEVSPACE_IMAGE_DATA_INVALID")
    try:
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
            "imageMimeType": mime, "imageFormat": extension,
            "evidenceState": "BROWSER_VERIFIED_IMAGE", "generationState": "CONFIRMED",
            "saveState": "SAVED", "deliveryState": "READY_FOR_LEADER_READ"}


def observe_owned_image(page, prompt, chat_url: str, binding, *, diagnostic=None):
    """Download once from the correlated generated response; fail closed.

    Exact matching URL + request key + the immediately subsequent assistant
    are mandatory. Never select a later gallery from body/global DOM.
    """
    phase = "PROVE_OWNER"
    download_state = "NOT_ATTEMPTED"
    save_state = "NOT_ATTEMPTED"

    def failed(reason, error=None):
        if diagnostic is not None:
            diagnostic.update(downloadPhase=phase, downloadState=download_state,
                              downloadAttempted=download_state != "NOT_ATTEMPTED",
                              downloadError=reason, saveState=save_state)
            if error is not None:
                diagnostic["downloadExceptionType"] = type(error).__name__[:80]
        return None

    try:
        if str(getattr(page, 'url', '')) != chat_url:
            return failed("CHAT_MISMATCH")
        if not bound_prompt(binding, prompt):
            return failed("BINDING_UNPROVEN")
        phase = "CORRELATE_ASSISTANT"
        turns, selector = observer.snapshot_turns(page, image_mode=True,
                                                   expected_prompt=prompt)
        correlated = observer.correlate_next_assistant(turns, prompt)
        if not correlated.get("ok"):
            return failed("ASSISTANT_UNPROVEN")
        index = correlated["assistantIndex"]
        if any(turn.get("role") == "user" for turn in turns[index + 1:]):
            return failed("NEWER_USER_TURN")
        assistant = correlated["assistant"]
        if assistant.get("imageCount") != 1:
            return failed("OWNED_IMAGE_COUNT_NOT_ONE")

        phase = "LOCATE_OWNED_GALLERY"
        scope = page.locator(selector).nth(assistant.get("nodeIndex", assistant["index"]))
        images = scope.locator('[data-testid="generated-image-gallery"] img')
        if not images.count() and scope.get_attribute("data-testid") == "generated-image-gallery":
            images = scope.locator("img")
        if not images.count():
            # The sibling gallery may be inside the same content-search turn.
            # Never search the whole document or a different assistant turn.
            images = scope.locator("xpath=ancestor-or-self::*[@data-content-search-turn-key][1]//*[@data-testid='generated-image-gallery']//img")
        if images.count() != 1:
            return failed("SCOPED_IMAGE_COUNT_NOT_ONE")
        if images.nth(0).evaluate(
                "(img) => !!img.closest('[data-user-message-bubble], [data-message-author-role=user]')"):
            return failed("USER_IMAGE_REJECTED")

        phase = "FIND_NATIVE_BUTTON"
        if observer.generation_active(page)[0]:
            return failed("GENERATION_ACTIVE")
        image = images.nth(0)
        image.hover(timeout=3000)
        gallery = image.locator("xpath=ancestor::*[@data-testid='generated-image-gallery'][1]")
        download_button = gallery.get_by_role("button", name=re.compile(
            r"^(?:Download(?: image)?|Скачать(?: изображение)?)$", re.I))
        button_count = download_button.count()
        if button_count != 1:
            if button_count:
                return failed("NATIVE_BUTTON_AMBIGUOUS")
            # Only open a preview belonging to the proved single owned gallery.
            # An already open dialog cannot be attributed to this image.
            if page.get_by_role("dialog").count():
                return failed("VIEWER_ALREADY_OPEN")
            preview = gallery.locator('button[data-testid="generated-image-preview"]')
            if preview.count() != 1 or not preview.is_enabled():
                return failed("NATIVE_BUTTON_NOT_FOUND")
            phase = "OPEN_OWNED_VIEWER"
            preview.click(timeout=3000)
            viewer = page.get_by_role("dialog")
            if viewer.count() != 1:
                return failed("OWNED_VIEWER_UNPROVEN")
            download_button = viewer.get_by_role("button", name=re.compile(
                r"^(?:Download(?: image)?|Скачать(?: изображение)?)$", re.I))
            if download_button.count() != 1:
                return failed("VIEWER_NATIVE_BUTTON_UNPROVEN")
        if not download_button.is_enabled():
            return failed("NATIVE_BUTTON_DISABLED")
        if str(page.url) != chat_url:
            return failed("CHAT_CHANGED_BEFORE_DOWNLOAD")

        phase = "EXPECT_NATIVE_DOWNLOAD"
        with page.expect_download(timeout=15000) as pending:
            phase = "CLICK_NATIVE_DOWNLOAD"
            download_state = "ATTEMPTED"  # A click exception may mean the click happened.
            download_button.click(timeout=3000)
            phase = "WAIT_NATIVE_DOWNLOAD"
        download = pending.value
        phase = "READ_NATIVE_ORIGINAL"
        if download.failure() is not None:
            download_state = "FAILED"
            return failed("NATIVE_DOWNLOAD_REPORTED_FAILURE")
        original = Path(download.path())
        if not 0 < original.stat().st_size <= MAX_IMAGE_BYTES:
            download_state = "FAILED"
            return failed("NATIVE_FILE_SIZE_INVALID")
        image_bytes = original.read_bytes()
        download_state = "DOWNLOADED"

        phase = "REPROVE_OWNER"
        if str(page.url) != chat_url:
            return failed("CHAT_CHANGED_AFTER_DOWNLOAD")
        fresh_turns, fresh_selector = observer.snapshot_turns(page, image_mode=True, expected_prompt=prompt)
        fresh = observer.correlate_next_assistant(fresh_turns, prompt)
        if not fresh.get("ok") or fresh["assistant"].get("imageCount") != 1 or any(
                t.get("role") == "user" for t in fresh_turns[fresh["assistantIndex"] + 1:]):
            return failed("ASSISTANT_REPROOF_FAILED")
        keys = ("groupKey", "contentSearchTurnKey", "assistantMessageId")
        for key in keys:
            if assistant.get(key) and fresh["assistant"].get(key) != assistant[key]:
                return failed("ASSISTANT_IDENTITY_CHANGED")
        if not any(assistant.get(key) for key in keys) and (fresh_selector != selector or
                fresh["assistant"].get("nodeIndex", fresh["assistant"]["index"]) !=
                assistant.get("nodeIndex", assistant["index"])):
            return failed("ASSISTANT_POSITION_CHANGED")
        identity = {"turnSelector": selector,
                    "nodeIndex": assistant.get("nodeIndex", assistant["index"]),
                    **{key: assistant[key] for key in keys if assistant.get(key)}}

        phase = "STORE_ORIGINAL"
        save_state = "ATTEMPTED"
        info = _store(binding, image_bytes)
        save_state = "SAVED"
        info["imageSource"] = "NATIVE_GENERATED_IMAGE_DOWNLOAD"
        info["assistantIdentity"] = identity
        info.update(downloadPhase="COMPLETE", downloadState="DOWNLOADED",
                    downloadAttempted=True, downloadError="NONE")
        if diagnostic is not None:
            diagnostic.update(downloadPhase="COMPLETE", downloadState=download_state,
                              downloadAttempted=True, downloadError="NONE", saveState=save_state)
        return {"ok": True, "code": "DEVSPACE_IMAGE_RESULT_DURABLE",
                "details": {"source": "image_result", "diagnostic": "UNKNOWN",
                            "reportedOutcome": "UNKNOWN", **info}}
    except Exception as error:
        if download_state == "ATTEMPTED":
            download_state = "FAILED"
        if save_state == "ATTEMPTED":
            save_state = "SAVE_FAILED"
        safe_errors = {"DEVSPACE_IMAGE_DATA_INVALID", "DEVSPACE_IMAGE_DECODE_FAILED",
                       "DEVSPACE_IMAGE_FORMAT_INVALID", "DEVSPACE_IMAGE_TARGET_REDIRECTED",
                       "DEVSPACE_IMAGE_ALREADY_RECORDED", "DEVSPACE_IMAGE_SAVE_FAILED"}
        reason = str(error) if isinstance(error, ValueError) and str(error) in safe_errors else "EXCEPTION"
        return failed(reason, error)
