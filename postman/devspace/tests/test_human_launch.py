"""Human launch text and Host-owned public documents; no live browser/model."""
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from postman.devspace import transport
import artifact_detector

REQ = "REQ_20261019T060000Z_0001"
JOB = "11111111-1111-4111-8111-111111111111"
TASK_URL = "https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/" + "a" * 40 + "/tasks/" + JOB + ".md"
RULES_URL = "https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/" + "b" * 40 + "/postman/devspace/SKILL.md"
PROMPT = ("Пожалуйста, выполни задание. Перед началом обязательно прочитай задание и правила по ссылкам ниже и соблюдай их. "
          "Ответ оформи строго по формату из задания, включая обязательные маркеры. "
          "Если любой документ недоступен, сообщи об этом и не начинай работу.\n"
          "Задание: " + TASK_URL + "\nПравила: " + RULES_URL)


class HumanLaunchTests(unittest.TestCase):
    def test_linked_task_requires_exact_existing_result_markers(self):
        from postman.devspace import task
        with tempfile.TemporaryDirectory() as directory:
            binding = dict(requestId=REQ, jobId=JOB, mode="READ_ONLY", workspaceRef=directory,
                           writeRoot=None, channel=directory, capability="never-publish-this")
            document = task.render_task(binding, "Read README", "pwsh -File signal.ps1")
        self.assertIn(artifact_detector.result_begin_marker(REQ), document)
        self.assertIn(artifact_detector.result_end_marker(REQ), document)

    def test_transport_checks_response_markers_without_resending_or_replacing_bell(self):
        begin = artifact_detector.result_begin_marker(REQ)
        end = artifact_detector.result_end_marker(REQ)
        valid = begin + "\nПрочитан README.\n" + end
        cases = [(valid, True), ("Прочитан README.", False),
                 (valid.replace(REQ, "REQ_20261019T060000Z_0002"), False),
                 (valid.replace(end, ""), False), (valid + "\n" + end, False),
                 (end + "\nИтог\n" + begin, False),
                 (begin + "\n\n" + end, False),
                 (" " + valid, False), (valid + " ", False),
                 (valid.replace(end, artifact_detector.result_end_marker("REQ_20261019T060000Z_0002")), False),
                 ("```\n" + valid + "\n```", False),
                 (valid + "\nЛишний текст", False)]
        for response, expected in cases:
            for mode in ("READ_ONLY", "WRITE_ISOLATED"):
                with self.subTest(response=response, mode=mode), tempfile.TemporaryDirectory() as directory:
                    binding = dict(requestId=REQ, jobId=JOB, mode=mode, workspaceRef=directory,
                                   writeRoot=directory if mode != "READ_ONLY" else None,
                                   channel=directory, capability="never-publish-this")
                    class Bridge:
                        def __init__(self, **kwargs): pass
                        def run_request(self, request_id, **kwargs):
                            return {"code": "DEVSPACE_DIAGNOSTIC", "details": {
                                "source": "text_fallback", "diagnostic": "UNKNOWN", "assistantText": response}}
                    with patch.object(transport, "load_binding", return_value=binding), patch.object(
                            transport, "publish_assignment", return_value={"taskUrl": TASK_URL, "prompt": PROMPT}):
                        result = transport.run(directory, REQ, "Read README",
                            ensure_browser=lambda: {"cdpUrl": "fake"}, bridge_factory=Bridge)
                        again = transport.run(directory, REQ, "Read README",
                            ensure_browser=lambda: self.fail("must not resend"))
                    self.assertEqual(result, again)
                    self.assertEqual(result["assistantText"], response)
                    self.assertEqual(result["transportDiagnostics"]["resultMarkers"]["valid"], expected)
                    self.assertEqual(result["diagnostic"], "UNKNOWN" if expected else "RESULT_MARKERS_INVALID")
        with tempfile.TemporaryDirectory() as directory:
            binding = dict(requestId=REQ, channel=directory)
            class Bridge:
                def __init__(self, **kwargs): pass
                def run_request(self, request_id, **kwargs):
                    return {"code": "DEVSPACE_SIGNAL_RECEIVED", "details": {"reportedOutcome": "DONE"}}
            with patch.object(transport, "load_binding", return_value=binding), patch.object(
                    transport, "publish_assignment", return_value={"taskUrl": TASK_URL, "prompt": PROMPT}):
                result = transport.run(directory, REQ, "Read README",
                    ensure_browser=lambda: {"cdpUrl": "fake"}, bridge_factory=Bridge)
            self.assertEqual(result["source"], "bell")
            self.assertEqual(result["reportedOutcome"], "DONE")
            self.assertNotIn("resultMarkers", result["transportDiagnostics"])

    def test_recovered_reply_keeps_source_req_and_permission_diagnostic(self):
        source_req = "REQ_20261019T055959Z_0002"
        for reply_req in (source_req, REQ):
            with self.subTest(reply_req=reply_req), tempfile.TemporaryDirectory() as directory:
                binding = dict(requestId=REQ, channel=directory, recovery={"sourceRequestId": source_req})
                response = artifact_detector.result_begin_marker(reply_req) + "\nBLOCKED: permission denied\n" + artifact_detector.result_end_marker(reply_req)
                class Bridge:
                    def __init__(self, **kwargs): pass
                    def run_request(self, request_id, **kwargs):
                        return {"code": "DEVSPACE_DIAGNOSTIC", "details": {"source": "text_fallback",
                            "diagnostic": "BLOCKED", "recoverySourceCompleted": True, "assistantText": response}}
                with patch.object(transport, "load_binding", return_value=binding), patch.object(
                        transport, "publish_assignment", return_value={"taskUrl": TASK_URL, "prompt": PROMPT}):
                    result = transport.run(directory, REQ, "Observe previous task",
                        ensure_browser=lambda: {"cdpUrl": "fake"}, bridge_factory=Bridge)
                self.assertEqual(result["diagnostic"], "BLOCKED")
                self.assertEqual(result["transportDiagnostics"]["resultMarkers"],
                    {"valid": reply_req == source_req, "requestId": source_req})

    def test_transport_sends_only_human_text_and_two_github_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binding = dict(requestId=REQ, jobId=JOB, mode="READ_ONLY", workspaceRef=directory,
                           writeRoot=None, channel=directory, capability="never-publish-this")
            calls = []
            class Bridge:
                def __init__(self, **kwargs): pass
                def run_request(self, request_id, **kwargs):
                    calls.append(kwargs)
                    return {"details": {"source": "text_fallback", "assistantText": "done"}}
            with patch.object(transport, "load_binding", return_value=binding), patch.object(
                    transport, "publish_assignment", create=True,
                    return_value={"taskUrl": TASK_URL, "rulesUrl": RULES_URL, "prompt": PROMPT}):
                transport.run(root, REQ, "Only task-specific intent", ensure_browser=lambda: {"cdpUrl": "fake"}, bridge_factory=Bridge)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["prompt"], PROMPT)
            self.assertNotIn(REQ, calls[0]["prompt"])
            self.assertNotIn("Only task-specific intent", calls[0]["prompt"])
            self.assertNotIn("never-publish-this", calls[0]["prompt"])
            self.assertEqual(calls[0]["task_url"], TASK_URL)
