#!/usr/bin/env python3
"""Central deterministic runner for declarative implementation packages.

The runner intentionally does very little:
- verifies that it is in the expected repository and a temporary clean worktree;
- validates/extracts a package made of manifest.json + a unified patch;
- asks Git whether the patch applies;
- rejects a small set of protected local-data paths;
- applies the patch;
- runs only the targeted argv-safe tests declared by the package;
- records git diff --check as a warning, not as a hard gate;
- creates a compact diagnostics ZIP on every hard failure.

It does NOT create branches, commit, push, open PRs, run LLMs, compare exact file
inventories, enforce package-base SHA equality, or run an automatic full regression.
Those responsibilities belong to the surrounding repository workflow.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

SCHEMA_VERSION = 1
PROTECTED_BRANCHES = {"main", "preview"}
PROTECTED_ROOT_NAMES = {"settings.yaml", ".env"}
PROTECTED_ROOT_PREFIXES = {"attachments"}
DIAGNOSTIC_PREFIX = "implementation-package-diagnostics"


@dataclass
class CommandResult:
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str


@dataclass
class RunState:
    package_name: str = "unknown-package"
    stage: str = "startup"
    failing_stdout: str = ""
    failing_stderr: str = ""
    log: list[str] = field(default_factory=list)
    warnings: list[dict[str, str]] = field(default_factory=list)

    def note(self, message: str) -> None:
        self.log.append(message)


class RunnerFailure(RuntimeError):
    def __init__(
        self,
        code: str,
        stage: str,
        message: str,
        *,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.message = message
        self.stdout = stdout
        self.stderr = stderr


def utc_stamp() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def windows_creationflags() -> int:
    if os.name != "nt":
        return 0
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0))


def secret_values() -> list[str]:
    values: list[str] = []
    sensitive = re.compile(r"(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY)", re.I)
    for key, value in os.environ.items():
        if sensitive.search(key) and isinstance(value, str) and len(value) >= 8:
            values.append(value)
    return sorted(set(values), key=len, reverse=True)


def redact(text: str) -> str:
    result = text
    for value in secret_values():
        result = result.replace(value, "<REDACTED_ENV_SECRET>")
    result = re.sub(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b", "<REDACTED_GITHUB_TOKEN>", result)
    result = re.sub(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", "<REDACTED_GITHUB_TOKEN>", result)
    result = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+\-/=]{16,}", "Bearer <REDACTED>", result)
    return result


def run_command(
    argv: Sequence[str],
    *,
    cwd: Path,
    timeout: int | None = None,
    env: dict[str, str] | None = None,
) -> CommandResult:
    args = [str(item) for item in argv]
    try:
        completed = subprocess.run(
            args,
            cwd=str(cwd),
            env=env,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=windows_creationflags(),
        )
        return CommandResult(
            argv=args,
            returncode=completed.returncode,
            stdout=redact(completed.stdout),
            stderr=redact(completed.stderr),
        )
    except FileNotFoundError as error:
        return CommandResult(args, 127, "", redact(str(error)))
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout if isinstance(error.stdout, str) else ""
        stderr = error.stderr if isinstance(error.stderr, str) else ""
        return CommandResult(args, 124, redact(stdout), redact(stderr + f"\nTimed out after {timeout}s"))


def require_success(result: CommandResult, *, code: str, stage: str, message: str) -> CommandResult:
    if result.returncode != 0:
        raise RunnerFailure(
            code,
            stage,
            message,
            stdout=result.stdout,
            stderr=result.stderr,
        )
    return result


def git(repo: Path, args: Sequence[str], *, timeout: int = 120, env: dict[str, str] | None = None) -> CommandResult:
    return run_command(["git", *args], cwd=repo, timeout=timeout, env=env)


def discover_repo(path: Path) -> Path:
    result = run_command(["git", "rev-parse", "--show-toplevel"], cwd=path, timeout=30)
    require_success(
        result,
        code="NOT_A_GIT_REPOSITORY",
        stage="repository",
        message="The selected path is not inside a Git repository.",
    )
    return Path(result.stdout.strip()).resolve()


def current_branch(repo: Path) -> str:
    result = git(repo, ["branch", "--show-current"])
    require_success(result, code="GIT_BRANCH_UNAVAILABLE", stage="repository", message="Cannot read current branch.")
    return result.stdout.strip()


def clean_status(repo: Path) -> str:
    result = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])
    require_success(result, code="GIT_STATUS_FAILED", stage="repository", message="Cannot read git status.")
    return result.stdout


def normalize_github_repository(remote: str) -> str | None:
    value = remote.strip().replace("\\", "/")
    patterns = [
        r"^https?://github\.com/([^/]+/[^/]+?)(?:\.git)?/?$",
        r"^git@github\.com:([^/]+/[^/]+?)(?:\.git)?$",
        r"^ssh://git@github\.com/([^/]+/[^/]+?)(?:\.git)?/?$",
    ]
    for pattern in patterns:
        match = re.match(pattern, value, flags=re.I)
        if match:
            return match.group(1)
    return None


def repository_identity(repo: Path) -> str | None:
    result = git(repo, ["remote", "get-url", "origin"])
    if result.returncode != 0:
        return None
    return normalize_github_repository(result.stdout)


def is_permanent_worktree(repo: Path) -> bool:
    home = Path.home().resolve()
    candidates = [(home / ".dsh").resolve(), (home / ".dsh-preview").resolve()]
    normalized = os.path.normcase(str(repo.resolve()))
    return any(normalized == os.path.normcase(str(candidate)) for candidate in candidates)


def safe_member_path(name: str) -> PurePosixPath:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or any(part in {"", ".."} for part in path.parts):
        raise RunnerFailure("UNSAFE_PACKAGE_PATH", "package", f"Unsafe ZIP entry: {name!r}")
    if re.match(r"^[A-Za-z]:", normalized):
        raise RunnerFailure("UNSAFE_PACKAGE_PATH", "package", f"Unsafe ZIP entry: {name!r}")
    return path


def extract_zip_safely(archive: Path, destination: Path) -> None:
    try:
        with zipfile.ZipFile(archive, "r") as zf:
            for info in zf.infolist():
                path = safe_member_path(info.filename)
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise RunnerFailure("PACKAGE_SYMLINK_REJECTED", "package", f"ZIP symlink is not allowed: {info.filename}")
                target = destination.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    with zf.open(info, "r") as source, target.open("wb") as sink:
                        shutil.copyfileobj(source, sink)
    except zipfile.BadZipFile as error:
        raise RunnerFailure("PACKAGE_ZIP_INVALID", "package", f"Invalid ZIP: {error}") from error


def locate_package_root(extracted: Path) -> Path:
    direct = extracted / "manifest.json"
    if direct.is_file():
        return extracted
    candidates = [path.parent for path in extracted.rglob("manifest.json")]
    unique = sorted({path.resolve() for path in candidates})
    if len(unique) != 1:
        raise RunnerFailure(
            "PACKAGE_MANIFEST_NOT_UNIQUE",
            "package",
            "Package must contain exactly one manifest.json at its root or inside one top-level directory.",
        )
    return unique[0]


def resolve_inside(root: Path, relative: str, *, code: str, stage: str) -> Path:
    posix = safe_member_path(relative)
    target = root.joinpath(*posix.parts).resolve()
    root_resolved = root.resolve()
    try:
        target.relative_to(root_resolved)
    except ValueError as error:
        raise RunnerFailure(code, stage, f"Path escapes package/repository root: {relative}") from error
    return target


def load_manifest(package_root: Path) -> dict[str, Any]:
    path = package_root / "manifest.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RunnerFailure("MANIFEST_INVALID", "package", f"Cannot read manifest.json: {error}") from error
    if not isinstance(manifest, dict):
        raise RunnerFailure("MANIFEST_INVALID", "package", "manifest.json must be a JSON object.")
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise RunnerFailure(
            "MANIFEST_SCHEMA_UNSUPPORTED",
            "package",
            f"schemaVersion must be {SCHEMA_VERSION}.",
        )
    package = manifest.get("package")
    repository = manifest.get("repository")
    patch = manifest.get("patch", "changes.patch")
    tests = manifest.get("tests", [])
    if not isinstance(package, str) or not package.strip():
        raise RunnerFailure("MANIFEST_INVALID", "package", "manifest.package must be a non-empty string.")
    if not isinstance(repository, str) or "/" not in repository:
        raise RunnerFailure("MANIFEST_INVALID", "package", "manifest.repository must be owner/repository.")
    if not isinstance(patch, str) or not patch.strip():
        raise RunnerFailure("MANIFEST_INVALID", "package", "manifest.patch must be a non-empty relative path.")
    if not isinstance(tests, list):
        raise RunnerFailure("MANIFEST_INVALID", "package", "manifest.tests must be an array.")
    for index, test in enumerate(tests):
        if not isinstance(test, dict):
            raise RunnerFailure("MANIFEST_INVALID", "package", f"tests[{index}] must be an object.")
        if not isinstance(test.get("name"), str) or not test["name"].strip():
            raise RunnerFailure("MANIFEST_INVALID", "package", f"tests[{index}].name must be non-empty.")
        command = test.get("command")
        if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
            raise RunnerFailure("MANIFEST_INVALID", "package", f"tests[{index}].command must be a non-empty argv array.")
        cwd = test.get("cwd", ".")
        if not isinstance(cwd, str):
            raise RunnerFailure("MANIFEST_INVALID", "package", f"tests[{index}].cwd must be a string.")
        timeout = test.get("timeoutSeconds", 600)
        if not isinstance(timeout, int) or timeout <= 0 or timeout > 3600:
            raise RunnerFailure("MANIFEST_INVALID", "package", f"tests[{index}].timeoutSeconds must be 1..3600.")
    return manifest


def parse_name_status_z(data: bytes) -> list[str]:
    tokens = data.split(b"\0")
    if tokens and tokens[-1] == b"":
        tokens.pop()
    paths: list[str] = []
    index = 0
    while index < len(tokens):
        status = tokens[index].decode("utf-8", "replace")
        index += 1
        if index >= len(tokens):
            break
        first = tokens[index].decode("utf-8", "surrogateescape")
        index += 1
        if status.startswith("R") or status.startswith("C"):
            if index >= len(tokens):
                break
            second = tokens[index].decode("utf-8", "surrogateescape")
            index += 1
            paths.extend([first, second])
        else:
            paths.append(first)
    return paths


def affected_paths(repo: Path, patch: Path) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="impl-package-index-") as temp_dir:
        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = str(Path(temp_dir) / "index")
        read_tree = git(repo, ["read-tree", "HEAD"], env=env)
        require_success(
            read_tree,
            code="PATCH_INDEX_PREPARE_FAILED",
            stage="patch-check",
            message="Cannot prepare temporary Git index for patch inspection.",
        )
        apply_index = git(repo, ["apply", "--cached", "--whitespace=nowarn", str(patch)], env=env)
        require_success(
            apply_index,
            code="PATCH_NOT_APPLICABLE",
            stage="patch-check",
            message="Git cannot apply the patch to the current worktree base.",
        )
        diff = subprocess.run(
            ["git", "diff", "--cached", "--name-status", "-z", "HEAD"],
            cwd=str(repo),
            env=env,
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
            creationflags=windows_creationflags(),
        )
        if diff.returncode != 0:
            raise RunnerFailure(
                "PATCH_PATH_INSPECTION_FAILED",
                "patch-check",
                "Cannot inspect paths affected by the patch.",
                stderr=redact(diff.stderr.decode("utf-8", "replace")),
            )
        return sorted(set(parse_name_status_z(diff.stdout)))


def is_protected_repo_path(raw: str) -> bool:
    normalized = raw.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    path = PurePosixPath(normalized)
    if path.is_absolute() or any(part == ".." for part in path.parts):
        return True
    if not path.parts:
        return True
    if path.parts[0] == ".git":
        return True
    if len(path.parts) == 1 and path.name in PROTECTED_ROOT_NAMES:
        return True
    if path.parts[0] in PROTECTED_ROOT_PREFIXES:
        return True
    return False


def validate_repository(repo: Path, manifest: dict[str, Any], state: RunState) -> None:
    state.stage = "repository"
    branch = current_branch(repo)
    state.note(f"branch={branch or '<detached>'}")
    if branch in PROTECTED_BRANCHES:
        raise RunnerFailure(
            "PROTECTED_BRANCH",
            "repository",
            f"Refusing to apply an implementation package directly on protected branch {branch!r}.",
        )
    if is_permanent_worktree(repo):
        raise RunnerFailure(
            "PERMANENT_WORKTREE",
            "repository",
            "Refusing to modify the permanent main/preview worktree.",
        )
    status = clean_status(repo)
    if status.strip():
        raise RunnerFailure(
            "WORKTREE_NOT_CLEAN",
            "repository",
            "Implementation worktree must be clean before applying a package.",
            stdout=status,
        )
    actual_repository = repository_identity(repo)
    expected_repository = manifest["repository"]
    if actual_repository is None:
        raise RunnerFailure(
            "REPOSITORY_IDENTITY_UNAVAILABLE",
            "repository",
            "Cannot resolve origin to a GitHub owner/repository identity.",
        )
    if actual_repository.lower() != expected_repository.lower():
        raise RunnerFailure(
            "REPOSITORY_MISMATCH",
            "repository",
            f"Package targets {expected_repository}, but origin is {actual_repository}.",
        )


def validate_patch(repo: Path, package_root: Path, manifest: dict[str, Any], state: RunState) -> Path:
    state.stage = "patch-check"
    patch = resolve_inside(package_root, manifest.get("patch", "changes.patch"), code="PATCH_PATH_INVALID", stage="package")
    if not patch.is_file():
        raise RunnerFailure("PATCH_MISSING", "package", f"Patch file not found: {manifest.get('patch', 'changes.patch')}")
    check = git(repo, ["apply", "--check", "--whitespace=nowarn", str(patch)])
    require_success(
        check,
        code="PATCH_NOT_APPLICABLE",
        stage="patch-check",
        message="Git reports that the patch does not apply cleanly to the current worktree.",
    )
    paths = affected_paths(repo, patch)
    protected = [path for path in paths if is_protected_repo_path(path)]
    if protected:
        raise RunnerFailure(
            "PROTECTED_PATH",
            "patch-check",
            "Patch touches protected local-data paths: " + ", ".join(protected),
        )
    state.note("affected_paths=" + json.dumps(paths, ensure_ascii=False))
    return patch


def apply_patch(repo: Path, patch: Path, state: RunState) -> None:
    state.stage = "apply"
    result = git(repo, ["apply", "--whitespace=nowarn", str(patch)])
    require_success(
        result,
        code="PATCH_APPLY_FAILED",
        stage="apply",
        message="git apply failed after a successful applicability check.",
    )
    state.note("patch_applied=true")


def run_declared_tests(repo: Path, manifest: dict[str, Any], state: RunState) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for test in manifest.get("tests", []):
        name = test["name"]
        state.stage = f"test:{name}"
        cwd = resolve_inside(repo, test.get("cwd", "."), code="TEST_CWD_INVALID", stage=state.stage)
        if not cwd.exists() or not cwd.is_dir():
            raise RunnerFailure("TEST_CWD_MISSING", state.stage, f"Test cwd does not exist: {test.get('cwd', '.')}")
        result = run_command(test["command"], cwd=cwd, timeout=test.get("timeoutSeconds", 600))
        results.append(
            {
                "name": name,
                "command": test["command"],
                "returncode": result.returncode,
            }
        )
        if result.returncode != 0:
            raise RunnerFailure(
                "TARGETED_TEST_FAILED",
                state.stage,
                f"Targeted test failed: {name}",
                stdout=result.stdout,
                stderr=result.stderr,
            )
        state.note(f"test_passed={name}")
    return results


def collect_git_text(repo: Path, args: Sequence[str]) -> str:
    result = git(repo, args, timeout=60)
    text = result.stdout
    if result.stderr:
        if text and not text.endswith("\n"):
            text += "\n"
        text += result.stderr
    if result.returncode != 0:
        text += f"\n[command exit code: {result.returncode}]\n"
    return redact(text)


def make_diagnostics_zip(
    repo: Path | None,
    state: RunState,
    failure: RunnerFailure,
    diagnostics_dir: Path,
) -> Path:
    diagnostics_dir.mkdir(parents=True, exist_ok=True)
    final_path = diagnostics_dir / f"{DIAGNOSTIC_PREFIX}-{utc_stamp()}.zip"
    payload = {
        "ok": False,
        "code": failure.code,
        "stage": failure.stage,
        "message": redact(failure.message),
        "package": state.package_name,
        "createdAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    status = diff_stat = diff_check = "repository unavailable\n"
    if repo is not None and repo.exists():
        status = collect_git_text(repo, ["status", "--short", "--branch", "--untracked-files=all"])
        diff_stat = collect_git_text(repo, ["diff", "--stat"])
        diff_check = collect_git_text(repo, ["diff", "--check"])
    with zipfile.ZipFile(final_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("failure.json", json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        zf.writestr("stdout.txt", redact(failure.stdout or state.failing_stdout))
        zf.writestr("stderr.txt", redact(failure.stderr or state.failing_stderr))
        zf.writestr("git-status.txt", status)
        zf.writestr("git-diff-stat.txt", diff_stat)
        zf.writestr("git-diff-check.txt", diff_check)
        zf.writestr("runner-log.txt", "\n".join(redact(line) for line in state.log) + ("\n" if state.log else ""))
    return final_path


def diff_check_warning(repo: Path, state: RunState) -> None:
    state.stage = "diff-check"
    result = git(repo, ["diff", "--check"])
    if result.returncode != 0:
        text = (result.stdout + result.stderr).strip()
        state.warnings.append({"code": "GIT_DIFF_CHECK_WARNING", "message": text or "git diff --check reported a warning"})
        state.note("git_diff_check=warning")
    else:
        state.note("git_diff_check=pass")


def prepare_package(package_path: Path, temp_dir: Path) -> tuple[Path, dict[str, Any]]:
    if package_path.is_dir():
        package_root = package_path.resolve()
    elif package_path.is_file() and package_path.suffix.lower() == ".zip":
        extracted = temp_dir / "package"
        extracted.mkdir(parents=True, exist_ok=True)
        extract_zip_safely(package_path, extracted)
        package_root = locate_package_root(extracted)
    else:
        raise RunnerFailure("PACKAGE_NOT_FOUND", "package", f"Package path must be a directory or ZIP: {package_path}")
    manifest = load_manifest(package_root)
    return package_root, manifest


def execute(mode: str, package_path: Path, repo_arg: Path, diagnostics_dir: Path) -> dict[str, Any]:
    state = RunState()
    repo: Path | None = None
    try:
        repo = discover_repo(repo_arg.resolve())
        with tempfile.TemporaryDirectory(prefix="implementation-package-") as temp:
            package_root, manifest = prepare_package(package_path.resolve(), Path(temp))
            state.package_name = manifest["package"]
            state.note(f"package={state.package_name}")
            validate_repository(repo, manifest, state)
            patch = validate_patch(repo, package_root, manifest, state)
            if mode == "check":
                return {
                    "ok": True,
                    "code": "IMPLEMENTATION_PACKAGE_CHECKED",
                    "package": state.package_name,
                    "repository": str(repo),
                    "warnings": state.warnings,
                }
            apply_patch(repo, patch, state)
            diff_check_warning(repo, state)
            tests = run_declared_tests(repo, manifest, state)
            state.stage = "complete"
            status = collect_git_text(repo, ["status", "--short", "--untracked-files=all"])
            return {
                "ok": True,
                "code": "IMPLEMENTATION_PACKAGE_APPLIED",
                "package": state.package_name,
                "repository": str(repo),
                "tests": tests,
                "warnings": state.warnings,
                "gitStatus": status,
            }
    except RunnerFailure as failure:
        state.stage = failure.stage
        state.failing_stdout = failure.stdout
        state.failing_stderr = failure.stderr
        diagnostics = make_diagnostics_zip(repo, state, failure, diagnostics_dir)
        return {
            "ok": False,
            "code": failure.code,
            "stage": failure.stage,
            "message": failure.message,
            "diagnosticsZip": str(diagnostics),
        }
    except Exception as error:  # last-resort compact diagnostic, not a silent crash
        failure = RunnerFailure("RUNNER_INTERNAL_ERROR", state.stage, f"{type(error).__name__}: {error}")
        diagnostics = make_diagnostics_zip(repo, state, failure, diagnostics_dir)
        return {
            "ok": False,
            "code": failure.code,
            "stage": failure.stage,
            "message": failure.message,
            "diagnosticsZip": str(diagnostics),
        }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Apply a declarative implementation package in a temporary clean worktree.")
    parser.add_argument("mode", choices=["check", "apply"], help="check does not modify the repo; apply performs the patch and targeted tests")
    parser.add_argument("package", type=Path, help="implementation package ZIP or directory")
    parser.add_argument("--repo", type=Path, default=Path.cwd(), help="repository/worktree path (default: current directory)")
    parser.add_argument(
        "--diagnostics-dir",
        type=Path,
        default=Path(tempfile.gettempdir()) / "dsh-implementation-diagnostics",
        help="where compact failure ZIPs are written",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = execute(args.mode, args.package, args.repo, args.diagnostics_dir)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
