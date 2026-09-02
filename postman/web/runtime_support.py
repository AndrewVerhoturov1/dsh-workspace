#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
from typing import Mapping

RESULT_ROOT_ENV = "DSH_POSTMAN_RESULT_ROOT"


def default_result_root(env: Mapping[str, str] | None = None) -> Path:
    source = os.environ if env is None else env
    configured = source.get(RESULT_ROOT_ENV)
    if isinstance(configured, str) and configured.strip():
        return Path(configured.strip())
    local_app_data = source.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError(
            f"{RESULT_ROOT_ENV} or LOCALAPPDATA is required for the Postman result store"
        )
    return Path(local_app_data) / "DSH" / "Postman" / "results"


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


def prepare_result_root(path: str | os.PathLike[str]) -> Path:
    root = Path(path)
    root.mkdir(parents=True, exist_ok=True)
    if _is_link_or_junction(root):
        raise RuntimeError("Postman result root must not be a symlink/junction")
    fd = None
    probe_name = None
    try:
        fd, probe_name = tempfile.mkstemp(
            prefix=".postman-write-probe-", suffix=".tmp", dir=str(root)
        )
        os.write(fd, b"POSTMAN_RESULT_ROOT_OK")
        os.fsync(fd)
    finally:
        if fd is not None:
            os.close(fd)
        if probe_name is not None:
            try:
                Path(probe_name).unlink()
            except FileNotFoundError:
                pass
    return root


def quiet_subprocess_kwargs() -> dict[str, int]:
    if os.name != "nt":
        return {}
    flag = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return {"creationflags": flag} if flag else {}
