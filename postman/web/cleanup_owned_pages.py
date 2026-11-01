"""Close recorded Postman pages whose transport has exited; never close Chrome."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


def owner_is_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            # Access denied and unknown failures are not evidence of death.
            return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER
        try:
            code = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True


def cleanup_owned_pages(browser, root: Path, *, apply=False, is_alive=owner_is_alive):
    targets = {}
    for context in browser.contexts:
        for page in context.pages:
            session = None
            try:
                session = context.new_cdp_session(page)
                info = session.send("Target.getTargetInfo")["targetInfo"]
                targets[info["targetId"]] = (page, info.get("browserContextId"))
            except Exception:
                continue
            finally:
                if session is not None:
                    try:
                        session.detach()
                    except Exception:
                        pass
    result = {"eligible": [], "closed": [], "failed": []}
    # Existing ownership proofs, not a new history/index or a recurring scan.
    paths = list((root / "workers").glob("*.json"))
    paths.extend((root / "devspace").glob("*/web/workers/*.json"))
    for path in paths:
        try:
            state = json.loads(path.read_text(encoding="utf-8-sig"))
            proof = state.get("pageDiagnostic") or {}
            target = proof.get("pageId")
            pid = proof.get("pid")
            if target not in targets or type(pid) is not int or pid <= 0:
                continue
            page, context_id = targets[target]
            # A target ID alone is insufficient across browser restarts.
            if not proof.get("contextId") or proof["contextId"] != context_id or is_alive(pid):
                continue
            result["eligible"].append(target)
            if apply:
                try:
                    page.close()
                    result["closed"].append(target)
                    targets.pop(target)
                except Exception:
                    result["failed"].append(target)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(os.environ.get("LOCALAPPDATA", Path.home())) / "DSH/Postman")
    parser.add_argument("--cdp-url", default="http://127.0.0.1:9222")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    from browser_bootstrap import normalize_cdp_url, wait_for_cdp
    endpoint = normalize_cdp_url(args.cdp_url)
    try:
        wait_for_cdp(endpoint, timeout_s=1)
    except Exception:
        print(json.dumps({"skipped": "browser_unavailable"}))
        return
    import cdp_download
    from playwright.sync_api import sync_playwright
    with cdp_download.temporary_artifacts_dir() as artifacts:
        with cdp_download.locked_playwright(sync_playwright) as playwright:
            browser = cdp_download.connect_over_cdp(playwright, endpoint, artifacts_dir=artifacts)
            result = cleanup_owned_pages(browser, args.root, apply=args.apply)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
