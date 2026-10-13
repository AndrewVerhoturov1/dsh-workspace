from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(REPO), str(REPO / "postman" / "web")]
from postman.devspace import controls

CHAT = "https://chatgpt.com/c/one-owned-conversation"
REQ = "REQ_20261013T000000Z_1234"
JOB = "11111111-1111-4111-8111-111111111111"


class ControlTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name) / JOB
        (root / "controls").mkdir(parents=True)
        self.channel = root
        self.binding = {"jobId": JOB, "requestId": REQ, "leaderSessionId": "leader",
                        "lunaSessionId": "luna", "capability": "a" * 64,
                        "channel": str(root)}
        self.page = SimpleNamespace(url=CHAT)
        self.now = [0.0]
        self.sent = []
        self.stops = []

    def issue(self, uid, kind, *, priority="normal", message="продолжай", **overrides):
        intent = {"version": 1, **{name: self.binding[name] for name in
                ("jobId", "requestId", "leaderSessionId", "lunaSessionId", "capability")},
                "controlId": uid, "kind": kind, "priority": priority,
                "message": message if kind != "stop" else "", "issuedAt": "2026-10-13T01:00:00Z"}
        intent.update(overrides)
        (self.channel / "controls" / (uid + ".json")).write_text(json.dumps(intent), encoding="utf-8")
        return intent

    def process(self, *, generation="IDLE", stop="ABSENT", after_stop=None, send_state="PROVEN_SENT",
                send_error=None):
        state = [generation]
        def activity(*args, **kwargs):
            return {"state": state[0]}
        def stop_control(_page):
            condition = "ABSENT" if self.stops else stop
            return condition, SimpleNamespace(click=lambda **kwargs: (self.stops.append("click"), state.__setitem__(0,"IDLE")))
        def send(page, message, chat_url, **kwargs):
            self.assertIs(page, self.page)
            self.assertEqual(chat_url, CHAT)
            self.assertFalse(kwargs.get("navigate", True))
            self.sent.append(message)
            if send_error:
                raise RuntimeError(send_error)
            return {"sendState": send_state}
        def sleep(seconds):
            self.now[0] += seconds
        with patch.object(controls.submit, "submit_existing_prompt", side_effect=send):
            return controls.process_one(self.page, "old", CHAT, self.binding,
                activity=activity, stop_control=stop_control,
                sleep=sleep, monotonic=lambda: self.now[0])

    def test_normal_steer_queues_during_generation_then_sends_once_when_idle(self):
        cid="00000000-0000-4000-8000-000000000001"
        self.issue(cid, "steer")
        self.assertIsNone(self.process(generation="ACTIVE_TOOL", stop="PRESENT"))
        self.assertFalse(self.sent)
        self.assertEqual(len(controls.pending(self.binding)), 1)
        sent=self.process()
        self.assertEqual(sent["status"], "SENT_CONFIRMED")
        self.assertEqual(self.sent, ["продолжай"])
        self.assertFalse(controls.pending(self.binding))
        self.assertIsNone(self.process())
        self.assertEqual(len(self.sent), 1)

    def test_preempt_clicks_stop_once_waits_then_sends_exact_control(self):
        cid="00000000-0000-4000-8000-000000000002"
        self.issue(cid, "preempt", priority="urgent", message="изменить инструкцию")
        result=self.process(generation="SAFE_GENERATION", stop="PRESENT")
        self.assertEqual(result["status"], "SENT_CONFIRMED")
        self.assertEqual(self.stops, ["click"])
        self.assertEqual(self.sent, ["изменить инструкцию"])
        receipt=json.loads((self.channel / "controls" / (cid + ".ack.json")).read_text(encoding="utf-8"))
        self.assertEqual(receipt["stopState"], "STOP_UI_PROVEN")
        self.assertEqual(receipt["sendState"], "PROVEN_SENT")
        self.assertIsNone(self.process())
        self.assertEqual(len(self.stops), 1)

    def test_explicit_stop_never_sends_or_claims_shell_process_termination(self):
        cid="00000000-0000-4000-8000-000000000003"
        self.issue(cid, "stop")
        result=self.process(generation="SAFE_GENERATION", stop="PRESENT")
        self.assertEqual(result["kind"], "stop")
        self.assertEqual(result["status"], "STOP_UI_PROVEN")
        self.assertEqual(self.stops, ["click"])
        self.assertEqual(self.sent, [])

    def test_preempt_and_stop_wait_for_active_devspace_operation(self):
        for kind, control_id in [("preempt", "00000000-0000-4000-8000-000000000011"),
                                 ("stop", "00000000-0000-4000-8000-000000000012")]:
            self.issue(control_id, kind, priority="urgent")
            self.assertIsNone(self.process(generation="ACTIVE_TOOL", stop="PRESENT"))
            self.assertEqual(self.stops, [])
            self.assertEqual(self.sent, [])
            self.assertEqual(len(controls.pending(self.binding)), 1)
            outcome = self.process(generation="SAFE_GENERATION", stop="PRESENT")
            self.assertEqual(outcome["status"],
                             "SENT_CONFIRMED" if kind == "preempt" else "STOP_UI_PROVEN")
            self.stops.clear()
            self.sent.clear()

    def test_preempt_when_idle_journals_unknown_send_before_click(self):
        control_id="00000000-0000-4000-8000-000000000013"
        self.issue(control_id, "preempt", priority="urgent")
        with self.assertRaisesRegex(RuntimeError, "SIMULATED_CRASH_AFTER_SEND"):
            self.process(generation="IDLE", stop="ABSENT",
                         send_error="SIMULATED_CRASH_AFTER_SEND")
        self.assertEqual(self.stops, [])
        self.assertEqual(self.sent, ["продолжай"])
        receipt=json.loads((self.channel / "controls" /
                            (control_id + ".ack.json")).read_text(encoding="utf-8"))
        self.assertEqual(receipt["state"], "SEND_UNKNOWN")
        self.assertEqual(receipt["stopState"], "ALREADY_IDLE")
        self.assertFalse(controls.pending(self.binding))
        self.assertIsNone(self.process())
        self.assertEqual(len(self.sent), 1)

    def test_preempt_cannot_stop_when_ui_proofs_conflict(self):
        control_id="00000000-0000-4000-8000-000000000014"
        self.issue(control_id, "preempt", priority="urgent")
        self.assertIsNone(self.process(generation="IDLE", stop="PRESENT"))
        self.assertEqual(self.stops, [])
        self.assertFalse(self.sent)
        self.assertEqual(len(controls.pending(self.binding)), 1)

    def test_uncertain_send_never_retries_or_claims_completion(self):
        cid="00000000-0000-4000-8000-000000000004"
        self.issue(cid, "steer")
        result=self.process(send_state="UNKNOWN")
        self.assertEqual(result["status"], "SEND_UNKNOWN")
        self.assertTrue(result["sendUnknown"])
        self.assertEqual(self.sent, ["продолжай"])
        self.assertIsNone(self.process())
        self.assertEqual(len(self.sent), 1)

    def test_wrong_host_owner_cannot_send(self):
        cid="00000000-0000-4000-8000-000000000005"
        self.issue(cid, "steer", leaderSessionId="foreign")
        with self.assertRaisesRegex(ValueError, "OWNER_MISMATCH"):
            self.process()
        self.assertEqual(self.sent, [])

    def test_stop_absence_during_active_tool_is_not_treated_as_idle(self):
        cid="00000000-0000-4000-8000-000000000007"
        self.issue(cid, "stop")
        self.assertIsNone(self.process(generation="ACTIVE_TOOL", stop="ABSENT"))
        self.assertEqual(self.stops, [])
        self.assertEqual(self.sent, [])
        self.assertEqual(len(controls.pending(self.binding)), 1)

    def test_urgent_preempts_ordinary_pending_control(self):
        ordinary="00000000-0000-4000-8000-000000000008"
        urgent="00000000-0000-4000-8000-000000000009"
        self.issue(ordinary,"steer",priority="normal",message="ordinary")
        self.issue(urgent,"steer",priority="urgent",message="urgent")
        self.assertEqual(self.process()["status"],"SENT_CONFIRMED")
        self.assertEqual(self.sent,["urgent"])
        self.assertEqual(self.process()["status"],"SENT_CONFIRMED")
        self.assertEqual(self.sent,["urgent","ordinary"])

    def test_unrelated_chat_cannot_take_control(self):
        cid="00000000-0000-4000-8000-000000000006"
        self.issue(cid, "preempt", priority="urgent")
        self.page.url="https://chatgpt.com/c/not-ours"
        result=self.process(generation="SAFE_GENERATION",stop="PRESENT")
        self.assertEqual(result["status"],"PROVEN_NOT_SENT")
        self.assertEqual(self.stops,[])
        self.assertEqual(self.sent,[])


if __name__ == "__main__":
    unittest.main()
