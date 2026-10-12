from __future__ import annotations
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "postman" / "web"))
from postman.devspace import signal, task, observer, transport
import web_worker_bridge as web

REQ = "REQ_20261012T120000Z_0001"
JOB = "11111111-1111-4111-8111-111111111111"
CHAT = "https://chatgpt.com/c/devspace-test"


class DevspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.channel = self.root / JOB
        self.channel.mkdir()
        self.workspace = self.channel / "workspace"
        self.workspace.mkdir()
        self.binding = {"version": 1, "jobId": JOB, "requestId": REQ, "leaderSessionId": "leader",
            "lunaSessionId": "luna", "channel": str(self.channel), "capability": "a"*64,
            "mode": "WRITE_TEST", "workspaceRef": str(self.root), "writeRoot": str(self.workspace)}
        (self.channel / "binding.json").write_text(json.dumps(self.binding), encoding="utf-8")

    def emit(self, outcome="done", **kwargs):
        return signal.signal(self.channel, self.binding["capability"], outcome, root=self.root, **kwargs)

    def test_atomic_durable_and_duplicate_first_bell(self):
        self.emit(message="plain\n*arbitrary*", report="missing.md")
        self.emit(message="plain\n*arbitrary*", report="missing.md")
        event = signal.read_event(self.binding)
        self.assertEqual(event["reportedOutcome"], "DONE")
        self.assertEqual(event["message"], "plain\n*arbitrary*")
        self.assertEqual(event["reportRef"], str(self.workspace / "missing.md"))
        with self.assertRaisesRegex(ValueError, "ALREADY_RECORDED"):
            self.emit("blocked", message="contradiction")
        self.assertEqual(signal.read_event(self.binding), event)
        self.assertFalse(list(self.channel.glob(".bell-*")))

    def test_all_outcomes_no_report_required(self):
        for outcome, expected in signal.OUTCOMES.items():
            with self.subTest(outcome=outcome):
                self.emit(outcome)
                self.assertEqual(signal.read_event(self.binding)["reportedOutcome"], expected)
                (self.channel / "event.json").unlink()

    def test_capability_request_foreign_channel_and_each_identity_rejected(self):
        with self.assertRaisesRegex(ValueError, "SIGNAL_REJECTED"):
            signal.signal(self.channel, "wrong", "done", root=self.root)
        with self.assertRaisesRegex(ValueError, "SIGNAL_REJECTED"):
            self.emit(request="REQ_wrong")
        with self.assertRaisesRegex(ValueError, "CHANNEL_REJECTED"):
            signal.load_binding(self.channel, root=self.workspace)
        self.emit()
        path = self.channel / "event.json"
        original = json.loads(path.read_text())
        for key in signal.IDENTITY:
            path.write_text(json.dumps({**original, key: "foreign"}))
            with self.assertRaisesRegex(ValueError, "OWNER_MISMATCH"):
                signal.read_event(self.binding)

    def test_foreign_report_is_dropped_without_losing_bell(self):
        self.emit(report=str(self.root / "private.txt"))
        self.assertIsNone(signal.read_event(self.binding)["reportRef"])

    def test_renderer_private_and_exact_limited_scope_no_zip(self):
        prompt = task.render_task(self.binding, "read harmless source", "& 'private/signal.ps1'")
        self.assertIn(str(self.workspace), prompt)
        self.assertIn("read harmless source", prompt)
        self.assertIn("CAPABILITY_UNAVAILABLE", prompt)
        self.assertNotIn(self.binding["capability"], prompt)
        self.assertNotIn("raw.githubusercontent.com", prompt)
        self.assertNotIn("POSTMAN_TEXT_RESULT_BEGIN", prompt)
        self.assertIn("Никаких Git writes", prompt)

    def wait(self, **kwargs):
        clock = [0.0]
        def sleep(seconds):
            clock[0] += seconds
        with patch.object(observer.observer, "observe_next_assistant", **kwargs) as observed, \
             patch.object(observer.observer, "connection_interrupted", return_value=(False, {})), \
             patch.object(observer.reminder_policy, "submit_reminder", side_effect=AssertionError("no reminder")):
            result = observer.wait_for_signal(SimpleNamespace(url=CHAT), "private task", CHAT, self.binding,
                timeout_ms=1000, interval_ms=600000, count=5, sleep=sleep,
                monotonic=lambda:clock[0], persist=lambda fields:None)
        return result, observed

    def test_bell_wins_without_browser_final_or_zip(self):
        self.emit()
        result, observed = self.wait(side_effect=AssertionError("browser not needed"))
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        observed.assert_not_called()

    def test_bell_during_browser_wait_and_diagnostic_race(self):
        def observe(*args, **kwargs):
            self.emit()
            return {"ok":True,"code":"ASSISTANT_TURN_COMPLETED", "details":{"assistantText":"CAPABILITY_UNAVAILABLE"}}
        result, observed = self.wait(side_effect=observe)
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(result["details"]["reportedOutcome"], "DONE")
        self.assertIn("external_result_probe", observed.call_args.kwargs)

    def test_minimal_text_diagnostics_tolerate_format_and_no_envelope(self):
        for text, expected in [("**capability unavailable**\nNo app", "CAPABILITY_UNAVAILABLE"), ("arbitrary prose: blocked — decision", "BLOCKED")]:
            result, _ = self.wait(return_value={"ok":True,"details":{"assistantText":text}})
            self.assertEqual(result["code"], "DEVSPACE_DIAGNOSTIC")
            self.assertEqual(result["details"]["diagnostic"], expected)
            self.assertEqual(result["details"]["assistantText"], text)

    def test_arbitrary_done_text_does_not_end_local_wait(self):
        result, _ = self.wait(return_value={"ok":True,"details":{"assistantText":"DONE but no bell"}})
        self.assertEqual(result["code"], "DEVSPACE_DIAGNOSTIC")
        self.assertEqual(result["details"]["source"], "transport_diagnostic")

    def test_external_bell_probe_precedes_dom_and_chat_final(self):
        received = {"ok":True,"code":"DEVSPACE_SIGNAL_RECEIVED","details":{"reportedOutcome":"DONE"}}
        result = observer.observer.observe_next_assistant(SimpleNamespace(url=CHAT), "exact", CHAT,
            external_result_probe=lambda:received)
        self.assertIs(result, received)

    def test_private_transport_no_publisher_and_result_idempotent_no_resend(self):
        calls=[]
        class Bridge:
            def __init__(self, **kwargs):calls.append(kwargs)
            def run_request(self, request_id, **kwargs):
                self_test.assertEqual(request_id, REQ)
                self_test.assertEqual(kwargs["task_url"], "")
                self_test.assertFalse(kwargs["artifact_mode"])
                self_test.assertEqual(kwargs["devspace_binding"], self_test.binding)
                return {"ok":True,"code":"DEVSPACE_DIAGNOSTIC","details":{"source":"text_fallback", "diagnostic":"CAPABILITY_UNAVAILABLE"}}
        self_test=self
        with patch.object(transport, "load_binding", return_value=self.binding):
            result=transport.run(self.channel, REQ, "harmless", ensure_browser=lambda:{"cdpUrl":"existing"}, bridge_factory=Bridge)
            again=transport.run(self.channel, REQ, "harmless", ensure_browser=lambda:(_ for _ in ()).throw(AssertionError("no resend")), bridge_factory=Bridge)
        self.assertEqual(result, again)
        self.assertEqual(len(calls),1)
        self.assertTrue((self.channel / "task.md").exists())

    def test_existing_web_send_and_private_terminal_same_page_cleanup_no_artifact(self):
        page=SimpleNamespace(url=CHAT,close=lambda:None)
        class Factory:
            def __enter__(self):self.chromium=self;return self
            def __exit__(self,*args):pass
            def connect_over_cdp(self,*args,**kwargs):return self
            @property
            def contexts(self):return [self]
            def new_page(self):return page
        self.emit()
        with patch.object(web.browser_submit, "submit_fresh_prompt", return_value={"ok":True,"sendState":"PROVEN_SENT","details":{"chatUrl":CHAT}}) as sent, \
             patch.object(web.artifact_detector,"detect_artifact_dom",side_effect=AssertionError("no ZIP")), \
             patch.object(web.browser_observer,"observe_next_assistant",side_effect=AssertionError("bell wins")):
            bridge=web.WebWorkerBridge(root=self.channel / "web")
            result=bridge.run_request(REQ,task_url="",prompt="private task",expected_filename="",expected_request={"transportKind":"devspace"},
                devspace_binding=self.binding,artifact_mode=False,playwright_factory=Factory)
        sent.assert_called_once()
        self.assertFalse(sent.call_args.kwargs["artifact_mode"])
        self.assertEqual(result["code"],"DEVSPACE_SIGNAL_RECEIVED", result)
        self.assertTrue(result["details"]["browserCleanup"]["ownedPageClosed"])
        self.assertEqual(bridge.read_state(REQ)["state"],"DEVSPACE_SIGNAL_RECEIVED")

if __name__ == "__main__":
    unittest.main()
