#!/usr/bin/env python3
"""Explicit, temporary GitHub publication of selected Postman input files."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
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
        raise InputStageError("symlink path cannot be published")
    if any(part.lower() in _SENSITIVE or part.lower().endswith((".key", ".pem", ".p12", ".log"))
           for part in source.resolve(strict=True).parts):
        raise InputStageError("sensitive/runtime path cannot be published")
    data = source.read_bytes()
    if not data:
        raise InputStageError("empty input file")
    return source.name, data


class GitHubInputPublisher:
    def __init__(self, api=None):
        self.api = api or self._api

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
        data = base64.b64decode(response["content"], validate=False)
        name = Path(path).name
        return normalize_input_files([dict(name=name, repository=REPOSITORY, commit=commit, path=path,
            sha256=hashlib.sha256(data).hexdigest(), byte_length=len(data),
            raw_url=f"https://raw.githubusercontent.com/{REPOSITORY}/{commit}/{quote(path, safe='/')}")])[0]

    def stage(self, paths):
        if not paths or len(paths) > 20:
            raise InputStageError("select 1-20 exact files")
        selected = [selected_file(path) for path in paths]
        bundle = uuid4().hex
        entries = []
        records = []
        for index, (name, data) in enumerate(selected, 1):
            dest = f"tmp/{bundle}/{index:02d}-{name}"
            blob = self.api(f"repos/{REPOSITORY}/git/blobs", "POST", {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"})["sha"]
            entries.append({"path": dest, "mode": "100644", "type": "blob", "sha": blob})
            records.append((name, dest, data))
        parent = self._head()
        commit = self._commit(parent, entries, "postman: stage input " + bundle)
        if not _SHA.fullmatch(commit):
            raise InputStageError("publication did not return immutable commit")
        descriptors = []
        for name, path, data in records:
            descriptors.append(dict(name=name, repository=REPOSITORY, commit=commit, path=path,
                                    raw_url=f"https://raw.githubusercontent.com/{REPOSITORY}/{commit}/{quote(path, safe='/')}",
                                    sha256=hashlib.sha256(data).hexdigest(), byte_length=len(data)))
        return {"bundle_id": bundle, "descriptors": normalize_input_files(descriptors)}

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
    group.add_argument("--cleanup")
    group.add_argument("--existing", nargs=2, metavar=("COMMIT", "PATH"))
    args = parser.parse_args(argv)
    try:
        publisher = GitHubInputPublisher()
        result = publisher.stage(args.stage) if args.stage else publisher.cleanup(args.cleanup) if args.cleanup else publisher.existing(*args.existing)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (InputStageError, KeyError, OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
