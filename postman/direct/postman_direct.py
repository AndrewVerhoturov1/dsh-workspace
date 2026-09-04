#!/usr/bin/env python3
"""Direct Web Postman bridge.

WP-014R removes the Cordis/Postman-agent orchestration layer from the critical
path. The initiating local agent calls this CLI directly and waits for one JSON
result. Existing browser-first WP-003..WP-007 modules still own ChatGPT browser
interaction, assistant correlation, artifact detection, download and validation.

Normal path:
    Luna -> postman.ps1 -> this CLI -> GitHub task publication
         -> dedicated Chrome/CDP -> WebWorkerBridge.run_request
         -> validated durable ZIP -> JSON back to Luna

The CLI never applies the returned implementation ZIP to the repository.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Iterable
from urllib.parse import quote

SCRIPT_DIR = Path(__file__).resolve().parent
POSTMAN_DIR = SCRIPT_DIR.parent
WEB_DIR = POSTMAN_DIR / "web"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(POSTMAN_DIR) not in sys.path:
    sys.path.insert(0, str(POSTMAN_DIR))
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import browser_bootstrap as bootstrap  # noqa: E402
import durable_handoff  # noqa: E402
import task_package  # noqa: E402
import request_identity  # noqa: E402
import runtime_support as runtime  # noqa: E402
from web_worker_bridge import WebWorkerBridge, RESULT_DURABLE  # noqa: E402

DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
DEFAULT_BRANCH = "main"
DEFAULT_GH_BINARY = os.environ.get("DSH_POSTMAN_GH_BINARY", "gh")
PUBLIC_POLICY_URL = (
    "https://raw.githubusercontent.com/AndrewVerhoturov1/agents-andrew-instructions/"
    "main/policies/postman-webchat-result-artifact.md"
)

DIRECT_VERSION = 3
DEFAULT_ASSISTANT_TIMEOUT_MS = 15 * 60 * 1000
STATE_INIT = "INIT"
STATE_TASK_PUBLISHED = "TASK_PUBLISHED"
STATE_BROWSER_READY = "BROWSER_READY"
STATE_WEB_RUNNING = "WEB_RUNNING"
STATE_RESULT_DURABLE = "RESULT_DURABLE"
STATE_FAILED = "FAILED"
STATE_BROWSER_SMOKE_READY = "BROWSER_SMOKE_READY"

DEFAULT_EXTRA_ALLOWED_ROOTS = (
    "app",
    "apps",
    "calculator",
    "demo",
    "docs",
    "examples",
    "projects",
    "public",
    "site",
    "src",
    "tests",
    "tools",
    "web",
    "index.html",
    "package.json",
    "tsconfig.json",
    "vite.config.js",
    "vite.config.ts",
)
DEFAULT_FORBIDDEN_PATHS = (
    ".git",
    ".credentials.yaml",
    ".anonymous-user-id",
    "codex-oauth.json",
    "settings.yaml",
    "attachments",
    "sessions",
    "storages",
    "backup",
    "profiles/web/node_modules",
    "plugins/dsh-postman-harness/node_modules",
)


class DirectPostmanError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


def _json_result(ok: bool, code: str, **fields: Any) -> dict[str, Any]:
    return {"ok": ok, "code": code, "directVersion": DIRECT_VERSION, **fields}


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def default_direct_root(env: dict[str, str] | None = None) -> Path:
    source = os.environ if env is None else env
    local = source.get("LOCALAPPDATA")
    if local:
        return Path(local) / "DSH" / "Postman" / "direct"
    return Path.home() / ".dsh" / "postman" / "direct"


def render_intent_task(user_intent: str) -> str:
    if not isinstance(user_intent, str) or not user_intent.strip():
        raise DirectPostmanError("DIRECT_INVALID_TASK", "task must be a non-empty string")
    normalized = user_intent.replace("\r\n", "\n").replace("\r", "\n")
    return f"# POSTMAN TASK\n\nuser_intent:\n{normalized}\n"


def build_external_prompt(
    *,
    request_id: str,
    task_url: str,
    repository: str,
    base_commit: str,
    expected_filename: str,
    allowed_paths: list[str],
    forbidden_paths: list[str],
    policy_url: str = PUBLIC_POLICY_URL,
) -> str:
    """Compatibility boundary delegating all prompt formatting to task_package."""

    request_identity.assert_canonical_request_id(request_id)
    if not request_identity.validate_expected_artifact_filename(request_id, expected_filename):
        raise DirectPostmanError("DIRECT_INVALID_FILENAME", "expected filename does not match request id")
    # Repository/base/path metadata are intentionally ignored here. They belong
    # only in the self-contained task file rendered before publication.
    return task_package.build_external_prompt(request_id, policy_url, task_url)


def _decode_task_file(path: str | os.PathLike[str]) -> str:
    return Path(path).read_text(encoding="utf-8")


def _decode_task_b64(value: str) -> str:
    try:
        raw = base64.b64decode(value, validate=True)
        return raw.decode("utf-8")
    except Exception as exc:  # pragma: no cover - defensive CLI boundary
        raise DirectPostmanError("DIRECT_INVALID_TASK", "task-base64 must be valid UTF-8 base64") from exc


def _normalized_unique(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = str(raw).replace("\\", "/").strip().strip("/")
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def derive_allowed_paths(root_entries: Iterable[str], extra: Iterable[str] = ()) -> list[str]:
    values: list[str] = []
    for raw in root_entries:
        name = str(raw).strip()
        if not name or name.startswith("REQ_"):
            continue
        if name in {"settings.yaml", "attachments", ".git"}:
            continue
        values.append(name)
    values.extend(DEFAULT_EXTRA_ALLOWED_ROOTS)
    values.extend(extra)
    result = _normalized_unique(values)
    if not result:
        raise DirectPostmanError("DIRECT_INVALID_SCOPE", "allowed path set is empty")
    return result


def derive_forbidden_paths(extra: Iterable[str] = ()) -> list[str]:
    return _normalized_unique([*DEFAULT_FORBIDDEN_PATHS, *extra])


@dataclass(frozen=True)
class TaskSnapshot:
    prepublication_commit: str
    root_entries: tuple[str, ...]


@dataclass(frozen=True)
class PublishedTask:
    request_id: str
    task_url: str
    prepublication_commit: str
    publication_commit: str
    root_entries: tuple[str, ...]


class GitHubTaskPublisher:
    def __init__(
        self,
        *,
        repository: str = DEFAULT_REPOSITORY,
        branch: str = DEFAULT_BRANCH,
        gh_binary: str = DEFAULT_GH_BINARY,
        cwd: str | os.PathLike[str] | None = None,
        run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    ) -> None:
        self.repository = repository
        self.branch = branch
        self.gh_binary = gh_binary
        self.cwd = str(cwd) if cwd is not None else None
        self._run = run

    def _api(self, endpoint: str, *, method: str | None = None, payload: dict[str, Any] | None = None) -> Any:
        command = [self.gh_binary, "api", endpoint]
        if method is not None:
            command += ["--method", method]
        stdin = None
        if payload is not None:
            command += ["--input", "-"]
            stdin = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        completed = self._run(
            command,
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=self.cwd,
            check=False,
            **runtime.quiet_subprocess_kwargs(),
        )
        if completed.returncode != 0:
            raise DirectPostmanError(
                "DIRECT_GITHUB_FAILED",
                f"gh api failed for {endpoint}",
                details={"exitCode": completed.returncode, "stderr": completed.stderr[-2000:]},
            )
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise DirectPostmanError(
                "DIRECT_GITHUB_FAILED",
                f"gh api returned non-JSON for {endpoint}",
                details={"stdout": completed.stdout[-1000:]},
            ) from exc

    def _branch_sha(self) -> str:
        value = self._api(f"repos/{self.repository}/git/ref/heads/{quote(self.branch, safe='')}")
        sha = value.get("object", {}).get("sha") if isinstance(value, dict) else None
        if not isinstance(sha, str) or len(sha) != 40:
            raise DirectPostmanError("DIRECT_GITHUB_FAILED", "branch ref did not return a full commit SHA")
        return sha

    def _root_entries(self, commit_sha: str) -> tuple[str, ...]:
        value = self._api(f"repos/{self.repository}/contents?ref={commit_sha}")
        if not isinstance(value, list):
            raise DirectPostmanError("DIRECT_GITHUB_FAILED", "repository root listing is not an array")
        names = []
        for item in value:
            name = item.get("name") if isinstance(item, dict) else None
            if isinstance(name, str) and name:
                names.append(name)
        return tuple(names)

    def snapshot(self) -> TaskSnapshot:
        prepublication = self._branch_sha()
        return TaskSnapshot(
            prepublication_commit=prepublication,
            root_entries=self._root_entries(prepublication),
        )

    def _single_parent_sha(self, commit_sha: str) -> str:
        value = self._api(f"repos/{self.repository}/git/commits/{commit_sha}")
        parents = value.get("parents") if isinstance(value, dict) else None
        if not isinstance(parents, list) or len(parents) != 1:
            raise DirectPostmanError(
                "DIRECT_TASK_PUBLICATION_INVALID",
                "task publication commit must have exactly one parent",
            )
        parent = parents[0].get("sha") if isinstance(parents[0], dict) else None
        if not isinstance(parent, str) or len(parent) != 40:
            raise DirectPostmanError(
                "DIRECT_TASK_PUBLICATION_INVALID",
                "task publication parent did not return a full commit SHA",
            )
        return parent.lower()

    def publish_content(
        self,
        request_id: str,
        content: str,
        *,
        expected_parent: str,
        root_entries: Iterable[str],
    ) -> PublishedTask:
        request_identity.assert_canonical_request_id(request_id)
        filename = f"{request_id}.md"
        expected_parent = expected_parent.lower()

        current = self._branch_sha().lower()
        if current != expected_parent:
            raise DirectPostmanError(
                "DIRECT_TASK_PUBLICATION_RACE",
                "repository branch advanced before task publication",
                details={"expectedParent": expected_parent, "actualHead": current},
            )

        response = self._api(
            f"repos/{self.repository}/contents/{filename}",
            method="PUT",
            payload={
                "message": f"postman: publish task {request_id}",
                "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
                "branch": self.branch,
            },
        )
        publication = response.get("commit", {}).get("sha") if isinstance(response, dict) else None
        if not isinstance(publication, str) or len(publication) != 40:
            raise DirectPostmanError("DIRECT_GITHUB_FAILED", "task publication did not return commit SHA")
        publication = publication.lower()

        actual_parent = self._single_parent_sha(publication)
        if actual_parent != expected_parent:
            raise DirectPostmanError(
                "DIRECT_TASK_PUBLICATION_RACE",
                "task publication was not based on the snapshotted implementation base",
                details={
                    "expectedParent": expected_parent,
                    "actualParent": actual_parent,
                    "taskPublicationCommit": publication,
                },
            )

        owner, repo = self.repository.split("/", 1)
        task_url = f"https://raw.githubusercontent.com/{owner}/{repo}/{publication}/{filename}"
        return PublishedTask(
            request_id=request_id,
            task_url=task_url,
            prepublication_commit=expected_parent,
            publication_commit=publication,
            root_entries=tuple(root_entries),
        )

    def publish(self, request_id: str, user_intent: str) -> PublishedTask:
        """Legacy compatibility helper; DirectPostman.run uses publish_content()."""

        snapshot = self.snapshot()
        return self.publish_content(
            request_id,
            render_intent_task(user_intent),
            expected_parent=snapshot.prepublication_commit,
            root_entries=snapshot.root_entries,
        )


def ensure_dedicated_chrome(
    *,
    cdp_url: str = bootstrap.DEFAULT_CDP_URL,
    profile_dir: str | os.PathLike[str] | None = None,
    chrome_executable: str | os.PathLike[str] | None = None,
    bootstrap_module: Any = bootstrap,
) -> dict[str, Any]:
    profile = Path(profile_dir) if profile_dir is not None else bootstrap_module.default_profile_dir()
    normalized = bootstrap_module.normalize_cdp_url(cdp_url)
    try:
        proof = bootstrap_module.wait_for_cdp(normalized, timeout_s=0.25)
        return {
            "launched": False,
            "reused": True,
            "cdpUrl": normalized,
            "profileDir": str(profile),
            "cdpProof": proof,
        }
    except bootstrap_module.BrowserBootstrapError as exc:
        if exc.code != bootstrap_module.BOOTSTRAP_CDP_UNREACHABLE:
            raise DirectPostmanError("DIRECT_BROWSER_FAILED", str(exc), details=getattr(exc, "details", {})) from exc

    executable = bootstrap_module.discover_chrome_executable(explicit=chrome_executable)
    if executable is None:
        raise DirectPostmanError("DIRECT_CHROME_NOT_FOUND", "Google Chrome executable was not found")
    process = bootstrap_module.start_dedicated_chrome(executable, profile)
    try:
        proof = bootstrap_module.wait_for_cdp(normalized, timeout_s=20.0)
    except bootstrap_module.BrowserBootstrapError as exc:
        raise DirectPostmanError("DIRECT_BROWSER_FAILED", str(exc), details=getattr(exc, "details", {})) from exc
    return {
        "launched": True,
        "reused": False,
        "pid": getattr(process, "pid", None),
        "cdpUrl": normalized,
        "profileDir": str(profile),
        "chromeExecutable": str(executable),
        "cdpProof": proof,
    }


class DirectPostman:
    def __init__(
        self,
        *,
        repository: str = DEFAULT_REPOSITORY,
        branch: str = DEFAULT_BRANCH,
        gh_binary: str = DEFAULT_GH_BINARY,
        repo_root: str | os.PathLike[str] | None = None,
        direct_root: str | os.PathLike[str] | None = None,
        result_root: str | os.PathLike[str] | None = None,
        publisher_factory: Callable[..., GitHubTaskPublisher] = GitHubTaskPublisher,
        bridge_factory: Callable[..., WebWorkerBridge] = WebWorkerBridge,
        ensure_browser: Callable[..., dict[str, Any]] = ensure_dedicated_chrome,
    ) -> None:
        self.repository = repository
        self.branch = branch
        self.gh_binary = gh_binary
        self.repo_root = Path(repo_root) if repo_root is not None else SCRIPT_DIR.parents[1]
        self.direct_root = Path(direct_root) if direct_root is not None else default_direct_root()
        if result_root is not None:
            self.result_root = Path(result_root)
        elif direct_root is not None and not os.environ.get(runtime.RESULT_ROOT_ENV):
            self.result_root = self.direct_root.parent / "results"
        else:
            self.result_root = runtime.default_result_root()
        self.publisher_factory = publisher_factory
        self.bridge_factory = bridge_factory
        self.ensure_browser = ensure_browser

    def state_path(self, request_id: str) -> Path:
        request_identity.assert_canonical_request_id(request_id)
        return self.direct_root / "requests" / f"{request_id}.json"

    def result_handoff_path(self, request_id: str) -> Path:
        return durable_handoff.handoff_path(self.direct_root, request_id)

    def _write_state(self, request_id: str, state: str, **fields: Any) -> None:
        path = self.state_path(request_id)
        previous: dict[str, Any] = {}
        if path.exists():
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    previous = value
            except Exception:
                previous = {}
        record = {
            **previous,
            "directVersion": DIRECT_VERSION,
            "requestId": request_id,
            "repository": self.repository,
            "branch": self.branch,
            "state": state,
            "updatedAt": time.time(),
            **fields,
        }
        _atomic_json(path, record)

    def browser_smoke(self, *, cdp_url: str = bootstrap.DEFAULT_CDP_URL) -> dict[str, Any]:
        browser = self.ensure_browser(cdp_url=cdp_url)
        return _json_result(
            True,
            STATE_BROWSER_SMOKE_READY,
            state=STATE_BROWSER_SMOKE_READY,
            browser=browser,
            promptSent=False,
        )

    def run(
        self,
        *,
        request_id: str,
        task: str,
        cdp_url: str = bootstrap.DEFAULT_CDP_URL,
        extra_allowed: Iterable[str] = (),
        extra_forbidden: Iterable[str] = (),
    ) -> dict[str, Any]:
        request_identity.assert_canonical_request_id(request_id)
        if self.state_path(request_id).exists():
            raise DirectPostmanError(
                "DIRECT_REQUEST_EXISTS",
                f"request {request_id} already has direct transport state; automatic resend is forbidden",
                details={"statePath": str(self.state_path(request_id))},
            )

        try:
            self.result_root = runtime.prepare_result_root(self.result_root)
        except Exception as exc:
            raise DirectPostmanError(
                "DIRECT_RESULT_ROOT_UNAVAILABLE",
                f"Postman result root is unavailable: {self.result_root}",
                details={"resultRoot": str(self.result_root), "reason": str(exc)[:500]},
            ) from exc

        self._write_state(
            request_id,
            STATE_INIT,
            taskSha256=_sha256_text(task),
            resultRoot=str(self.result_root),
        )

        publisher = self.publisher_factory(
            repository=self.repository,
            branch=self.branch,
            gh_binary=self.gh_binary,
            cwd=self.repo_root,
        )
        snapshot = publisher.snapshot()
        expected_filename = request_identity.expected_artifact_filename(request_id)
        allowed_paths = derive_allowed_paths(snapshot.root_entries, extra_allowed)
        forbidden_paths = derive_forbidden_paths(extra_forbidden)

        task_content = task_package.render_direct_task_manifest(
            request_id=request_id,
            user_intent=task,
            repository=self.repository,
            base_commit=snapshot.prepublication_commit,
            expected_filename=expected_filename,
            allowed_paths=allowed_paths,
            forbidden_paths=forbidden_paths,
        )
        published = publisher.publish_content(
            request_id,
            task_content,
            expected_parent=snapshot.prepublication_commit,
            root_entries=snapshot.root_entries,
        )

        expected_request = {
            "requestId": request_id,
            "repository": self.repository,
            "baseCommit": snapshot.prepublication_commit,
            "expectedFilename": expected_filename,
            "allowedPaths": allowed_paths,
            "forbiddenPaths": forbidden_paths,
        }
        prompt = build_external_prompt(
            request_id=request_id,
            task_url=published.task_url,
            repository=self.repository,
            base_commit=snapshot.prepublication_commit,
            expected_filename=expected_filename,
            allowed_paths=allowed_paths,
            forbidden_paths=forbidden_paths,
        )
        self._write_state(
            request_id,
            STATE_TASK_PUBLISHED,
            taskUrl=published.task_url,
            prepublicationCommit=published.prepublication_commit,
            baseCommit=published.prepublication_commit,
            taskPublicationCommit=published.publication_commit,
            expectedFilename=expected_filename,
            allowedPaths=allowed_paths,
            forbiddenPaths=forbidden_paths,
            promptSha256=_sha256_text(prompt),
        )

        browser = self.ensure_browser(cdp_url=cdp_url)
        self._write_state(request_id, STATE_BROWSER_READY, browser=browser)

        bridge_root = self.direct_root.parent
        bridge = self.bridge_factory(root=bridge_root, result_root=self.result_root)
        self._write_state(request_id, STATE_WEB_RUNNING)
        result = bridge.run_request(
            request_id,
            task_url=published.task_url,
            prompt=prompt,
            expected_filename=expected_filename,
            expected_request=expected_request,
            cdp_url=browser.get("cdpUrl", cdp_url),
            observer_timeout_ms=DEFAULT_ASSISTANT_TIMEOUT_MS,
        )
        if not isinstance(result, dict) or result.get("code") != RESULT_DURABLE or result.get("ok") is not True:
            code = result.get("code", "DIRECT_WEB_FAILED") if isinstance(result, dict) else "DIRECT_WEB_FAILED"
            details = result.get("details", {}) if isinstance(result, dict) else {"result": repr(result)}
            self._write_state(request_id, STATE_FAILED, failureCode=code, failureDetails=details)
            raise DirectPostmanError("DIRECT_WEB_FAILED", f"Web Postman pipeline failed: {code}", details=details)

        details = result.get("details", {})
        result_zip = details.get("resultZip")
        sha256 = details.get("resultSha256")
        if not isinstance(result_zip, str) or not result_zip:
            raise DirectPostmanError("DIRECT_RESULT_INVALID", "durable result did not expose resultZip", details=details)

        state_path = self.state_path(request_id)
        handoff_path = durable_handoff.handoff_path(self.direct_root, request_id)
        terminal = _json_result(
            True,
            STATE_RESULT_DURABLE,
            state=STATE_RESULT_DURABLE,
            requestId=request_id,
            repository=self.repository,
            baseCommit=published.prepublication_commit,
            taskPublicationCommit=published.publication_commit,
            taskUrl=published.task_url,
            expectedFilename=expected_filename,
            resultZip=result_zip,
            sha256=sha256,
            resultRoot=str(self.result_root),
            browser=browser,
            statePath=str(state_path),
            resultHandoffPath=str(handoff_path.resolve()),
            handoffVersion=durable_handoff.HANDOFF_VERSION,
        )
        try:
            terminal = durable_handoff.validate_terminal(
                terminal,
                expected_repository=self.repository,
                request_id=request_id,
                expected_state_path=state_path,
                expected_handoff_path=handoff_path,
            )
        except durable_handoff.DurableHandoffError as exc:
            raise DirectPostmanError("DIRECT_RESULT_INVALID", str(exc), details=exc.details) from exc
        try:
            durable_handoff.atomic_write_json(handoff_path, terminal)
        except OSError as exc:
            raise DirectPostmanError(
                "DIRECT_RESULT_HANDOFF_WRITE_FAILED",
                f"could not persist durable result handoff: {handoff_path}",
                details={"handoffPath": str(handoff_path), "reason": str(exc)},
            ) from exc

        self._write_state(
            request_id,
            STATE_RESULT_DURABLE,
            resultZip=result_zip,
            artifactSha256=terminal["sha256"],
            workerDetails=details,
        )
        return terminal


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Direct Web Postman bridge")
    parser.add_argument("--browser-smoke", action="store_true", help="Ensure dedicated Postman Chrome/CDP only; send no prompt")
    parser.add_argument("--request-id")
    task_group = parser.add_mutually_exclusive_group()
    task_group.add_argument("--task")
    task_group.add_argument("--task-file")
    task_group.add_argument("--task-base64")
    parser.add_argument("--repository", default=DEFAULT_REPOSITORY)
    parser.add_argument("--branch", default=DEFAULT_BRANCH)
    parser.add_argument("--gh-binary", default=DEFAULT_GH_BINARY)
    parser.add_argument("--repo-root")
    parser.add_argument("--direct-root")
    parser.add_argument("--result-root")
    parser.add_argument("--cdp-url", default=bootstrap.DEFAULT_CDP_URL)
    parser.add_argument("--allow-path", action="append", default=[])
    parser.add_argument("--forbid-path", action="append", default=[])
    return parser


def _task_from_args(args: argparse.Namespace) -> str:
    if args.task is not None:
        return args.task
    if args.task_file is not None:
        return _decode_task_file(args.task_file)
    if args.task_base64 is not None:
        return _decode_task_b64(args.task_base64)
    raise DirectPostmanError("DIRECT_INVALID_TASK", "one of --task, --task-file or --task-base64 is required")


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        direct = DirectPostman(
            repository=args.repository,
            branch=args.branch,
            gh_binary=args.gh_binary,
            repo_root=args.repo_root,
            direct_root=args.direct_root,
            result_root=args.result_root,
        )
        if args.browser_smoke:
            result = direct.browser_smoke(cdp_url=args.cdp_url)
        else:
            if not args.request_id:
                raise DirectPostmanError("DIRECT_INVALID_REQUEST", "--request-id is required")
            task = _task_from_args(args)
            result = direct.run(
                request_id=args.request_id,
                task=task,
                cdp_url=args.cdp_url,
                extra_allowed=args.allow_path,
                extra_forbidden=args.forbid_path,
            )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (DirectPostmanError, ValueError) as exc:
        code = exc.code if isinstance(exc, DirectPostmanError) else "DIRECT_INVALID_REQUEST"
        details = exc.details if isinstance(exc, DirectPostmanError) else {}
        result = _json_result(False, code, error=str(exc), details=details)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 2
    except Exception as exc:  # pragma: no cover - last-resort CLI boundary
        result = _json_result(False, "DIRECT_INTERNAL_ERROR", error=str(exc))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
