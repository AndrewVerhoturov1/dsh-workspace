from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

WEB = Path(__file__).resolve().parents[1]
if str(WEB) not in sys.path:
    sys.path.insert(0, str(WEB))
import browser_submit as submit
import input_attachment as attachments
import input_bundle
import browser_recovery
import web_worker_bridge as worker
from test_browser_submit import FakePage, FakeLocator

REQ = "REQ_20261001T000000Z_0021"
NAME = f"POSTMAN_INPUT_{REQ}.zip"
PROMPT = f"POSTMAN_REQUEST_ID: {REQ}\ntask_file: https://example.test/{REQ}.md"


def proof(name=NAME, count=1, pending=False, error=False, known=True, file_id=""):
    return dict(known=known, count=count, names=[name] if count else [], ids=[file_id] if count else [], pending=pending, error=error, settled=count == 1 and not pending and not error)


class Attachment:
    request_id = REQ
    name = NAME
    def upload_bytes(self): return b"verified-ZIP"
    def metadata(self): return dict(requestId=REQ, displayName=NAME, bundleSha256="a" * 64, bundleByteLength=12)


class ZipLocator(FakeLocator):
    def __init__(self, page, kind, text="", attachment_proof=None):
        super().__init__(page, kind, text=text)
        self.attachment_proof = attachment_proof
    def count(self): return 1
    def locator(self, selector):
        if selector == 'xpath=ancestor::form[1]': return ZipLocator(self.page, "scope")
        if selector == 'input[type="file"]':
            return FakeLocator(items=[ZipLocator(self.page, "file")]) if self.page.has_input else FakeLocator(items=[])
        return FakeLocator(items=[])
    def evaluate(self, script, options=None):
        if options is not None:
            return self.attachment_proof if options.get("sent") else self.page.attachment_proof
        return super().evaluate(script)
    def fill(self, text, timeout=None):
        super().fill(text, timeout)
        if self.page.lose_on_fill: self.page.attachment_proof = proof(count=0)
        if self.page.change_chat_on_fill: self.page.url = "https://chatgpt.com/c/unrelated-chat"
    def set_input_files(self, files, timeout=None):
        self.page.uploads.append(files)
        if self.page.upload_throws: raise RuntimeError("upload failed")
        self.page.attachment_proof = self.page.upload_result
    def click(self, timeout=None):
        self.page.click_count += 1
        if self.page.confirm_on_click:
            self.page.user_turns.append(self.page.composer_text)
            self.page.turn_attachments.append(self.page.sent_result)
            self.page.composer_text = ""
            self.page.url = self.page.bound_url
            self.page.attachment_proof = proof(count=0)
        if self.page.click_error: raise RuntimeError(self.page.click_error)


class ZipPage(FakePage):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.has_input = True
        self.uploads = []
        self.upload_result = proof()
        self.attachment_proof = proof(count=0)
        self.sent_result = proof()
        self.turn_attachments = [proof(name="previous.zip") for _ in self.user_turns]
        self.lose_on_fill = False
        self.change_chat_on_fill = False
        self.upload_throws = False
    def locator(self, selector):
        if selector == '#prompt-textarea': return ZipLocator(self, "composer")
        if selector in submit.USER_TURN_SELECTORS:
            return FakeLocator(items=[ZipLocator(self, "bubble", text, self.turn_attachments[i]) for i, text in enumerate(self.user_turns)])
        if selector == submit.SEND_BUTTON_SELECTORS[0]: return ZipLocator(self, "send")
        return super().locator(selector)


class InputAttachmentTests(unittest.TestCase):
    def run_submit(self, page):
        return submit.submit_fresh_prompt(page, PROMPT, timeout_ms=0, input_attachment=Attachment())

    def assert_unsent(self, page, code):
        result = self.run_submit(page)
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], code)
        self.assertEqual(result["sendState"], submit.SEND_PROVEN_NOT_SENT)
        self.assertEqual(page.click_count, 0)
        self.assertNotIn(submit.PROMPT_SEND_STARTED, result["transitions"])
        return result

    def test_one_native_zip_upload_exact_bytes_and_sent_turn(self):
        page = ZipPage()
        result = self.run_submit(page)
        self.assertTrue(result["ok"], result)
        self.assertEqual(page.click_count, 1)
        self.assertEqual(page.uploads, [{"name": NAME, "mimeType": "application/zip", "buffer": b"verified-ZIP"}])
        self.assertEqual(result["sendState"], submit.SEND_PROVEN_SENT)
        self.assertTrue(result["details"]["sentAttachmentConfirmed"])
        self.assertEqual(result["details"]["sentAttachment"]["names"], [NAME])
        self.assertLess(result["transitions"].index(attachments.ATTACHMENT_READY_CONFIRMED), result["transitions"].index(submit.PROMPT_INSERTED))

    def test_control_unavailable_and_set_input_failure_no_send(self):
        page = ZipPage(); page.has_input = False
        self.assert_unsent(page, attachments.ATTACHMENT_CONTROL_UNAVAILABLE)
        page = ZipPage(); page.upload_throws = True
        self.assert_unsent(page, attachments.ATTACHMENT_UPLOAD_FAILED)

    def test_pending_error_timeout_unknown_filename_and_multiple_no_send(self):
        for upload_result, code in [(proof(pending=True), attachments.ATTACHMENT_UPLOAD_TIMEOUT),
            (proof(error=True), attachments.ATTACHMENT_UPLOAD_FAILED), (proof(count=0), attachments.ATTACHMENT_UPLOAD_TIMEOUT),
            (proof(name="different.zip"), attachments.ATTACHMENT_UPLOAD_TIMEOUT),
            (proof(count=2), attachments.ATTACHMENT_UPLOAD_TIMEOUT), (proof(known=False), attachments.ATTACHMENT_UPLOAD_TIMEOUT)]:
            with self.subTest(proof=upload_result):
                page = ZipPage(); page.upload_result = upload_result
                self.assert_unsent(page, code)

    def test_preexisting_attachment_and_fill_loses_attachment_no_send(self):
        page = ZipPage(); page.attachment_proof = proof(name="old.zip")
        self.assert_unsent(page, attachments.ATTACHMENT_NOT_READY)
        page = ZipPage(); page.lose_on_fill = True
        self.assert_unsent(page, attachments.ATTACHMENT_LOST)

    def test_chat_changed_during_upload_or_prompt_fill_no_send(self):
        page = ZipPage(); page.change_chat_on_fill = True
        self.assert_unsent(page, submit.SUBMIT_INVALID_CONFIG)

    def test_missing_sent_attachment_is_unknown_never_success_or_resend(self):
        page = ZipPage(); page.sent_result = proof(count=0)
        result = self.run_submit(page)
        self.assertEqual(result["sendState"], submit.SEND_UNKNOWN)
        self.assertEqual(result["code"], submit.PROMPT_SEND_UNKNOWN)
        self.assertFalse(result["ok"])
        self.assertEqual(result["details"]["attachmentCode"], attachments.SENT_ATTACHMENT_UNKNOWN)
        self.assertEqual(page.click_count, 1)
        self.assertEqual(len(page.uploads), 1)
        guard = submit.SendGuard(); guard.unknown()
        retry = submit.submit_once(page, page.locator('#prompt-textarea'), PROMPT, guard, timeout_ms=0)
        self.assertEqual(retry["code"], submit.PROMPT_RESEND_BLOCKED)
        self.assertEqual(page.click_count, 1)

    def test_uncertain_click_no_reupload(self):
        page = ZipPage(click_error="maybe clicked")
        result = self.run_submit(page)
        self.assertEqual(result["sendState"], submit.SEND_UNKNOWN)
        self.assertFalse(result["ok"])
        self.assertEqual((page.click_count, len(page.uploads)), (1, 1))

    def test_same_turn_only_continuation_never_previous_attachment(self):
        for current in [proof(), proof(count=0), proof(name="previous.zip")]:
            with self.subTest(current=current):
                page = ZipPage(url="https://chatgpt.com/c/abc123", user_turns=["old prompt"])
                page.turn_attachments[0] = proof()  # same filename in OLD turn cannot prove new turn.
                page.sent_result = current
                result = submit.submit_existing_prompt(page, PROMPT, page.url, timeout_ms=0, input_attachment=Attachment())
                self.assertEqual(result["ok"], current["count"] == 1 and current["names"] == [NAME])
                self.assertEqual(result["details"]["userTurnIndex"], 1)
                self.assertEqual((page.click_count, len(page.uploads)), (1, 1))

    def test_exact_prompt_required_not_request_key_only_with_inputs(self):
        page = ZipPage(); page.user_turns = [PROMPT + "\nwrong extra intent"]; page.turn_attachments = [proof()]
        page.composer_text = ""; page.url = page.bound_url
        ok, details = submit._observe_send_proof(page, PROMPT, 0, input_attachment=Attachment())
        self.assertFalse(ok)
        self.assertTrue(details["requestKeyUserTurn"])
        self.assertFalse(details["exactUserTurn"])

    def test_file_id_must_stay_the_same_when_dom_exposes_it(self):
        page = ZipPage(); page.upload_result = proof(file_id="file-authorized")
        page.sent_result = proof(file_id="different-file")
        result = self.run_submit(page)
        self.assertFalse(result["ok"])
        self.assertEqual(result["sendState"], submit.SEND_UNKNOWN)

    def test_modified_bundle_before_native_payload_no_send(self):
        with patch.object(Attachment, 'upload_bytes', side_effect=input_bundle.InputBundleError("POSTMAN_INPUT_BUNDLE_CONTENT_MISMATCH")):
            page = ZipPage()
            self.assert_unsent(page, "POSTMAN_INPUT_BUNDLE_CONTENT_MISMATCH")
            self.assertEqual(page.uploads, [])

    def test_no_input_flow_never_uploads(self):
        page = ZipPage()
        result = submit.submit_fresh_prompt(page, PROMPT, timeout_ms=0)
        self.assertTrue(result["ok"], result)
        self.assertEqual(page.uploads, [])
        self.assertNotIn(attachments.ATTACHMENT_READY_CONFIRMED, result["transitions"])

    def test_pre_send_failure_never_enters_system_recovery_and_can_use_new_owned_attempt(self):
        with patch.object(browser_recovery, 'recover_interrupted_chat', side_effect=AssertionError("not send recovery")):
            page = ZipPage(); page.upload_result = proof(pending=True)
            self.assert_unsent(page, attachments.ATTACHMENT_UPLOAD_TIMEOUT)
            fresh = ZipPage()
            self.assertTrue(self.run_submit(fresh)["ok"])
            self.assertEqual(len(fresh.uploads), 1)

    def test_worker_rejects_upload_failure_and_unproved_attachment_success(self):
        class Page:
            closed = False
            def close(self): self.closed = True
            def is_closed(self): return self.closed
        class Factory:
            def __enter__(self): self.chromium = self; return self
            def __exit__(self, *args): pass
            def connect_over_cdp(self, url): return types.SimpleNamespace(contexts=[types.SimpleNamespace(new_page=lambda: Page())])
        for submitted in [{"ok": False, "code": attachments.ATTACHMENT_UPLOAD_TIMEOUT, "sendState": submit.SEND_PROVEN_NOT_SENT},
                          {"ok": True, "code": submit.PROMPT_SEND_CONFIRMED, "sendState": submit.SEND_PROVEN_SENT,
                           "details": {"chatUrl": "https://chatgpt.com/c/abc123"}}]:
            with tempfile.TemporaryDirectory() as root, \
                 patch.object(worker.browser_submit, 'submit_fresh_prompt', return_value=submitted) as sender, \
                 patch.object(worker.browser_recovery, 'recover_interrupted_chat', side_effect=AssertionError("recovery forbidden")) as recovery:
                bridge = worker.WebWorkerBridge(root=root)
                result = bridge.run_request(REQ, task_url=f"https://example.test/{REQ}.md", prompt=PROMPT,
                    expected_filename=f"POSTMAN_{REQ}_RESULT.zip", expected_request={}, playwright_factory=Factory,
                    input_attachment=Attachment())
                self.assertFalse(result["ok"], result)
                self.assertEqual(sender.call_count, 1)
                self.assertEqual(recovery.call_count, 0)
                self.assertIsNotNone(sender.call_args.kwargs["input_attachment"])

    def test_dom_extractor_requires_structural_card_not_text_filename(self):
        code = r'''
const vm = require('vm');
const extract = vm.runInNewContext(process.argv[1], {getComputedStyle:()=>({display:'block',visibility:'visible'})});
const name=process.argv[2];
const empty=[];
const node=(attrs={},children=[])=>({hidden:false,children,textContent:attrs.text||'',innerText:attrs.text||'',
 getAttribute:k=>attrs[k]||null,getBoundingClientRect:()=>({width:10,height:10}),getClientRects:()=>[1],closest:()=>null,
 contains:e=>children.includes(e),querySelector:()=>null,querySelectorAll:selector=>
  selector==='*' || selector===':scope > * > *'?children:selector.includes('file-upload-preview')?children.filter(c=>c.card):empty});
const leaf=node({text:name});
const card=node({'data-filename':name,'data-upload-state':'ready'},[leaf]);card.card=true;
const container=node({},[card]);
const root=node();root.querySelectorAll=selector=>selector.includes('composer-attachments')?[container]:empty;
const proof=extract(root,{name,sent:false});
if(!proof.known||proof.count!==1||proof.names[0]!==name||proof.pending||proof.error)throw Error(JSON.stringify(proof));
container.children=[leaf];container.querySelectorAll=selector=>selector==='*'?[leaf]:empty;
const textOnly=extract(root,{name,sent:false});if(textOnly.known)throw Error('text must not prove attachment');
// Same-turn scope containing multiple bubbles is rejected, no previous-turn borrowing.
const scope=node();scope.querySelectorAll=()=>[leaf,leaf];
const bubble=node();bubble.closest=()=>scope;
if(extract(bubble,{name,sent:true}).known)throw Error('ambiguous scope accepted');
console.log('DOM proof OK');
'''
        done = subprocess.run(['node', '-e', code, attachments._PROOF_JS, NAME], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == '__main__':
    unittest.main()
