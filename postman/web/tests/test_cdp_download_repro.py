"""Opt-in five-cycle local Chrome CDP regression; never touches ChatGPT/live profile.
Run: DSH_POSTMAN_CDP_REPRO=1 python -m unittest discover -s postman/web/tests -p test_cdp_download_repro.py
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request
import zipfile

WEB_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB_DIR))
import artifact_download
import cdp_download


@unittest.skipUnless(os.environ.get("DSH_POSTMAN_CDP_REPRO") == "1", "isolated Chrome reproduction is opt-in")
class CdpDownloadReproduction(unittest.TestCase):
    def test_five_attach_detach_download_cycles(self):
        from playwright.sync_api import sync_playwright
        from browser_bootstrap import discover_chrome_executable
        buffer = BytesIO()
        with zipfile.ZipFile(buffer, "w") as z:
            z.writestr("result.txt", "CDP regression\n" * 4096)
        payload = buffer.getvalue()
        sha = hashlib.sha256(payload).hexdigest()
        filename = "POSTMAN_REQ_20261001T175853Z_9264_RESULT.zip"
        parallel_started = threading.Barrier(4)
        transfer_times = {}
        class Handler(BaseHTTPRequestHandler):
            def handle(self):
                try:
                    super().handle()
                except ConnectionResetError:
                    pass  # Chrome may cancel its unused keep-alive connection.
            def do_GET(self):
                if self.path.startswith("/parallel/"):
                    token = self.path.rsplit("/",1)[1]
                    name = "POSTMAN_REQ_20261003T000000Z_000" + token + "_RESULT.zip"
                    self.send_response(200)
                    self.send_header("Content-Type","application/zip")
                    self.send_header("Content-Disposition", 'attachment; filename="' + name + '"')
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    transfer_times[token] = {"start":time.monotonic()}
                    self.wfile.write(payload[:20000]); self.wfile.flush()
                    parallel_started.wait(timeout=15)
                    for start in range(20000,len(payload),2048):
                        self.wfile.write(payload[start:start+2048]); self.wfile.flush(); time.sleep(.025)
                    transfer_times[token]["end"] = time.monotonic()
                elif self.path == "/download":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Disposition", 'attachment; filename="' + filename + '"')
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(('<a href="/download">' + filename + '</a>').encode())
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        chrome = None
        workspace = tempfile.TemporaryDirectory(prefix="postman-cdp-repro-")
        try:
            temp = workspace.name
            root = Path(temp)
            native = root / "native-downloads"
            native.mkdir()
            profile = root / "profile"
            (profile / "Default").mkdir(parents=True)
            (profile / "Default" / "Preferences").write_text(json.dumps({"download": {
                "default_directory": str(native), "prompt_for_download": False}}), encoding="utf-8")
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            endpoint = "http://127.0.0.1:" + str(port)
            chrome = subprocess.Popen([str(discover_chrome_executable()), "--headless=new",
                "--remote-debugging-port=" + str(port), "--remote-debugging-address=127.0.0.1",
                "--user-data-dir=" + str(profile), "--no-first-run", "--no-default-browser-check",
                "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 20
            while True:
                try:
                    with urllib.request.urlopen(endpoint + "/json/version", timeout=1): pass
                    break
                except Exception:
                    if time.monotonic() >= deadline: raise
                    time.sleep(0.1)
            with patch.dict(os.environ, {"LOCALAPPDATA": temp}):
                artifacts = root / "artifacts-a"
                artifacts.mkdir()
                with cdp_download.locked_playwright(sync_playwright) as pw:
                    browser = cdp_download.connect_over_cdp(pw, endpoint, artifacts_dir=artifacts)
                    page = browser.contexts[0].new_page()
                    events = []
                    page.on("download", lambda d: events.append(d))
                    rows = []
                    for cycle in range(5):
                        # An independent process connects and disconnects AFTER A's attach.
                        child = "from playwright.sync_api import sync_playwright; import cdp_download; " + \
                            "m=cdp_download.locked_playwright(sync_playwright); p=m.__enter__(); " + \
                            "cdp_download.connect_over_cdp(p, '" + endpoint + "'); m.__exit__(None,None,None)"
                        completed = subprocess.run([sys.executable, "-c", child],
                            env=dict(os.environ, PYTHONPATH=str(WEB_DIR)), capture_output=True, text=True, timeout=20)
                        self.assertEqual(completed.returncode, 0, completed.stderr)
                        page.goto("http://127.0.0.1:" + str(server.server_port))
                        req = "REQ_20261001T175853Z_9264"
                        proof = {"ok": True, "code": "ARTIFACT_DOM_CONFIRMED", "details": {
                            "requestId": req, "expectedFilename": filename, "chatUrl": page.url,
                            "assistantIndex": 1, "assistantTextSha256": "b" * 64,
                            "turnSelector": "a", "attachment": {"path": "0"}, "downloadStarted": False}}
                        results = root / ("results-" + str(cycle))
                        with patch.object(artifact_download.detector, "detect_artifact_dom", return_value=proof), \
                             patch.object(artifact_download, "_resolve_control", return_value=page.locator("a")):
                            result = artifact_download.download_validated_artifact(page,
                                expected_prompt="local fixture", expected_chat_url=page.url, request_id=req,
                                expected_filename=filename, completed_observer_result={}, artifact_dom_result=proof,
                                expected_request={"requestId": req, "repository": "AndrewVerhoturov1/dsh-workspace",
                                    "baseCommit": "a" * 40, "expectedFilename": filename,
                                    "allowedPaths": ["docs"], "forbiddenPaths": []},
                                result_root=results, cdp_artifacts_dir=artifacts)
                        self.assertEqual(result["code"], "RESULT_DURABLE", result)
                        self.assertEqual(len(events), cycle + 1)
                        source = Path(events[-1].path())
                        durable = results / req / "result.zip"
                        self.assertEqual(source.read_bytes(), payload)
                        self.assertEqual(durable.read_bytes(), payload)
                        self.assertEqual(result["details"]["sha256"], sha)
                        self.assertEqual(list(native.iterdir()), [])
                        rows.append({"cycle": cycle + 1, "sourceSize": source.stat().st_size,
                            "resultSize": durable.stat().st_size, "sha256": sha, "nativeFiles": 0, "events": 1})
                    print("CDP_REPRO " + json.dumps(rows))
                    page.close()
            from concurrent.futures import ThreadPoolExecutor
            def capture(token):
                name = "POSTMAN_REQ_20261003T000000Z_000" + token + "_RESULT.zip"
                with cdp_download.locked_playwright(sync_playwright) as pw:
                    browser = cdp_download.connect_over_cdp(pw, endpoint)
                    page = browser.contexts[0].new_page()
                    try:
                        page.goto("http://127.0.0.1:" + str(server.server_port))
                        page.locator('a').evaluate('(e,path)=>{e.href=path;e.textContent=path}', '/parallel/' + token)
                        target = root / name
                        with cdp_download.download_behavior(page,None):
                            result = artifact_download._capture_download(page,page.locator('a'),target,name,30000,3000)
                        self.assertTrue(result['ok'],result)
                        self.assertEqual(target.read_bytes(),payload)
                        self.assertEqual(result['details']['sha256'],sha)
                        return {"requestId":"REQ_20261003T000000Z_000"+token,"filename":name,
                                "sha256":sha,"clicks":1,"bytes":target.stat().st_size}
                    finally: page.close()
            with ThreadPoolExecutor(max_workers=4) as workers:
                parallel = list(workers.map(capture,['1','2','3','4']))
            overlap = min(t['end'] for t in transfer_times.values()) - max(t['start'] for t in transfer_times.values())
            self.assertGreater(overlap,.5)
            self.assertEqual(list(native.iterdir()),[])
            print('CDP_PARALLEL ' + json.dumps({"overlapSeconds":overlap,"downloads":parallel}))
        finally:
            if chrome is not None:
                chrome.terminate()
                chrome.wait(timeout=10)
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            workspace.cleanup()


if __name__ == "__main__":
    unittest.main()
