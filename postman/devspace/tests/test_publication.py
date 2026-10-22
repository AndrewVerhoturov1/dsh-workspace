import base64
import copy
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from postman import input_files
from postman.devspace import publication as pub


class GitHub:
    """In-memory Git data API; exercises the existing real transport publisher."""
    def __init__(self):
        self.head = None
        self.blobs = {}
        self.trees = {}
        self.commits = {}
        self.writes = []

    def api(self, endpoint, method="GET", payload=None):
        if method != "GET": self.writes.append((endpoint, method, payload))
        if "/git/ref/heads/" in endpoint:
            if not self.head: raise input_files.InputStageError("404")
            return {"object": {"sha": self.head}}
        if "/contents/" in endpoint:
            path, revision = endpoint.split("/contents/", 1)[1].split("?ref=")
            entries = self.trees[self.commits[revision]["tree"]]
            if path not in entries: raise input_files.InputStageError("404")
            return {"content": base64.b64encode(self.blobs[entries[path]]).decode()}
        if endpoint.endswith("/git/blobs"):
            key = str(len(self.blobs) + 1)
            self.blobs[key] = base64.b64decode(payload["content"])
            return {"sha": key}
        if endpoint.endswith("/git/trees"):
            entries = copy.copy(self.trees.get(payload.get("base_tree"), {}))
            entries.update({entry["path"]: entry["sha"] for entry in payload["tree"]})
            key = str(len(self.trees) + 100)
            self.trees[key] = entries
            return {"sha": key}
        if "/git/commits/" in endpoint:
            value = self.commits[endpoint.rsplit("/", 1)[-1]]
            return {"tree": {"sha": value["tree"]}}
        if endpoint.endswith("/git/commits"):
            key = f"{len(self.commits) + 1:040x}"
            self.commits[key] = payload
            return {"sha": key}
        if "/git/refs" in endpoint:
            self.head = payload["sha"]
            if method == "PATCH": assert payload["force"] is False
            return {}
        raise AssertionError(endpoint)

    def fetch(self, url):
        revision, path = url[len(pub.BASE):].split("/", 1)
        if revision == "b" * 40:
            return ("public " + path).encode()
        return self.blobs[self.trees[self.commits[revision]["tree"]][path]]


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.binding = dict(requestId="REQ_20261019T060000Z_0001", jobId="11111111-1111-4111-8111-111111111111",
                            leaderSessionId="leader", lunaSessionId="luna", channel=str(self.root), mode="READ_ONLY",
                            workspaceRef=str(self.root), writeRoot=None, capability="host-private-capability")
        self.github = GitHub()
        self.publisher = input_files.GitHubInputPublisher(api=self.github.api, branch=pub.BRANCH)

    def publish(self, intent="Read README and report its purpose", binding=None, fetch=None, image_mode=False):
        return pub.publish_assignment(binding or self.binding, intent, "pwsh -File private-signal.ps1",
            image_mode=image_mode, publisher=self.publisher, fetch=fetch or self.github.fetch,
            source=lambda: ("b" * 40, {name: ("public " + name).encode() for name in pub.SOURCE_FILES}))

    def test_public_documents_and_natural_prompt_preserve_binding_without_credentials(self):
        value = self.publish()
        self.assertNotIn(self.binding["requestId"], value["prompt"])
        self.assertEqual(value["prompt"].count("https://"), 2)
        self.assertTrue(pub.bound_prompt(self.binding, value["prompt"]))
        body = self.github.fetch(value["taskUrl"]).decode()
        self.assertIn(self.binding["requestId"], body)
        self.assertIn("Read README and report its purpose", body)
        self.assertIn(value["rulesUrl"], body)
        self.assertNotIn(self.binding["capability"], body)
        self.assertFalse(pub.bound_prompt({**self.binding, "mode": "WRITE_ISOLATED"}, value["prompt"]))
        self.assertFalse(pub.bound_prompt(self.binding, value["prompt"].replace("11111111", "22222222")))
        self.assertFalse(pub.bound_prompt(self.binding, value["prompt"], task_url=value["taskUrl"].replace("11111111", "22222222")))
        self.assertFalse(pub.bound_prompt(self.binding, "POSTMAN_REQUEST_ID: " + self.binding["requestId"] + "\n"))

    def test_repeated_request_and_cold_restore_do_not_republish_or_retarget(self):
        first = self.publish()
        mutations = len(self.github.writes)
        again = self.publish(binding=json.loads(json.dumps(self.binding)))
        self.assertEqual(first, again)
        self.assertEqual(pub.saved_prompt(self.binding), first["prompt"])
        self.assertEqual(len(self.github.writes), mutations)
        with self.assertRaisesRegex(ValueError, "BINDING_CHANGED"):
            self.publish(intent="different intent")

    def test_visual_image_mode_keeps_plain_prompt_and_private_binding(self):
        visual = "Нарисуй одну картинку: светящийся маяк у моря."
        binding = {**self.binding, "imageMode": True}
        first = self.publish(visual, binding=binding, image_mode=True)
        self.assertEqual(first["prompt"], visual)
        self.assertEqual(first["imageMode"], True)
        self.assertNotIn("POSTMAN_REQUEST_ID", first["prompt"])
        self.assertNotIn("https://", first["prompt"])
        self.assertTrue(pub.bound_prompt(binding, first["prompt"]))
        self.assertFalse(pub.bound_prompt(binding, visual + " again"))
        self.assertFalse(pub.bound_prompt(self.binding, visual))
        self.assertEqual(first["taskUrl"], "")
        self.assertEqual(first["rulesUrl"], "")
        self.assertEqual(self.github.writes, [])
        (self.root / "task.md").write_text(visual, encoding="utf-8")
        self.assertEqual(pub.saved_prompt(binding), visual)
        writes = len(self.github.writes)
        self.assertEqual(self.publish(visual, binding=binding, image_mode=True), first)
        self.assertEqual(len(self.github.writes), writes)
        with self.assertRaisesRegex(ValueError, "BINDING_CHANGED"):
            self.publish(visual, binding=self.binding)
        with self.assertRaisesRegex(ValueError, "BINDING_CHANGED"):
            self.publish(visual + " second", binding=binding, image_mode=True)

    def test_old_launch_receipt_keeps_its_exact_prompt_during_cold_restore(self):
        first = self.publish()
        receipt = self.root / "publication.json"
        saved = json.loads(receipt.read_text())
        saved.pop("launchVersion")
        receipt.write_text(json.dumps(saved))
        old = pub.render_launch(first["taskUrl"], first["rulesUrl"], launch_version=1)
        writes = len(self.github.writes)
        self.assertEqual(pub.saved_prompt(self.binding), old)
        self.assertTrue(pub.bound_prompt(self.binding, old))
        self.assertFalse(pub.bound_prompt(self.binding, first["prompt"]))
        self.assertEqual(self.publish()["prompt"], old)
        self.assertEqual(len(self.github.writes), writes)

    def test_publication_before_receipt_crash_is_recovered_without_new_commit(self):
        first = self.publish()
        mutations = len(self.github.writes)
        (self.root / "publication.json").unlink()
        self.assertEqual(self.publish()["taskUrl"], first["taskUrl"])
        self.assertEqual(len(self.github.writes), mutations)

    def test_sequential_requests_keep_separate_documents_and_reuse_rules_link(self):
        first = self.publish()
        for index, mode in enumerate(["READ_ONLY", "WRITE_ISOLATED", "WRITE_TEST"], 2):
            channel = self.root / str(index)
            channel.mkdir()
            binding = {**self.binding, "requestId": f"REQ_20261019T06000{index}Z_000{index}",
                       "jobId": str(index) * 8 + "-1111-4111-8111-111111111111", "channel": str(channel),
                       "mode": mode, "writeRoot": str(channel) if mode != "READ_ONLY" else None}
            next_value = self.publish(binding=binding)
            self.assertEqual(first["rulesUrl"], next_value["rulesUrl"])
            self.assertNotEqual(first["taskUrl"], next_value["taskUrl"])
            self.assertIn(binding["requestId"], self.github.fetch(next_value["taskUrl"]).decode())
            self.assertTrue(pub.bound_prompt(binding, next_value["prompt"]))

    def test_missing_public_rules_and_credentials_fail_before_publication(self):
        for intent in ["api_key=SECRET_VALUE", '{"password":"SECRET_VALUE"}', self.binding["capability"], "ghp_" + "a" * 30]:
            with self.assertRaisesRegex(ValueError, "CREDENTIAL_REJECTED"):
                self.publish(intent=intent)
        with self.assertRaisesRegex(ValueError, "INSTRUCTION_UNAVAILABLE"):
            self.publish(fetch=lambda url: (_ for _ in ()).throw(OSError("403")))
        self.assertEqual(self.github.writes, [])

    def test_public_read_failure_and_tampering_are_visible_without_republication(self):
        first = self.publish()
        writes = len(self.github.writes)
        with self.assertRaisesRegex(ValueError, "INSTRUCTION_UNAVAILABLE"):
            self.publish(fetch=lambda url: self.github.fetch(url) if "/tasks/" in url else (_ for _ in ()).throw(OSError("404")))
        self.assertEqual(writes, len(self.github.writes))
        saved = json.loads((self.root / "publication.json").read_text())
        saved["requestId"] = "foreign"
        (self.root / "publication.json").write_text(json.dumps(saved))
        self.assertFalse(pub.bound_prompt(self.binding, first["prompt"]))

    def test_natural_url_anchor_handles_unknown_send_and_rejects_duplicate_or_newer_turn(self):
        from postman.devspace import transport, observer
        value = self.publish()
        key = "Задание: " + value["taskUrl"]
        turns = [{"index": 0, "role": "user", "text": "Rendered differently\n" + key}]
        self.assertEqual(observer.observer.find_user_anchor(turns, value["prompt"]), 0)
        self.assertIsNone(observer.observer.find_user_anchor(turns + [{"index": 1, "role": "user", "text": key}], value["prompt"]))
        chat = "https://chatgpt.com/c/owned-human-prompt"
        clock = [0.0]
        def sleep(seconds): clock[0] += seconds
        with patch.object(observer.observer, "snapshot_turns", return_value=(turns, "fixture")), \
             patch.object(observer.image_output, "observe_owned_image", return_value=None), \
             patch.object(observer, "wait_for_signal", return_value={"code": "DEVSPACE_DIAGNOSTIC", "details": {}}) as timed:
            result = observer.wait_for_bell_after_unknown_send(self.binding, timeout_ms=3000,
                page=SimpleNamespace(url=chat), prompt=value["prompt"], conversation_ref=None,
                sleep=sleep, monotonic=lambda: clock[0], persist=lambda _: None, interval_ms=1000, count=1)
            self.assertEqual(result["details"]["sendState"], "UNKNOWN")
            timed.assert_called_once()
        clock[0] = 0.0
        newer = turns + [{"index": 1, "role": "user", "text": "A later user request"}]
        with patch.object(observer.observer, "snapshot_turns", return_value=(newer, "fixture")), \
             patch.object(observer, "wait_for_signal", side_effect=AssertionError("no old control")):
            result = observer.wait_for_bell_after_unknown_send(self.binding, timeout_ms=3000,
                page=SimpleNamespace(url=chat), prompt=value["prompt"], conversation_ref=chat,
                sleep=sleep, monotonic=lambda: clock[0])
            self.assertTrue(result["details"]["supersededByUserTurn"])

    def test_cold_recovery_reads_saved_human_prompt_instead_of_guessing_req_text(self):
        from postman.devspace import transport, observer, signal
        import web_worker_bridge as web
        previous = self.publish()
        channel = self.root / "next"
        channel.mkdir()
        binding = {**self.binding, "requestId": "REQ_20261019T060002Z_0002", "channel": str(channel),
                   "jobId": "22222222-1111-4111-8111-111111111111", "conversationUrl": "https://chatgpt.com/c/owned-human-prompt",
                   "recovery": {"sourceRequestId": self.binding["requestId"], "sourceChannel": str(self.root),
                                "attempt": 1, "intent": "observe-then-continue"}}
        current = self.publish(binding=binding)
        page = SimpleNamespace(url=binding["conversationUrl"], goto=lambda *a, **kw: None, close=lambda: None)
        class Factory:
            def __enter__(self): self.chromium = self; return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, *a, **kw): return self
            @property
            def contexts(self): return [self]
            def new_page(self): return page
        bridge = web.WebWorkerBridge(root=channel / "web")
        with patch.object(signal, "load_binding", return_value=self.binding), \
             patch.object(web.browser_submit, "_read_user_history", return_value=([previous["prompt"]], "")) as history, \
             patch.object(web.browser_submit, "submit_existing_prompt", return_value={"ok": True, "sendState": "PROVEN_SENT", "details": {"chatUrl": page.url}}) as sent, \
             patch.object(observer.controls, "newer_user_turn", return_value=False), \
             patch.object(observer.observer, "snapshot_turns", return_value=([{ "index": 0, "role": "user", "text": previous["prompt"]}], "fixture")), \
             patch.object(observer, "wait_for_signal", return_value={"ok": True, "code": "DEVSPACE_DIAGNOSTIC", "details": {"source": "text_fallback"}}):
            bridge.run_request(binding["requestId"], task_url=current["taskUrl"], prompt=current["prompt"],
                expected_filename="", expected_request={"transportKind": "devspace"}, devspace_binding=binding,
                artifact_mode=False, playwright_factory=Factory, conversation_url=page.url)
        self.assertEqual(history.call_args.kwargs["prior_prompt"], previous["prompt"])
        self.assertTrue(bridge.read_state(binding["requestId"])["recoveryObservation"]["messageObserved"])
        sent.assert_called_once()
