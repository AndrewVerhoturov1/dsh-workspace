#!/usr/bin/env python3
"""Web Postman P6 exact correlated artifact download + validation + durable store.

Boundary:
- requires an already successful P5 ARTIFACT_DOM_CONFIRMED proof;
- re-proves the same P5 DOM identity immediately before clicking;
- clicks exactly one exact correlated control under page.expect_download();
- never scans a browser Downloads directory for candidates;
- saves raw bytes to request-scoped controlled staging;
- validates through the existing WP-002 Node validator;
- publishes result.zip + manifest.json + validation.json + metadata.json
  atomically as one request directory only after validation PASS;
- does not route to an agent and does not mark Postman Runtime READY.

Runtime READY / delivery integration belongs to a later milestone.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Any, Callable
import zipfile

import artifact_detector as detector
import request_identity as identity

import runtime_support as runtime
DOWNLOAD_STARTING = "DOWNLOAD_STARTING"
DOWNLOAD_STARTED = "DOWNLOAD_STARTED"
DOWNLOAD_COMPLETED = "DOWNLOAD_COMPLETED"
DOWNLOAD_NOT_FOUND = "DOWNLOAD_NOT_FOUND"
DOWNLOAD_INTERRUPTED = "DOWNLOAD_INTERRUPTED"
DOWNLOAD_FILENAME_MISMATCH = "DOWNLOAD_FILENAME_MISMATCH"
DOWNLOAD_PROOF_INVALID = "DOWNLOAD_PROOF_INVALID"
DOWNLOAD_PROOF_CHANGED = "DOWNLOAD_PROOF_CHANGED"
DOWNLOAD_CONTROL_INVALID = "DOWNLOAD_CONTROL_INVALID"
ARTIFACT_VALIDATING = "ARTIFACT_VALIDATING"
ARTIFACT_INVALID = "ARTIFACT_INVALID"
ARTIFACT_VALID = "ARTIFACT_VALID"
ARTIFACT_VALIDATOR_FAILED = "ARTIFACT_VALIDATOR_FAILED"
RESULT_STORE_CONFLICT = "RESULT_STORE_CONFLICT"
RESULT_STORE_FAILED = "RESULT_STORE_FAILED"
RESULT_DURABLE = "RESULT_DURABLE"

DEFAULT_BROWSER_DOWNLOAD_DIR = r"D:\Downloads_dsh_auto"
DEFAULT_DOWNLOAD_TIMEOUT_MS = 30000
DEFAULT_CLICK_TIMEOUT_MS = 10000
DEFAULT_VALIDATOR_TIMEOUT_SECONDS = 60

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SHA1_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_REPO_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
_DOM_PATH_RE = re.compile(r"^\d+(?:/\d+)*$")

_CONTROL_PROOF_JS = r"""
(el, expectedFilename) => {
  const normalize = (value) => String(value || "").replace(/\r\n?/g, "\n").trim();
  let visible = false;
  try {
    const style = window.getComputedStyle(el);
    visible = style.display !== "none" &&
      style.visibility !== "hidden" &&
      el.getAttribute("aria-hidden") !== "true" &&
      el.getClientRects().length > 0;
  } catch (_) {
    visible = false;
  }
  const disabled = Boolean(
    el.disabled ||
    el.getAttribute("aria-disabled") === "true"
  );
  return {
    connected: Boolean(el && el.isConnected),
    visible,
    disabled,
    visibleLabel: normalize(el.textContent),
    visibleLabelExact: normalize(el.textContent) === String(expectedFilename || ""),
    tag: String(el.tagName || "").toLowerCase()
  };
}
"""


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


def default_result_root() -> Path:
    return runtime.default_result_root()


def _is_link_or_junction(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
    except OSError:
        return True
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction):
        try:
            if is_junction():
                return True
        except OSError:
            return True
    return False


def _validate_expected_request(
    request_id: str,
    expected_filename: str,
    expected_request: Any,
) -> dict[str, Any]:
    if not identity.is_canonical_request_id(request_id):
        raise ValueError("request_id must be canonical")
    if not identity.validate_expected_artifact_filename(request_id, expected_filename):
        raise ValueError("expected_filename must embed the exact canonical request_id")
    if not isinstance(expected_request, dict):
        raise ValueError("expected_request must be an object")

    required_string = ("requestId", "repository", "baseCommit")
    for key in required_string:
        if not isinstance(expected_request.get(key), str) or not expected_request[key]:
            raise ValueError(f"expected_request.{key} must be a non-empty string")
    if expected_request["requestId"] != request_id:
        raise ValueError("expected_request.requestId mismatch")
    if not _REPO_RE.fullmatch(expected_request["repository"]):
        raise ValueError("expected_request.repository must be owner/repo")
    if not _SHA1_RE.fullmatch(expected_request["baseCommit"]):
        raise ValueError("expected_request.baseCommit must be a full 40-hex Git SHA")

    for key in ("allowedPaths", "forbiddenPaths"):
        value = expected_request.get(key)
        if not isinstance(value, list) or any(not isinstance(x, str) or not x for x in value):
            raise ValueError(f"expected_request.{key} must be an array of non-empty strings")

    supplied_filename = expected_request.get("expectedFilename")
    if supplied_filename is not None and supplied_filename != expected_filename:
        raise ValueError("expected_request.expectedFilename mismatch")

    trusted = dict(expected_request)
    trusted["expectedFilename"] = expected_filename
    # Routing authority must never be accepted from the artifact-download request object.
    for forbidden_authority in (
        "origin_agent_id",
        "originAgentId",
        "destination_agent_id",
        "destinationAgentId",
        "destination_session",
        "delivery_target",
    ):
        trusted.pop(forbidden_authority, None)
    return trusted


def _p5_identity(proof: Any) -> dict[str, Any] | None:
    if not isinstance(proof, dict):
        return None
    if proof.get("ok") is not True or proof.get("code") != detector.ARTIFACT_DOM_CONFIRMED:
        return None
    details = proof.get("details")
    if not isinstance(details, dict):
        return None
    attachment = details.get("attachment")
    if not isinstance(attachment, dict):
        return None

    required_strings = (
        "requestId",
        "expectedFilename",
        "chatUrl",
        "assistantTextSha256",
        "turnSelector",
    )
    if any(not isinstance(details.get(k), str) or not details[k] for k in required_strings):
        return None
    if not _SHA256_RE.fullmatch(details["assistantTextSha256"]):
        return None
    assistant_index = details.get("assistantIndex")
    if isinstance(assistant_index, bool) or not isinstance(assistant_index, int) or assistant_index < 0:
        return None
    dom_path = attachment.get("path")
    if not isinstance(dom_path, str) or not _DOM_PATH_RE.fullmatch(dom_path):
        return None
    if details.get("downloadStarted") is not False:
        return None

    return {
        "requestId": details["requestId"],
        "expectedFilename": details["expectedFilename"],
        "chatUrl": details["chatUrl"],
        "assistantIndex": assistant_index,
        "assistantTextSha256": details["assistantTextSha256"],
        "turnSelector": details["turnSelector"],
        "attachmentPath": dom_path,
    }


def _same_p5_identity(first: dict[str, Any], second: dict[str, Any]) -> bool:
    return first == second


def _resolve_control(page: Any, proof_identity: dict[str, Any]) -> Any:
    selector = proof_identity["turnSelector"]
    turn = page.locator(selector).nth(proof_identity["assistantIndex"])
    control = turn
    segments = proof_identity["attachmentPath"].split("/")
    if len(segments) > 64:
        raise ValueError("attachment DOM path too deep")
    for raw in segments:
        index = int(raw)
        if index > 10000:
            raise ValueError("attachment DOM path index too large")
        control = control.locator(":scope > *").nth(index)
    return control


def _control_snapshot(control: Any, expected_filename: str) -> dict[str, Any]:
    value = control.evaluate(_CONTROL_PROOF_JS, expected_filename)
    if not isinstance(value, dict):
        raise ValueError("control proof did not return an object")
    return {
        "connected": bool(value.get("connected")),
        "visible": bool(value.get("visible")),
        "disabled": bool(value.get("disabled")),
        "visibleLabel": str(value.get("visibleLabel", ""))[:512],
        "visibleLabelExact": bool(value.get("visibleLabelExact")),
        "tag": str(value.get("tag", ""))[:40],
    }


def _download_failure(download: Any) -> str | None:
    failure = getattr(download, "failure", None)
    if not callable(failure):
        return None
    value = failure()
    return None if value is None else str(value)[:1000]


def _cancel_download_best_effort(download: Any) -> None:
    cancel = getattr(download, "cancel", None)
    if callable(cancel):
        try:
            cancel()
        except Exception:
            pass


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    with tmp.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _atomic_write_json(path: Path, value: Any) -> None:
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    _atomic_write_bytes(path, payload)


def _read_manifest_bytes(zip_path: Path) -> tuple[bytes, dict[str, Any]]:
    with zipfile.ZipFile(zip_path, "r") as archive:
        raw = archive.read("manifest.json")
    text = raw.decode("utf-8", errors="strict")
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("manifest must be an object")
    return raw, value


def _run_validator(
    zip_path: Path,
    expected_request: dict[str, Any],
    *,
    timeout_seconds: int = DEFAULT_VALIDATOR_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    cli_path = Path(__file__).resolve().with_name("artifact_validate_cli.mjs")
    if not cli_path.is_file():
        raise RuntimeError(f"validator CLI missing: {cli_path}")
    expected_path = zip_path.parent / "expected-request.json"
    _atomic_write_json(expected_path, expected_request)
    try:
        completed = subprocess.run(
            [
                os.environ.get("POSTMAN_NODE", "node"),
                str(cli_path),
                "--zip",
                str(zip_path),
                "--expected",
                str(expected_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
            **runtime.quiet_subprocess_kwargs(),
        )
    finally:
        try:
            expected_path.unlink()
        except FileNotFoundError:
            pass

    stdout = completed.stdout.strip()
    if not stdout:
        raise RuntimeError(
            f"validator CLI produced no JSON (exit={completed.returncode}, stderr={completed.stderr[:500]!r})"
        )
    try:
        value = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError("validator CLI returned non-JSON output") from exc
    if not isinstance(value, dict):
        raise RuntimeError("validator CLI JSON must be an object")
    if completed.returncode not in (0, 3):
        raise RuntimeError(
            f"validator CLI failed (exit={completed.returncode}, stderr={completed.stderr[:500]!r})"
        )
    return value


def _validation_matches_trusted(
    validation: dict[str, Any],
    *,
    trusted: dict[str, Any],
    actual_sha256: str,
) -> bool:
    return (
        validation.get("ok") is True
        and validation.get("code") == ARTIFACT_VALID
        and validation.get("status") == ARTIFACT_VALID
        and validation.get("sha256") == actual_sha256
        and validation.get("requestId") == trusted["requestId"]
        and validation.get("repository") == trusted["repository"]
        and str(validation.get("baseCommit", "")).lower() == trusted["baseCommit"].lower()
    )


def _manifest_matches_trusted(manifest: dict[str, Any], trusted: dict[str, Any]) -> bool:
    return (
        manifest.get("requestId") == trusted["requestId"]
        and manifest.get("repository") == trusted["repository"]
        and isinstance(manifest.get("baseCommit"), str)
        and manifest["baseCommit"].lower() == trusted["baseCommit"].lower()
    )


def _prepare_staging(
    result_root: Path,
    request_id: str,
    expected_filename: str,
) -> tuple[Path, Path]:
    result_root.mkdir(parents=True, exist_ok=True)
    if _is_link_or_junction(result_root):
        raise RuntimeError("result root must not be a symlink/junction")

    final_dir = result_root / request_id
    staging_parent = result_root / ".staging"
    staging_parent.mkdir(parents=True, exist_ok=True)
    if _is_link_or_junction(staging_parent):
        raise RuntimeError("staging root must not be a symlink/junction")

    staging_dir = staging_parent / request_id
    if final_dir.exists() or staging_dir.exists():
        raise FileExistsError("request result/staging already exists")
    staging_dir.mkdir(parents=False, exist_ok=False)
    return final_dir, staging_dir / expected_filename


def _publish_durable(
    *,
    result_root: Path,
    final_dir: Path,
    staging_zip: Path,
    manifest_bytes: bytes,
    validation: dict[str, Any],
    metadata: dict[str, Any],
) -> None:
    publish_dir = Path(
        tempfile.mkdtemp(prefix=f".publish-{metadata['requestId']}-", dir=str(result_root))
    )
    try:
        shutil.copyfile(staging_zip, publish_dir / "result.zip")
        _atomic_write_bytes(publish_dir / "manifest.json", manifest_bytes)
        _atomic_write_json(publish_dir / "validation.json", validation)
        _atomic_write_json(publish_dir / "metadata.json", metadata)
        if final_dir.exists():
            raise FileExistsError("durable result directory appeared during publish")
        os.replace(publish_dir, final_dir)
    except Exception:
        if publish_dir.exists():
            shutil.rmtree(publish_dir, ignore_errors=True)
        raise


def download_validated_artifact(
    page: Any,
    *,
    expected_prompt: str,
    expected_chat_url: str,
    request_id: str,
    expected_filename: str,
    completed_observer_result: dict[str, Any],
    artifact_dom_result: dict[str, Any],
    expected_request: dict[str, Any],
    result_root: str | os.PathLike[str] | None = None,
    browser_download_dir: str = DEFAULT_BROWSER_DOWNLOAD_DIR,
    download_timeout_ms: int = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    click_timeout_ms: int = DEFAULT_CLICK_TIMEOUT_MS,
    validator_runner: Callable[[Path, dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Perform P6 after P5 proof. Never retries a click/download."""
    try:
        trusted = _validate_expected_request(request_id, expected_filename, expected_request)
    except Exception as exc:
        return _result(
            DOWNLOAD_PROOF_INVALID,
            ok=False,
            details={"phase": "config", "reason": str(exc)[:500]},
        )

    initial = _p5_identity(artifact_dom_result)
    if initial is None:
        return _result(
            DOWNLOAD_PROOF_INVALID,
            ok=False,
            details={"phase": "p5", "reason": "invalid_initial_artifact_dom_proof"},
        )
    if (
        initial["requestId"] != request_id
        or initial["expectedFilename"] != expected_filename
        or initial["chatUrl"] != expected_chat_url
    ):
        return _result(
            DOWNLOAD_PROOF_INVALID,
            ok=False,
            details={"phase": "p5", "reason": "initial_proof_trusted_identity_mismatch"},
        )

    try:
        root = Path(result_root) if result_root is not None else default_result_root()
        final_dir, staging_zip = _prepare_staging(root, request_id, expected_filename)
    except FileExistsError as exc:
        return _result(
            RESULT_STORE_CONFLICT,
            ok=False,
            details={"phase": "preclick", "reason": str(exc)},
        )
    except Exception as exc:
        return _result(
            RESULT_STORE_FAILED,
            ok=False,
            details={"phase": "preclick", "reason": str(exc)[:500]},
        )

    staging_dir = staging_zip.parent

    reproof = detector.detect_artifact_dom(
        page,
        expected_prompt=expected_prompt,
        expected_chat_url=expected_chat_url,
        request_id=request_id,
        expected_filename=expected_filename,
        completed_observer_result=completed_observer_result,
    )
    current = _p5_identity(reproof)
    if current is None:
        return _result(
            DOWNLOAD_PROOF_CHANGED,
            ok=False,
            recoverable=bool(reproof.get("recoverable")) if isinstance(reproof, dict) else False,
            details={
                "phase": "preclick_reproof",
                "detectorCode": reproof.get("code") if isinstance(reproof, dict) else "",
                "clickAttempted": False,
            },
        )
    if not _same_p5_identity(initial, current):
        return _result(
            DOWNLOAD_PROOF_CHANGED,
            ok=False,
            details={
                "phase": "preclick_reproof",
                "reason": "p5_identity_changed",
                "clickAttempted": False,
            },
        )

    try:
        control = _resolve_control(page, current)
        snapshot = _control_snapshot(control, expected_filename)
    except Exception as exc:
        return _result(
            DOWNLOAD_CONTROL_INVALID,
            ok=False,
            details={
                "phase": "preclick_control",
                "reason": str(exc)[:500],
                "clickAttempted": False,
            },
        )

    if not (
        snapshot["connected"]
        and snapshot["visible"]
        and not snapshot["disabled"]
        and snapshot["visibleLabelExact"]
    ):
        return _result(
            DOWNLOAD_CONTROL_INVALID,
            ok=False,
            details={
                "phase": "preclick_control",
                "control": snapshot,
                "clickAttempted": False,
            },
        )

    click_attempted = False
    try:
        with page.expect_download(timeout=download_timeout_ms) as download_info:
            click_attempted = True
            control.click(timeout=click_timeout_ms)
        download = download_info.value
    except Exception as exc:
        return _result(
            DOWNLOAD_NOT_FOUND,
            ok=False,
            recoverable=False,
            details={
                "phase": "download_event",
                "reason": str(exc)[:500],
                "clickAttempted": click_attempted,
                "retryAllowed": False,
            },
        )

    suggested = str(getattr(download, "suggested_filename", "") or "")
    if suggested != expected_filename:
        _cancel_download_best_effort(download)
        return _result(
            DOWNLOAD_FILENAME_MISMATCH,
            ok=False,
            details={
                "phase": "download_event",
                "suggestedFilename": suggested[:512],
                "expectedFilename": expected_filename,
                "clickAttempted": True,
                "retryAllowed": False,
            },
        )

    try:
        failure = _download_failure(download)
        if failure is not None:
            return _result(
                DOWNLOAD_INTERRUPTED,
                ok=False,
                details={
                    "phase": "download",
                    "failure": failure,
                    "clickAttempted": True,
                    "retryAllowed": False,
                },
            )
        download.save_as(str(staging_zip))
        if not staging_zip.is_file():
            raise RuntimeError("save_as completed without a staging file")
    except Exception as exc:
        return _result(
            DOWNLOAD_INTERRUPTED,
            ok=False,
            details={
                "phase": "download_save",
                "reason": str(exc)[:500],
                "clickAttempted": True,
                "retryAllowed": False,
            },
        )

    actual_sha256 = _sha256_file(staging_zip)
    runner = validator_runner or _run_validator
    try:
        validation = runner(staging_zip, trusted)
    except Exception as exc:
        return _result(
            ARTIFACT_VALIDATOR_FAILED,
            ok=False,
            details={
                "phase": "validator",
                "reason": str(exc)[:500],
                "stagingPath": str(staging_zip),
                "sha256": actual_sha256,
            },
        )

    if not isinstance(validation, dict):
        return _result(
            ARTIFACT_VALIDATOR_FAILED,
            ok=False,
            details={"phase": "validator", "reason": "validator result is not an object"},
        )

    if validation.get("ok") is not True:
        try:
            _atomic_write_json(staging_dir / "validation.json", validation)
        except Exception:
            pass
        return _result(
            ARTIFACT_INVALID,
            ok=False,
            details={
                "phase": "validator",
                "validatorCode": validation.get("code"),
                "stagingPath": str(staging_zip),
                "sha256": actual_sha256,
            },
        )

    if not _validation_matches_trusted(validation, trusted=trusted, actual_sha256=actual_sha256):
        return _result(
            ARTIFACT_INVALID,
            ok=False,
            details={
                "phase": "validator_attestation",
                "reason": "validator success did not match trusted metadata or raw SHA-256",
                "stagingPath": str(staging_zip),
                "sha256": actual_sha256,
            },
        )

    try:
        manifest_bytes, manifest = _read_manifest_bytes(staging_zip)
    except Exception as exc:
        return _result(
            ARTIFACT_INVALID,
            ok=False,
            details={
                "phase": "manifest_post_validation",
                "reason": str(exc)[:500],
                "stagingPath": str(staging_zip),
            },
        )
    if not _manifest_matches_trusted(manifest, trusted):
        return _result(
            ARTIFACT_INVALID,
            ok=False,
            details={
                "phase": "manifest_post_validation",
                "reason": "manifest identity mismatch after validator PASS",
                "stagingPath": str(staging_zip),
            },
        )

    metadata = {
        "protocolVersion": 1,
        "state": RESULT_DURABLE,
        "requestId": request_id,
        "repository": trusted["repository"],
        "baseCommit": trusted["baseCommit"],
        "expectedFilename": expected_filename,
        "artifactSha256": actual_sha256,
        "chatUrl": current["chatUrl"],
        "assistantIndex": current["assistantIndex"],
        "assistantTextSha256": current["assistantTextSha256"],
        "downloadSuggestedFilename": suggested,
        "browserDownloadDirectory": str(browser_download_dir),
        "browserDownloadDirectoryTrusted": False,
        "routingAuthorityIncluded": False,
    }

    try:
        _publish_durable(
            result_root=root,
            final_dir=final_dir,
            staging_zip=staging_zip,
            manifest_bytes=manifest_bytes,
            validation=validation,
            metadata=metadata,
        )
        shutil.rmtree(staging_dir, ignore_errors=True)
    except Exception as exc:
        return _result(
            RESULT_STORE_FAILED,
            ok=False,
            details={
                "phase": "publish",
                "reason": str(exc)[:500],
                "stagingPath": str(staging_zip),
            },
        )

    return _result(
        RESULT_DURABLE,
        ok=True,
        details={
            "phase": "durable",
            "requestId": request_id,
            "expectedFilename": expected_filename,
            "sha256": actual_sha256,
            "resultDirectory": str(final_dir),
            "resultZip": str(final_dir / "result.zip"),
            "manifest": str(final_dir / "manifest.json"),
            "validation": str(final_dir / "validation.json"),
            "metadata": str(final_dir / "metadata.json"),
            "downloadStarted": True,
            "downloadCompleted": True,
            "artifactValid": True,
            "runtimeReadyTransitionPerformed": False,
            "browserDownloadDirectory": str(browser_download_dir),
            "browserDownloadDirectoryTrusted": False,
        },
    )
