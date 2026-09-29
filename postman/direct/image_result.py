"""Extract one decoded image from an already transport-validated Postman ZIP.

Call only after artifact-validator.mjs returned ARTIFACT_VALID. Its exact ZIP SHA-256
and inventory are required so a changed archive cannot silently replace validation.
No archive member path is ever used as a filesystem destination.
"""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import warnings
import zipfile

MAX_IMAGE_BYTES = 64 * 1024 * 1024
_EXTENSIONS = {".png": "PNG", ".jpg": "JPEG", ".webp": "WEBP"}
_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


class ImageResultError(ValueError):
    def __init__(self, code: str, message: str, *, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def _fail(code: str, message: str, **details):
    raise ImageResultError(code, message, details=details)


def _decode_image(data: bytes, expected_extension: str) -> tuple[str, int, int]:
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError:
        _fail("IMAGE_DECODER_UNAVAILABLE", "Pillow is required to decode PNG, JPEG, and WEBP images")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()  # Decode every pixel, not just inspect a magic header.
                fmt = image.format
                width, height = image.size
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombWarning, Image.DecompressionBombError, UnidentifiedImageError) as exc:
        _fail("IMAGE_DECODE_FAILED", "Image bytes cannot be fully decoded", reason=str(exc)[:200])
    if fmt not in _MIME or _EXTENSIONS[expected_extension] != fmt:
        _fail("IMAGE_FORMAT_MISMATCH", "Decoded image format does not match image extension", decodedFormat=fmt)
    return fmt, width, height


def extract_validated_image(
    zip_path: str | os.PathLike,
    validated_inventory: list[dict],
    destination_dir: str | os.PathLike,
    *,
    expected_zip_sha256: str,
    request_id: str,
) -> dict:
    """Write image.<extension> exclusively; return image path, hash and dimensions.

    The caller must supply the successful Node validator's inventory and SHA.
    Raises ImageResultError with stable IMAGE_* code; never extracts other entries.
    A pre-existing output is never overwritten. Destination directory is trusted.
    """
    archive = Path(zip_path)
    try:
        if archive.stat().st_size > 50 * 1024 * 1024:
            _fail("IMAGE_ZIP_CHANGED", "ZIP exceeds the validated transport limit")
        zip_bytes = archive.read_bytes()
    except OSError as exc:
        _fail("IMAGE_ZIP_UNREADABLE", "Cannot read validated ZIP", reason=str(exc)[:200])
    zip_sha = hashlib.sha256(zip_bytes).hexdigest()
    if zip_sha != expected_zip_sha256.lower():
        _fail("IMAGE_ZIP_CHANGED", "ZIP changed since transport validation")

    files = [entry for entry in validated_inventory if entry.get("kind") == "file"]
    if len(files) != 1 or len(validated_inventory) != 1:
        _fail("IMAGE_ENTRY_COUNT", "Expected exactly one file and no directories in the image ZIP", count=len(files))
    chosen = files[0]
    normalized_name = chosen.get("path", "")
    extension = Path(normalized_name).suffix.lower()
    if extension not in _EXTENSIONS:
        _fail("IMAGE_ENTRY_COUNT", "The only ZIP file must be PNG, JPEG, or WEBP", count=0)
    if normalized_name != f"{request_id}_img1{extension}":
        _fail("IMAGE_ENTRY_NAME", "Image entry must match the canonical request filename", entry=normalized_name)
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            # Resolve by validated member position, not by an untrusted output path.
            selected = zf.infolist()[validated_inventory.index(chosen)]
            if (selected.filename.replace(chr(92), "/") != normalized_name
                    or selected.file_size != chosen["uncompressedSize"]):
                _fail("IMAGE_INVENTORY_MISMATCH", "Selected image differs from validated inventory")
            with zf.open(selected) as source:
                data = source.read(MAX_IMAGE_BYTES + 1)
                if len(data) > MAX_IMAGE_BYTES:
                    _fail("IMAGE_INVENTORY_MISMATCH", "Image entry exceeds size limit")
    except (zipfile.BadZipFile, RuntimeError, OSError, EOFError) as exc:
        _fail("IMAGE_ZIP_CHANGED", "ZIP can no longer be read", reason=str(exc)[:200])
    fmt, width, height = _decode_image(data, extension)
    destination = Path(destination_dir)
    destination.mkdir(parents=True, exist_ok=True)
    output = destination / ("image" + extension)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(output, flags, 0o600)
    except FileExistsError:
        _fail("IMAGE_OUTPUT_EXISTS", "Image output already exists", path=str(output))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    return {
        "path": str(output.resolve()),
        "sourceEntry": normalized_name,
        "format": fmt,
        "mime": _MIME[fmt],
        "width": width,
        "height": height,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "zipSha256": zip_sha,
    }
