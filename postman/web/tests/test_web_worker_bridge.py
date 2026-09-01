from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

WEB_DIR = Path(__file__).resolve().parents[1]
if str(WEB_DIR) not in sys.path:
    sys.path.insert(0, str(WEB_DIR))
MODULE_PATH = WEB_DIR / "web_worker_bridge.py"
spec = importlib.util.spec_from_file_location("web_worker_bridge", MODULE_PATH)
bridge_module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = bridge_module
spec.loader.exec_module(bridge_module)


REQ = "REQ_20260831T043820Z_0042"
TASK_URL = "https://example.test/tasks/request.md"


class WebWorkerBridgeTests(unittest.TestCase):
    def test_accept_persists_request_identity_and_result_path(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            result = bridge.accept_request(REQ, TASK_URL)

            self.assertTrue(result["ok"])
            self.assertEqual(result["code"], bridge_module.ACCEPTED)
            self.assertEqual(result["details"]["requestId"], REQ)
            self.assertEqual(result["details"]["workerJobId"], f"WEB_{REQ}")
            self.assertEqual(result["details"]["state"], bridge_module.ACCEPTED)
            self.assertTrue(result["details"]["resultPath"].replace("\\", "/").endswith(f"results/{REQ}"))
            stored = bridge.read_state(REQ)
            self.assertEqual(stored["requestId"], REQ)
            self.assertEqual(stored["taskUrl"], TASK_URL)

    def test_accept_rejects_invalid_identity_and_task_url(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            self.assertEqual(bridge.accept_request("REQ_BAD", TASK_URL)["code"], bridge_module.BRIDGE_INVALID_REQUEST)
            self.assertEqual(bridge.accept_request(REQ, "not-a-url")["code"], bridge_module.BRIDGE_INVALID_TASK_URL)
            self.assertIsNone(bridge.read_state(REQ))

    def test_accept_is_idempotent_and_does_not_rewrite_request_id(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            first = bridge.accept_request(REQ, TASK_URL)
            second = bridge.accept_request(REQ, TASK_URL)

            self.assertEqual(first["details"]["requestId"], second["details"]["requestId"])
            self.assertEqual(second["details"]["workerJobId"], f"WEB_{REQ}")
            self.assertEqual(second["details"]["resultPath"], first["details"]["resultPath"])

    def test_state_machine_rejects_backward_transition(self):
        with tempfile.TemporaryDirectory() as root:
            bridge = bridge_module.WebWorkerBridge(root=root)
            bridge.accept_request(REQ, TASK_URL)
            request = bridge_module.BridgeRequest(REQ, TASK_URL, str(bridge.result_path(REQ)), f"WEB_{REQ}")
            bridge._write_state(request, bridge_module.WEB_STARTING)
            with self.assertRaises(ValueError):
                bridge._write_state(request, bridge_module.ACCEPTED)

    def test_terminal_result_contains_the_same_request_id_and_durable_path(self):
        with tempfile.TemporaryDirectory() as root:
            callback_results = []
            bridge = bridge_module.WebWorkerBridge(root=root, on_result_durable=callback_results.append)
            bridge.accept_request(REQ, TASK_URL)
            request = bridge_module.BridgeRequest(REQ, TASK_URL, str(bridge.result_path(REQ)), f"WEB_{REQ}")
            stored = bridge._write_state(
                request,
                bridge_module.RESULT_DURABLE,
                resultPath=str(bridge.result_path(REQ)),
                resultSha256="a" * 64,
            )

            self.assertEqual(stored["requestId"], REQ)
            self.assertEqual(stored["state"], bridge_module.RESULT_DURABLE)
            self.assertTrue(stored["resultPath"].replace("\\", "/").endswith(f"results/{REQ}"))
            self.assertEqual(callback_results, [])


if __name__ == "__main__":
    unittest.main()
