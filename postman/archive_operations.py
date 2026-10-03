#!/usr/bin/env python3
"""Bounded Host file location and selected ZIP operations; never uploads files."""
import argparse
import difflib
import json
import os
from pathlib import Path
import tempfile
import zipfile
from input_files import selected_file, MAX_AGGREGATE_BYTES, _SENSITIVE
from safe_zip import regular_path, read_archive, unpack, entry_name

def safe_selected(path):
    if not path or not Path(path).is_absolute(): raise ValueError("explicit_absolute_path_required")
    result = regular_path(path).resolve()
    if any(p.lower() in _SENSITIVE or p.lower().endswith(('.key','.pem','.p12','.log')) for p in result.parts):
        raise ValueError('sensitive_path_rejected')
    return result

def locate(name, roots):
    if not isinstance(name, str) or not name.strip() or len(name) > 180 or Path(name).name != name or '/' in name or '\\' in name:
        raise ValueError('filename_required')
    candidates, examined, capped = [], 0, False
    for root in roots:
        root = safe_selected(root)
        if not root.is_dir(): continue
        stack = [(root, 0)]
        while stack and examined < 2000:
            directory, depth = stack.pop()
            try:
                with os.scandir(directory) as entries:
                    for item in entries:
                        if examined >= 2000: capped = True; break
                        examined += 1
                        if item.name.lower() in _SENSITIVE or item.name.lower().endswith(('.key','.pem','.p12','.log')) or item.is_symlink(): continue
                        path = Path(item.path)
                        if getattr(path, 'is_junction', lambda: False)(): continue
                        if item.is_dir(follow_symlinks=False) and depth < 3:
                            stack.append((path, depth + 1))
                        elif item.is_file(follow_symlinks=False):
                            exact = item.name.casefold() == name.casefold()
                            if exact or difflib.SequenceMatcher(None, item.name.casefold(), name.casefold()).ratio() >= .85:
                                info = item.stat(follow_symlinks=False)
                                candidates.append(dict(path=str(path), name=item.name, bytes=info.st_size, modified=info.st_mtime, exact=exact))
                                if len(candidates) >= 50: capped = True; break
            except OSError: continue
            if capped: break
        if examined >= 2000: capped = True
        if capped: break
    exact = [item for item in candidates if item['exact']]
    matches = exact or candidates
    return dict(status='POSTMAN_INPUT_LOCATED' if len(matches) == 1 and not capped else 'POSTMAN_INPUT_SELECTION_REQUIRED',
                candidates=matches, examined=examined, capped=capped)

def pack(paths, destination):
    if not 1 <= len(paths) <= 20: raise ValueError('selected_file_count')
    destination = safe_selected(destination)
    if destination.exists(): raise ValueError('destination_exists')
    contents, total, names = [], 0, set()
    for path in paths:
        name, data = selected_file(str(safe_selected(path)))
        entry_name(name)
        if name.casefold() in names: raise ValueError('duplicate_selected_filename')
        names.add(name.casefold()); total += len(data)
        if total > MAX_AGGREGATE_BYTES: raise ValueError('selected_bytes_limit')
        contents.append((name, data))
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.postman-pack-', dir=destination.parent)
    os.close(fd)
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in contents: archive.writestr(name, data)
        result = read_archive(temporary, limits={'maxCompressedBytes':150*1024*1024,'maxEntryUncompressedBytes':48*1024*1024})
        with destination.open('xb') as output, open(temporary, 'rb') as source:
            import shutil
            shutil.copyfileobj(source, output)
        return dict(status='POSTMAN_ARCHIVE_PACKED', path=str(destination), **result)
    finally:
        Path(temporary).unlink(missing_ok=True)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['locate','pack','list','unpack'])
    p.add_argument('--name'); p.add_argument('--roots', nargs='*', default=[])
    p.add_argument('--paths', nargs='*', default=[]); p.add_argument('--source'); p.add_argument('--destination')
    a = p.parse_args()
    try:
        if a.action == 'locate': result = locate(a.name, a.roots)
        elif a.action == 'pack': result = pack(a.paths, a.destination)
        elif a.action == 'list': result = dict(status='POSTMAN_ARCHIVE_LISTED', **read_archive(safe_selected(a.source)))
        else: result = dict(status='POSTMAN_ARCHIVE_UNPACKED', **unpack(safe_selected(a.source), safe_selected(a.destination)))
        print(json.dumps(result, ensure_ascii=False)); return 0
    except (ValueError, OSError) as exc:
        print(json.dumps(dict(status='POSTMAN_ARCHIVE_REJECTED', reason=str(exc)))); return 1

if __name__ == '__main__': raise SystemExit(main())
