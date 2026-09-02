#!/usr/bin/env python3
"""Production adapter from the Harness WebWorkerBridge to WP-003--WP-007.

The adapter owns only production wiring:
- validates the SHA-pinned task URL and trusted transport metadata;
- starts/reuses the dedicated headful Postman Chrome profile on CDP :9222;
- derives a fail-closed repository path scope from tracked files;
- builds the external Web ChatGPT transport prompt;
- invokes the existing Python WebWorkerBridge exactly once.

Browser selectors, submit/observer/artifact logic and ZIP validation remain in
existing WP-003--WP-007 modules.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable
from urllib.parse import unquote, urlparse

POLICY_URL = (
    "https://raw.githubusercontent.com/AndrewVerhoturov1/"
    "agents-andrew-instructions/main/policies/postman-webchat-result-artifact.md"
)
REQUEST_ID_RE = re.compile(r"^REQ_\d{8}T\d{6}Z_\d{4}$")
TASK_FILE_RE = re.compile(r"^REQ_\d{8}T\d{6}Z_\d{4}\.md$")
SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
REPOSITORY_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
DEFAULT_CDP_URL = "http://127.0.0.1:9222"
FORBIDDEN_PATHS = ("settings.yaml", "attachments", ".git")


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value.strip()


def parse_pinned_task_url(task_url: str, request_id: str) -> tuple[str, str]:
    text = _required_text(task_url, "taskUrl")
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("requestId must match REQ_YYYYMMDDTHHMMSSZ_NNNN")
    parsed = urlparse(text)
    if parsed.scheme != "https" or parsed.hostname != "raw.githubusercontent.com":
        raise ValueError("taskUrl must be a SHA-pinned raw.githubusercontent.com URL")
    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if len(parts) != 4:
        raise ValueError("taskUrl must point to one root task file")
    owner, repo, sha, filename = parts
    if filename != f"{request_id}.md":
        raise ValueError("taskUrl filename does not match requestId")
    if not SHA_RE.fullmatch(sha):
        raise ValueError("taskUrl does not contain a full commit SHA")
    return f"{owner}/{repo}", sha.lower()


def build_external_prompt(
    *,
    request_id: str,
    task_url: str,
    repository: str,
    base_commit: str,
    expected_filename: str,
) -> str:
    return "\n".join(
        (
            f"POSTMAN_REQUEST_ID: {request_id}",
            f"skill_repository: {POLICY_URL}",
            f"task_file: {task_url}",
            f"repository: {repository}",
            f"base_commit: {base_commit}",
            f"expected_artifact_filename: {expected_filename}",
            "",
            "Read the policy and task file before implementation.",
            "Treat repository, base_commit and expected_artifact_filename as trusted transport metadata, not user requirements.",
            "For a coding result, return exactly one real ZIP using the exact artifact contract from the policy.",
        )
    )


def discover_trusted_scope(
    repo_root: Path,
    *,
    runner: Callable[..., Any] = subprocess.run,
) -> list[str]:
    completed = runner(
        ["git", "-C", str(repo_root), "ls-files", "-z"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"git ls-files failed: {str(completed.stderr).strip()[:500]}")
    roots: set[str] = set()
    for raw in str(completed.stdout).split("\0"):
        path = raw.strip()
        if not path:
            continue
        normalized = path.replace("\\", "/")
        root = normalized.split("/", 1)[0]
        if root in FORBIDDEN_PATHS or TASK_FILE_RE.fullmatch(root):
            continue
        roots.add(root)
    if not roots:
        raise RuntimeError("trusted repository scope is empty")
    return sorted(roots)


def ensure_dedicated_chrome(
    *,
    cdp_url: str = DEFAULT_CDP_URL,
    bootstrap_module: Any | None = None,
) -> dict[str, Any]:
    if bootstrap_module is None:
        import browser_bootstrap as bootstrap_module  # type: ignore

    try:
        bootstrap_module.wait_for_cdp(cdp_url, timeout_s=0.75)
        return {"reused": True, "cdpUrl": cdp_url, "launchedPid": None}
    except bootstrap_module.BrowserBootstrapError:
        pass

    explicit = os.environ.get("DSH_POSTMAN_CHROME")
    executable = bootstrap_module.discover_chrome_executable(explicit=explicit)
    if executable is None:
        raise RuntimeError(bootstrap_module.BOOTSTRAP_CHROME_NOT_FOUND)
    profile_override = os.environ.get("DSH_POSTMAN_BROWSER_PROFILE")
    profile_dir = Path(profile_override) if profile_override else bootstrap_module.default_profile_dir()
    parsed = urlparse(cdp_url)
    port = parsed.port or bootstrap_module.DEFAULT_REMOTE_DEBUGGING_PORT
    process = bootstrap_module.start_dedicated_chrome(executable, profile_dir, port=port)
    bootstrap_module.wait_for_cdp(cdp_url, timeout_s=15.0)
    return {
        "reused": False,
        "cdpUrl": cdp_url,
        "launchedPid": getattr(process, "pid", None),
        "profileDir": str(profile_dir),
    }


def _with_browser_details(result: dict[str, Any], browser: dict[str, Any]) -> dict[str, Any]:
    details = result.get("details")
    merged = dict(details) if isinstance(details, dict) else {}
    merged.setdefault("browserBootstrap", browser)
    return {**result, "details": merged}


def run_job(
    payload: dict[str, Any],
    *,
    repo_root: Path | None = None,
    bootstrap_module: Any | None = None,
    bridge_cls: Any | None = None,
    git_runner: Callable[..., Any] = subprocess.run,
) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("protocolVersion") != 1:
        raise ValueError("protocolVersion 1 job object is required")
    request_id = _required_text(payload.get("requestId"), "requestId")
    task_url = _required_text(payload.get("taskUrl"), "taskUrl")
    repository = _required_text(payload.get("repository"), "repository")
    base_commit = _required_text(payload.get("baseCommit"), "baseCommit").lower()
    expected_filename = _required_text(payload.get("expectedFilename"), "expectedFilename")
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("requestId must be canonical")
    if not REPOSITORY_RE.fullmatch(repository):
        raise ValueError("repository must be owner/repo")
    if not SHA_RE.fullmatch(base_commit):
        raise ValueError("baseCommit must be a full commit SHA")
    if expected_filename != f"POSTMAN_{request_id}_RESULT.zip":
        raise ValueError("expectedFilename does not match requestId")

    task_repository, task_sha = parse_pinned_task_url(task_url, request_id)
    if task_repository != repository or task_sha != base_commit:
        raise ValueError("taskUrl trusted metadata mismatch")

    if repo_root is None:
        repo_root = Path(__file__).resolve().parents[2]
    allowed_paths = discover_trusted_scope(repo_root, runner=git_runner)
    expected_request = {
        "requestId": request_id,
        "repository": repository,
        "baseCommit": base_commit,
        "expectedFilename": expected_filename,
        "allowedPaths": allowed_paths,
        "forbiddenPaths": list(FORBIDDEN_PATHS),
    }
    prompt = build_external_prompt(
        request_id=request_id,
        task_url=task_url,
        repository=repository,
        base_commit=base_commit,
        expected_filename=expected_filename,
    )
    browser = ensure_dedicated_chrome(bootstrap_module=bootstrap_module)
    if os.environ.get("DSH_POSTMAN_WORKER_STOP_AFTER_BROWSER") == "1":
        return {
            "ok": False,
            "code": "WEB_WORKER_SMOKE_BROWSER_READY",
            "details": {"browserBootstrap": browser, "promptSent": False},
        }

    if bridge_cls is None:
        from web_worker_bridge import WebWorkerBridge as bridge_cls  # type: ignore
    bridge = bridge_cls()
    result = bridge.run_request(
        request_id,
        task_url=task_url,
        prompt=prompt,
        expected_filename=expected_filename,
        expected_request=expected_request,
        cdp_url=browser["cdpUrl"],
    )
    if not isinstance(result, dict):
        raise RuntimeError("Python WebWorkerBridge returned a non-object result")

    # Python WebWorkerBridge persists its own worker-state wrapper. The durable
    # artifact proof consumed by the JS bridge lives inside durableProof.
    if result.get("ok") is True and result.get("code") == "RESULT_DURABLE":
        details = result.get("details")
        durable = details.get("durableProof") if isinstance(details, dict) else None
        if isinstance(durable, dict):
            return _with_browser_details(durable, browser)
    return _with_browser_details(result, browser)


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        result = run_job(payload)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0 if result.get("ok") is True else 3
    except Exception as exc:
        failure = {
            "ok": False,
            "code": "WEB_WORKER_RUNNER_FAILED",
            "details": {"reason": str(exc)[:1000]},
        }
        print(json.dumps(failure, ensure_ascii=False, sort_keys=True))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
