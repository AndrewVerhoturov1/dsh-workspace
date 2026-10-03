"""Offline input -> submit -> real observer -> packaging -> durable image regression."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import zipfile

WEB = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(WEB), str(WEB / "tests")]
import browser_submit as submit
import browser_observer as observer
import web_worker_bridge as worker
from test_input_attachment import ZipPage, ZipLocator, proof
import input_attachment
from test_browser_observer import FakePage, FakeClock, image_snapshot, turn
from postman import input_files, input_bundle
from postman.direct import postman_direct as direct

REQ = "REQ_20261001T000000Z_0881"
from PIL import Image
_image = io.BytesIO()
Image.new("RGB", (1, 1), "red").save(_image, format="PNG")
PNG = _image.getvalue()


class NativeImageTests(unittest.TestCase):
    def test_two_and_seven_native_references_match_entire_sent_set(self):
        for count in (2,7):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as temp:
                root=Path(temp); snapshots=root/'snapshots';snapshots.mkdir();dest=root/'request';dest.mkdir()
                paths=[]
                for index in range(count):
                    path=root/f'reference-{index}.png';path.write_bytes(PNG);paths.append(str(path))
                stage=input_files.GitHubInputPublisher(lambda *a:self.fail('public input'),snapshot_dir=snapshots)
                staged=stage.stage(paths)
                made=input_bundle.build_images(REQ,staged['descriptors'],stage.materializations,dest)
                attached=input_bundle.read_handoff(made['handoffPath'],REQ,staged['descriptors'],image=True)
                self.assertEqual(attached.upload_bytes(),[PNG]*count)
                page=ZipPage(confirm_on_click=True)
                ready=dict(known=True,count=count,names=attached.name,ids=[f'file_{i}' for i in range(count)],
                           pending=False,error=False,settled=True)
                page.upload_result=ready;page.sent_result=ready
                original_attribute=ZipLocator.get_attribute
                def attribute(node,name):
                    return 'multiple' if name=='multiple' else original_attribute(node,name)
                with patch.object(ZipLocator,'get_attribute',new=attribute):
                    result=submit.submit_fresh_prompt(page,'draw one image',timeout_ms=0,input_attachment=attached)
                self.assertEqual(result['sendState'],'PROVEN_SENT',result)
                self.assertTrue(result['details']['sentAttachmentConfirmed'])
                self.assertEqual(page.click_count,1)
                self.assertEqual([item['buffer'] for item in page.uploads[0]],[PNG]*count)
                wrong={**ready,'names':attached.name[:-1]+['foreign.png']}
                self.assertFalse(input_attachment.ready(wrong,attached.name))
                altered=json.loads(Path(made['handoffPath']).read_text())
                altered['attachments'].reverse();Path(made['handoffPath']).write_text(json.dumps(altered))
                with self.assertRaises(input_bundle.InputBundleError):
                    input_bundle.read_handoff(made['handoffPath'],REQ,staged['descriptors'],image=True)

    def make_input(self, root):
        source = root / "reference.png"
        source.write_bytes(PNG)
        snapshots = root / "snapshots"; snapshots.mkdir()
        stage = input_files.GitHubInputPublisher(lambda *a: self.fail("GitHub input publication"), snapshot_dir=snapshots)
        result = stage.stage([str(source)])
        request = root / "request"; request.mkdir()
        made = input_bundle.build_image(REQ, result["descriptors"], stage.materializations, request)
        attached = input_bundle.read_handoff(made["handoffPath"], REQ, result["descriptors"], image=True)
        self.assertEqual(attached.upload_bytes(), PNG)
        return result["descriptors"], made, attached

    def test_image_input_submit_observer_packaging_and_durable_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            descriptors, made, attached = self.make_input(root)
            self.run_image_flow(root, descriptors, made, attached, "Точное намерение\nбез переписывания  ")

    def run_image_flow(self, root, descriptors, made, attached, intent):
        prompt = direct.build_image_generation_prompt(intent, descriptors)
        page = ZipPage()
        page.upload_result = proof(name=attached.name, file_id="reference-1")
        page.sent_result = proof(name=attached.name, file_id="reference-1")
        clock = FakeClock(types.SimpleNamespace(step=0))
        submits, observations, publications, phases = [], [], [], []
        original_submit = submit.submit_fresh_prompt
        original_existing = submit.submit_existing_prompt
        original_observe = observer.observe_next_assistant
        def first(target, text, **kwargs):
            phases.append("generation")
            result = original_submit(target, text, **{**kwargs, "timeout_ms": 0})
            submits.append(result)
            self.assertEqual(result["sendState"], "PROVEN_SENT", result)
            self.assertTrue(result["details"]["sentAttachmentConfirmed"])
            return result
        def second(target, text, url, **kwargs):
            phases.append("packaging")
            self.assertNotIn("input_attachment", kwargs)
            result = original_existing(target, text, url, **{**kwargs, "timeout_ms": 0})
            submits.append(result)
            return result
        def observe(target, text, url, **kwargs):
            if kwargs.get("image_mode"):
                dom = FakePage([image_snapshot(prompt=text, message_id="generated-image")], url=url)
            else:
                dom = FakePage([[turn("user", prompt), turn("assistant", "", "generated-image", images=["img"]),
                                 turn("user", text), turn("assistant", "ZIP ready", "packaged")]], url=url)
            local = FakeClock(dom)
            with patch.object(observer.time, "sleep", local.sleep), patch.object(observer.time, "monotonic", local.monotonic):
                result = original_observe(dom, text, url, **{**kwargs, "stable_ms": 0, "timeout_ms": 1000})
            observations.append(result)
            return result
        class Factory:
            def __enter__(self): self.chromium = self; return self
            def __exit__(self, *a): pass
            def connect_over_cdp(self, *a, **kw): return self
            @property
            def contexts(self): return [self]
            def new_page(self): return page
        bridge_holder = []
        def bridge_factory(**kwargs):
            real = worker.WebWorkerBridge(**kwargs, sleep=clock.sleep, monotonic=clock.monotonic)
            bridge_holder.append(real)
            return types.SimpleNamespace(run_request=lambda req, **kw: real.run_request(req,
                **{**kw, "playwright_factory": Factory, "stable_ms": 0, "timeout_ms": 0}))
        class Publisher:
            def __init__(self, **kwargs): pass
            def snapshot(self): return direct.TaskSnapshot("a" * 40, ("postman",))
            def publish_content(self, request_id, content, **kwargs):
                self_state = bridge_holder[0].read_state(REQ)
                if self_state["state"] != "IMAGE_TURN_COMPLETED": raise AssertionError(self_state)
                publications.append(content)
                return direct.PublishedTask(request_id, f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{'b' * 40}/{REQ}.md",
                                            "a" * 40, "b" * 40, ("postman",))
        results = root / "results"
        def download(*args, **kwargs):
            folder = results / REQ; folder.mkdir(parents=True)
            archive = folder / "result.zip"
            name = f"{REQ}_img1.png"
            with zipfile.ZipFile(archive, "w") as zf: zf.writestr(name, PNG)
            sha = hashlib.sha256(archive.read_bytes()).hexdigest()
            inventory = [dict(path=name, kind="file", uncompressedSize=len(PNG))]
            (folder / "validation.json").write_text(json.dumps(dict(ok=True, sha256=sha, inventory=inventory)), encoding="utf-8")
            return dict(ok=True, code="RESULT_DURABLE", details=dict(resultDirectory=str(folder), resultZip=str(archive), sha256=sha))
        runner = direct.DirectPostman(branch="main", repo_root=root, direct_root=root / "direct",
            result_root=results, publisher_factory=Publisher, bridge_factory=bridge_factory,
            ensure_browser=lambda **kw: {"cdpUrl": "http://127.0.0.1:9222"})
        with patch.object(worker.browser_submit, "submit_fresh_prompt", side_effect=first), \
             patch.object(worker.browser_submit, "submit_existing_prompt", side_effect=second), \
             patch.object(worker.browser_observer, "observe_next_assistant", side_effect=observe), \
             patch.object(worker.browser_observer, "connection_interrupted", return_value=(False, {})), \
             patch.object(worker.browser_observer, "additional_processing", return_value=(False, {})), \
             patch.object(worker.artifact_detector, "detect_artifact_dom", return_value=dict(ok=True, code="ARTIFACT_FOUND")), \
             patch.object(worker.artifact_download, "download_validated_artifact", side_effect=download):
            result = runner.run(request_id=REQ, task=intent, image_mode=True, input_files=descriptors, input_bundle_manifest=made["handoffPath"])
        self.assertEqual(result["code"], "IMAGE_RESULT_DURABLE")
        self.assertEqual(Path(result["resultImage"]).read_bytes(), PNG)
        self.assertEqual(page.click_count, 2)
        self.assertEqual(len(submits), 2)
        self.assertEqual(phases, ["generation", "packaging"])
        self.assertTrue(all(item["sendState"] == "PROVEN_SENT" for item in submits))
        self.assertEqual(page.uploads, [dict(name=attached.name, mimeType="image/png", buffer=PNG)])
        self.assertEqual(page.user_turns[0], prompt)
        self.assertIn(intent, prompt)
        self.assertNotIn("raw_url", prompt)
        self.assertNotIn("github", prompt.lower())
        self.assertEqual(len(publications), 1)  # task-only packaging publication
        self.assertEqual(observations[0]["details"]["assistantImageCount"], 1)
        self.assertTrue(observations[0]["details"]["assistantIdentityProved"])
        self.assertFalse(Path(made["handoffPath"]).exists())
        self.assertFalse(attached.path.exists())

        return dict(terminal=result, generationSends=phases.count("generation"), packagingSends=phases.count("packaging"),
                    sendStates=[item["sendState"] for item in submits], mimeType=page.uploads[0]["mimeType"])

    def test_image_negative_proofs_never_resend(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, _, attached = self.make_input(Path(tmp))
            for failure in ("wrong", "lost", "uncertain", "prompt"):
                with self.subTest(failure=failure):
                    page = ZipPage()
                    page.upload_result = proof(name=attached.name)
                    page.sent_result = proof(name=attached.name)
                    if failure == "wrong": page.upload_result = proof(name="wrong.png")
                    if failure == "lost": page.lose_on_fill = True
                    if failure == "uncertain": page.sent_result = proof(name=attached.name, known=False)
                    if failure == "prompt": page.sent_result = proof(name="wrong.png")
                    result = submit.submit_fresh_prompt(page, "exact intent", timeout_ms=0, input_attachment=attached)
                    self.assertFalse(result["ok"], result)
                    clicks = 0 if failure in ("wrong", "lost") else 1
                    self.assertEqual(page.click_count, clicks)
                    if clicks:
                        self.assertEqual(result["sendState"], "UNKNOWN")
                        guard = submit.SendGuard(); guard.unknown()
                        self.assertEqual(submit.submit_once(page, page.locator('#prompt-textarea'), "exact intent", guard, timeout_ms=0)["code"], submit.PROMPT_RESEND_BLOCKED)
                        self.assertEqual(page.click_count, 1)
            page = ZipPage(); page.url = page.bound_url
            page.user_turns = ["exact intent plus tampered text"]
            page.turn_attachments = [proof(name=attached.name)]
            ok, details = submit._observe_send_proof(page, "exact intent", 0, input_attachment=attached)
            self.assertFalse(ok)
            self.assertFalse(details["exactUserTurn"])


    def test_image_card_selectors_execute_in_exact_scopes(self):
        import subprocess
        import input_attachment
        script = r'''
const vm=require('node:vm'), name=process.argv[2];
const extract=vm.runInNewContext(process.argv[1],{getComputedStyle:()=>({display:'block',visibility:'visible'})});
const node=(attrs={})=>({hidden:false,getAttribute:k=>attrs[k]??null,
  getBoundingClientRect:()=>({width:10,height:10}),getClientRects:()=>[1],closest:()=>null,
  querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false});
const image=node({alt:name});image.complete=true;image.naturalWidth=1;
const remove=node({'aria-label':'Remove '+name});
const card=node({'data-file-id':'authorized'});
card.querySelector=s=>s.includes('img')?image:null;
card.querySelectorAll=s=>s==='img'||s.includes('img[alt]')?[image]:s==='button[aria-label]'?[remove]:[];
const scope=node(); scope.querySelectorAll=s=>s.includes('image-attachment')?[card]:[];
const root=node({'data-message-author-role':'user'});
root.querySelectorAll=s=>s.includes('composer-attachments')?[scope]:scope.querySelectorAll(s);
let result=extract(root,{name,image:true,sent:false});
if(result.names[0]!==name||!result.settled||result.count!==1)throw Error(JSON.stringify(result));
result=extract(root,{name,image:true,sent:true});
if(result.names[0]!==name||!result.settled||result.ids[0]!=='authorized')throw Error(JSON.stringify(result));
image.getAttribute=k=>k==='alt'?'wrong.png':null;
result=extract(root,{name,image:true,sent:true});if(result.names[0]===name)throw Error('wrong image accepted');
image.getAttribute=()=>null;
result=extract(root,{name,image:true,sent:true});if(result.names[0]===name)throw Error('unknown sent image accepted');
root.querySelectorAll=()=>[]; // unrelated/body-wide image cannot be borrowed
result=extract(root,{name,image:true,sent:true});if(result.count)throw Error('unscoped image accepted');
'''
        name = f"POSTMAN_REFERENCE_{REQ}.png"
        done = subprocess.run(['node', '-e', script, input_attachment._PROOF_JS, name], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_image_count_type_and_mutated_snapshot_fail_before_browser(self):
        with tempfile.TemporaryDirectory() as tmp:
            descriptors, made, attached = self.make_input(Path(tmp))
            with self.assertRaisesRegex(input_bundle.InputBundleError, "COUNT_UNSUPPORTED"):
                input_bundle.image_media(descriptors * 8)
            with self.assertRaisesRegex(input_bundle.InputBundleError, "TYPE_UNSUPPORTED"):
                input_bundle.image_media([{**descriptors[0], "media_type": "application/pdf"}])
            attached.path.write_bytes(b"different")
            with self.assertRaisesRegex(input_bundle.InputBundleError, "CONTENT_MISMATCH"):
                input_bundle.read_handoff(made["handoffPath"], REQ, descriptors, image=True)


if __name__ == "__main__": unittest.main()
