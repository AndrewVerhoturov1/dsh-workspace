from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
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
import reminder_policy
import browser_observer

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
        prompt = task.render_task(self.binding, "read harmless source", "pwsh -NoProfile -NonInteractive -File 'private/signal.ps1'")
        self.assertIn(str(self.workspace), prompt)
        self.assertTrue(prompt.startswith('POSTMAN_REQUEST_ID: ' + REQ + '\n'))
        self.assertEqual(web.browser_submit.request_key_line_from_prompt(prompt),
                         'POSTMAN_REQUEST_ID: ' + REQ)
        self.assertIn("read harmless source", prompt)
        self.assertIn("CAPABILITY_UNAVAILABLE", prompt)
        self.assertNotIn(self.binding["capability"], prompt)
        self.assertNotIn("raw.githubusercontent.com", prompt)
        self.assertNotIn("POSTMAN_TEXT_RESULT_BEGIN", prompt)
        self.assertIn("Никаких Git writes", prompt)

    def test_script_transport_does_not_shadow_standard_python_signal(self):
        script = REPO / 'postman' / 'devspace' / 'transport.py'
        probe = '''import importlib, pathlib, runpy, sys
script = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(script.parent))
runpy.run_path(str(script), run_name='devspace_import_probe')
assert script.parent not in [pathlib.Path(path or '.').resolve() for path in sys.path]
sys.modules.pop('signal', None)
stdlib_signal = importlib.import_module('signal')
assert hasattr(stdlib_signal, 'set_wakeup_fd')
'''
        result = subprocess.run([sys.executable, '-c', probe, str(script)], cwd=REPO,
                                capture_output=True, text=True, timeout=25,
                                env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertEqual(result.returncode, 0, result.stderr)

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

    def test_arbitrary_completed_text_is_delivered_without_claiming_bell(self):
        result, _ = self.wait(return_value={"ok":True,"details":{"assistantText":"DONE but no bell\nпроизвольный **итог**"}})
        self.assertEqual(result["code"], "DEVSPACE_DIAGNOSTIC")
        self.assertEqual(result["details"]["source"], "text_fallback")
        self.assertEqual(result["details"]["diagnostic"], "UNKNOWN")
        self.assertIn("произвольный", result["details"]["assistantText"])

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
                self_test.assertEqual(kwargs["reminder_interval_ms"], 900000)
                self_test.assertEqual(kwargs["max_reminders"], 3)
                self_test.assertIn("pwsh -NoProfile -NonInteractive -File", kwargs["prompt"])
                self_test.assertNotIn("& \'", kwargs["prompt"])
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

    def test_unknown_send_waits_for_late_bell_without_resending(self):
        page = SimpleNamespace(url=CHAT, close=lambda: None)
        class Factory:
            def __enter__(self): self.chromium = self; return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, *args, **kwargs): return self
            @property
            def contexts(self): return [self]
            def new_page(self): return page
        clock = [0.0]
        def sleep(seconds):
            clock[0] += seconds
            if clock[0] >= 2 and not (self.channel / "event.json").exists():
                self.emit(message="bell after unproved send")
        uncertain = {"ok": False, "code": web.browser_submit.PROMPT_SEND_UNKNOWN,
                     "sendState": web.browser_submit.SEND_UNKNOWN,
                     "details": {"chatUrl": CHAT, "exactUserTurn": False}}
        with patch.object(web.browser_submit, "submit_fresh_prompt", return_value=uncertain) as submit, \
             patch.object(web.browser_observer, "observe_next_assistant",
                          side_effect=AssertionError("unknown Send must not use text observer")):
            bridge = web.WebWorkerBridge(root=self.channel / "web", sleep=sleep,
                                         monotonic=lambda: clock[0])
            result = bridge.run_request(REQ, task_url="", prompt="private task",
                expected_filename="", expected_request={"transportKind": "devspace"},
                devspace_binding=self.binding, artifact_mode=False,
                playwright_factory=Factory, observer_timeout_ms=4000)
        submit.assert_called_once()
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(result["details"]["reportedOutcome"], "DONE")
        self.assertEqual(result["details"]["sendState"], "UNKNOWN")
        self.assertEqual(bridge.read_state(REQ)["state"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertTrue(result["details"]["browserCleanup"]["ownedPageClosed"])

    def test_unknown_send_without_bell_yields_diagnostic_no_false_done(self):
        clock = [0.0]
        result = observer.wait_for_bell_after_unknown_send(self.binding, timeout_ms=1000,
            sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
            monotonic=lambda: clock[0], conversation_ref=CHAT)
        self.assertEqual(result["code"], "DEVSPACE_DIAGNOSTIC")
        self.assertEqual(result["details"]["sendState"], "UNKNOWN")
        self.assertEqual(result["details"]["diagnostic"], "BLOCKED")
        self.assertFalse((self.channel / "event.json").exists())

    def test_unknown_send_unproven_anchor_remains_bell_only(self):
        page = SimpleNamespace(url=CHAT)
        prompt = task.render_task(self.binding, "read README", "pwsh -File signal.ps1")
        clock = [0.0]
        turns = [{"index": 0, "role": "user", "text": "unrelated user turn"}]
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns, "family")), \
             patch.object(observer.controls, "process_one",
                          side_effect=AssertionError("unproven turn may not mutate browser")) as action, \
             patch.object(observer.observer, "observe_next_assistant",
                          side_effect=AssertionError("unproven turn may not supply text")):
            result = observer.wait_for_bell_after_unknown_send(self.binding,
                timeout_ms=1500, sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
                monotonic=lambda: clock[0], conversation_ref=CHAT, page=page, prompt=prompt)
        self.assertEqual(result["details"]["diagnostic"], "BLOCKED")
        action.assert_not_called()

    def test_unknown_send_defers_urgent_preempt_during_active_devspace_tool(self):
        page = SimpleNamespace(url=CHAT)
        prompt = task.render_task(self.binding, "read README", "pwsh -File signal.ps1")
        control_id = "11111111-1111-4111-8111-111111111111"
        folder = self.channel / "controls"
        folder.mkdir(exist_ok=True)
        intent = {"version": 1, "controlId": control_id, "kind": "preempt",
                  "priority": "urgent", "message": "keep current operation safe",
                  "issuedAt": "2026-10-13T00:00:00Z",
                  **{key: self.binding[key] for key in signal.IDENTITY}}
        (folder / (control_id + ".json")).write_text(json.dumps(intent), encoding="utf-8")
        turns = [{"index": 0, "role": "user",
                  "text": "POSTMAN_REQUEST_ID: " + REQ + "\n# Markdown altered by ChatGPT"}]
        clock = [0.0]
        def sleep(seconds):
            clock[0] += seconds
            if clock[0] >= 2.0 and not (self.channel / "event.json").exists():
                self.emit(message="original DevSpace tool completed safely")
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns, "family")), \
             patch.object(observer, "activity_snapshot", return_value={"state": "ACTIVE_TOOL"}), \
             patch.object(observer, "stop_control",
                          return_value=("PRESENT", SimpleNamespace(
                              click=lambda **kwargs: self.fail("Stop clicked during active tool")))), \
             patch.object(observer.observer, "observe_next_assistant",
                          return_value={"ok": False, "code": "ASSISTANT_NOT_STARTED", "details": {}}):
            result = observer.wait_for_bell_after_unknown_send(self.binding,
                timeout_ms=6000, sleep=sleep, monotonic=lambda: clock[0],
                conversation_ref=CHAT, page=page, prompt=prompt)
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(result["details"]["reportedOutcome"], "DONE")
        self.assertFalse((folder / (control_id + ".ack.json")).exists())
        self.assertEqual(len(observer.controls.pending(self.binding)), 1)

    def test_unknown_send_correlated_idle_control_sends_once_before_bell(self):
        page = SimpleNamespace(url=CHAT)
        prompt = task.render_task(self.binding, "read README", "pwsh -File signal.ps1")
        control_id = "22222222-2222-4222-8222-222222222222"
        folder = self.channel / "controls"
        folder.mkdir(exist_ok=True)
        intent = {"version": 1, "controlId": control_id, "kind": "steer",
                  "priority": "urgent", "message": "complete and ring bell",
                  "issuedAt": "2026-10-13T00:00:00Z",
                  **{key: self.binding[key] for key in signal.IDENTITY}}
        (folder / (control_id + ".json")).write_text(json.dumps(intent), encoding="utf-8")
        turns = [{"index": 0, "role": "user",
                  "text": "POSTMAN_REQUEST_ID: " + REQ + "\n# Altered rendered Markdown"}]
        clock = [0.0]
        def sleep(seconds):
            clock[0] += seconds
            if clock[0] >= 2 and not (self.channel / "event.json").exists():
                self.emit(message="bell after distinct steer")
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns, "family")), \
             patch.object(observer, "activity_snapshot", return_value={"state": "IDLE"}), \
             patch.object(observer.controls.submit, "submit_existing_prompt",
                          return_value={"sendState": "PROVEN_SENT"}) as send, \
             patch.object(observer.observer, "observe_next_assistant",
                          return_value={"ok": False, "code": "ASSISTANT_NOT_STARTED", "details": {}}):
            result = observer.wait_for_bell_after_unknown_send(self.binding,
                timeout_ms=6000, sleep=sleep, monotonic=lambda: clock[0],
                conversation_ref=CHAT, page=page, prompt=prompt)
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        send.assert_called_once()
        self.assertEqual(send.call_args.args[1], intent["message"])
        self.assertEqual(send.call_args.kwargs["navigate"], False)
        ack = json.loads((folder / (control_id + ".ack.json")).read_text(encoding="utf-8"))
        self.assertEqual(ack["state"], "SENT_CONFIRMED")
        self.assertFalse(observer.controls.pending(self.binding))

    def test_unknown_send_correlated_text_backup_never_claims_bell(self):
        page = SimpleNamespace(url=CHAT)
        prompt = task.render_task(self.binding, "read README", "pwsh -File signal.ps1")
        turns = [{"index": 0, "role": "user",
                  "text": "POSTMAN_REQUEST_ID: " + REQ + "\n# Markdown changed"}]
        clock = [0.0]
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns, "family")), \
             patch.object(observer.observer, "observe_next_assistant", return_value={
                 "ok": True, "code": "ASSISTANT_COMPLETED", "details": {
                     "assistantText": "CAPABILITY_UNAVAILABLE: DevSpace connection missing"}}), \
             patch.object(observer.controls, "process_one", return_value=None) as actions:
            result = observer.wait_for_bell_after_unknown_send(self.binding,
                timeout_ms=20000,
                sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
                monotonic=lambda: clock[0], conversation_ref=CHAT, page=page, prompt=prompt)
        self.assertEqual(result["code"], "DEVSPACE_DIAGNOSTIC")
        self.assertEqual(result["details"]["source"], "text_fallback")
        self.assertEqual(result["details"]["diagnostic"], "CAPABILITY_UNAVAILABLE")
        self.assertEqual(result["details"]["sendState"], "UNKNOWN")
        self.assertFalse((self.channel / "event.json").exists())
        self.assertGreaterEqual(clock[0], 12)
        self.assertTrue(actions.called)

    def run_checks(self, *, state="SAFE_GENERATION", delay=0, send_ready=True, send_state="PROVEN_SENT", on_stop=None, on_send=None, complete=False, before_check=None):
        clock = [0.0]
        clicks = []
        checks = []
        snapshots = []
        def sleep(seconds): clock[0] += seconds
        def stop_click(**kwargs):
            clicks.append(clock[0])
            if on_stop: on_stop()
        button = SimpleNamespace(click=stop_click)
        def activity(*args, **kwargs):
            checks.append(clock[0])
            if before_check: before_check()
            post = bool(clicks) and clock[0] >= clicks[0] + delay
            return {"state":"IDLE" if post else state, "stopState":"ABSENT" if post else "PRESENT", "reason":"fixture"}
        def observe(*args, **kwargs):
            sleep(0.2)
            return {"ok":complete, "code":"ASSISTANT_TURN_COMPLETED" if complete else "ASSISTANT_TURN_TIMEOUT",
                    "details":{"assistantText":"частичный произвольный текст"}}
        intent = {"requestId":REQ, "conversationUrl":CHAT, "exactPromptText":"continue", "expectedUserTurnRelation":{}}
        def send(*args, **kwargs):
            self.assertEqual(kwargs["control_intent"]["requestId"], REQ)
            self.assertEqual(args[2], CHAT)
            self.assertIn("Не начинай заново", args[1])
            self.assertIn("phase_probe", kwargs)
            if on_send: on_send(kwargs["phase_probe"])
            return {"sendState":send_state, "details":{}}
        with patch.object(observer.observer, "observe_next_assistant", side_effect=observe), \
             patch.object(observer.observer, "connection_interrupted", return_value=(False, {})), \
             patch.object(observer, "activity_snapshot", side_effect=activity), \
             patch.object(observer, "stop_control", return_value=("PRESENT",button)), \
             patch.object(observer.recovery, "chat_ready_snapshot", return_value={"ok":True}), \
             patch.object(observer.submit, "find_send_button", return_value=(button,"send") if send_ready else (None,None)), \
             patch.object(observer.transport_control, "make_intent", return_value=intent), \
             patch.object(observer.transport_control, "confirmed_binding", return_value={"confirmed":True}), \
             patch.object(observer.reminder_policy, "submit_reminder", side_effect=send) as sent:
            result = observer.wait_for_signal(SimpleNamespace(url=CHAT), "private task", CHAT, self.binding,
                timeout_ms=14000, interval_ms=1000, count=3, sleep=sleep, monotonic=lambda:clock[0],
                persist=lambda value:snapshots.append(value))
        return result, clicks, checks, sent, snapshots

    def test_safe_generation_one_stop_delayed_absence_and_confirmed_continuation(self):
        def after_send(probe): self.emit(message="done after continuation")
        result, clicks, checks, sent, _ = self.run_checks(delay=3, on_send=after_send)
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(len(clicks),1)
        sent.assert_called_once()
        # Synthetic float clock subtraction can round 3 seconds down by one ULP.
        self.assertGreaterEqual(max(checks)-clicks[0],3-1e-9)

    def test_bell_after_stop_wins_before_readiness_and_send(self):
        result, clicks, _, sent, _ = self.run_checks(on_stop=lambda:self.emit())
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(len(clicks),1)
        sent.assert_not_called()

    def test_bell_before_check_action_wins_without_stop(self):
        result, clicks, _, sent, _ = self.run_checks(before_check=lambda:self.emit())
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(clicks,[])
        sent.assert_not_called()

    def test_completed_response_no_stop_even_if_interval_due(self):
        result, clicks, _, sent, _ = self.run_checks(complete=True)
        self.assertEqual(result["details"]["source"], "text_fallback")
        self.assertEqual(clicks,[])
        sent.assert_not_called()

    def test_active_tool_and_unknown_safety_defer_check_without_click(self):
        for state in ["ACTIVE_TOOL","UNKNOWN","IDLE"]:
            with self.subTest(state=state):
                result, clicks, checks, sent, _ = self.run_checks(state=state)
                self.assertEqual(clicks,[])
                sent.assert_not_called()
                self.assertEqual(result["details"]["diagnostic"],"PARTIAL")
                self.assertEqual(len(checks),3)
                self.assertTrue(all(s["status"]=="DEFERRED" for s in result["details"]["reminderSlots"]))

    def test_missing_send_and_stop_still_active_are_bounded_not_proof(self):
        for delay, ready in [(0,False),(11,True)]:
            with self.subTest(delay=delay):
                result, clicks, checks, sent, _ = self.run_checks(delay=delay, send_ready=ready)
                self.assertEqual(len(clicks),1)
                sent.assert_not_called()
                self.assertEqual(result["details"]["diagnostic"],"BLOCKED")
                self.assertLessEqual(max(checks)-clicks[0],10)
                self.assertIn("not proven",result["details"]["message"])

    def test_send_unknown_is_terminal_no_second_stop_or_send(self):
        result, clicks, _, sent, _ = self.run_checks(send_state="UNKNOWN")
        self.assertEqual(len(clicks),1)
        sent.assert_called_once()
        self.assertIn("no resend",result["details"]["message"])

    def test_next_check_is_15min_relative_to_confirmed_continuation(self):
        # Millisecond-scale injected interval verifies the same schedule rule.
        def after_send(probe): self.emit()
        result, clicks, _, _, snapshots = self.run_checks(delay=2, on_send=after_send)
        # Bell preempts scheduling; run without bell to see schedule mutation.
        (self.channel / "event.json").unlink()
        result, clicks, _, _, snapshots = self.run_checks(delay=2)
        confirmed = next(s for s in snapshots if s["reminderSlots"][0]["status"]=="SENT_CONFIRMED")
        first = confirmed["reminderSlots"][0]
        self.assertEqual(confirmed["reminderSlots"][1]["scheduledElapsedMs"], first["finishedElapsedMs"]+1000)
        self.assertEqual(confirmed["reminderSlots"][2]["scheduledElapsedMs"], first["finishedElapsedMs"]+2000)

    def test_bell_during_send_guard_suppresses_action(self):
        def guard(probe):
            self.emit()
            phase = probe()
            self.assertTrue(phase["bellReceived"])
            suppressed = observer.reminder_policy._phase_suppression(phase,boundary="pre_click",transitions=[],page=SimpleNamespace(),prompt="draft")
            self.assertEqual(suppressed["sendState"],"PROVEN_NOT_SENT")
            self.assertFalse(suppressed["details"]["unsentPromptCleared"])
        result, _, _, _, _ = self.run_checks(on_send=guard)
        self.assertEqual(result["code"],"DEVSPACE_SIGNAL_RECEIVED")

    def test_real_reminder_send_after_stop_and_legacy_final_and_bell_guards(self):
        class Clock:
            value = 0.0
            def monotonic(self): return self.value
            def sleep(self, seconds): self.value += max(0.0, seconds)

        class Button:
            def __init__(self): self.clicks = 0
            def click(self, *, timeout): self.clicks += 1

        prompt = "original REQ user prompt"
        continuation = "continue from the current point"
        button = Button()
        page = SimpleNamespace(url=CHAT)
        clock = Clock()
        turns = ([{"index":0,"role":"user","text":prompt},
                  {"index":1,"role":"assistant","text":"stopped partial response"}], "turns")
        binding = {"userOrdinal":0,"precedingUserHashes":[],
                   "promptSha256":reminder_policy.submit.prompt_sha256(prompt)}
        intent = {"conversationUrl":CHAT,"exactPromptText":continuation,
                  "expectedUserTurnRelation":{"userOrdinal":1,"precedingUserHashes":
                      [reminder_policy.submit.prompt_sha256(prompt)]}}
        idle_probe = lambda: {"phase":browser_observer.WORKING}
        with patch.object(reminder_policy.browser_observer, "snapshot_turns", return_value=turns), \
             patch.object(reminder_policy.browser_observer, "generation_active", return_value=(False, "")), \
             patch.object(reminder_policy, "prepare_same_chat", return_value={
                 "ok":True,"code":reminder_policy.submit.EXISTING_CHAT_CONFIRMED,
                 "composer":object(),"details":{"composerSelector":"#prompt-textarea"}}), \
             patch.object(reminder_policy.submit, "insert_prompt", return_value={
                 "ok":True,"code":reminder_policy.submit.PROMPT_INSERTED,"details":{}}), \
             patch.object(reminder_policy.submit, "_exact_prompt_readback", return_value=(True, {})), \
             patch.object(reminder_policy.submit, "find_send_button", return_value=(button,"send")), \
             patch.object(reminder_policy.submit, "_observe_send_proof", return_value=(True, {
                 "userTurnCorrelationMode":"exact","chatUrl":CHAT})):
            sent = reminder_policy.submit_reminder(page, continuation, CHAT,
                anchor_prompt=prompt, anchor_binding=binding, control_intent=intent,
                phase_probe=idle_probe, sleep=clock.sleep, monotonic=clock.monotonic,
                uniform=lambda _low,_high:0.0)
        self.assertEqual(sent["code"], reminder_policy.submit.PROMPT_SEND_CONFIRMED, sent)
        self.assertEqual(sent["sendState"], reminder_policy.submit.SEND_PROVEN_SENT)
        self.assertEqual(button.clicks, 1)
        self.assertTrue(sent["details"]["userTurnCorrelationMode"] == "exact")

        legacy_page = SimpleNamespace(url=CHAT)
        with patch.object(reminder_policy.browser_observer, "inspect_answer_phase", return_value={
                 "phase":browser_observer.FINAL_ANSWER_STARTED,"finalAnswerLatched":True}), \
             patch.object(reminder_policy, "prepare_same_chat") as prepare, \
             patch.object(reminder_policy.submit, "insert_prompt") as insert:
            legacy = reminder_policy.submit_reminder(legacy_page, continuation, CHAT,
                anchor_prompt=prompt, anchor_binding=binding)
        self.assertEqual(legacy["code"], reminder_policy.REMINDER_SUPPRESSED_ASSISTANT_ACTIVITY)
        prepare.assert_not_called()
        insert.assert_not_called()

        bell_page = SimpleNamespace(url=CHAT)
        def bell_probe():
            return {"phase":browser_observer.UNKNOWN,"bellReceived":True}
        with patch.object(reminder_policy.browser_observer, "snapshot_turns", return_value=turns), \
             patch.object(reminder_policy, "prepare_same_chat") as prepare, \
             patch.object(reminder_policy.submit, "insert_prompt") as insert, \
             patch.object(reminder_policy.submit, "find_send_button") as find_send:
            bell = reminder_policy.submit_reminder(bell_page, continuation, CHAT,
                anchor_prompt=prompt, anchor_binding=binding, control_intent=intent,
                phase_probe=bell_probe)
        self.assertEqual(bell["code"], reminder_policy.REMINDER_PHASE_PENDING)
        self.assertEqual(bell["sendState"], reminder_policy.submit.SEND_PROVEN_NOT_SENT)
        prepare.assert_not_called()
        insert.assert_not_called()
        find_send.assert_not_called()

    def test_stop_control_errors_are_unknown_not_absence(self):
        broken = SimpleNamespace(locator=lambda selector: (_ for _ in ()).throw(RuntimeError("unobservable")))
        self.assertEqual(observer.stop_control(broken),("UNKNOWN",None))

if __name__ == "__main__":
    unittest.main()
