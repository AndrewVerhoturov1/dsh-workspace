#!/usr/bin/env python3
"""One bounded standard-library ZIP reader/extractor; no repository semantics."""
from __future__ import annotations
import argparse
import hashlib
import json
import ntpath
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import zipfile

DEFAULT_LIMITS = dict(maxCompressedBytes=50*1024*1024, maxTotalUncompressedBytes=200*1024*1024,
                      maxEntryUncompressedBytes=64*1024*1024, maxEntries=2000)

class SafeZipError(ValueError):
    def __init__(self, code, reason):
        self.code, self.reason = code, reason
        super().__init__(reason)

def reject(code, reason):
    raise SafeZipError('ARTIFACT_' + code, reason)

def regular_path(path):
    path = Path(path).absolute()
    for part in [path, *path.parents]:
        if part.is_symlink() or getattr(part, 'is_junction', lambda: False)():
            reject('PATH_INVALID', 'symlink_or_junction')
    return path

def entry_name(name):
    if not name or '\x00' in name:
        reject('BAD_ZIP', 'empty_or_nul_name')
    if name.startswith(('//', '\\\\')):
        reject('UNC_PATH', 'unc')
    if ntpath.splitdrive(name)[0]:
        reject('WINDOWS_DRIVE_PATH', 'drive')
    if name.startswith(('/', '\\')):
        reject('ABSOLUTE_PATH', 'absolute')
    normalized = name.replace('\\', '/')
    parts = normalized.rstrip('/').split('/')
    if '..' in parts:
        reject('PATH_TRAVERSAL', 'dotdot')
    if any(p in ('', '.') for p in parts):
        reject('PATH_INVALID', 'invalid_segment')
    for part in parts:
        if ':' in part:
            reject('NTFS_ADS', 'ads')
        if part.endswith(('.', ' ')) or re.search(r'[<>"|?*\x00-\x1f\x7f]', part):
            reject('PATH_INVALID', 'windows_name')
        if re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I):
            reject('WINDOWS_RESERVED_NAME', 'reserved_name')
    return normalized

def read_archive(source, *, limits=None, consume=None, require_nonempty=True):
    limits = {**DEFAULT_LIMITS, **(limits or {})}
    if any(type(limits[k]) is not int or limits[k] <= 0 for k in DEFAULT_LIMITS):
        raise ValueError('ZIP limits must be positive integers')
    source = regular_path(source)
    if not source.is_file():
        reject('NOT_FOUND', 'not_regular_file')
    if source.stat().st_size > limits['maxCompressedBytes']:
        reject('COMPRESSED_SIZE_LIMIT', 'compressed_size')
    sha = hashlib.sha256()
    with source.open('rb') as raw:
        for block in iter(lambda: raw.read(1024*1024), b''):
            sha.update(block)
        raw.seek(0)
        inventory, names, folded, total = [], set(), set(), 0
        try:
            with zipfile.ZipFile(raw) as archive:
                entries = archive.infolist()
                if not entries or require_nonempty and not any(not i.is_dir() for i in entries):
                    reject('EMPTY', 'no_file_entries')
                if len(entries) > limits['maxEntries']:
                    reject('ENTRY_LIMIT', 'entries')
                for info in entries:
                    name = entry_name(info.filename)
                    if name in names:
                        reject('DUPLICATE_PATH', 'duplicate')
                    if name.casefold() in folded:
                        reject('CASE_COLLISION', 'case_collision')
                    names.add(name); folded.add(name.casefold())
                    mode = info.external_attr >> 16
                    if stat.S_ISLNK(mode):
                        reject('SYMLINK', 'symlink')
                    if info.external_attr & 0x400:
                        reject('REPARSE_ENTRY', 'reparse')
                    if info.flag_bits & 1:
                        reject('BAD_ZIP', 'encrypted')
                    if info.file_size > limits['maxEntryUncompressedBytes'] or total + info.file_size > limits['maxTotalUncompressedBytes']:
                        reject('UNCOMPRESSED_SIZE_LIMIT', 'uncompressed_size')
                    count = 0
                    with archive.open(info) as member:
                        def blocks():
                            nonlocal total, count
                            while True:
                                block = member.read(1024*1024)
                                if not block:
                                    break
                                total += len(block); count += len(block)
                                if total > limits['maxTotalUncompressedBytes'] or count > limits['maxEntryUncompressedBytes']:
                                    reject('UNCOMPRESSED_SIZE_LIMIT', 'actual_uncompressed_bytes')
                                yield block
                        stream = blocks()
                        if consume is None:
                            for _ in stream: pass
                        else:
                            consume(name, info.is_dir(), stream)
                    if count != info.file_size:
                        reject('BAD_ZIP', 'entry_size_mismatch')
                    inventory.append(dict(path=name, kind='directory' if info.is_dir() else 'file',
                                          compressedSize=info.compress_size, uncompressedSize=count))
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError, EOFError) as exc:
            reject('BAD_ZIP', str(exc)[:300])
    return dict(sha256=sha.hexdigest(), inventory=inventory)

def unpack(source, destination, *, limits=None):
    destination = regular_path(destination)
    if destination.exists():
        reject('PATH_INVALID', 'destination_exists')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.postman-unpack-', dir=destination.parent))
    try:
        def consume(name, directory, blocks):
            target = temporary.joinpath(*name.rstrip('/').split('/'))
            if directory:
                target.mkdir(parents=True, exist_ok=True)
                for _ in blocks: pass
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as handle:
                    for block in blocks: handle.write(block)
        result = read_archive(source, limits=limits, consume=consume)
        if destination.exists():
            reject('PATH_INVALID', 'destination_appeared')
        os.rename(temporary, destination)
        return {**result, 'destination': str(destination)}
    finally:
        if temporary.exists(): shutil.rmtree(temporary)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('source'); p.add_argument('--limits'); p.add_argument('--destination')
    args = p.parse_args()
    try:
        limits = json.loads(args.limits) if args.limits else None
        value = unpack(args.source, args.destination, limits=limits) if args.destination else read_archive(args.source, limits=limits)
        print(json.dumps(dict(ok=True, code='ARTIFACT_VALID', **value)))
        return 0
    except (SafeZipError, ValueError, OSError) as exc:
        print(json.dumps(dict(ok=False, code=getattr(exc, 'code', 'ARTIFACT_BAD_ZIP'), details={'reason': str(exc)})))
        return 3

if __name__ == '__main__':
    raise SystemExit(main())
