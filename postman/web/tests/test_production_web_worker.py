from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "production_web_worker.py"
spec = importlib.util.spec_from_file_location("production_web_worker", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)

REQ = "REQ_20260902T010203Z_0042"
SHA = "0123456789abcdef0123456789abcdef01234567"
TASK_URL = f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{SHA}/{REQ}.md"


class ProductionWebWorkerTests(unittest.TestCase):
    def test_pinned_url_and_prompt_keep_user_task_external_and_transport_metadata_explicit(self):
        repository, sha = module.parse_pinned_task_url(TASK_URL, REQ)
        self.assertEqual(repository, "AndrewVerhoturov1/dsh-workspace")
        self.assertEqual(sha, SHA)
        prompt = module.build_external_prompt(
            request_id=REQ,
            task_url=TASK_URL,
            repository=repository,
            base_commit=sha,
            expected_filename=f"POSTMAN_{REQ}_RESULT.zip",
        )
        self.assertEqual(prompt.splitlines()[0], f"POSTMAN_REQUEST_ID: {REQ}")
        self.assertIn(f"task_file: {TASK_URL}", prompt)
        self.assertIn(f"base_commit: {SHA}", prompt)
        self.assertNotIn("древне-япон", prompt)

    def test_trusted_scope_comes_only_from_tracked_top_level_paths(self):
        class Completed:
            returncode = 0
            stdout = "plugins/a.js\0postman/web/a.py\0settings.yaml\0attachments/x.bin\0REQ_20260901T000000Z_0001.md\0README.md\0"
            stderr = ""

        allowed = module.discover_trusted_scope(Path("C:/repo"), runner=lambda *args, **kwargs: Completed())
        self.assertEqual(allowed, ["README.md", "plugins", "postman"])

    def test_ensure_browser_reuses_existing_cdp_without_launch(self):
        class BootstrapError(RuntimeError):
            pass

        class Bootstrap:
            BrowserBootstrapError = BootstrapError
            BOOTSTRAP_CHROME_NOT_FOUND = "BOOTSTRAP_CHROME_NOT_FOUND"
            DEFAULT_REMOTE_DEBUGGING_PORT = 9222
            calls = []

            @classmethod
            def wait_for_cdp(cls, url, timeout_s):
                cls.calls.append(("wait", timeout_s))
                return {"ok": True}

            @staticmethod
            def discover_chrome_executable(explicit=None):
                raise AssertionError("must not discover Chrome when CDP is already ready")

        result = module.ensure_dedicated_chrome(bootstrap_module=Bootstrap)
        self.assertTrue(result["reused"])
        self.assertIsNone(result["launchedPid"])

    def test_ensure_browser_launches_dedicated_profile_when_cdp_is_absent(self):
        class BootstrapError(RuntimeError):
            pass

        class Process:
            pid = 1234

        class Bootstrap:
            BrowserBootstrapError = BootstrapError
            BOOTSTRAP_CHROME_NOT_FOUND = "BOOTSTRAP_CHROME_NOT_FOUND"
            DEFAULT_REMOTE_DEBUGGING_PORT = 9222
            calls = 0

            @classmethod
            def wait_for_cdp(cls, url, timeout_s):
                cls.calls += 1
                if cls.calls == 1:
                    raise BootstrapError("offline")
                return {"ok": True}

            @staticmethod
            def discover_chrome_executable(explicit=None):
                return Path("C:/Chrome/chrome.exe")

            @staticmethod
            def default_profile_dir():
                return Path("C:/Local/DSH/Postman/browser-profile")

            @staticmethod
            def start_dedicated_chrome(executable, profile_dir, port):
                self.assertEqual(str(profile_dir).replace("\\", "/"), "C:/Local/DSH/Postman/browser-profile")
                self.assertEqual(port, 9222)
                return Process()

        result = module.ensure_dedicated_chrome(bootstrap_module=Bootstrap)
        self.assertFalse(result["reused"])
        self.assertEqual(result["launchedPid"], 1234)


    def test_browser_smoke_seam_stops_before_external_prompt(self):
        class Completed:
            returncode = 0
            stdout = "plugins/a.js\0postman/web/a.py\0"
            stderr = ""

        class BootstrapError(RuntimeError):
            pass

        class Bootstrap:
            BrowserBootstrapError = BootstrapError
            BOOTSTRAP_CHROME_NOT_FOUND = "BOOTSTRAP_CHROME_NOT_FOUND"
            DEFAULT_REMOTE_DEBUGGING_PORT = 9222
            @staticmethod
            def wait_for_cdp(url, timeout_s):
                return {"ok": True}

        class ForbiddenBridge:
            def __init__(self):
                raise AssertionError("bridge must not start in browser-only smoke")

        payload = {
            "protocolVersion": 1,
            "requestId": REQ,
            "taskUrl": TASK_URL,
            "repository": "AndrewVerhoturov1/dsh-workspace",
            "baseCommit": SHA,
            "expectedFilename": f"POSTMAN_{REQ}_RESULT.zip",
        }
        with tempfile.TemporaryDirectory() as root, patch.dict("os.environ", {"DSH_POSTMAN_WORKER_STOP_AFTER_BROWSER": "1"}):
            result = module.run_job(
                payload,
                repo_root=Path(root),
                bootstrap_module=Bootstrap,
                bridge_cls=ForbiddenBridge,
                git_runner=lambda *args, **kwargs: Completed(),
            )
        self.assertEqual(result["code"], "WEB_WORKER_SMOKE_BROWSER_READY")
        self.assertFalse(result["details"]["promptSent"])

    def test_run_job_calls_existing_pipeline_once_and_unwraps_durable_artifact_proof(self):
        captured = {}

        class FakeBridge:
            def run_request(self, request_id, **kwargs):
                captured["request_id"] = request_id
                captured.update(kwargs)
                durable = {
                    "ok": True,
                    "code": "RESULT_DURABLE",
                    "details": {
                        "requestId": REQ,
                        "resultDirectory": "C:/result",
                        "resultZip": "C:/result/result.zip",
                        "manifest": "C:/result/manifest.json",
                        "validation": "C:/result/validation.json",
                        "metadata": "C:/result/metadata.json",
                        "sha256": "a" * 64,
                    },
                }
                return {"ok": True, "code": "RESULT_DURABLE", "details": {"durableProof": durable}}

        class Completed:
            returncode = 0
            stdout = "plugins/a.js\0postman/web/a.py\0"
            stderr = ""

        class BootstrapError(RuntimeError):
            pass

        class Bootstrap:
            BrowserBootstrapError = BootstrapError
            BOOTSTRAP_CHROME_NOT_FOUND = "BOOTSTRAP_CHROME_NOT_FOUND"
            DEFAULT_REMOTE_DEBUGGING_PORT = 9222
            @staticmethod
            def wait_for_cdp(url, timeout_s):
                return {"ok": True}

        payload = {
            "protocolVersion": 1,
            "requestId": REQ,
            "taskUrl": TASK_URL,
            "repository": "AndrewVerhoturov1/dsh-workspace",
            "baseCommit": SHA,
            "expectedFilename": f"POSTMAN_{REQ}_RESULT.zip",
        }
        with tempfile.TemporaryDirectory() as root:
            result = module.run_job(
                payload,
                repo_root=Path(root),
                bootstrap_module=Bootstrap,
                bridge_cls=FakeBridge,
                git_runner=lambda *args, **kwargs: Completed(),
            )
        self.assertEqual(result["code"], "RESULT_DURABLE")
        self.assertEqual(result["details"]["manifest"], "C:/result/manifest.json")
        self.assertEqual(captured["request_id"], REQ)
        self.assertEqual(captured["expected_request"]["baseCommit"], SHA)
        self.assertEqual(captured["expected_request"]["allowedPaths"], ["plugins", "postman"])


if __name__ == "__main__":
    unittest.main()
