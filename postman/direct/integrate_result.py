#!/usr/bin/env python3
"""Deterministic integration gate for validated Direct Postman artifacts.

This module deliberately starts *after* Direct Postman has returned RESULT_DURABLE.
It does not send prompts, open a browser, create REQs, choose implementation details,
or publish Git commits/PRs. Its job is to collapse the repetitive local handoff into
one deterministic operation:

    terminal RESULT_DURABLE JSON
      -> identity/hash/manifest validation
      -> clean integration worktree gate
      -> base/staleness checks
      -> exact patch/files application
      -> git diff --check
      -> READY_FOR_TEST JSON

The implementation files from the ZIP are copied as exact bytes. They are never
rewritten through an LLM.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import sys
import tempfile
from typing import Any, Iterable
import zipfile

SCRIPT_DIR = Path(__file__).resolve().parent
WEB_DIR = SCRIPT_DIR.parent / "web"
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))

import request_identity  # noqa: E402

DEFAULT_REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
DEFAULT_ORIGIN_REF = "origin/main"
READY_FOR_TEST = "READY_FOR_TEST"

PROTECTED_ROOTS = (
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


class IntegrationError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


@dataclass(frozen=True)
class DurableResult:
    request_id: str
    repository: str
    base_commit: str
    expected_filename: str
    result_zip: Path
    sha256: str


@dataclass(frozen=True)
class ArtifactPlan:
    result_type: str
    patch_member: str | None
    file_paths: tuple[str, ...]
    patch_paths: tuple[str, ...]

    @property
    def payload_paths(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys((*self.patch_paths, *self.file_paths)))


def _json(ok: bool, code: str, **fields: Any) -> dict[str, Any]:
    return {"ok": ok, "code": code, **fields}


def _run_git(repo_root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=repo_root,
            check=check,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except FileNotFoundError as exc:
        raise IntegrationError("GIT_MISSING", "git executable is not available") from exc
    except subprocess.CalledProcessError as exc:
        raise IntegrationError(
            "GIT_COMMAND_FAILED",
            f"git {' '.join(args)} failed",
            details={"returncode": exc.returncode, "stdout": exc.stdout, "stderr": exc.stderr},
        ) from exc


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_result_json(value: str) -> dict[str, Any]:
    if value == "-":
        text = sys.stdin.read()
    else:
        try:
            text = Path(value).read_text(encoding="utf-8-sig")
        except OSError as exc:
            raise IntegrationError("RESULT_JSON_UNREADABLE", f"cannot read result JSON: {value}") from exc
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise IntegrationError("POSTMAN_RESULT_JSON_INVALID", "terminal result is not valid JSON") from exc
    if not isinstance(parsed, dict):
        raise IntegrationError("POSTMAN_RESULT_JSON_INVALID", "terminal result JSON must be an object")
    return parsed


def _require_str(mapping: dict[str, Any], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value:
        raise IntegrationError("DIRECT_RESULT_INVALID", f"terminal result field {key!r} is missing or empty")
    return value


def validate_durable_result(data: dict[str, Any], *, expected_repository: str) -> DurableResult:
    if data.get("ok") is not True or data.get("code") != "RESULT_DURABLE" or data.get("state") != "RESULT_DURABLE":
        raise IntegrationError(
            "RESULT_NOT_DURABLE",
            "terminal result is not exact RESULT_DURABLE",
            details={"ok": data.get("ok"), "code": data.get("code"), "state": data.get("state")},
        )

    request_id = _require_str(data, "requestId")
    try:
        request_identity.assert_canonical_request_id(request_id)
    except ValueError as exc:
        raise IntegrationError("DIRECT_RESULT_INVALID", "terminal requestId is not canonical") from exc

    repository = _require_str(data, "repository")
    if repository != expected_repository:
        raise IntegrationError(
            "RESULT_REPOSITORY_MISMATCH",
            "terminal result repository does not match expected repository",
            details={"expected": expected_repository, "actual": repository},
        )

    base_commit = _require_str(data, "baseCommit").lower()
    if re.fullmatch(r"[0-9a-f]{40}", base_commit) is None:
        raise IntegrationError("DIRECT_RESULT_INVALID", "baseCommit must be a full 40-hex SHA")

    expected_filename = _require_str(data, "expectedFilename")
    if not request_identity.validate_expected_artifact_filename(request_id, expected_filename):
        raise IntegrationError("RESULT_FILENAME_MISMATCH", "expectedFilename does not correlate with requestId")

    result_zip = Path(_require_str(data, "resultZip"))
    if not result_zip.is_file():
        raise IntegrationError("RESULT_ZIP_MISSING", f"durable ZIP does not exist: {result_zip}")

    sha256 = _require_str(data, "sha256").lower()
    if re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
        raise IntegrationError("DIRECT_RESULT_INVALID", "sha256 must be a 64-hex digest")
    actual_sha = _sha256_file(result_zip)
    if actual_sha != sha256:
        raise IntegrationError(
            "RESULT_SHA256_MISMATCH",
            "durable ZIP SHA256 does not match terminal result",
            details={"expected": sha256, "actual": actual_sha},
        )

    return DurableResult(
        request_id=request_id,
        repository=repository,
        base_commit=base_commit,
        expected_filename=expected_filename,
        result_zip=result_zip,
        sha256=sha256,
    )


def _safe_repo_path(raw: object, *, field: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise IntegrationError("RESULT_MANIFEST_INVALID", f"{field} contains an empty path")
    value = raw.strip()
    if any(ch in value for ch in ("\x00", "\r", "\n")):
        raise IntegrationError("RESULT_PATH_UNSAFE", f"unsafe repository path: {value!r}")
    if "\\" in value or value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise IntegrationError("RESULT_PATH_UNSAFE", f"unsafe repository path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise IntegrationError("RESULT_PATH_UNSAFE", f"unsafe repository path: {value!r}")
    normalized = path.as_posix()
    if _is_protected(normalized):
        raise IntegrationError("RESULT_PROTECTED_PATH", f"artifact attempts to modify protected path: {normalized}")
    return normalized


def _is_protected(path: str) -> bool:
    candidate = PurePosixPath(path)
    for root in PROTECTED_ROOTS:
        protected = PurePosixPath(root)
        if candidate == protected or protected in candidate.parents:
            return True
    return False


def _validate_zip_member(info: zipfile.ZipInfo) -> None:
    name = info.filename
    if any(ch in name for ch in ("\x00", "\r", "\n")):
        raise IntegrationError("RESULT_ZIP_UNSAFE", f"unsafe ZIP member: {name!r}")
    if "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise IntegrationError("RESULT_ZIP_UNSAFE", f"unsafe ZIP member: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise IntegrationError("RESULT_ZIP_UNSAFE", f"unsafe ZIP member: {name!r}")
    mode = (info.external_attr >> 16) & 0o170000
    if mode == stat.S_IFLNK:
        raise IntegrationError("RESULT_ZIP_UNSAFE", f"symbolic links are not allowed in result ZIP: {name!r}")
    if info.flag_bits & 0x1:
        raise IntegrationError("RESULT_ZIP_UNSAFE", f"encrypted ZIP members are not allowed: {name!r}")


def _read_manifest(zf: zipfile.ZipFile, result: DurableResult) -> dict[str, Any]:
    infos = zf.infolist()
    for info in infos:
        _validate_zip_member(info)
    names = {info.filename for info in infos if not info.is_dir()}
    if "manifest.json" not in names:
        raise IntegrationError("RESULT_MANIFEST_MISSING", "result ZIP does not contain root manifest.json")
    try:
        raw = zf.read("manifest.json").decode("utf-8-sig")
        manifest = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise IntegrationError("RESULT_MANIFEST_INVALID", "manifest.json is not valid UTF-8 JSON") from exc
    if not isinstance(manifest, dict):
        raise IntegrationError("RESULT_MANIFEST_INVALID", "manifest.json must contain an object")

    if manifest.get("protocolVersion") != 1:
        raise IntegrationError("RESULT_MANIFEST_INVALID", "manifest.protocolVersion must be 1")

    exact = {
        "requestId": result.request_id,
        "repository": result.repository,
        "baseCommit": result.base_commit,
    }
    for key, expected in exact.items():
        if manifest.get(key) != expected:
            raise IntegrationError(
                "RESULT_MANIFEST_MISMATCH",
                f"manifest {key} does not match terminal result",
                details={"field": key, "expected": expected, "actual": manifest.get(key)},
            )
    return manifest


def _parse_patch_paths(patch_text: str) -> tuple[str, ...]:
    touched: list[str] = []
    for line in patch_text.splitlines():
        if not line.startswith("diff --git "):
            continue
        try:
            parts = shlex.split(line)
        except ValueError as exc:
            raise IntegrationError("RESULT_PATCH_INVALID", "cannot parse diff --git header") from exc
        if len(parts) != 4 or not parts[2].startswith("a/") or not parts[3].startswith("b/"):
            raise IntegrationError("RESULT_PATCH_INVALID", f"unsupported diff header: {line}")
        for raw in (parts[2][2:], parts[3][2:]):
            path = _safe_repo_path(raw, field="patch")
            if path not in touched:
                touched.append(path)
    if not touched:
        raise IntegrationError("RESULT_PATCH_INVALID", "changes.patch contains no diff --git paths")
    return tuple(touched)


def build_artifact_plan(zf: zipfile.ZipFile, manifest: dict[str, Any]) -> ArtifactPlan:
    result_type = manifest.get("resultType")
    if result_type not in {"patch", "files", "hybrid_patch"}:
        raise IntegrationError("RESULT_MANIFEST_INVALID", f"unsupported resultType: {result_type!r}")

    raw_files = manifest.get("files", [])
    if raw_files is None:
        raw_files = []
    if not isinstance(raw_files, list):
        raise IntegrationError("RESULT_MANIFEST_INVALID", "manifest.files must be an array")
    file_paths: list[str] = []
    for raw in raw_files:
        path = _safe_repo_path(raw, field="manifest.files")
        if path in file_paths:
            raise IntegrationError("RESULT_MANIFEST_INVALID", f"duplicate manifest file path: {path}")
        member = f"files/{path}"
        try:
            info = zf.getinfo(member)
        except KeyError as exc:
            raise IntegrationError("RESULT_FILE_MISSING", f"manifest file is absent from ZIP: {member}") from exc
        if info.is_dir():
            raise IntegrationError("RESULT_FILE_MISSING", f"manifest file points to a directory: {member}")
        file_paths.append(path)

    patch_member: str | None = None
    patch_paths: tuple[str, ...] = ()
    if result_type in {"patch", "hybrid_patch"}:
        raw_patch = manifest.get("patch")
        if not isinstance(raw_patch, str) or not raw_patch.strip():
            raise IntegrationError("RESULT_MANIFEST_INVALID", "patch/hybrid result requires manifest.patch")
        patch_member = raw_patch.strip()
        if patch_member != "changes.patch":
            raise IntegrationError("RESULT_MANIFEST_INVALID", "manifest.patch must be exactly changes.patch")
        try:
            patch_bytes = zf.read(patch_member)
        except KeyError as exc:
            raise IntegrationError("RESULT_PATCH_MISSING", "changes.patch is absent from ZIP") from exc
        try:
            patch_text = patch_bytes.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise IntegrationError("RESULT_PATCH_INVALID", "changes.patch must be UTF-8 text") from exc
        patch_paths = _parse_patch_paths(patch_text)
    elif manifest.get("patch") not in (None, ""):
        raise IntegrationError("RESULT_MANIFEST_INVALID", "files result must not declare a patch")

    if result_type == "patch" and file_paths:
        raise IntegrationError("RESULT_MANIFEST_INVALID", "patch result must not declare manifest.files")
    if result_type == "files" and not file_paths:
        raise IntegrationError("RESULT_MANIFEST_INVALID", "files result must declare at least one file")
    if result_type == "hybrid_patch" and not file_paths:
        raise IntegrationError("RESULT_MANIFEST_INVALID", "hybrid_patch requires at least one manifest file")

    overlap = set(file_paths).intersection(patch_paths)
    if overlap:
        raise IntegrationError(
            "RESULT_APPLICATION_AMBIGUOUS",
            "the same destination is modified by both patch and files payload",
            details={"paths": sorted(overlap)},
        )

    payload = tuple(dict.fromkeys((*patch_paths, *file_paths)))
    if payload and all(path == "diagnostics" or path.startswith("diagnostics/") for path in payload):
        diagnostics: dict[str, str] = {}
        for path in file_paths[:10]:
            try:
                diagnostics[path] = zf.read(f"files/{path}").decode("utf-8", errors="replace")[:4000]
            except Exception:
                diagnostics[path] = "<unreadable diagnostic>"
        raise IntegrationError(
            "RESULT_DIAGNOSTIC_ONLY",
            "RESULT_DURABLE contains only diagnostic/blocker payload and is not an implementation result",
            details={"diagnostics": diagnostics},
        )

    return ArtifactPlan(
        result_type=result_type,
        patch_member=patch_member,
        file_paths=tuple(file_paths),
        patch_paths=patch_paths,
    )


def _normalize_remote_repository(url: str) -> str | None:
    value = url.strip().replace("\\", "/")
    if value.startswith("git@github.com:"):
        value = value[len("git@github.com:") :]
    else:
        marker = "github.com/"
        index = value.lower().find(marker)
        if index < 0:
            return None
        value = value[index + len(marker) :]
    value = value.strip("/")
    if value.endswith(".git"):
        value = value[:-4]
    parts = value.split("/")
    if len(parts) < 2:
        return None
    return f"{parts[0]}/{parts[1]}"


def _path_overlap(left: str, right: str) -> bool:
    a = PurePosixPath(left)
    b = PurePosixPath(right)
    return a == b or a in b.parents or b in a.parents


def _transport_only(path: str) -> bool:
    return re.fullmatch(r"REQ_\d{8}T\d{6}Z_\d{4}\.md", path) is not None


def preflight_repo(
    repo_root: Path,
    result: DurableResult,
    plan: ArtifactPlan,
    *,
    origin_ref: str,
    fetch: bool,
    allow_main: bool,
) -> dict[str, Any]:
    if not repo_root.is_dir():
        raise IntegrationError("REPO_ROOT_MISSING", f"integration repo root does not exist: {repo_root}")

    top = Path(_run_git(repo_root, "rev-parse", "--show-toplevel").stdout.strip()).resolve()
    if top != repo_root.resolve():
        raise IntegrationError(
            "REPO_ROOT_MISMATCH",
            "--repo-root must be the root of the integration worktree",
            details={"expected": str(repo_root.resolve()), "actual": str(top)},
        )

    remote_url = _run_git(repo_root, "remote", "get-url", "origin").stdout.strip()
    actual_repository = _normalize_remote_repository(remote_url)
    if actual_repository != result.repository:
        raise IntegrationError(
            "REPO_REMOTE_MISMATCH",
            "integration worktree origin does not match result repository",
            details={"expected": result.repository, "actual": actual_repository, "remote": remote_url},
        )

    status = _run_git(repo_root, "status", "--porcelain", "--untracked-files=all").stdout
    if status.strip():
        raise IntegrationError(
            "INTEGRATION_WORKTREE_DIRTY",
            "integration must run in a clean task worktree",
            details={"status": status.splitlines()[:100]},
        )

    branch = _run_git(repo_root, "branch", "--show-current").stdout.strip()
    if not branch:
        raise IntegrationError("INTEGRATION_DETACHED_HEAD", "integration worktree must be on a task branch")
    if branch == "main" and not allow_main:
        raise IntegrationError("INTEGRATION_MAIN_FORBIDDEN", "implementation artifact must not be applied directly on main")

    if fetch:
        _run_git(repo_root, "fetch", "--quiet", "origin")

    base_exists = _run_git(repo_root, "cat-file", "-e", f"{result.base_commit}^{{commit}}", check=False)
    if base_exists.returncode != 0:
        raise IntegrationError(
            "BASE_COMMIT_MISSING",
            "result baseCommit does not exist in the integration repository",
            details={"baseCommit": result.base_commit},
        )

    origin_main = _run_git(repo_root, "rev-parse", origin_ref).stdout.strip().lower()
    if re.fullmatch(r"[0-9a-f]{40}", origin_main) is None:
        raise IntegrationError("ORIGIN_MAIN_INVALID", f"{origin_ref} did not resolve to a full commit SHA")

    # The validated artifact may be based on a transport publication commit which
    # is older than current origin/main, but it must remain in main's ancestry.
    ancestor = _run_git(repo_root, "merge-base", "--is-ancestor", result.base_commit, origin_ref, check=False)
    if ancestor.returncode != 0:
        raise IntegrationError(
            "BASE_COMMIT_DIVERGED",
            "result baseCommit is not an ancestor of current origin/main",
            details={"baseCommit": result.base_commit, "originMain": origin_main},
        )

    head = _run_git(repo_root, "rev-parse", "HEAD").stdout.strip().lower()
    if head != origin_main:
        raise IntegrationError(
            "INTEGRATION_HEAD_STALE",
            "task worktree HEAD must equal current origin/main before applying the result",
            details={"head": head, "originMain": origin_main},
        )

    advancement = _run_git(
        repo_root,
        "diff",
        "--name-only",
        "--no-renames",
        f"{result.base_commit}..{origin_ref}",
    ).stdout.splitlines()
    functional_advancement = [path for path in advancement if path and not _transport_only(path)]
    conflicts = sorted(
        {
            changed
            for changed in functional_advancement
            for payload in plan.payload_paths
            if _path_overlap(changed, payload)
        }
    )
    if conflicts:
        raise IntegrationError(
            "RESULT_BASE_STALE",
            "origin/main advanced functionally on paths touched by the implementation result",
            details={
                "baseCommit": result.base_commit,
                "originMain": origin_main,
                "conflictingPaths": conflicts,
                "payloadPaths": list(plan.payload_paths),
            },
        )

    return {
        "branch": branch,
        "head": head,
        "originMain": origin_main,
        "advancement": advancement,
        "functionalAdvancement": functional_advancement,
    }


def _copy_manifest_files(zf: zipfile.ZipFile, repo_root: Path, file_paths: Iterable[str]) -> None:
    for path in file_paths:
        destination = repo_root.joinpath(*PurePosixPath(path).parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        data = zf.read(f"files/{path}")
        # Exact-byte copy: do not decode/re-encode implementation payload.
        with destination.open("wb") as handle:
            handle.write(data)


def apply_artifact(zf: zipfile.ZipFile, repo_root: Path, plan: ArtifactPlan) -> list[str]:
    patch_path: Path | None = None
    with tempfile.TemporaryDirectory(prefix="postman-integrate-") as temp_name:
        temp_root = Path(temp_name)
        if plan.patch_member is not None:
            patch_path = temp_root / "changes.patch"
            patch_path.write_bytes(zf.read(plan.patch_member))
            _run_git(repo_root, "apply", "--check", str(patch_path))

        # All deterministic checks that can fail on artifact structure happened
        # before this point. Apply patch first, then exact manifest files.
        if patch_path is not None:
            _run_git(repo_root, "apply", str(patch_path))
        _copy_manifest_files(zf, repo_root, plan.file_paths)

    diff_check = _run_git(repo_root, "diff", "--check", check=False)
    if diff_check.returncode != 0:
        raise IntegrationError(
            "INTEGRATION_DIFF_CHECK_FAILED",
            "git diff --check failed after artifact application",
            details={"stdout": diff_check.stdout, "stderr": diff_check.stderr},
        )

    changed = set(
        path
        for path in _run_git(repo_root, "diff", "--name-only", "--no-renames").stdout.splitlines()
        if path
    )
    changed.update(
        path
        for path in _run_git(repo_root, "ls-files", "--others", "--exclude-standard").stdout.splitlines()
        if path
    )
    expected = set(plan.payload_paths)
    unexpected = sorted(path for path in changed if path not in expected)
    if unexpected:
        raise IntegrationError(
            "INTEGRATION_UNEXPECTED_PATHS",
            "artifact application changed paths outside the manifest/patch payload",
            details={"unexpectedPaths": unexpected, "expectedPaths": sorted(expected)},
        )
    if not changed:
        raise IntegrationError("RESULT_NO_CHANGES", "artifact application produced no repository changes")
    return sorted(changed)


def integrate(
    *,
    result_json: str,
    repo_root: Path,
    expected_repository: str = DEFAULT_REPOSITORY,
    origin_ref: str = DEFAULT_ORIGIN_REF,
    fetch: bool = True,
    allow_main: bool = False,
) -> dict[str, Any]:
    data = _load_result_json(result_json)
    result = validate_durable_result(data, expected_repository=expected_repository)

    try:
        with zipfile.ZipFile(result.result_zip, "r") as zf:
            manifest = _read_manifest(zf, result)
            plan = build_artifact_plan(zf, manifest)
            repo = preflight_repo(
                repo_root,
                result,
                plan,
                origin_ref=origin_ref,
                fetch=fetch,
                allow_main=allow_main,
            )
            changed = apply_artifact(zf, repo_root, plan)
    except zipfile.BadZipFile as exc:
        raise IntegrationError("RESULT_ZIP_INVALID", "durable artifact is not a valid ZIP") from exc

    return _json(
        True,
        READY_FOR_TEST,
        requestId=result.request_id,
        repository=result.repository,
        baseCommit=result.base_commit,
        originMain=repo["originMain"],
        branch=repo["branch"],
        artifactSha256=result.sha256,
        resultType=plan.result_type,
        changedFiles=changed,
        payloadPaths=list(plan.payload_paths),
        functionalAdvancement=repo["functionalAdvancement"],
        next="run task-scoped tests, then commit/push/PR according to REPO_POLICY.md",
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Apply one validated Direct Postman result deterministically")
    parser.add_argument("--result-json", required=True, help="Path to terminal RESULT_DURABLE JSON, or - for stdin")
    parser.add_argument("--repo-root", required=True, help="Clean task worktree rooted at current origin/main")
    parser.add_argument("--expected-repository", default=DEFAULT_REPOSITORY)
    parser.add_argument("--origin-ref", default=DEFAULT_ORIGIN_REF)
    parser.add_argument("--no-fetch", action="store_true", help="Skip git fetch origin (tests/offline diagnostics only)")
    parser.add_argument("--allow-main", action="store_true", help="Permit applying on main (tests only; normal production forbids this)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = integrate(
            result_json=args.result_json,
            repo_root=Path(args.repo_root).resolve(),
            expected_repository=args.expected_repository,
            origin_ref=args.origin_ref,
            fetch=not args.no_fetch,
            allow_main=args.allow_main,
        )
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except IntegrationError as exc:
        print(
            json.dumps(
                _json(False, exc.code, error=str(exc), details=exc.details),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 2
    except Exception as exc:  # pragma: no cover - last-resort CLI boundary
        print(
            json.dumps(
                _json(False, "INTEGRATION_INTERNAL_ERROR", error=str(exc)),
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
