#!/usr/bin/env python3
"""Host-only request ZIP construction and strict Direct handoff verification."""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import sys
import zipfile

try:
    from postman.task_package import normalize_input_files
    from postman.input_files import MAX_INPUT_BYTES, MAX_AGGREGATE_BYTES
except ModuleNotFoundError:
    from task_package import normalize_input_files
    from input_files import MAX_INPUT_BYTES, MAX_AGGREGATE_BYTES

MAX_ZIP_BYTES = 50 * 1024 * 1024
MAX_METADATA_BYTES = 128 * 1024
MANIFEST = "POSTMAN_INPUT_MANIFEST.json"
_REQ = re.compile(r"^REQ_\d{8}T\d{6}Z_\d{4}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")


class InputBundleError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(suffix):
    raise InputBundleError("POSTMAN_INPUT_" + suffix)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def descriptor_digest(descriptors):
    return digest(canonical(descriptors))


def regular_bytes(path, maximum, code):
    path = Path(path)
    try:
        if not path.is_absolute() or path.is_symlink() or any(p.is_symlink() for p in path.parents):
            fail(code)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode):
            fail(code)
        if info.st_size > maximum:
            fail("BUNDLE_LIMIT_EXCEEDED")
        with path.open("rb") as handle:
            data = handle.read(maximum + 1)
        if len(data) > maximum:
            fail("BUNDLE_LIMIT_EXCEEDED")
        return data
    except OSError:
        fail(code)


def strict_json(data, code):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail(code)
            result[key] = value
        return result
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs)
    except (UnicodeError, ValueError) as exc:
        if isinstance(exc, InputBundleError):
            raise
        fail(code)


def safe_name(name):
    # Independent of descriptor validation; no hierarchy, drives, controls or traversal.
    value = re.sub(r"[^A-Za-z0-9._-]", "_", str(name))
    while ".." in value:
        value = value.replace("..", "_")
    value = value.strip("._-") or "input"
    if len(value) > 100:
        extension = Path(value).suffix[:16]
        value = value[:100 - len(extension)] + extension
    return value


def manifest_for(request_id, descriptors):
    if not isinstance(request_id, str) or not _REQ.fullmatch(request_id):
        fail("BUNDLE_INVALID")
    if not 1 <= len(descriptors) <= 20:
        fail("BUNDLE_LIMIT_EXCEEDED")
    if any(d["byte_length"] > MAX_INPUT_BYTES for d in descriptors) or sum(d["byte_length"] for d in descriptors) > MAX_AGGREGATE_BYTES:
        fail("BUNDLE_LIMIT_EXCEEDED")
    files = []
    for index, item in enumerate(descriptors, 1):
        files.append(dict(index=index, archive_path=f"files/{index:03d}-{safe_name(item['name'])}",
                          **{key: item[key] for key in ("name", "sha256", "byte_length", "repository", "commit", "path")}))
    return dict(protocol_version=1, request_id=request_id, file_count=len(files), files=files)


def verify_zip(data, request_id, descriptors):
    if not data or len(data) > MAX_ZIP_BYTES:
        fail("BUNDLE_LIMIT_EXCEEDED")
    expected = manifest_for(request_id, descriptors)
    inventory = [MANIFEST] + [f["archive_path"] for f in expected["files"]]
    try:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            infos = archive.infolist()
            names = [i.filename for i in infos]
            # Exact generated inventory already rules out duplicate/unsafe names.
            if names != inventory:
                fail("BUNDLE_INVALID")
            if any(item.is_dir() or stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1 for item in infos):
                fail("BUNDLE_INVALID")
            if infos[0].file_size > MAX_METADATA_BYTES:
                fail("BUNDLE_INVALID")
            manifest = strict_json(archive.read(MANIFEST), "BUNDLE_INVALID")
            # Exact types too: bool is not an integer in the protocol.
            if canonical(manifest) != canonical(expected):
                fail("BUNDLE_CONTENT_MISMATCH")
            for entry, info in zip(expected["files"], infos[1:]):
                if info.file_size != entry["byte_length"] or info.file_size > MAX_INPUT_BYTES:
                    fail("BUNDLE_CONTENT_MISMATCH")
                content = archive.read(info)
                if len(content) != entry["byte_length"] or digest(content) != entry["sha256"]:
                    fail("BUNDLE_CONTENT_MISMATCH")
    except (zipfile.BadZipFile, RuntimeError, OSError, KeyError, NotImplementedError, EOFError):
        fail("BUNDLE_INVALID")
    return expected


@dataclass(frozen=True)
class InputAttachment:
    request_id: str
    path: Path = field(repr=False)
    name: str
    sha256: str
    byte_length: int
    input_count: int
    descriptor_set_digest: str

    def metadata(self):
        return dict(requestId=self.request_id, displayName=self.name, bundleSha256=self.sha256,
                    bundleByteLength=self.byte_length, inputCount=self.input_count,
                    descriptorSetDigest=self.descriptor_set_digest)

    def upload_bytes(self):
        data = regular_bytes(self.path, MAX_ZIP_BYTES, "BUNDLE_HANDOFF_INVALID")
        if len(data) != self.byte_length or digest(data) != self.sha256:
            fail("BUNDLE_CONTENT_MISMATCH")
        return data


def read_handoff(path, request_id, descriptors):
    descriptors = normalize_input_files(descriptors)
    if not path or not descriptors:
        fail("BUNDLE_HANDOFF_INVALID")
    value = strict_json(regular_bytes(path, MAX_METADATA_BYTES, "BUNDLE_HANDOFF_INVALID"), "BUNDLE_HANDOFF_INVALID")
    if (not isinstance(value, dict) or set(value) != {"version", "request_id", "attachment", "input_count", "descriptor_set_digest"}
            or type(value["version"]) is not int or value["version"] != 1 or value["request_id"] != request_id
            or type(value["input_count"]) is not int or value["input_count"] != len(descriptors)
            or value["descriptor_set_digest"] != descriptor_digest(descriptors)):
        fail("BUNDLE_HANDOFF_INVALID")
    item = value["attachment"]
    name = f"POSTMAN_INPUT_{request_id}.zip"
    if (not isinstance(item, dict) or set(item) != {"path", "name", "sha256", "byte_length"}
            or not isinstance(item["path"], str) or item["name"] != name
            or not isinstance(item["sha256"], str) or not _SHA.fullmatch(item["sha256"])
            or type(item["byte_length"]) is not int or not 0 < item["byte_length"] <= MAX_ZIP_BYTES):
        fail("BUNDLE_HANDOFF_INVALID")
    bundle = Path(item["path"])
    if bundle.name != name or bundle.parent != Path(path).parent:
        fail("BUNDLE_HANDOFF_INVALID")
    attachment = InputAttachment(request_id, bundle, name, item["sha256"], item["byte_length"],
                                 len(descriptors), value["descriptor_set_digest"])
    # The Host verified ZIP contents once at build; outer hash binds those bytes.
    attachment.upload_bytes()
    return attachment


def build_bundle(request_id, descriptors, materializations, directory):
    try:
        descriptors = normalize_input_files(descriptors)
        manifest = manifest_for(request_id, descriptors)
        if len(materializations) != len(descriptors):
            fail("MATERIALIZATION_MISSING")
        contents = []
        for descriptor, snapshot in zip(descriptors, materializations):
            data = regular_bytes(snapshot["snapshot_path"], MAX_INPUT_BYTES, "MATERIALIZATION_MISSING")
            if (snapshot["sha256"] != descriptor["sha256"] or snapshot["byte_length"] != descriptor["byte_length"]
                    or len(data) != descriptor["byte_length"] or digest(data) != descriptor["sha256"]):
                fail("MATERIALIZATION_MISMATCH")
            contents.append(data)
        directory = Path(directory)
        bundle = directory / f"POSTMAN_INPUT_{request_id}.zip"
        with zipfile.ZipFile(bundle, "x", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in [(MANIFEST, canonical(manifest))] + list(zip([f["archive_path"] for f in manifest["files"]], contents)):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o600) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, content)
        # Writer is closed; independent disk read + decompression prove actual archive bytes.
        data = regular_bytes(bundle, MAX_ZIP_BYTES, "BUNDLE_INVALID")
        verify_zip(data, request_id, descriptors)
        handoff = dict(version=1, request_id=request_id, input_count=len(descriptors),
                       descriptor_set_digest=descriptor_digest(descriptors),
                       attachment=dict(path=str(bundle), name=bundle.name, sha256=digest(data), byte_length=len(data)))
        handoff_path = directory / "input-handoff.json"
        with handoff_path.open("xb") as handle:
            handle.write(canonical(handoff))
        attachment = InputAttachment(request_id, bundle, bundle.name, handoff["attachment"]["sha256"], len(data),
                                     len(descriptors), handoff["descriptor_set_digest"])
        return {"handoffPath": str(handoff_path), **attachment.metadata()}
    except InputBundleError:
        raise
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile):
        fail("BUNDLE_BUILD_FAILED")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", required=True)
    args = parser.parse_args()
    try:
        spec = strict_json(regular_bytes(args.build, MAX_METADATA_BYTES, "BUNDLE_HANDOFF_INVALID"), "BUNDLE_HANDOFF_INVALID")
        result = build_bundle(spec["request_id"], spec["descriptors"], spec["materializations"], Path(args.build).parent)
        print(json.dumps(result))
        return 0
    except (InputBundleError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
