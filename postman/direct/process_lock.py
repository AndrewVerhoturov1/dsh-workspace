"""Small cross-process locks for shared Postman browser resources."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import time


def claim_request(direct_root, request_id):
    """Reserve a new REQ atomically across both Direct modes; never resend after a crash."""
    import request_identity
    request_identity.assert_canonical_request_id(request_id)
    path = Path(direct_root) / "locks" / f"request-{request_id}.claim"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb"):
        pass


if os.name == "nt":
    import msvcrt
else:
    import fcntl


class ResourceBusyError(RuntimeError):
    pass


class ChatBusyError(ResourceBusyError):
    pass


@contextmanager
def exclusive_lock(path: str | os.PathLike[str], *, timeout_s: float = 0.0, busy_error=ResourceBusyError):
    """Lock one persistent byte; never unlink a lock file (waiters may hold it)."""
    lock_path = Path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        if lock_path.stat().st_size == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + timeout_s
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except (OSError, BlockingIOError) as exc:
                if time.monotonic() >= deadline:
                    raise busy_error(f"resource already locked: {lock_path}") from exc
                time.sleep(0.05)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def lock_publication(direct_root, repository, branch):
    """Serialize the short GitHub snapshot/commit window, not Web requests."""
    key = hashlib.sha256(f"{repository}/{branch}".encode("utf-8")).hexdigest()
    with exclusive_lock(Path(direct_root) / "locks" / f"publish-{key}.lock", timeout_s=90.0):
        yield


@contextmanager
def lock_chat(direct_root, chat_request_id, repository):
    """Reject simultaneous sends to the same proven conversation, including REQ aliases."""
    if chat_request_id is None:
        yield
        return
    import chat_reference
    reference = chat_reference.resolve_chat_reference(
        direct_root, chat_request_id, expected_repository=repository,
    )
    identity = hashlib.sha256(reference.conversation_url.encode("utf-8")).hexdigest()
    with exclusive_lock(Path(direct_root) / "locks" / f"chat-{identity}.lock", busy_error=ChatBusyError):
        yield
