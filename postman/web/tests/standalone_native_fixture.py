"""Offline Direct child for the Harness standalone current-attachment regression.
Only external GitHub task publication/browser IO are controlled; input staging and
handoff originate in the real Harness grants and all Send proofs run real helpers.
"""
import base64
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT), str(Path(__file__).parent), str(ROOT / "postman" / "web")]
from postman import input_bundle
from postman.direct import postman_direct as direct, postman_ask as ask
from test_input_attachment import ZipPage, proof
from postman.web import browser_submit
from test_native_image_input import NativeImageTests


def run(argv):
    def arg(name): return argv[argv.index(name) + 1]
    req = arg("-RequestId")
    task = base64.b64decode(arg("-TaskBase64")).decode("utf-8")
    descriptors = json.loads(base64.b64decode(arg("-InputFilesBase64")))
    image = "-ImageMode" in argv
    text = Path(arg("-File")).name == "postman-ask.ps1"
    case = unittest.TestCase()
    case.assertEqual(arg("-Branch"), "main")
    case.assertEqual(len(descriptors), 1)
    case.assertEqual(descriptors[0]["source_kind"], "native")
    case.assertFalse(any(key in descriptors[0] for key in ("repository", "commit", "path", "raw_url")))
    handoff = arg("-InputBundleManifest")
    attached = input_bundle.read_handoff(handoff, req, descriptors, image=image)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        if image:
            import test_native_image_input as fixture
            # Reuse the real generation -> observer -> packaging -> extraction flow,
            # with the request-bound attachment built by Harness (not a Python re-stage).
            fixture.REQ = req
            evidence = NativeImageTests().run_image_flow(root, descriptors,
                {"handoffPath": handoff}, attached, task)
        else:
            captured, sends = [], []
            class Publisher:
                def __init__(self, **kwargs): pass
                def snapshot(self): return direct.TaskSnapshot("a" * 40, ("postman",))
                def publish_content(self, request_id, content, **kwargs):
                    case.assertEqual(request_id, req)
                    captured.append(content)
                    return direct.PublishedTask(req,
                        f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{'b' * 40}/{req}.md",
                        "a" * 40, "b" * 40, ("postman",))
            class Bridge:
                def __init__(self, **kwargs): pass
                def run_request(self, request_id, **kwargs):
                    case.assertEqual(request_id, req)
                    item = kwargs["input_attachment"]
                    case.assertEqual(item.upload_bytes(), attached.upload_bytes())
                    with zipfile.ZipFile(item.path) as archive:
                        manifest = json.loads(archive.read("POSTMAN_INPUT_MANIFEST.json"))
                        case.assertEqual(manifest["request_id"], req)
                        case.assertEqual(manifest["file_count"], 1)
                        entry = manifest["files"][0]
                        data = archive.read(entry["archive_path"])
                        case.assertEqual(hashlib.sha256(data).hexdigest(), descriptors[0]["sha256"])
                        case.assertEqual(len(data), descriptors[0]["byte_length"])
                    page = ZipPage()
                    page.upload_result = proof(name=item.name, file_id="standalone-native")
                    page.sent_result = proof(name=item.name, file_id="standalone-native")
                    sent = browser_submit.submit_fresh_prompt(page, kwargs["prompt"], timeout_ms=0, input_attachment=item)
                    case.assertEqual(sent["sendState"], "PROVEN_SENT", sent)
                    case.assertTrue(sent["details"]["sentAttachmentConfirmed"])
                    case.assertEqual(page.click_count, 1)
                    case.assertEqual(len(page.user_turns), 1)
                    case.assertEqual(page.uploads, [dict(name=item.name, mimeType="application/zip", buffer=item.upload_bytes())])
                    sends.append(sent["sendState"])
                    answer = f"{ask.text_result.begin_marker(req)}\nanswer\n{ask.text_result.end_marker(req)}" if text else "no result ZIP"
                    return dict(ok=True, code="ASSISTANT_COMPLETED_NO_ARTIFACT", details=dict(
                        assistantText=answer, assistantTextSha256=hashlib.sha256(answer.encode()).hexdigest(),
                        conversationUrl="https://chatgpt.com/c/standalone-native", conversationId="standalone-native",
                        assistantIndex=1, noArtifactRecheckMs=10000))
            cls = ask.DirectPostmanAsk if text else direct.DirectPostman
            options = dict(branch="main", repo_root=root, direct_root=root / "direct",
                publisher_factory=Publisher, bridge_factory=Bridge,
                ensure_browser=lambda **kwargs: {"cdpUrl": "http://127.0.0.1:9222"})
            if not text: options["result_root"] = root / "results"
            result = cls(**options).run(request_id=req, task=task, input_files=descriptors, input_bundle_manifest=handoff)
            case.assertTrue(result["ok"], result)
            if text: case.assertEqual(result["code"], "TEXT_RESULT_DURABLE")
            case.assertEqual(len(captured), 1)
            case.assertIn("## User intent\n\n" + task, captured[0])
            case.assertNotIn("raw_url", captured[0])
            evidence = dict(terminal=result, generationSends=1, packagingSends=0, sendStates=sends, mimeType="application/zip")
        case.assertFalse(Path(handoff).exists())
        case.assertFalse(attached.path.exists())
        # The Harness terminal gate reads durable image bytes before this temp root exits.
        # Copy only the test result into the independently Host-owned request root.
        if image:
            target = Path(handoff).parent / "result.png"
            target.write_bytes(Path(evidence["terminal"]["resultImage"]).read_bytes())
            evidence["terminal"]["resultImage"] = str(target)
        result = evidence.pop("terminal")
        result["standaloneEvidence"] = evidence
        return result


if __name__ == "__main__":
    print(json.dumps(run(sys.argv[1:]), ensure_ascii=False))
