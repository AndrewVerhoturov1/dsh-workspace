#!/usr/bin/env python3
"""Private selected inputs; GitHub is an existing source or explicit public fallback only."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import stat
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import quote
from uuid import uuid4

try:
    from postman.task_package import normalize_input_files
except ModuleNotFoundError:
    from task_package import normalize_input_files

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_AGGREGATE_BYTES = 48 * 1024 * 1024

REPOSITORY = "AndrewVerhoturov1/dsh-workspace"
BRANCH = "transport/postman-inputs"
_SHA = re.compile(r"^[0-9a-f]{40}$")
_BUNDLE = re.compile(r"^[0-9a-f]{32}$")
_SENSITIVE = {"settings.yaml", ".credentials.yaml", "codex-oauth.json", ".env", ".ssh", "id_rsa", "id_ed25519", "credentials", "secrets", "sessions", "storages", "logs", "diagnostics", "profiles", "browser-state", ".git", "node_modules"}


class InputStageError(ValueError):
    pass


def selected_file(path: str) -> tuple[str, bytes]:
    source = Path(path)
    if not source.is_absolute() or source.is_symlink() or not source.is_file():
        raise InputStageError("select an absolute regular file, not a directory or symlink")
    if any(parent.is_symlink() for parent in source.parents):
        raise InputStageError("symlink path cannot be staged")
    if any(part.lower() in _SENSITIVE or part.lower().endswith((".key", ".pem", ".p12", ".log"))
           for part in source.resolve(strict=True).parts):
        raise InputStageError("sensitive/runtime path cannot be staged")
    # One bounded read: hashing, publication and private snapshot use these same bytes.
    with source.open("rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise InputStageError("select a regular file")
        data = handle.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise InputStageError("POSTMAN_INPUT_BUNDLE_LIMIT_EXCEEDED")
    if not data:
        raise InputStageError("empty input file")
    return source.name, data


def input_media_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


class GitHubInputPublisher:
    def __init__(self, api=None, snapshot_dir=None):
        self.api = api or self._api
        # Only Host supplies this private directory; never returned in a descriptor.
        self.snapshot_dir = Path(snapshot_dir) if snapshot_dir is not None else None
        self.materializations = []

    def _materialize(self, sha256, data):
        if self.snapshot_dir is None:  # manual descriptor-only diagnostics
            return
        path = self.snapshot_dir / f"{len(self.materializations) + 1:03d}.bin"
        with path.open("xb") as handle:
            os.chmod(path, 0o600)
            handle.write(data)
        self.materializations.append(dict(snapshot_path=str(path), sha256=sha256, byte_length=len(data)))

    @staticmethod
    def _api(endpoint, method="GET", payload=None):
        command = ["gh", "api", endpoint, "--method", method]
        if payload is not None:
            command += ["--input", "-"]
        done = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                              capture_output=True, text=True, encoding="utf-8", check=False)
        if done.returncode:
            raise InputStageError("GitHub API failed: " + done.stderr[-1200:])
        return json.loads(done.stdout)

    def _head(self):
        try:
            result = self.api(f"repos/{REPOSITORY}/git/ref/heads/{quote(BRANCH, safe='')}")
            return result["object"]["sha"]
        except InputStageError as exc:
            # Only a missing ref may be created; never replace an existing branch.
            if "404" not in str(exc):
                raise
            return None

    def _commit(self, parent, entries, message):
        tree_request = {"tree": entries}
        if parent is not None:
            base = self.api(f"repos/{REPOSITORY}/git/commits/{parent}")["tree"]["sha"]
            if base != "4b825dc642cb6eb9a060e54bf8d69288fbee4904":
                tree_request["base_tree"] = base
        tree = self.api(f"repos/{REPOSITORY}/git/trees", "POST", tree_request)["sha"]
        commit = self.api(f"repos/{REPOSITORY}/git/commits", "POST", {"message": message, "tree": tree, "parents": [parent] if parent else []})["sha"]
        if parent is None:
            self.api(f"repos/{REPOSITORY}/git/refs", "POST", {"ref": "refs/heads/" + BRANCH, "sha": commit})
        else:
            self.api(f"repos/{REPOSITORY}/git/refs/heads/{quote(BRANCH, safe='')}", "PATCH", {"sha": commit, "force": False})
        return commit

    def existing(self, commit, path):
        if not _SHA.fullmatch(commit) or not path or path.startswith("/") or any(part in {"", ".", ".."} for part in path.split("/")) or "\\" in path or ":" in path:
            raise InputStageError("existing file requires exact commit and safe repository-relative path")
        response = self.api(f"repos/{REPOSITORY}/contents/{quote(path, safe='/')}?ref={commit}")
        if response.get("type") != "file" or response.get("encoding") != "base64":
            raise InputStageError("GitHub file unavailable")
        if response.get("size", 0) > MAX_INPUT_BYTES or len(response["content"]) > 24 * 1024 * 1024:
            raise InputStageError("POSTMAN_INPUT_BUNDLE_LIMIT_EXCEEDED")
        data = base64.b64decode("".join(response["content"].split()), validate=True)
        if len(data) > MAX_INPUT_BYTES:
            raise InputStageError("POSTMAN_INPUT_BUNDLE_LIMIT_EXCEEDED")
        if "size" in response and response["size"] != len(data):
            raise InputStageError("POSTMAN_INPUT_MATERIALIZATION_MISMATCH")
        name = Path(path).name
        descriptor = normalize_input_files([dict(source_kind="github", media_type=input_media_type(data), name=name, repository=REPOSITORY, commit=commit, path=path,
            sha256=hashlib.sha256(data).hexdigest(), byte_length=len(data),
            raw_url=f"https://raw.githubusercontent.com/{REPOSITORY}/{commit}/{quote(path, safe='/')}")])[0]
        self._materialize(descriptor["sha256"], data)
        return descriptor

    def stage(self, paths):
        if self.snapshot_dir is None:
            raise InputStageError("POSTMAN_INPUT_MATERIALIZATION_MISSING")
        if not paths or len(paths) > 20:
            raise InputStageError("select 1-20 exact files")
        selected, total = [], 0
        for path in paths:
            name, data = selected_file(path)
            total += len(data)
            if total > MAX_AGGREGATE_BYTES:
                raise InputStageError("POSTMAN_INPUT_BUNDLE_LIMIT_EXCEEDED")
            selected.append((name, data))
        descriptors = []
        for name, data in selected:
            sha = hashlib.sha256(data).hexdigest()
            descriptor = normalize_input_files([dict(source_kind="native", name=name,
                sha256=sha, byte_length=len(data), media_type=input_media_type(data))])[0]
            self._materialize(sha, data)
            descriptors.append(descriptor)
        return dict(bundle_id=uuid4().hex, descriptors=descriptors)

    def stage_public_fallback(self, paths, *, public_fallback_confirmed=False):
        if public_fallback_confirmed is not True:
            raise InputStageError("POSTMAN_INPUT_PUBLIC_APPROVAL_REQUIRED")
        if not paths or len(paths) > 20:
            raise InputStageError("select 1-20 exact files")
        selected, total = [], 0
        for path in paths:
            item = selected_file(path)
            total += len(item[1])
            if total > MAX_AGGREGATE_BYTES:
                raise InputStageError("POSTMAN_INPUT_BUNDLE_LIMIT_EXCEEDED")
            selected.append((*item, hashlib.sha256(item[1]).hexdigest()))
        # Snapshot the selected buffers before any GitHub operation; no pathname reread.
        for _, data, sha256 in selected:
            self._materialize(sha256, data)
        bundle = uuid4().hex
        entries = []
        records = []
        for index, (name, data, sha256) in enumerate(selected, 1):
            dest = f"tmp/{bundle}/{index:02d}-{name}"
            blob = self.api(f"repos/{REPOSITORY}/git/blobs", "POST", {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})["sha"]
            entries.append({"path": dest, "mode": "100644", "type": "blob", "sha": blob})
            records.append((name, dest, sha256, len(data)))
        parent = self._head()
        commit = self._commit(parent, entries, "postman: stage input " + bundle)
        if not _SHA.fullmatch(commit):
            raise InputStageError("publication did not return immutable commit")
        descriptors = []
        for name, path, sha256, byte_length in records:
            descriptors.append(dict(name=name, repository=REPOSITORY, commit=commit, path=path,
                                    raw_url=f"https://raw.githubusercontent.com/{REPOSITORY}/{commit}/{quote(path, safe='/')}",
                                    sha256=sha256, byte_length=byte_length))
        descriptors = normalize_input_files(descriptors)
        return {"bundle_id": bundle, "descriptors": descriptors}

    def cleanup(self, bundle):
        if not _BUNDLE.fullmatch(bundle):
            raise InputStageError("invalid bundle id")
        parent = self._head()
        if parent is None:
            return {"bundle_id": bundle, "removed": 0}
        current_tree = self.api(f"repos/{REPOSITORY}/git/commits/{parent}")["tree"]["sha"]
        if current_tree == "4b825dc642cb6eb9a060e54bf8d69288fbee4904":
            return {"bundle_id": bundle, "removed": 0}
        listing = self.api(f"repos/{REPOSITORY}/git/trees/{parent}?recursive=1")
        if listing.get("truncated"):
            raise InputStageError("transport tree listing truncated; cleanup refused")
        tree = listing["tree"]
        prefix = "tmp/" + bundle + "/"
        paths = [item["path"] for item in tree if item.get("type") == "blob" and item.get("path", "").startswith(prefix)]
        if not paths:
            return {"bundle_id": bundle, "removed": 0}
        remaining = [item for item in tree if item.get("type") == "blob" and item["path"] not in paths]
        entries = [{"path": item["path"], "mode": item["mode"], "type": "blob", "sha": item["sha"]} for item in remaining]
        if not entries:
            # GitHub rejects deletion of the last nested tree entry; the empty Git tree is canonical.
            tree_sha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
        else:
            tree_sha = self.api(f"repos/{REPOSITORY}/git/trees", "POST", {"tree": entries})["sha"]
        commit = self.api(f"repos/{REPOSITORY}/git/commits", "POST",
                          {"message": "postman: cleanup input " + bundle, "tree": tree_sha, "parents": [parent]})["sha"]
        self.api(f"repos/{REPOSITORY}/git/refs/heads/{quote(BRANCH, safe='')}", "PATCH", {"sha": commit, "force": False})
        return {"bundle_id": bundle, "removed": len(paths)}


def main(argv=None):
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--stage", nargs="+")
    group.add_argument("--stage-public-fallback", nargs="+")
    group.add_argument("--cleanup-public-fallback")
    parser.add_argument("--public-fallback-confirmed", action="store_true")
    group.add_argument("--existing", nargs=2, metavar=("COMMIT", "PATH"))
    parser.add_argument("--snapshot-dir", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        publisher = GitHubInputPublisher(snapshot_dir=args.snapshot_dir)
        if args.stage:
            result = publisher.stage(args.stage)
        elif args.stage_public_fallback:
            result = publisher.stage_public_fallback(args.stage_public_fallback,
                public_fallback_confirmed=args.public_fallback_confirmed)
        elif args.cleanup_public_fallback:
            result = publisher.cleanup(args.cleanup_public_fallback)
        else:
            result = publisher.existing(*args.existing)
        if args.snapshot_dir:
            result = {**result, "materializations": publisher.materializations} if args.stage or args.stage_public_fallback else {
                "descriptors": [result], "materializations": publisher.materializations}
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (InputStageError, KeyError, OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
