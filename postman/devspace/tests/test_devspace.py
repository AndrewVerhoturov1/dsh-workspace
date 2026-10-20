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

        def publish(binding, intent, command):
            from postman.devspace.publication import render_launch
            self.published_intent = intent
            self.published_task = task.render_task(binding, intent, command)
            url = "https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/" + "a" * 40 + "/tasks/" + binding["jobId"] + ".md"
            rules = "https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/" + "b" * 40 + "/postman/devspace/SKILL.md"
            return {"taskUrl": url, "rulesUrl": rules, "prompt": render_launch(url, rules)}
        publisher = patch.object(transport, "publish_assignment", side_effect=publish)
        publisher.start()
        self.addCleanup(publisher.stop)


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

    def test_report_outside_assignment_is_retained_without_losing_bell(self):
        self.emit(report=str(self.root / "private.txt"))
        self.assertEqual(signal.read_event(self.binding)["reportRef"], str(self.root / "private.txt"))

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
        self.assertIn("GitHub writes/commit/push/PR/merge", prompt)
        self.assertIn("Leader запретил Computer Use", prompt)
        allowed = task.render_task({**self.binding, "computerUse": "allow"}, "inspect", "bell")
        self.assertIn("Leader разрешил Computer Use", allowed)
        self.assertNotIn("Host grant на целевое приложение", allowed)
        instructions = (REPO / "postman/devspace/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("15/30/45", instructions)
        self.assertIn("не доказывает остановку Bash", instructions)

    def test_writer_prompt_requires_owned_alias_before_any_devspace_tools(self):
        for mode in ("WRITE_TEST", "WRITE_ISOLATED", "WRITE_APPROVED_TARGET"):
            with self.subTest(mode=mode):
                prompt = task.render_task({**self.binding, "mode": mode}, "inspect first", "bell")
                self.assertIn("Перед любыми другими DevSpace-инструментами вызови open_workspace с path='postman-writer:" + JOB + "'", prompt)
                self.assertIn("Этот адрес связывает выполнение с заданием", prompt)
                self.assertIn("сообщи CAPABILITY_UNAVAILABLE обычным текстом", prompt)
                instructions = (REPO / "postman/devspace/SKILL.md").read_text(encoding="utf-8")
                self.assertIn("нужны поля execution и job_id", instructions)
                self.assertIn("connector schema does not support execution/job_id", instructions)
                self.assertIn("не повторяй неподдерживаемый вызов", instructions)
        read_only = task.render_task({**self.binding, "mode": "READ_ONLY"}, "inspect", "bell")
        self.assertNotIn("postman-writer:", read_only)
        self.assertIn("обычным open_workspace с path=" + json.dumps(str(self.root), ensure_ascii=False), read_only)
        self.assertIn("В READ_ONLY не используй postman-writer", read_only)
        self.assertNotIn("execution='background'", read_only)
        self.assertIn("MCP UNAVAILABLE", instructions)
        self.assertIn("отказ прав/scope или NEED_DECISION", instructions)

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
        for text, expected in [("**capability unavailable**\nNo app", "UNKNOWN"), ("arbitrary prose: blocked — decision", "UNKNOWN")]:
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

    def test_native_image_handoff_reaches_owned_devspace_browser_once(self):
        import base64
        calls=[]
        attachment=SimpleNamespace(request_id=REQ,media_type="image/png")
        class Bridge:
            def __init__(self, **kwargs): pass
            def run_request(self, request_id, **kwargs):
                self_test.assertIs(kwargs["input_attachment"], attachment)
                self_test.assertEqual(kwargs["devspace_binding"], self_test.binding)
                self_test.assertIn("автоматически", self_test.published_intent)
                calls.append(kwargs)
                return {"ok":True,"code":"DEVSPACE_DIAGNOSTIC","details":{
                    "source":"text_fallback","assistantText":"processed reference",
                    "diagnostic":"UNKNOWN"}}
        self_test=self
        encoded=base64.b64encode(b'[{"media_type":"image/png"}]').decode("ascii")
        with patch.object(transport, "load_binding", return_value=self.binding), \
             patch.object(transport.input_bundle, "normalize_input_files",
                          return_value=[{"media_type":"image/png"}]), \
             patch.object(transport.input_bundle, "read_handoff",
                          return_value=attachment) as handoff:
            outcome=transport.run(self.channel, REQ, "use attached image",
                input_bundle_manifest="/private/handoff.json", input_files_base64=encoded,
                ensure_browser=lambda:{"cdpUrl":"existing"},bridge_factory=Bridge)
        self.assertEqual(outcome["source"],"text_fallback")
        handoff.assert_called_once()
        self.assertTrue(handoff.call_args.kwargs["image"])
        self.assertEqual(len(calls),1)

    def test_external_bell_probe_precedes_dom_and_chat_final(self):
        received = {"ok":True,"code":"DEVSPACE_SIGNAL_RECEIVED","details":{"reportedOutcome":"DONE"}}
        result = observer.observer.observe_next_assistant(SimpleNamespace(url=CHAT), "exact", CHAT,
            external_result_probe=lambda:received)
        self.assertIs(result, received)

    def test_github_launch_and_result_idempotent_no_resend(self):
        calls=[]
        class Bridge:
            def __init__(self, **kwargs):calls.append(kwargs)
            def run_request(self, request_id, **kwargs):
                self_test.assertEqual(request_id, REQ)
                self_test.assertIn("/tasks/" + JOB + ".md", kwargs["task_url"])
                self_test.assertFalse(kwargs["artifact_mode"])
                self_test.assertEqual(kwargs["reminder_interval_ms"], 900000)
                self_test.assertEqual(kwargs["max_reminders"], 3)
                self_test.assertIn("pwsh -NoProfile -NonInteractive -File", self_test.published_task)
                self_test.assertNotIn(REQ, kwargs["prompt"])
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

    def test_fast_presend_and_unknown_failure_evidence_reaches_terminal_without_private_data(self):
        for state, code, reason in [
            ("PROVEN_NOT_SENT", "SUBMIT_INVALID_CONFIG", "presend_ownership_or_prompt_changed"),
            ("UNKNOWN", "PROMPT_SEND_UNKNOWN", "submit_exception"),
        ]:
            with self.subTest(state=state):
                submitted = {"ok": False, "code": code, "sendState": state,
                    "details": {"reason": reason, "private": "PRIVATE_SECRET_VALUE",
                        "pageDiagnostic": {"url": "https://chatgpt.com/c/PRIVATE_SECRET_VALUE"},
                        "presendOwnership": {"sendNotAttempted": state == "PROVEN_NOT_SENT",
                            "ownedUrlEqual": False, "userTurnCountEqual": True,
                            "expectedUserTurnCount": 1, "observedUserTurnCount": 1,
                            "userTurnSelectorFamily": "author-role", "private": "PRIVATE_SECRET_VALUE"},
                        "exactPromptReadback": True, "singleLogicalComposer": True}}
                observed = {"ok": False, "code": "POSTMAN_TRANSPORT_FAILED", "details": {
                    "diagnostic": "BLOCKED", "transportCode": code,
                    "transportMessage": code, "sendProof": {"sendState": state, "proofClass": state},
                    "sendProofClass": state, "conversationUrl": "https://chatgpt.com/c/PRIVATE_SECRET_VALUE",
                    "details": submitted, "runtimeCredentials": "PRIVATE_SECRET_VALUE"}}
                class Bridge:
                    def __init__(self, **kwargs): pass
                    def run_request(self, *args, **kwargs): return observed
                with patch.object(transport, "load_binding", return_value=self.binding):
                    result = transport.run(self.channel, REQ, "safe task",
                        ensure_browser=lambda: {"cdpUrl": "fixture"}, bridge_factory=Bridge)
                evidence = result["transportDiagnostics"]
                self.assertNotIn("transportCode", result, "Host consumes only the transportDiagnostics envelope")
                self.assertEqual(evidence["transportCode"], code)
                self.assertEqual(evidence["transportMessage"], code)
                self.assertEqual(evidence["sendProof"], {"sendState": state, "proofClass": state})
                self.assertEqual(evidence["sendProofClass"], state)
                self.assertEqual(evidence["submitProof"]["code"], code)
                self.assertEqual(evidence["submitProof"]["sendState"], state)
                self.assertEqual(evidence["submitProof"]["reason"], reason)
                self.assertEqual(evidence["submitProof"]["presendOwnership"]["userTurnSelectorFamily"], "author-role")
                self.assertEqual(evidence["submitProof"]["presendOwnership"]["observedUserTurnCount"], 1)
                self.assertNotIn("PRIVATE_SECRET_VALUE", json.dumps(result))
                self.assertNotIn("chatgpt.com", json.dumps(result))
                self.assertNotIn(self.binding["capability"], json.dumps(result))
                with patch.object(transport, "load_binding", return_value=self.binding):
                    cached = transport.run(self.channel, REQ, "safe task",
                        ensure_browser=lambda: (_ for _ in ()).throw(AssertionError("no resend")), bridge_factory=Bridge)
                self.assertEqual(result, cached)
                (self.channel / "result.json").unlink()

    def test_history_diagnostic_is_bounded_and_never_forwards_snapshot(self):
        for reason in ("history_count_failed", "history_traversal_failed", "history_semantic_unrecognized",
                       "history_text_read_failed", "history_changed_during_read", "history_prior_anchor_missing",
                       "history_prior_anchor_ambiguous", "history_turns_unrecognized", "history_changed",
                       "prior_history_unproven", "invalid_prior_request_id"):
            proof = {"code": "EXISTING_CHAT_NOT_CONFIRMED", "sendState": "PROVEN_NOT_SENT",
                "details": {"reason": reason, "historyReady": False, "history": ["PRIVATE_SECRET_VALUE"],
                    "priorRequestId": "PRIVATE_SECRET_VALUE", "presendOwnership": {
                        "historyReadConfirmed": False, "historyEqual": False, "historyReason": reason,
                        "userHistory": ["PRIVATE_SECRET_VALUE"], "hash": "PRIVATE_SECRET_VALUE"}}}
            safe = transport._safe_transport_evidence({"details": proof})["submitProof"]
            self.assertEqual(safe["reason"], reason)
            self.assertFalse(safe["historyReady"])
            self.assertEqual(safe["presendOwnership"], {
                "historyReadConfirmed": False, "historyEqual": False, "historyReason": reason})
            self.assertNotIn("PRIVATE_SECRET_VALUE", json.dumps(safe))

    def test_devspace_prior_history_handoff_and_validation(self):
        prior = "REQ_20261011T120000Z_0001"
        binding = {**self.binding, "conversationUrl": CHAT, "priorRequestId": prior}
        page = SimpleNamespace(url=CHAT, close=lambda: None)
        class Factory:
            def __enter__(self): self.chromium = self; return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, *args, **kwargs): return self
            @property
            def contexts(self): return [self]
            def new_page(self): return page
        refused = {"ok": False, "code": "EXISTING_CHAT_NOT_CONFIRMED", "sendState": "PROVEN_NOT_SENT",
                   "details": {"reason": "history_prior_anchor_missing"}}
        with patch.object(web.browser_submit, "submit_existing_prompt", return_value=refused) as sent:
            bridge = web.WebWorkerBridge(root=self.channel / "handoff")
            result = bridge.run_request(REQ, task_url="", prompt="private task", expected_filename="",
                expected_request={"transportKind": "devspace"}, conversation_url=CHAT,
                devspace_binding=binding, artifact_mode=False, playwright_factory=Factory)
        sent.assert_called_once()
        self.assertEqual(sent.call_args.kwargs["prior_request_id"], prior)
        self.assertEqual(result["details"]["details"]["details"]["reason"], "history_prior_anchor_missing")
        with patch.object(web.browser_submit, "submit_existing_prompt", return_value=refused) as sent:
            bridge = web.WebWorkerBridge(root=self.channel / "without-old-anchor")
            bridge.run_request(REQ, task_url="", prompt="private task", expected_filename="",
                expected_request={"transportKind": "devspace"}, conversation_url=CHAT,
                devspace_binding={**binding, "priorRequestId": None}, artifact_mode=False,
                playwright_factory=Factory)
        sent.assert_called_once()
        self.assertNotIn("prior_request_id", sent.call_args.kwargs)
        for candidate in ("bad", REQ):
            with self.subTest(candidate=candidate):
                bridge = web.WebWorkerBridge(root=self.channel / ("bad-" + str(candidate)))
                with patch.object(web.browser_bootstrap, "_load_sync_playwright", side_effect=AssertionError("no attach")):
                    result = bridge.run_request(REQ, task_url="", prompt="private task", expected_filename="",
                        expected_request={"transportKind": "devspace"}, conversation_url=CHAT,
                        devspace_binding={**binding, "priorRequestId": candidate}, artifact_mode=False)
                self.assertEqual(result["code"], web.BRIDGE_INVALID_CONFIG)
                self.assertEqual(result["details"]["reason"], "invalid_prior_request_id")

    def test_transport_rejects_unsafe_dynamic_message_and_reason(self):
        fields = transport._safe_transport_evidence({
            "transportCode": "SECRET_NOT_AN_AUTHORIZED_CODE",
            "transportMessage": "PRIVATE_SECRET_VALUE https://chatgpt.com/c/foreign",
            "sendProof": {"sendState": "PROVEN_NOT_SENT", "proofClass": "PROVEN_NOT_SENT",
                          "private": "PRIVATE_SECRET_VALUE"},
            "details": {"code": "SUBMIT_INVALID_CONFIG", "sendState": "PROVEN_NOT_SENT",
                        "details": {"reason": "PRIVATE_SECRET_VALUE",
                                    "presendOwnership": {"ownedUrlEqual": False,
                                        "expectedUserTurnCount": 999999999,
                                        "userTurnSelectorFamily": "PRIVATE_SECRET_VALUE"}}}})
        self.assertEqual(fields["sendProof"], {"sendState": "PROVEN_NOT_SENT", "proofClass": "PROVEN_NOT_SENT"})
        self.assertNotIn("transportCode", fields)
        self.assertNotIn("transportMessage", fields)
        self.assertNotIn("reason", fields["submitProof"])
        self.assertEqual(fields["submitProof"]["presendOwnership"], {"ownedUrlEqual": False})
        self.assertNotIn("PRIVATE_SECRET_VALUE", json.dumps(fields))
        self.assertEqual(transport._safe_transport_evidence({
            "sendProofClass": [], "sendProof": {"sendState": {}},
            "details": {"code": [], "sendState": [], "details": {
                "reason": {}, "presendOwnership": {"userTurnSelectorFamily": []}}}}), {})

    def test_recovery_observes_old_req_then_sends_distinct_corrective_req(self):
        old = "REQ_20261011T120000Z_0001"
        binding = {**self.binding, "conversationUrl": CHAT,
                   "recovery": {"sourceRequestId": old, "attempt": 2, "intent": "observe-then-continue"}}
        events = []
        page = SimpleNamespace(url=CHAT, close=lambda: None,
            goto=lambda *args, **kwargs: events.append("open-owned-chat"))
        class Factory:
            def __enter__(self): self.chromium = self; return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, *args, **kwargs): return self
            @property
            def contexts(self): return [self]
            def new_page(self): return page
        old_prompt = "POSTMAN_REQUEST_ID: " + old + "\noriginal work"
        prompt = "POSTMAN_REQUEST_ID: " + REQ + "\nCheck what was done and continue missing work"
        def read_history(_page, source):
            self.assertEqual(source, old)
            events.append("observe-source")
            return [old_prompt], ""
        def send(_page, text, url, **kwargs):
            events.append("send-new-req")
            self.assertEqual(text, prompt)
            self.assertEqual(url, CHAT)
            self.assertFalse(kwargs["navigate"])
            return {"ok": False, "code": "PROMPT_SEND_UNKNOWN", "sendState": "PROVEN_NOT_SENT"}
        bridge = web.WebWorkerBridge(root=self.channel / "recovery")
        with patch.object(web.browser_submit, "_read_user_history", side_effect=read_history), \
             patch.object(web.browser_observer, "snapshot_turns", return_value=([
                 {"index": 0, "role": "user", "text": old_prompt},
                 {"index": 1, "role": "assistant", "text": "old partial evidence"}], "fixture")), \
             patch.object(observer, "stop_control", return_value=("ABSENT", None)), \
             patch.object(web.browser_submit, "submit_existing_prompt", side_effect=send):
            result = bridge.run_request(REQ, task_url="", prompt=prompt, expected_filename="",
                expected_request={"transportKind": "devspace"}, conversation_url=CHAT,
                devspace_binding=binding, artifact_mode=False, playwright_factory=Factory)
        self.assertEqual(events, ["open-owned-chat", "observe-source", "send-new-req"])
        saved = bridge.read_state(REQ)["recoveryObservation"]
        self.assertTrue(saved["messageObserved"])
        self.assertEqual(saved["sourceRequestId"], old)
        self.assertEqual(saved["assistantText"], "old partial evidence")
        self.assertNotEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")

    def test_fresh_recovery_without_url_or_source_req_uses_new_owned_send(self):
        for source in (None, "REQ_20261011T120000Z_0001"):
            with self.subTest(source=source):
                binding = {**self.binding, "recovery": {
                    "sourceRequestId": source, "attempt": 1, "intent": "observe-then-continue"}}
                page = SimpleNamespace(url="https://chatgpt.com/", close=lambda: None)
                class Factory:
                    def __enter__(self): self.chromium = self; return self
                    def __exit__(self, *args): pass
                    def connect_over_cdp(self, *args, **kwargs): return self
                    @property
                    def contexts(self): return [self]
                    def new_page(self): return page
                bridge = web.WebWorkerBridge(root=self.channel / ("fresh-recovery-" + str(source)))
                with patch.object(web.browser_submit, "submit_fresh_prompt", return_value={
                         "ok": True, "sendState": "PROVEN_SENT", "details": {"chatUrl": CHAT}}) as fresh, \
                     patch.object(web.browser_submit, "submit_existing_prompt", side_effect=AssertionError("no saved chat")), \
                     patch.object(observer, "wait_for_signal", return_value={"ok": True,
                         "code": "DEVSPACE_DIAGNOSTIC", "details": {"source": "transport_diagnostic", "diagnostic": "UNKNOWN"}}):
                    bridge.run_request(REQ, task_url="", prompt="inspect current state before any continuation",
                        expected_filename="", expected_request={"transportKind": "devspace"},
                        devspace_binding=binding, artifact_mode=False, playwright_factory=Factory)
                fresh.assert_called_once()
                self.assertEqual(bridge.read_state(REQ)["recoveryObservation"]["observationReason"], "conversation_not_created")
                self.assertTrue(bridge.read_state(REQ)["recoveryObservation"]["newMessageSent"])

    def test_revocation_stops_monitor_without_claiming_shell_termination(self):
        receipt = {key: self.binding[key] for key in signal.IDENTITY if key != "capability"}
        (self.channel / "revoked.json").write_text(json.dumps(receipt), encoding="utf-8")
        with patch.object(observer.observer, "observe_next_assistant", side_effect=AssertionError("no UI action")):
            result = observer.wait_for_signal(SimpleNamespace(url=CHAT), "old", CHAT, self.binding,
                timeout_ms=14000, interval_ms=1000, count=3,
                sleep=lambda _: None, monotonic=lambda: 0, persist=lambda _: None)
        self.assertEqual(result["details"]["diagnostic"], "REVOKED")
        self.assertIn("may continue", result["details"]["message"])

    def test_late_source_bell_suppresses_recovery_send_without_completing_new_req(self):
        source_id = "REQ_20261011T120000Z_0001"
        source_job = "22222222-2222-4222-8222-222222222222"
        source_channel = self.root / source_job
        source_channel.mkdir()
        source_binding = {**self.binding, "jobId": source_job, "requestId": source_id,
                          "channel": str(source_channel)}
        (source_channel / "binding.json").write_text(json.dumps(source_binding), encoding="utf-8")
        recovery_binding = {**self.binding, "conversationUrl": CHAT,
            "recovery": {"sourceRequestId": source_id, "sourceChannel": str(source_channel),
                         "attempt": 1, "intent": "observe-then-continue"}}
        page = SimpleNamespace(url=CHAT, close=lambda: None, goto=lambda *args, **kwargs: None)
        class Factory:
            def __enter__(self): self.chromium = self; return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, *args, **kwargs): return self
            @property
            def contexts(self): return [self]
            def new_page(self): return page
        for outcome, expected, message in (("done", "DONE", "ready"),
                ("blocked", "BLOCKED", "temporary Bash failure " + "x" * 2100),
                ("need-decision", "NEED_DECISION", "new permission required")):
            with self.subTest(outcome=outcome):
                signal.signal(source_channel, source_binding["capability"], outcome, message=message, root=self.root)
                with patch.object(web.browser_submit, "submit_existing_prompt", side_effect=AssertionError("no new Send")):
                    bridge = web.WebWorkerBridge(root=self.channel / ("late-source-" + outcome))
                    result = bridge.run_request(REQ, task_url="", prompt="new corrective prompt", expected_filename="",
                        expected_request={"transportKind": "devspace"}, conversation_url=CHAT,
                        devspace_binding=recovery_binding, artifact_mode=False, playwright_factory=Factory)
                self.assertEqual(result["code"], "DEVSPACE_DIAGNOSTIC")
                self.assertEqual(result["details"]["diagnostic"], "UNKNOWN")
                self.assertNotIn("reportedOutcome", result["details"])
                self.assertTrue(result["details"]["recoverySourceCompleted"])
                self.assertEqual(result["details"]["recoverySourceOutcome"], expected)
                self.assertEqual(result["details"]["recoverySourceMessage"], message[:2000])
                safe = transport._safe_transport_evidence(result["details"])
                self.assertEqual(safe["recoverySourceOutcome"], expected)
                self.assertEqual(safe["recoverySourceMessage"], message[:2000])
                self.assertEqual(signal.read_event(source_binding)["reportedOutcome"], expected)
                self.assertIsNone(signal.read_event(self.binding))
                (source_channel / "event.json").unlink()
        def observe_new(*args, **kwargs):
            signal.signal(source_channel, source_binding["capability"], "done", root=self.root)
            self.assertTrue(page._postman_action_guard())  # old bell cannot fence the new REQ
            return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {
                "source": "transport_diagnostic", "diagnostic": "UNKNOWN", "assistantText": ""}}
        with patch.object(web.browser_submit, "submit_existing_prompt", return_value={
                 "ok": True, "sendState": "PROVEN_SENT", "details": {"chatUrl": CHAT}}), \
             patch.object(web.browser_submit, "_read_user_history", return_value=([], "history_prior_anchor_missing")), \
             patch.object(observer, "stop_control", return_value=("ABSENT", None)), \
             patch.object(observer, "wait_for_signal", side_effect=observe_new):
            bridge = web.WebWorkerBridge(root=self.channel / "source-after-new-send")
            new_result = bridge.run_request(REQ, task_url="", prompt="new corrective prompt", expected_filename="",
                expected_request={"transportKind": "devspace"}, conversation_url=CHAT,
                devspace_binding=recovery_binding, artifact_mode=False, playwright_factory=Factory)
        self.assertEqual(new_result["details"]["diagnostic"], "UNKNOWN")
        self.assertNotIn("recoverySourceCompleted", new_result["details"])
        self.assertIsNone(signal.read_event(self.binding))

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
                     "details": {"chatUrl": None, "exactUserTurn": False}}
        with patch.object(web.browser_submit, "submit_fresh_prompt", return_value=uncertain) as submit, \
             patch.object(web.browser_observer, "observe_next_assistant",
                          side_effect=AssertionError("unknown Send must not use text observer")), \
             patch.object(observer, "wait_for_bell_after_unknown_send",
                          wraps=observer.wait_for_bell_after_unknown_send) as waiting:
            bridge = web.WebWorkerBridge(root=self.channel / "web", sleep=sleep,
                                         monotonic=lambda: clock[0])
            result = bridge.run_request(REQ, task_url="", prompt="private task",
                expected_filename="", expected_request={"transportKind": "devspace"},
                devspace_binding=self.binding, artifact_mode=False,
                playwright_factory=Factory, observer_timeout_ms=4000,
                reminder_interval_ms=1000, max_reminders=3)
        submit.assert_called_once()
        self.assertEqual(waiting.call_args.kwargs["interval_ms"], 1000)
        self.assertEqual(waiting.call_args.kwargs["count"], 3)
        self.assertTrue(callable(waiting.call_args.kwargs["persist"]))
        self.assertIs(waiting.call_args.kwargs["page"], page)
        self.assertEqual(waiting.call_args.kwargs["prompt"], "private task")
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(result["details"]["reportedOutcome"], "DONE")
        self.assertEqual(result["details"]["sendState"], "UNKNOWN")
        self.assertEqual(bridge.read_state(REQ)["state"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertTrue(result["details"]["browserCleanup"]["ownedPageClosed"])


    def test_unknown_send_proven_exact_req_promotes_to_timed_reminders(self):
        # Unknown initial click is NOT a failed task if the exact user turn
        # subsequently appears in the original ChatGPT conversation.
        page = SimpleNamespace(url=CHAT)
        prompt = task.render_task(self.binding, "continue development", "pwsh -File signal.ps1")
        turns = [{"index": 0, "role": "user",
                  "text": "POSTMAN_REQUEST_ID: " + REQ + "\n# Markdown re-rendered"}]
        clock = [0.0]
        records = []
        def timed(page_arg, original, chat, binding, **opts):
            self.assertIs(page_arg, page)
            self.assertEqual(original, prompt)
            self.assertEqual(chat, CHAT)
            self.assertIs(binding, self.binding)
            self.assertEqual(opts["started_at"], 0.0,
                             "the 15-minute clock must not restart on late REQ proof")
            self.assertEqual(opts["interval_ms"], 1000)
            self.assertEqual(opts["count"], 3)
            self.assertTrue(callable(opts["persist"]))
            return {"ok": True, "code": "DEVSPACE_SIGNAL_RECEIVED",
                    "details": {"reportedOutcome": "DONE", "reminderSlots": [
                        {"slot": 1, "status": "SENT_CONFIRMED"}]}}
        with patch.object(observer.observer, "snapshot_turns",
                          return_value=(turns, "turns")), \
             patch.object(observer.image_output, "observe_owned_image", return_value=None), \
             patch.object(observer, "wait_for_signal", side_effect=timed) as promoted, \
             patch.object(observer.controls, "process_one",
                          side_effect=AssertionError("timed handler owns future controls")):
            result = observer.wait_for_bell_after_unknown_send(
                self.binding, timeout_ms=60_000,
                sleep=lambda x: clock.__setitem__(0, clock[0] + x),
                monotonic=lambda: clock[0], page=page, prompt=prompt,
                conversation_ref=CHAT, interval_ms=1000, count=3,
                persist=records.append)
        promoted.assert_called_once()
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(result["details"]["sendState"], "UNKNOWN")
        self.assertEqual(result["details"]["reminderSlots"][0]["status"], "SENT_CONFIRMED")

    def test_unknown_send_without_bell_yields_diagnostic_no_false_done(self):
        clock = [0.0]
        result = observer.wait_for_bell_after_unknown_send(self.binding, timeout_ms=1000,
            sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
            monotonic=lambda: clock[0], conversation_ref=CHAT)
        self.assertEqual(result["code"], "DEVSPACE_DIAGNOSTIC")
        self.assertEqual(result["details"]["sendState"], "UNKNOWN")
        self.assertEqual(result["details"]["diagnostic"], "BLOCKED")
        self.assertFalse((self.channel / "event.json").exists())

    def test_unknown_send_recovers_late_owned_chat_url_without_resending(self):
        page = SimpleNamespace(url=CHAT)
        prompt = task.render_task(self.binding, "Read source", "pwsh -File signal.ps1")
        turns = [{"index":0, "role":"user", "text":
                  "POSTMAN_REQUEST_ID: " + REQ + chr(10) + "# Changed rendered Markdown"}]
        clock=[0.0]
        def sleep(seconds):
            clock[0]+=seconds
            if clock[0] >= 1 and not (self.channel/"event.json").exists():
                self.emit(message="late bound chat")
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns,"family")),              patch.object(observer.controls, "process_one", return_value=None) as control,              patch.object(observer.observer, "observe_next_assistant",
                          return_value={"ok":False,"code":"ASSISTANT_NOT_STARTED","details":{}}),              patch.object(observer.image_output, "observe_owned_image", return_value=None):
            result=observer.wait_for_bell_after_unknown_send(self.binding,
                timeout_ms=4000, sleep=sleep, monotonic=lambda:clock[0],
                conversation_ref=None, page=page, prompt=prompt)
        self.assertEqual(result["code"],"DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(result["details"]["reportedOutcome"],"DONE")
        self.assertEqual(result["details"]["conversationRef"],CHAT)
        self.assertEqual(result["details"]["sendState"],"UNKNOWN")
        self.assertLessEqual(control.call_count,1)


    def test_unknown_send_late_chat_proof_keeps_original_check_schedule(self):
        page = SimpleNamespace(url=CHAT)
        prompt = task.render_task(self.binding, "original task", "pwsh -File signal.ps1")
        turns = [{"index": 0, "role": "user",
                  "text": "POSTMAN_REQUEST_ID: " + REQ + "\n# Rendered markdown"}]
        clock = [0.0]
        def snapshots(*args, **kwargs):
            # A ChatGPT conversation link/turn can appear only after the
            # original 15-minute check has become due.
            return ((turns if clock[0] >= 2 else []), "turns")
        def timed(page_arg, original, chat, binding, **opts):
            self.assertGreaterEqual(clock[0], 2)
            self.assertEqual(chat, CHAT)
            self.assertEqual(opts["started_at"], 0.0,
                             "late proof must not grant a new 15-minute wait")
            self.assertEqual(opts["interval_ms"], 1000)
            self.assertEqual(opts["count"], 3)
            return {"ok": True, "code": "DEVSPACE_DIAGNOSTIC",
                    "details": {"diagnostic": "BLOCKED", "source": "transport_diagnostic"}}
        with patch.object(observer.observer, "snapshot_turns", side_effect=snapshots), \
             patch.object(observer.image_output, "observe_owned_image", return_value=None), \
             patch.object(observer, "wait_for_signal", side_effect=timed) as promoted:
            outcome = observer.wait_for_bell_after_unknown_send(
                self.binding, timeout_ms=5000, interval_ms=1000, count=3,
                sleep=lambda t: clock.__setitem__(0, clock[0] + t),
                monotonic=lambda: clock[0], conversation_ref=None,
                page=page, prompt=prompt, persist=lambda _: None)
        promoted.assert_called_once()
        self.assertEqual(outcome["details"]["sendState"], "UNKNOWN")

    def test_unknown_send_late_chat_url_keeps_text_fallback(self):
        prompt = task.render_task(self.binding, "Read source", "pwsh -File signal.ps1")
        turns = [{"index":0, "role":"user", "text":"POSTMAN_REQUEST_ID: " + REQ}]
        clock=[0.0]
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns,"family")),              patch.object(observer.controls, "process_one", return_value=None),              patch.object(observer.image_output, "observe_owned_image", return_value=None),              patch.object(observer.observer, "observe_next_assistant", return_value={
                 "ok":True,"code":"ASSISTANT_COMPLETED",
                 "details":{"assistantText":"CAPABILITY_UNAVAILABLE: external web provider absent"}}):
            result=observer.wait_for_bell_after_unknown_send(
                self.binding, timeout_ms=20000,
                sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds),
                monotonic=lambda:clock[0], conversation_ref=None,
                page=SimpleNamespace(url=CHAT), prompt=prompt)
        self.assertEqual(result["code"],"DEVSPACE_DIAGNOSTIC")
        self.assertEqual(result["details"]["source"],"text_fallback")
        self.assertEqual(result["details"]["diagnostic"],"UNKNOWN")
        self.assertEqual(result["details"]["conversationRef"],CHAT)
        self.assertFalse((self.channel/"event.json").exists())

    def test_unknown_send_does_not_bind_foreign_or_later_user_turn(self):
        prompt = task.render_task(self.binding, "Read source", "pwsh -File signal.ps1")
        exact={"index":0,"role":"user","text":"POSTMAN_REQUEST_ID: "+REQ}
        foreign={"index":0,"role":"user","text":"POSTMAN_REQUEST_ID: REQ_other"}
        later={"index":1,"role":"user","text":"Another later user task"}
        self.emit(message="bell is delivered regardless of URL proof")
        for turns in [[foreign],[exact,later]]:
            with self.subTest(turns=turns),                  patch.object(observer.observer, "snapshot_turns", return_value=(turns,"family")),                  patch.object(observer.controls, "process_one",
                              side_effect=AssertionError("no control without owned turn")):
                result=observer.wait_for_bell_after_unknown_send(
                    self.binding, timeout_ms=1000, sleep=lambda _:None,
                    monotonic=lambda:0.0, conversation_ref=None,
                    page=SimpleNamespace(url=CHAT),prompt=prompt)
            self.assertEqual(result["code"],"DEVSPACE_SIGNAL_RECEIVED")
            self.assertIsNone(result["details"]["conversationRef"])

    def test_unknown_send_unproven_anchor_remains_bell_only(self):
        page = SimpleNamespace(url=CHAT)
        prompt = task.render_task(self.binding, "read README", "pwsh -File signal.ps1")
        clock = [0.0]
        turns = [{"index": 0, "role": "user", "text": "unrelated user turn"}]
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns, "family")), \
             patch.object(observer.controls, "process_one",
                          side_effect=AssertionError("unproven turn may not mutate browser")) as action, \
             patch.object(observer, "wait_for_signal",
                          side_effect=AssertionError("unproven turn must not enable reminders")) as timed, \
             patch.object(observer.observer, "observe_next_assistant",
                          side_effect=AssertionError("unproven turn may not supply text")):
            result = observer.wait_for_bell_after_unknown_send(self.binding,
                timeout_ms=1500, sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds),
                monotonic=lambda: clock[0], conversation_ref=CHAT, page=page, prompt=prompt,
                interval_ms=1000, count=3, persist=lambda _: None)
        self.assertEqual(result["details"]["diagnostic"], "BLOCKED")
        action.assert_not_called()
        timed.assert_not_called()

    def test_unknown_send_active_tool_allows_one_addressed_leader_stop(self):
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
        clicks = []
        def sleep(seconds):
            clock[0] += seconds
            if clock[0] >= 2.0 and not (self.channel / "event.json").exists():
                self.emit(message="original DevSpace tool completed safely")
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns, "family")), \
             patch.object(observer, "activity_snapshot", return_value={"state": "ACTIVE_TOOL"}), \
             patch.object(observer, "stop_control",
                          side_effect=lambda *_: (("ABSENT", None) if clicks else
                              ("PRESENT", SimpleNamespace(click=lambda **kwargs: clicks.append(clock[0]))))), \
             patch.object(observer.submit, "submit_existing_prompt", return_value={"sendState": "PROVEN_NOT_SENT"}), \
             patch.object(observer.observer, "observe_next_assistant",
                          return_value={"ok": False, "code": "ASSISTANT_NOT_STARTED", "details": {}}):
            result = observer.wait_for_bell_after_unknown_send(self.binding,
                timeout_ms=6000, sleep=sleep, monotonic=lambda: clock[0],
                conversation_ref=CHAT, page=page, prompt=prompt)
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(result["details"]["reportedOutcome"], "DONE")
        self.assertEqual(len(clicks), 1)
        self.assertTrue((folder / (control_id + ".ack.json")).exists())
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
        self.assertEqual(result["details"]["diagnostic"], "UNKNOWN")
        self.assertEqual(result["details"]["sendState"], "UNKNOWN")
        self.assertFalse((self.channel / "event.json").exists())
        self.assertGreaterEqual(clock[0], 12)
        self.assertTrue(actions.called)

    def run_checks(self, *, state="SAFE_GENERATION", delay=0, send_ready=True, send_state="PROVEN_SENT", on_stop=None, on_send=None, complete=False, before_check=None, stop_present=True, stop_raises=False, url_change=False, bad_req=False, foreign_turn=False, foreign_url=False, prestop_complete=False, binding=None, chat_url=CHAT, stop_unknown=False,
                   stop_unknown_until=None, result_stage=None, composer_delay=0, missing_history=False,
                   on_persist=None, newer_user_after=None):
        clock = [0.0]
        binding = binding or self.binding
        request_id = binding["requestId"]
        clicks, checks, snapshots, sent_prompts = [], [], [], []
        original = "POSTMAN_REQUEST_ID: " + ("REQ_20261012T120000Z_9999" if bad_req else request_id) + "\nprivate task"
        page = SimpleNamespace(url=chat_url + "-foreign" if foreign_url else chat_url)
        turns = [{"index":0, "role":"user", "text":original},
                 {"index":1, "role":"assistant", "text":"partial"}]
        if missing_history:
            turns.clear()
        if foreign_turn:
            turns.append({"index":2, "role":"user", "text":"foreign newer turn"})
        def sleep(seconds): clock[0] += seconds
        def stop_click(**kwargs):
            clicks.append(clock[0])
            if url_change: page.url = "https://chatgpt.com/c/foreign"
            if on_stop: on_stop()
            if stop_raises: raise RuntimeError("ambiguous Stop")
        button = SimpleNamespace(click=stop_click)
        def is_ready():
            return bool(clicks) and len(clicks)>len(sent_prompts) and clock[0] >= clicks[-1] + delay
        def activity(*args, **kwargs):
            checks.append(clock[0])
            if before_check: before_check()
            post = is_ready()
            return {"state": (state if state in ("ACTIVE_TOOL","TEXT_STREAMING","UNKNOWN") else "IDLE") if post else state,
                    "stopState":"ABSENT" if post else "PRESENT", "reason":"fixture"}
        def stop(*args, **kwargs):
            if stop_unknown or (stop_unknown_until is not None and clock[0] < stop_unknown_until):
                return "UNKNOWN", None
            return ("ABSENT",None) if not stop_present or is_ready() else ("PRESENT",button)
        def hydration(*args, **kwargs):
            checks.append(clock[0])
            ready = send_ready and (not clicks or clock[0] >= clicks[-1] + composer_delay)
            return {"ok":ready, "details":{"composerEmpty":ready}}
        def observe(*args, **kwargs):
            sleep(0.2)
            reproving = kwargs.get("stable_ms") == 0
            stage_complete = result_stage == "after_stop" and bool(clicks) and reproving
            stopped_partial = result_stage == "partial_after_stop" and bool(clicks) and reproving
            done = complete or (prestop_complete and reproving) or stage_complete or stopped_partial
            text = "готовый ответ" if stage_complete else "частичный произвольный текст"
            phase = {"phase": observer.observer.FINAL_ANSWER_COMPLETED,
                     "phaseSource": "response_actions_and_inactive_control",
                     "finalUnitProven": True, "completionControlFound": True}
            return {"ok":done, "code":observer.observer.ASSISTANT_TURN_COMPLETED if done else
                    observer.observer.CHAT_CORRELATION_LOST if missing_history else observer.observer.ASSISTANT_TURN_TIMEOUT,
                    "details":{"assistantText":text, **({"answerPhase":phase} if done else {})}}
        def send(*args, **kwargs):
            self.assertEqual(kwargs["control_intent"]["requestId"], request_id)
            self.assertEqual(args[2], chat_url)
            self.assertIn("Не начинай исходную задачу заново", args[1])
            self.assertIn("local bell", args[1])
            self.assertIn("phase_probe", kwargs)
            intent = kwargs["control_intent"]
            self.assertEqual(intent["promptSha256"], observer.submit.prompt_sha256(args[1]))
            if send_state == "PROVEN_SENT":
                turns.extend([{"index":len(turns), "role":"user", "text":args[1]},
                              {"index":len(turns)+1, "role":"assistant", "text":"running"}])
                sent_prompts.append(args[1])
            if on_send: on_send(kwargs["phase_probe"])
            return {"sendState":send_state, "details":{}}
        sent = unittest.mock.Mock(side_effect=send)
        def persist(value):
            snapshots.append(value)
            if on_persist:
                on_persist(value)
        def existing_send(*args, **kwargs):
            return sent(*args, control_intent=snapshots[-1]["controlIntent"],
                        phase_probe=lambda: {"phase": observer.observer.WORKING})
        def snapshot(*args, **kwargs):
            if newer_user_after and any(e["event"] == newer_user_after
                    for value in snapshots for e in value["transportEventJournal"]) and not any(
                    t["text"] == "new manual assignment" for t in turns):
                turns.append({"index": len(turns), "role": "user", "text": "new manual assignment"})
            return turns, "turns"
        with patch.object(observer.observer, "observe_next_assistant", side_effect=observe), \
             patch.object(observer.observer, "connection_interrupted", return_value=(False, {})), \
             patch.object(observer.observer, "snapshot_turns", side_effect=snapshot), \
             patch.object(observer, "activity_snapshot", side_effect=activity), \
             patch.object(observer, "stop_control", side_effect=stop), \
             patch.object(observer.submit, "prepare_existing_chat", side_effect=hydration), \
             patch.object(observer.submit, "submit_existing_prompt", side_effect=existing_send), \
             patch.object(observer.reminder_policy, "submit_reminder", new=sent):
            result = observer.wait_for_signal(page, original, chat_url, binding,
                timeout_ms=14000, interval_ms=1000, count=3, sleep=sleep, monotonic=lambda:clock[0],
                persist=persist)
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

    def test_due_activity_never_defers_stop_and_continue(self):
        for state in ["SAFE_GENERATION", "ACTIVE_TOOL", "TEXT_STREAMING", "UNKNOWN"]:
            with self.subTest(state=state):
                (self.channel / "event.json").unlink(missing_ok=True)
                def completed(_probe):
                    self.emit()
                result, clicks, checks, sent, snapshots = self.run_checks(state=state, on_send=completed)
                self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
                self.assertEqual(len(clicks), 1)
                sent.assert_called_once()
                self.assertTrue(any(s["reminderSlots"][0]["status"] == "SENT_CONFIRMED" for s in snapshots))

    def test_missing_composer_or_unsettled_stop_waits_to_task_deadline(self):
        for delay, ready in [(0,False),(20,True)]:
            with self.subTest(delay=delay):
                result, clicks, checks, sent, _ = self.run_checks(delay=delay, send_ready=ready)
                self.assertEqual(len(clicks),1)
                sent.assert_not_called()
                self.assertEqual(result["details"]["diagnostic"],"BLOCKED")
                self.assertLessEqual(max(checks),14)
                self.assertIn("not proven",result["details"]["message"])

    def test_slow_composer_beyond_ten_seconds_sends_one_saved_continuation(self):
        result, clicks, checks, sent, snapshots = self.run_checks(
            state="ACTIVE_TOOL", composer_delay=11, on_send=lambda _: self.emit())
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(len(clicks), 1)
        sent.assert_called_once()
        self.assertGreaterEqual(max(checks) - clicks[0], 11)
        self.assertTrue(any(e["event"] == "CONTINUATION_WAITING_COMPOSER"
                            for snapshot in snapshots for e in snapshot["transportEventJournal"]))

    def test_send_unknown_is_terminal_no_second_stop_or_send(self):
        result, clicks, _, sent, _ = self.run_checks(send_state="UNKNOWN")
        self.assertEqual(len(clicks),1)
        sent.assert_called_once()
        self.assertIn("no resend",result["details"]["message"])

    def test_absent_stop_direct_send_or_bounded_unready(self):
        def bell_on_send(_probe): self.emit()
        result, clicks, _, sent, snapshots = self.run_checks(
            state="ACTIVE_TOOL", stop_present=False, on_send=bell_on_send)
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(clicks, [])
        sent.assert_called_once()
        self.assertTrue(any(s["reminderSlots"][0]["status"] == "SENT_CONFIRMED" for s in snapshots))
        (self.channel / "event.json").unlink()
        blocked, clicks, _, sent, _ = self.run_checks(stop_present=False, send_ready=False)
        self.assertEqual(clicks, [])
        sent.assert_not_called()
        self.assertEqual(blocked["details"]["diagnostic"], "BLOCKED")
        self.assertEqual([s["status"] for s in blocked["details"]["reminderSlots"]],
                         ["BLOCKED_UNKNOWN", "PENDING", "PENDING"])

    def test_original_req_url_and_newer_user_guard_stop_and_send(self):
        for options in ({"bad_req": True}, {"foreign_url": True}):
            with self.subTest(options=options):
                result, clicks, _, sent, _ = self.run_checks(**options)
                self.assertEqual(clicks, [])
                sent.assert_not_called()
                self.assertEqual(result["details"]["diagnostic"], "BLOCKED")
        result, clicks, _, sent, _ = self.run_checks(url_change=True)
        self.assertEqual(len(clicks), 1)
        sent.assert_not_called()
        self.assertEqual(result["details"]["reminderSlots"][0]["status"], "BLOCKED_UNKNOWN")

    def test_timer_owned_chat_missing_old_anchor_stops_and_sends_distinct_control(self):
        result, clicks, _, sent, snapshots = self.run_checks(missing_history=True,
            state="UNKNOWN", on_send=lambda _: self.emit())
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(len(clicks), 1)
        sent.assert_called_once()
        intent = next(s["controlIntent"] for s in snapshots if s.get("controlIntent"))
        self.assertTrue(intent["ownedConversationOnly"])
        self.assertEqual(intent["controlId"], REQ + ":reminder:1")

    def test_stale_timer_cannot_stop_or_send_after_positive_newer_user_turn(self):
        result, clicks, _, sent, _ = self.run_checks(foreign_turn=True, state="ACTIVE_TOOL")
        self.assertEqual(clicks, [])
        sent.assert_not_called()
        self.assertTrue(result["details"]["supersededByUserTurn"])

    def test_new_user_races_durable_stop_intent_and_pending_continuation(self):
        for stage, expected_stops in (("STOP_REQUESTED", 0), ("STOP_OBSERVED", 1)):
            with self.subTest(stage=stage):
                result, clicks, _, sent, _ = self.run_checks(state="UNKNOWN", newer_user_after=stage)
                self.assertEqual(len(clicks), expected_stops)
                sent.assert_not_called()
                self.assertTrue(result["details"]["supersededByUserTurn"])

    def test_timer_revocation_at_durable_stop_intent_prevents_actual_click_and_send(self):
        def revoke_at_stop(value):
            if any(e["event"] == "STOP_REQUESTED" for e in value["transportEventJournal"]):
                receipt = {key: self.binding[key] for key in signal.IDENTITY if key != "capability"}
                (self.channel / "revoked.json").write_text(json.dumps(receipt), encoding="utf-8")
        result, clicks, _, sent, _ = self.run_checks(state="ACTIVE_TOOL", on_persist=revoke_at_stop)
        self.assertEqual(result["details"]["diagnostic"], "REVOKED")
        self.assertEqual(clicks, [])
        sent.assert_not_called()

    def test_completion_newly_proved_at_due_prevents_stop(self):
        result, clicks, _, sent, snapshots = self.run_checks(prestop_complete=True)
        self.assertEqual(result["details"]["source"], "text_fallback")
        self.assertEqual(clicks, [])
        sent.assert_not_called()
        self.assertTrue(any(s["reminderSlots"][0]["status"] == "ATTEMPTING" for s in snapshots))
        self.assertEqual(result["details"]["reminderSlots"][0]["status"], "CANCELLED_RESULT_READY")

    def test_completed_result_after_stop_cancels_reminder_without_send(self):
        result, clicks, _, sent, _ = self.run_checks(result_stage="after_stop", state="ACTIVE_TOOL")
        self.assertEqual(len(clicks), 1)
        sent.assert_not_called()
        self.assertEqual(result["details"]["source"], "text_fallback")
        self.assertEqual(result["details"]["assistantText"], "готовый ответ")
        self.assertEqual([s["status"] for s in result["details"]["reminderSlots"]],
                         ["CANCELLED_RESULT_READY"] * 3)

    def test_stop_partial_must_not_masquerade_as_completed_result(self):
        def bell_after_send(_probe): self.emit()
        result, clicks, _, sent, _ = self.run_checks(
            result_stage="partial_after_stop", state="TEXT_STREAMING", on_send=bell_after_send)
        self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(len(clicks), 1)
        sent.assert_called_once()

    def test_ambiguous_stop_ui_aborts_without_click_or_send(self):
        result, clicks, _, sent, snapshots = self.run_checks(stop_unknown=True)
        self.assertEqual(result["details"]["diagnostic"], "BLOCKED")
        self.assertEqual(clicks, [])
        sent.assert_not_called()
        self.assertEqual(result["details"]["reminderSlots"][0]["status"], "BLOCKED_UNKNOWN")
        self.assertTrue(any(e["event"] == "STOP_UNPROVED" for e in result["details"]["transportEventJournal"]))

    def test_transient_unknown_stop_is_observed_without_retrying_click(self):
        for absent in (False, True):
            with self.subTest(absent=absent):
                (self.channel / "event.json").unlink(missing_ok=True)
                def bell_after_send(_probe): self.emit()
                result, clicks, _, sent, journal = self.run_checks(
                    state="UNKNOWN", stop_unknown_until=2.5, stop_present=not absent,
                    on_send=bell_after_send)
                self.assertEqual(result["code"], "DEVSPACE_SIGNAL_RECEIVED")
                self.assertEqual(len(clicks), 0 if absent else 1)
                sent.assert_called_once()
                self.assertEqual(result["details"]["reminderSlots"][0]["status"], "SENT_CONFIRMED")
                self.assertLessEqual(max(e["elapsedMs"] for e in
                    result["details"]["transportEventJournal"] if e["event"] == "STOP_OBSERVED"), 11000)

    def test_persistent_unknown_stop_is_bounded_read_only(self):
        result, clicks, _, sent, _ = self.run_checks(stop_unknown=True)
        self.assertEqual(result["details"]["diagnostic"], "BLOCKED")
        self.assertEqual(clicks, [])
        sent.assert_not_called()
        journal = result["details"]["transportEventJournal"]
        self.assertTrue(any(e["event"] == "STOP_UNPROVED" for e in journal))
        self.assertEqual(sum(e["event"] == "STOP_REQUESTED" for e in journal), 0)
        check_at = next(e["elapsedMs"] for e in journal if e["event"] == "DEVSPACE_CHECK")
        observed_at = next(e["elapsedMs"] for e in journal if e["event"] == "STOP_OBSERVED")
        self.assertLessEqual(observed_at - check_at, 14000)
        self.assertLessEqual(observed_at, 14200)  # one in-flight read may settle at the deadline

    def test_stop_outcome_unknown_never_reclicke_and_deadline_is_honest(self):
        result, clicks, _, sent, snapshots = self.run_checks(stop_raises=True, delay=20)
        self.assertEqual(len(clicks), 1)
        sent.assert_not_called()
        self.assertEqual(result["details"]["diagnostic"], "BLOCKED")
        self.assertEqual(result["details"]["reminderSlots"][0]["status"], "BLOCKED_UNKNOWN")
        journal = result["details"]["transportEventJournal"]
        self.assertEqual(sum(e["event"] == "STOP_REQUESTED" for e in journal), 1)
        self.assertEqual(sum(e["event"] == "STOP_CLICK_UNKNOWN" for e in journal), 1)
        self.assertLessEqual(max(e["elapsedMs"] for e in journal), 14200)

    def test_three_confirmed_reminders_only_and_pinned_random_prompts(self):
        from continuation_prompts import CONTINUATION_TEMPLATES
        result, clicks, _, sent, snapshots = self.run_checks(state="ACTIVE_TOOL")
        self.assertEqual(len(clicks), 3)
        self.assertEqual(sent.call_count, 3)
        self.assertEqual([s["status"] for s in result["details"]["reminderSlots"]],
                         ["SENT_CONFIRMED"] * 3)
        self.assertEqual(result["details"]["diagnostic"], "PARTIAL")
        seen = {}
        for snapshot in snapshots:
            intent = snapshot.get("controlIntent")
            if not intent:
                continue
            cid = intent["controlId"]
            current = (intent["templateId"], intent["exactPromptText"], intent["promptSha256"])
            self.assertEqual(seen.setdefault(cid, current), current)
            self.assertTrue(intent["exactPromptText"].startswith(
                CONTINUATION_TEMPLATES[intent["templateId"] - 1]))
            self.assertEqual(intent["promptSha256"], observer.submit.prompt_sha256(intent["exactPromptText"]))
            self.assertNotIn("POSTMAN_REQUEST_ID", intent["exactPromptText"])
        self.assertEqual(len(seen), 3)
        self.assertEqual(len(CONTINUATION_TEMPLATES), 50)

    def test_two_independent_lanes_do_not_share_bell_slots_or_control_ids(self):
        second_req = "REQ_20261012T120000Z_0002"
        second_url = "https://chatgpt.com/c/devspace-other"
        second_channel = self.root / "22222222-2222-4222-8222-222222222222"
        second_channel.mkdir()
        second = {**self.binding, "requestId": second_req,
                  "jobId": second_channel.name, "channel": str(second_channel)}
        def finish_lane_a(_probe): self.emit()
        a, a_clicks, _, a_send, a_journal = self.run_checks(
            state="ACTIVE_TOOL", on_send=finish_lane_a)
        b, b_clicks, _, b_send, b_journal = self.run_checks(
            binding=second, chat_url=second_url, state="UNKNOWN")
        self.assertEqual(a["code"], "DEVSPACE_SIGNAL_RECEIVED")
        self.assertEqual(b["code"], "DEVSPACE_DIAGNOSTIC")
        self.assertEqual(a_send.call_count, 1)
        self.assertEqual(b_send.call_count, 3)
        self.assertEqual(len(a_clicks), 1)
        self.assertEqual(len(b_clicks), 3)
        self.assertEqual([s["status"] for s in a["details"]["reminderSlots"]],
                         ["SENT_CONFIRMED", "CANCELLED_RESULT_READY", "CANCELLED_RESULT_READY"])
        self.assertEqual([s["status"] for s in b["details"]["reminderSlots"]],
                         ["SENT_CONFIRMED"] * 3)
        self.assertEqual(a["details"]["controlIntent"]["requestId"], REQ)
        self.assertEqual(b["details"]["controlIntent"]["requestId"], second_req)
        self.assertNotEqual(a["details"]["controlIntent"]["controlId"],
                            b["details"]["controlIntent"]["controlId"])
        self.assertTrue(all(s["status"] == "SENT_CONFIRMED" for s in b_journal[-2]["reminderSlots"]))

    def test_multiple_stop_controls_not_unequivocally_own(self):
        class Candidate:
            def is_visible(self): return True
            def is_enabled(self): return True
        candidates = [Candidate(), Candidate()]
        class Locators:
            def __init__(self, selector):
                self.items = candidates if observer.observer.GENERATION_CONTROL_SELECTORS[0] in selector else []
            def count(self): return len(self.items)
            def nth(self, index): return self.items[index]
        class Semantic:
            def count(self): return 0
        page = SimpleNamespace(locator=lambda selector: Locators(selector),
                               get_by_role=lambda *a, **kw: Semantic())
        self.assertEqual(observer.stop_control(page), ("UNKNOWN", None))

    def test_cold_waiting_worker_does_not_replay_saved_stop_or_send(self):
        for saved_event in ("STOP_REQUESTED", "SEND_REQUESTED", "SEND_UNKNOWN"):
            with self.subTest(saved_event=saved_event):
                bridge = web.WebWorkerBridge(root=self.channel / ("cold-" + saved_event))
                req = web.BridgeRequest(REQ, "", str(bridge.result_path(REQ)), "cold")
                bridge._write_state(req, web.WAITING_ASSISTANT,
                    controlIntent={"controlId":REQ + ":reminder:1", "exactPromptText":"already pinned"},
                    reminderSlots=[{"slot":1,"status":"ATTEMPTING"}],
                    transportEventJournal=[{"event":saved_event,"slot":1}])
                with patch.object(web.browser_bootstrap, "_load_sync_playwright",
                                  side_effect=AssertionError("cold restore must not click")) as browser:
                    result = bridge.run_request(REQ, task_url="", prompt="POSTMAN_REQUEST_ID: " + REQ,
                        expected_filename="", expected_request={"transportKind":"devspace"},
                        artifact_mode=False, devspace_binding=self.binding)
                self.assertEqual(result["code"], web.WAITING_ASSISTANT)
                self.assertEqual(result["details"]["controlIntent"]["exactPromptText"], "already pinned")
                self.assertEqual(result["details"]["transportEventJournal"][0]["event"], saved_event)
                browser.assert_not_called()

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
