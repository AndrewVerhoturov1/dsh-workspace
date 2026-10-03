import base64
import hashlib
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from postman import input_bundle as bundle, input_files, task_package, text_task_package
from postman.direct import postman_direct, postman_ask

REQ = "REQ_20261001T000000Z_0001"
REPO = "AndrewVerhoturov1/dsh-workspace"
COMMIT = "a" * 40


def descriptor(data, name="note.txt", path="docs/note.txt"):
    return dict(name=name, repository=REPO, commit=COMMIT, path=path,
                sha256=hashlib.sha256(data).hexdigest(), byte_length=len(data))


def snapshots(root, contents):
    records = []
    for i, data in enumerate(contents, 1):
        path = root / f"{i:03d}.bin"
        path.write_bytes(data)
        records.append(dict(snapshot_path=str(path), sha256=bundle.digest(data), byte_length=len(data)))
    return records


class InputBundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def build(self, contents=(b"exact text",), names=None):
        descriptors = [descriptor(data, names[i] if names else "note.txt", f"docs/{i}.bin") for i, data in enumerate(contents)]
        result = bundle.build_bundle(REQ, descriptors, snapshots(self.root, contents), self.root)
        return descriptors, result, bundle.read_handoff(result["handoffPath"], REQ, descriptors)

    def test_single_text_png_multiple_duplicates_and_final_digest(self):
        for contents in [(b"text",), (b"\x89PNG\r\n\x1a\nmarker",), (b"one", b"two")]:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                descriptors = [descriptor(data) for data in contents]
                with patch.object(bundle, "verify_zip", wraps=bundle.verify_zip) as verified:
                    result = bundle.build_bundle(REQ, descriptors, snapshots(root, contents), root)
                    attached = bundle.read_handoff(result["handoffPath"], REQ, descriptors)
                    data = attached.upload_bytes()
                    self.assertEqual(verified.call_count, 1)  # Build-only contents proof; later boundaries use outer hash.
                self.assertEqual(result["bundleSha256"], bundle.digest(data))
                self.assertEqual(result["bundleByteLength"], len(data))
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    self.assertEqual(archive.namelist(), [bundle.MANIFEST] + [f"files/{i:03d}-note.txt" for i in range(1, len(contents) + 1)])
                    manifest = json.loads(archive.read(bundle.MANIFEST))
                    self.assertEqual(manifest["request_id"], REQ)
                    self.assertEqual(manifest["file_count"], len(contents))
                    for expected, record in zip(descriptors, manifest["files"]):
                        for key, value in expected.items():
                            self.assertEqual(record[key], value)
                    self.assertEqual([archive.read(n) for n in archive.namelist()[1:]], list(contents))
                    self.assertNotIn(str(root), archive.read(bundle.MANIFEST).decode())

    def test_safe_names_independent_of_descriptor_validation(self):
        for malicious in ["../../secret.txt", "C:\\private\\x.png", "/abs", "..", "\0evil", "a\nb.zip", "a:b.png", "кириллица.png"]:
            name = bundle.safe_name(malicious)
            self.assertFalse(any(c in name for c in "/\\:\0\n"))
            self.assertNotIn("..", name)
            self.assertEqual(name, bundle.safe_name(malicious))
        descriptors, _, attachment = self.build((b"a", b"b"), ["a:b.png", "a..b.png"])
        manifest = bundle.verify_zip(attachment.upload_bytes(), REQ, descriptors)
        self.assertEqual([f["archive_path"] for f in manifest["files"]], ["files/001-a_b.png", "files/002-a_b.png"])
        self.assertEqual([f["name"] for f in manifest["files"]], ["a:b.png", "a..b.png"])

    def test_deterministic_bytes(self):
        all_bytes = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); descriptors = [descriptor(b"data")]
                result = bundle.build_bundle(REQ, descriptors, snapshots(root, [b"data"]), root)
                all_bytes.append(bundle.read_handoff(result["handoffPath"], REQ, descriptors).upload_bytes())
        self.assertEqual(*all_bytes)

    def test_modified_missing_snapshot_and_limits(self):
        descriptors = [descriptor(b"original")]
        records = snapshots(self.root, [b"original"])
        Path(records[0]["snapshot_path"]).write_bytes(b"modified")
        with self.assertRaisesRegex(bundle.InputBundleError, "MATERIALIZATION_MISMATCH"):
            bundle.build_bundle(REQ, descriptors, records, self.root)
        Path(records[0]["snapshot_path"]).unlink()
        with self.assertRaisesRegex(bundle.InputBundleError, "MATERIALIZATION_MISSING"):
            bundle.build_bundle(REQ, descriptors, records, self.root)
        for field, value in [("byte_length", bundle.MAX_INPUT_BYTES + 1)]:
            with self.assertRaisesRegex(bundle.InputBundleError, "LIMIT_EXCEEDED"):
                bundle.manifest_for(REQ, [{**descriptors[0], field: value}])
        with self.assertRaisesRegex(bundle.InputBundleError, "LIMIT_EXCEEDED"):
            bundle.manifest_for(REQ, [{**descriptors[0], "byte_length": bundle.MAX_INPUT_BYTES}] * 4)
        with self.assertRaisesRegex(bundle.InputBundleError, "LIMIT_EXCEEDED"):
            bundle.manifest_for(REQ, descriptors * 21)
        with patch.object(bundle, "MAX_ZIP_BYTES", 2), self.assertRaisesRegex(bundle.InputBundleError, "LIMIT_EXCEEDED"):
            bundle.verify_zip(b"zip", REQ, descriptors)

    def test_corrupt_reopen_extra_entries_symlink_and_manifest_mapping(self):
        descriptors, _, attached = self.build()
        original = attached.upload_bytes()
        with self.assertRaisesRegex(bundle.InputBundleError, "BUNDLE_INVALID"):
            bundle.verify_zip(b"corrupt", REQ, descriptors)
        for alteration in ["extra", "directory", "symlink", "req", "count", "hash", "bytes", "duplicate"]:
            with self.subTest(alteration=alteration):
                out = io.BytesIO()
                with zipfile.ZipFile(io.BytesIO(original)) as src, zipfile.ZipFile(out, "w") as dest:
                    for info in src.infolist():
                        data = src.read(info)
                        if info.filename == bundle.MANIFEST and alteration in {"req", "count", "hash"}:
                            value = json.loads(data)
                            if alteration == "req": value["request_id"] = REQ.replace("0001", "0002")
                            if alteration == "count": value["file_count"] = 2
                            if alteration == "hash": value["files"][0]["sha256"] = "f" * 64
                            data = bundle.canonical(value)
                        if info.filename != bundle.MANIFEST and alteration == "bytes": data = b"wrong"
                        if info.filename != bundle.MANIFEST and alteration == "symlink": info.external_attr = (stat.S_IFLNK | 0o777) << 16
                        dest.writestr(info, data)
                    if alteration == "extra": dest.writestr("extra.txt", "extra")
                    if alteration == "directory": dest.writestr("files/", "")
                    if alteration == "duplicate": dest.writestr(bundle.MANIFEST, "{}")
                with self.assertRaises(bundle.InputBundleError):
                    bundle.verify_zip(out.getvalue(), REQ, descriptors)
        with patch.object(bundle, "verify_zip", side_effect=bundle.InputBundleError("POSTMAN_INPUT_BUNDLE_INVALID")):
            other = self.root / "other"; other.mkdir()
            with self.assertRaisesRegex(bundle.InputBundleError, "BUNDLE_INVALID"):
                bundle.build_bundle(REQ, descriptors, snapshots(other, [b"exact text"]), other)
            self.assertFalse((other / "input-handoff.json").exists())

    def test_symlink_guard_without_platform_privilege_and_directory(self):
        descriptors, result, attached = self.build()
        actual = Path.is_symlink
        with patch.object(Path, "is_symlink", lambda path: path == attached.path or actual(path)):
            with self.assertRaisesRegex(bundle.InputBundleError, "HANDOFF_INVALID"):
                bundle.read_handoff(result["handoffPath"], REQ, descriptors)
        attached.path.unlink(); attached.path.mkdir()
        with self.assertRaisesRegex(bundle.InputBundleError, "HANDOFF_INVALID"):
            bundle.read_handoff(result["handoffPath"], REQ, descriptors)

    def test_stage_limits_before_publication_and_empty_rejected(self):
        source = self.root / "large.txt"; source.write_bytes(b"12345")
        with patch.object(input_files, "MAX_INPUT_BYTES", 4), self.assertRaisesRegex(input_files.InputStageError, "LIMIT_EXCEEDED"):
            input_files.selected_file(str(source))
        with patch.object(input_files, "MAX_AGGREGATE_BYTES", 4), self.assertRaisesRegex(input_files.InputStageError, "LIMIT_EXCEEDED"):
            input_files.GitHubInputPublisher(lambda *args: self.fail("publication forbidden"), snapshot_dir=self.root).stage([str(source)])
        source.write_bytes(b"")
        with self.assertRaisesRegex(input_files.InputStageError, "empty"):
            input_files.selected_file(str(source))

    def test_strict_handoff_and_changed_zip(self):
        descriptors, result, attached = self.build()
        path = Path(result["handoffPath"]); original = path.read_bytes()
        value = json.loads(original)
        for changed in [{**value, "request_id": REQ.replace("0001", "0002")}, {**value, "extra": "C:/secret"},
                        {**value, "version": True}, {**value, "descriptor_set_digest": "f" * 64},
                        {**value, "attachment": {**value["attachment"], "name": "evil.zip"}}]:
            path.write_bytes(bundle.canonical(changed))
            with self.assertRaisesRegex(bundle.InputBundleError, "HANDOFF_INVALID"):
                bundle.read_handoff(path, REQ, descriptors)
        path.write_bytes(original)
        attached.path.write_bytes(b"modified zip")
        with self.assertRaisesRegex(bundle.InputBundleError, "CONTENT_MISMATCH"):
            bundle.read_handoff(path, REQ, descriptors)

    def test_bundle_symlink_and_directory_rejected(self):
        descriptors, result, attached = self.build()
        contents = attached.path.read_bytes(); attached.path.unlink()
        target = self.root / "target"; target.write_bytes(contents)
        try:
            attached.path.symlink_to(target)
        except OSError:
            self.skipTest("symlinks unavailable")
        with self.assertRaisesRegex(bundle.InputBundleError, "HANDOFF_INVALID"):
            bundle.read_handoff(result["handoffPath"], REQ, descriptors)
        attached.path.unlink(); attached.path.mkdir()
        with self.assertRaisesRegex(bundle.InputBundleError, "HANDOFF_INVALID"):
            bundle.read_handoff(result["handoffPath"], REQ, descriptors)

    def test_stage_one_read_snapshot_survives_source_mutation(self):
        source = self.root / "selected.txt"; source.write_bytes(b"authorized-A")
        private = self.root / "snapshot"; private.mkdir()
        publisher = input_files.GitHubInputPublisher(lambda *args: self.fail("GitHub forbidden"), snapshot_dir=private)
        original = input_files.selected_file
        def read_once(path):
            item = original(path)
            source.write_bytes(b"changed-B")
            return item
        with patch.object(input_files, "selected_file", side_effect=read_once) as selected:
            result = publisher.stage([str(source)])
            self.assertEqual(selected.call_count, 1)
        self.assertEqual(result["descriptors"][0]["source_kind"], "native")
        self.assertNotIn("raw_url", result["descriptors"][0])
        request = self.root / "request"; request.mkdir()
        result_zip = bundle.build_bundle(REQ, result["descriptors"], publisher.materializations, request)
        attachment = bundle.read_handoff(result_zip["handoffPath"], REQ, result["descriptors"])
        with zipfile.ZipFile(io.BytesIO(attachment.upload_bytes())) as archive:
            self.assertEqual(archive.read("files/001-selected.txt"), b"authorized-A")

    def test_existing_single_fetch_snapshot_and_mismatch(self):
        data = b"exact GitHub bytes"; calls = []
        def api(endpoint, *args):
            calls.append(endpoint)
            return dict(type="file", encoding="base64", content=base64.b64encode(data).decode(), size=len(data))
        publisher = input_files.GitHubInputPublisher(api, snapshot_dir=self.root)
        desc = publisher.existing(COMMIT, "docs/note.txt")
        result = bundle.build_bundle(REQ, [desc], publisher.materializations, self.root)
        bundle.read_handoff(result["handoffPath"], REQ, [desc])
        self.assertEqual(len(calls), 1)
        self.assertEqual(desc["sha256"], bundle.digest(data))
        self.assertEqual(Path(publisher.materializations[0]["snapshot_path"]).read_bytes(), data)
        invalid = input_files.GitHubInputPublisher(lambda *args: dict(type="file", encoding="base64", content="YQ==", size=2), snapshot_dir=self.root)
        with self.assertRaisesRegex(input_files.InputStageError, "MATERIALIZATION_MISMATCH"):
            invalid.existing(COMMIT, "docs/note.txt")

    def test_direct_modes_require_handoff_and_no_browser_on_mismatch(self):
        descriptors, result, attached = self.build()
        for cls in [postman_direct.DirectPostman, postman_ask.DirectPostmanAsk]:
            direct = cls(branch="task/postman-" + "f" * 32, repo_root=self.root, direct_root=self.root / "direct",
                         ensure_browser=lambda **kwargs: self.fail("browser must not run"))
            error_type = postman_ask.DirectPostmanError if cls is postman_ask.DirectPostmanAsk else postman_direct.DirectPostmanError
            direct.publication_receipt = {"stale": "previous request"}
            with self.assertRaisesRegex(error_type, "HANDOFF_INVALID") as failure:
                direct.run(request_id=REQ, task="intent", input_files=descriptors)
            self.assertIsNone(direct.publication_receipt)
            self.assertEqual(failure.exception.details["inputBundlePhase"], "direct-handoff")
            with self.assertRaisesRegex(error_type, "HANDOFF_INVALID"):
                direct.run(request_id=REQ.replace("0001", "0002"), task="intent", input_files=descriptors, input_bundle_manifest=result["handoffPath"])
        attached.path.write_bytes(b"changed")
        with self.assertRaisesRegex(error_type, "CONTENT_MISMATCH"):
            direct.run(request_id=REQ, task="intent", input_files=descriptors, input_bundle_manifest=result["handoffPath"])

    def test_actual_direct_and_ask_handoff_survives_browser_then_cleanup(self):
        # Real task renderer/Direct entrypoints, fake only external publication/browser result.
        for mode in ("artifact", "text"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source = root / "selected.txt"; source.write_bytes(b"exact bytes")
                snapshot_root = root / "snapshots"; snapshot_root.mkdir()
                staged = input_files.GitHubInputPublisher(lambda *a: self.fail("GitHub input publication"), snapshot_dir=snapshot_root)
                selected = staged.stage([str(source)])
                descriptors = selected["descriptors"]
                made = bundle.build_bundle(REQ, descriptors, staged.materializations, root)
                handoff = Path(made["handoffPath"])
                zip_path = root / f"POSTMAN_INPUT_{REQ}.zip"
                captured = []
                class Publisher:
                    def __init__(self, **kwargs): pass
                    def snapshot(self): return postman_direct.TaskSnapshot(COMMIT, ("postman",))
                    def publish_content(self, request_id, content, **kwargs):
                        captured.append(content)
                        return postman_direct.PublishedTask(request_id,
                            f"https://raw.githubusercontent.com/{REPO}/{'b' * 40}/{REQ}.md", COMMIT, 'b' * 40, ("postman",))
                class Bridge:
                    def __init__(self, **kwargs): pass
                    def run_request(inner, request_id, **kwargs):
                        self.assertTrue(handoff.exists())
                        self.assertTrue(zip_path.exists())
                        attached = kwargs["input_attachment"]
                        self.assertEqual(attached.request_id, REQ)
                        self.assertEqual(len(kwargs["prompt"].splitlines()), 2)
                        self.assertEqual(attached.upload_bytes(), zip_path.read_bytes())
                        import sys
                        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "web" / "tests"))
                        from test_input_attachment import ZipPage, proof
                        from postman.web import browser_submit
                        page = ZipPage()
                        page.upload_result = proof(name=attached.name)
                        page.sent_result = proof(name=attached.name)
                        sent = browser_submit.submit_fresh_prompt(page, kwargs["prompt"], timeout_ms=0, input_attachment=attached)
                        self.assertEqual(sent["sendState"], "PROVEN_SENT", sent)
                        self.assertTrue(sent["details"]["sentAttachmentConfirmed"])
                        self.assertEqual(page.click_count, 1)
                        self.assertEqual(page.uploads[0]["buffer"], zip_path.read_bytes())
                        self.assertNotIn("snapshot_path", kwargs["expected_request"])
                        if mode == "artifact":
                            return {"ok": True, "code": "ASSISTANT_COMPLETED_NO_ARTIFACT", "details": {
                                "assistantText": "no result ZIP", "conversationUrl": "https://chatgpt.com/c/inputs-test",
                                "conversationId": "inputs-test", "noArtifactRecheckMs": 10000}}
                        return {"ok": True, "code": "ASSISTANT_COMPLETED_NO_ARTIFACT", "details": {
                            "assistantText": f"{postman_ask.text_result.begin_marker(REQ)}\nanswer\n{postman_ask.text_result.end_marker(REQ)}",
                            "assistantTextSha256": "c" * 64, "conversationUrl": "https://chatgpt.com/c/inputs-test",
                            "conversationId": "inputs-test", "assistantIndex": 1, "noArtifactRecheckMs": 10000}}
                cls = postman_direct.DirectPostman if mode == "artifact" else postman_ask.DirectPostmanAsk
                options = dict(branch="main", repo_root=root, direct_root=root / "direct", publisher_factory=Publisher,
                    bridge_factory=Bridge, ensure_browser=lambda **kwargs: {"cdpUrl": "http://127.0.0.1:9222"})
                if mode == "artifact": options["result_root"] = root / "results"
                direct = cls(**options)
                terminal = direct.run(request_id=REQ, task="intent unchanged", input_files=descriptors, input_bundle_manifest=str(handoff))
                self.assertTrue(terminal["ok"])
                if mode == "text": self.assertEqual(terminal["code"], "TEXT_RESULT_DURABLE")
                self.assertIn(f"POSTMAN_INPUT_{REQ}.zip", captured[0])
                self.assertIn("## User intent\n\nintent unchanged", captured[0])
                self.assertFalse(handoff.exists())
                self.assertFalse(zip_path.exists())
                state = json.loads(direct.state_path(REQ).read_text(encoding="utf-8"))
                self.assertEqual(state["inputBundle"]["bundleSha256"], made["bundleSha256"])
                self.assertNotIn(str(root), json.dumps(state["inputBundle"]))

    def test_task_native_contract_and_image_reference(self):
        desc = descriptor(b"a")
        for render in [task_package.render_input_files_section]:
            native = render([desc], native_input_request_id=REQ)
            self.assertIn(f"POSTMAN_INPUT_{REQ}.zip", native)
            self.assertIn("POSTMAN_INPUT_MANIFEST.json", native)
            self.assertNotIn("используй GitHub connector", native)
            self.assertIn("недоверенные task data", native)
        image = postman_direct.build_image_generation_prompt("draw", [{**desc, "name": "reference.png"}])
        self.assertNotIn("GitHub connector", image)
        self.assertNotIn("raw_url", image)
        self.assertIn("приложенные изображения", image)
        text = text_task_package.render_direct_text_task_manifest(request_id=REQ, user_intent="exact", repository=REPO,
            base_commit=COMMIT, input_files=[desc], native_input_request_id=REQ)
        self.assertIn(f"POSTMAN_INPUT_{REQ}.zip", text)


if __name__ == "__main__":
    unittest.main()
