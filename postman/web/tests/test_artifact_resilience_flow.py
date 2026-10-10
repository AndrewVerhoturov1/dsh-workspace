"""Controlled native download → Web/Direct physical candidate; never live transport."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

WEB = Path(__file__).resolve().parents[1]
DIRECT = WEB.parent / "direct"
for path in (WEB, DIRECT):
    if str(path) not in sys.path: sys.path.insert(0, str(path))
import artifact_detector as detector
import artifact_download as download
import browser_observer as observer
import web_worker_bridge as bridge_module
import postman_direct as direct

REQ = "REQ_20261010T010203Z_1234"
URL = "https://chatgpt.com/c/fixture-owned"
PROMPT = "exact synthetic task"
NAME = detector.expected_artifact_filename(REQ)
TEXT = "answer without any envelope"

class NativeDownload:
    suggested_filename = "wrong-request.zip"
    def __init__(self, root):
        self.file = Path(root) / "native.bin"
        self.file.write_bytes(b"malformed-but-real-bytes")
    def path(self): return self.file
    def failure(self): return None
    def save_as(self, path): Path(path).write_bytes(self.file.read_bytes())

class Page:
    url = URL
    def __init__(self, native, choices=1):
        self.native = native; self.clicks = 0; self.choices = choices; self.closed = False
        self.eligible_native_download = True
        session = SimpleNamespace(send=lambda *a: None, detach=lambda: None)
        self.context = SimpleNamespace(pages=[self], browser=SimpleNamespace(new_browser_cdp_session=lambda: session, _postman_download_dir=Path(tempfile.gettempdir())))
    def locator(self, selector): return self
    def nth(self, index): return self
    def get_attribute(self, name): return "answer" if name == "data-turn-key" else None
    def evaluate(self, script, args):
        if isinstance(args, dict):
            return {"candidates": [{"path": str(i), "label": NAME, "tag": "a", "visibleLabelExact": True} for i in range(self.choices)]}
        return {"eligibleNativeDownload": self.eligible_native_download, "connected": True, "visible": True, "disabled": False, "visibleLabelExact": True, "visibleLabel": NAME, "tag": "a"}
    def click(self, **kwargs): self.clicks += 1
    def expect_download(self, **kwargs):
        page = self
        class Event:
            value = page.native
            def __enter__(self): return self
            def __exit__(self, *a): return False
        return Event()
    def close(self): self.closed = True
    def is_closed(self): return self.closed

class FlowTests(unittest.TestCase):
    def run_flow(self, root, *, attachment=False, choices=1, owned=True):
        native = NativeDownload(root); page = Page(native, choices)
        class Factory:
            def __enter__(self): self.chromium=self; return self
            def __exit__(self,*a): pass
            def connect_over_cdp(self,*a,**kw): return self
            @property
            def contexts(self): return [self]
            def new_page(self): return page
        bridge = bridge_module.WebWorkerBridge(root=root, sleep=lambda _: None)
        sent = {"ok": False, "code": "PROMPT_SEND_UNKNOWN", "sendState": "UNKNOWN",
            "details": {"ownedPage": owned, "ownedChatUrl": URL, "chatUrl": URL, "userTurnCountBefore": 4}}
        turns=[{"role":"user","text":PROMPT,"index":0},{"role":"assistant","text":TEXT,"index":1,"groupKey":"answer"}]
        with patch.object(bridge_module.browser_submit,"submit_existing_prompt",return_value=sent) as submit, \
             patch.object(observer,"snapshot_turns",return_value=(turns,"turns")), \
             patch.object(observer,"generation_active",return_value=(False,{})), \
             patch.object(bridge_module.reminder_policy,"submit_reminder",side_effect=AssertionError("no outbound retry")), \
             patch.object(bridge_module.browser_recovery,"run_recovery",side_effect=AssertionError("no recovery"),create=True):
            result=bridge.run_request(REQ,task_url="https://example.test/task.md",prompt=PROMPT,expected_filename=NAME,
                expected_request={"requestId":REQ,"repository":"AndrewVerhoturov1/dsh-workspace","baseCommit":"a"*40,"expectedFilename":NAME,"allowedPaths":["postman"],"forbiddenPaths":["settings.yaml"]},
                conversation_url=URL,playwright_factory=Factory,observer_timeout_ms=1,stable_ms=0,
                input_attachment=SimpleNamespace(request_id=REQ,media_type="application/zip") if attachment else None)
        self.assertEqual(submit.call_count,1,result)
        self.assertTrue(page.closed)
        return result,page,native

    def test_unknown_real_bytes_are_displayed_through_direct_without_trust(self):
        for attachment in (False,True):
            with self.subTest(attachment=attachment),tempfile.TemporaryDirectory() as root:
                result,page,native=self.run_flow(root,attachment=attachment)
                self.assertEqual(result["code"],"ARTIFACT_CANDIDATE_SAVED",result)
                self.assertFalse(result["ok"])
                candidate=result["details"]["candidate"]
                self.assertEqual(page.clicks,1)
                self.assertEqual(Path(candidate["path"]).read_bytes(),native.file.read_bytes())
                self.assertEqual(candidate["sha256"],hashlib.sha256(native.file.read_bytes()).hexdigest())
                self.assertFalse(candidate["verified"])
                if attachment: self.assertIn("RESULT_MAY_LACK_INPUT_ATTACHMENT",candidate["reasons"])
                runner=direct.DirectPostman(branch="task/fixture",direct_root=Path(root)/"direct")
                published=direct.PublishedTask(REQ,"https://example.test/task.md","a"*40,"b"*40,())
                runner.publication_receipt={"requestId":REQ,"branch":"task/fixture"}
                terminal=runner._candidate_terminal(REQ,result,published,{}, {})
                self.assertFalse(terminal["ok"])
                self.assertFalse(terminal["verified"])
                self.assertFalse(terminal["applyEligible"])
                self.assertEqual(terminal["candidate"]["path"],candidate["path"])
                handoff=json.loads((Path(root)/"direct"/"results"/(REQ+".json")).read_text())
                self.assertEqual(handoff["candidate"]["sha256"],candidate["sha256"])

    def test_external_href_mutated_after_reproof_blocks_actual_downloader_click(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            try: browser = playwright.chromium.launch(headless=True)
            except Exception as exc: self.skipTest("local Chromium unavailable: " + str(exc)[:160])
            try:
                browser_page = browser.new_page()
                browser_page.route(URL + "**", lambda route: route.fulfill(status=200, body="<main></main>"))
                browser_page.goto(URL)
                browser_page.set_content('<a id="candidate" href="/files/artifact.zip">artifact.zip</a>')
                control = browser_page.locator('#candidate')
                self.assertTrue(download._control_snapshot(control, "artifact.zip")["eligibleNativeDownload"])
                browser_page.evaluate("document.querySelector('#candidate').href='https://external.invalid/artifact.zip'")
                self.assertFalse(download._control_snapshot(control, "artifact.zip")["eligibleNativeDownload"])
            finally: browser.close()
        # Exercise the real downloader on its candidate path; the detector's reproof
        # returns a local eligible candidate, then the control snapshot observes the
        # synthetic local→external mutation while retaining its label.
        spec = importlib.util.spec_from_file_location("flow_artifact_download_fixture", WEB / "tests" / "test_artifact_download.py")
        fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
        DL_REQ, DL_NAME, DL_PROMPT, DL_URL = fixture.REQ, fixture.FILENAME, fixture.PROMPT, fixture.CHAT_URL
        p5_proof, dl_expected_request, validator_ok = fixture.p5_proof, fixture.expected_request, fixture.validator_ok
        FakeDownload, FakePage = fixture.FakeDownload, fixture.FakePage
        from artifact_download import download_validated_artifact
        with tempfile.TemporaryDirectory() as root:
            dl_page = FakePage(FakeDownload(payload=b"external href must not be clicked"))
            dl_page.turn_key = "group-1"
            details = p5_proof()["details"]
            details.update({"assistantIdentity":{"groupKey":"group-1"}, "verified":False,
                "applyEligible":False, "turnNodeIndex":1, "turnKey":"group-1",
                "attachment":{"path":"1/2", "label":"artifact.zip", "hrefBasename":"artifact.zip"}})
            candidate = {"ok":False,"code":detector.ARTIFACT_CANDIDATE_DOM,"details":details}
            original_discover = detector.discover_artifact_candidate
            detector.discover_artifact_candidate = lambda *a, **k: candidate
            try:
                def mutate_then_snapshot(script, expected):
                    dl_page.turn.snapshot["eligibleNativeDownload"] = False
                    dl_page.turn.snapshot["visibleLabel"] = "artifact.zip"
                    return dict(dl_page.turn.snapshot)
                dl_page.turn.evaluate = mutate_then_snapshot
                result = download_validated_artifact(dl_page, expected_prompt=DL_PROMPT,
                    expected_chat_url=DL_URL, request_id=DL_REQ, expected_filename=DL_NAME,
                    completed_observer_result={"ok":True}, artifact_dom_result=candidate,
                    expected_request=dl_expected_request(), result_root=root,
                    candidate_root=Path(root)/"candidate", validator_runner=validator_ok)
            finally:
                detector.discover_artifact_candidate = original_discover
        self.assertEqual(result["code"], download.DOWNLOAD_CONTROL_INVALID, result)
        self.assertFalse(result["details"]["control"]["eligibleNativeDownload"])
        self.assertEqual(dl_page.clicks, 0)
        self.assertEqual(dl_page.expect_download_calls, 0)

    def test_candidate_metadata_write_failure_preserves_web_direct_descriptor(self):
        from artifact_download import _atomic_write_json
        from artifact_download import download_validated_artifact
        spec=importlib.util.spec_from_file_location("flow_metadata_download_fixture", WEB / "tests" / "test_artifact_download.py")
        fixture=importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
        FakeDownload,FakePage,p5_proof=fixture.FakeDownload,fixture.FakePage,fixture.p5_proof
        dl_expected_request,validator_ok=fixture.expected_request,fixture.validator_ok
        dl_prompt,dl_url,dl_req,dl_name=fixture.PROMPT,fixture.CHAT_URL,fixture.REQ,fixture.FILENAME
        with tempfile.TemporaryDirectory() as root:
            page=FakePage(FakeDownload(suggested=fixture.FILENAME, payload=b"raw retained bytes"))
            page.turn.snapshot.update({"visibleLabel":"artifact.zip","visibleLabelExact":False,"eligibleNativeDownload":True})
            page.turn_key="answer"
            proof=p5_proof()
            proof["details"].update({"assistantIdentity":{"groupKey":"answer"},"verified":False,
                "applyEligible":False,"turnNodeIndex":1,"turnKey":"answer",
                "attachment":{"path":"1/2","label":"artifact.zip"}})
            proof={"ok":False,"code":detector.ARTIFACT_CANDIDATE_DOM,"details":proof["details"]}
            original_discover=detector.discover_artifact_candidate
            detector.discover_artifact_candidate=lambda *a,**k: proof
            original_write=download._atomic_write_json
            def fail_candidate_metadata(path, value):
                if Path(path).name == "candidate.json": raise OSError("synthetic metadata disk failure")
                return original_write(path,value)
            try:
                with patch.object(download,"_atomic_write_json",side_effect=fail_candidate_metadata):
                    result=download_validated_artifact(page,expected_prompt=dl_prompt,
                        expected_chat_url=dl_url,request_id=dl_req,expected_filename=dl_name,
                        completed_observer_result={"ok":True},artifact_dom_result=proof,
                        expected_request=dl_expected_request(),result_root=Path(root)/"results",
                        candidate_root=Path(root)/"candidates",validator_runner=validator_ok)
            finally:
                detector.discover_artifact_candidate=original_discover
            self.assertEqual(result["code"],"ARTIFACT_CANDIDATE_SAVED",result)
            candidate=result["details"]["candidate"]
            raw=Path(root)/"candidates"/dl_req/"capture.bin"
            self.assertEqual(raw.read_bytes(),b"raw retained bytes")
            self.assertEqual(candidate["path"],str(raw.resolve()))
            self.assertEqual(candidate["sha256"],hashlib.sha256(b"raw retained bytes").hexdigest())
            self.assertIn("CANDIDATE_METADATA_SAVE_FAILED",candidate["reasons"])
            self.assertFalse((raw.parent/"candidate.json").exists())
            runner=direct.DirectPostman(branch="task/fixture",direct_root=Path(root)/"direct")
            published=direct.PublishedTask(dl_req,"https://example.test/task.md","a"*40,"b"*40,())
            runner.publication_receipt={"requestId":dl_req,"branch":"task/fixture"}
            terminal=runner._candidate_terminal(dl_req,result,published,{}, {})
            self.assertFalse(terminal["verified"])
            self.assertFalse(terminal["applyEligible"])
            self.assertEqual(terminal["candidate"]["path"],candidate["path"])
            self.assertEqual(terminal["candidate"]["sha256"],candidate["sha256"])

    def test_choices_no_click_and_unowned_page_no_candidate(self):
        for choices,owned in ((2,True),(1,False),(0,True)):
            with self.subTest(choices=choices,owned=owned),tempfile.TemporaryDirectory() as root:
                result,page,_=self.run_flow(root,choices=choices,owned=owned)
                self.assertEqual(page.clicks,0)
                self.assertFalse(result["ok"])
                self.assertFalse(result["details"].get("candidate"))
                if choices==2: self.assertEqual(len(result["details"]["choices"]),2)


class CandidateDOMTests(unittest.TestCase):
    def test_actual_scoped_js_filters_external_and_arbitrary_urls(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            try: browser = playwright.chromium.launch(headless=True)
            except Exception as exc: self.skipTest("local Chromium unavailable: " + str(exc)[:160])
            try:
                page = browser.new_page()
                page.route("https://chatgpt.com/**", lambda route: route.fulfill(status=200, body="<main></main>"))
                page.goto(URL)
                page.set_content("<main><article id=answer>"
                    "<a href=sandbox:/mnt/data/wrong.zip>wrong.zip</a>"
                    "<a href=https://evil.test/attack.zip>attack.zip</a>"
                    "<a href=/arbitrary.zip>arbitrary.zip</a>"
                    "<a href=/backend-api/files/download/f>Download result</a>"
                    "<button data-testid=attachment-download>button-result.zip</button>"
                    "<button>unproved-button.zip</button>"
                    "</article><article id=old><a href=sandbox:/mnt/data/old.zip>old.zip</a></article></main>")
                found = page.locator("#answer").evaluate(detector._CANDIDATE_DOM_JS,
                    {"expectedFilename": NAME, "beginMarker": "BEGIN", "endMarker": "END", "candidateMode": True})
                labels=[item["label"] for item in found["candidates"]]
                self.assertEqual(labels,["wrong.zip","Download result","button-result.zip"])
                self.assertNotIn("attack.zip", labels)
                self.assertNotIn("old.zip", labels)
            finally: browser.close()

if __name__ == "__main__": unittest.main()
