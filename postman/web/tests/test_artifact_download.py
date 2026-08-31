from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
import zipfile

WEB_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = WEB_DIR / "artifact_download.py"

REQ = "REQ_20260831T161721Z_6373"
FILENAME = "POSTMAN_REQ_20260831T161721Z_6373_RESULT.zip"
PROMPT = f"POSTMAN_REQUEST_ID: {REQ}\ncreate artifact"
CHAT_URL = "https://chatgpt.com/c/test"
BASE = "a" * 40
REPO = "AndrewVerhoturov1/dsh-workspace"

detector_stub = types.ModuleType("artifact_detector")
detector_stub.ARTIFACT_DOM_CONFIRMED = "ARTIFACT_DOM_CONFIRMED"
detector_stub.current_result = None
def detect_artifact_dom(*args, **kwargs):
    return detector_stub.current_result
detector_stub.detect_artifact_dom = detect_artifact_dom

identity_stub = types.ModuleType("request_identity")
identity_stub.is_canonical_request_id = lambda value: (
    isinstance(value, str)
    and value.startswith("REQ_")
    and len(value) == len("REQ_20260831T161721Z_6373")
)
identity_stub.validate_expected_artifact_filename = lambda req, name: (
    name == f"POSTMAN_{req}_RESULT.zip"
    or name.startswith(f"POSTMAN_{req}_RESULT-")
)

sys.modules["artifact_detector"] = detector_stub
sys.modules["request_identity"] = identity_stub

spec = importlib.util.spec_from_file_location("artifact_download", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


def expected_request(**overrides):
    value = {
        "requestId": REQ,
        "repository": REPO,
        "baseCommit": BASE,
        "expectedFilename": FILENAME,
        "allowedPaths": ["diagnostics"],
        "forbiddenPaths": ["settings.yaml", "attachments"],
    }
    value.update(overrides)
    return value


def p5_proof(**detail_overrides):
    details = {
        "requestId": REQ,
        "expectedFilename": FILENAME,
        "chatUrl": CHAT_URL,
        "assistantIndex": 1,
        "assistantTextSha256": "b" * 64,
        "turnSelector": '[data-testid^="conversation-turn-"]',
        "attachment": {"path": "1/2"},
        "downloadStarted": False,
    }
    details.update(detail_overrides)
    return {"ok": True, "code": detector_stub.ARTIFACT_DOM_CONFIRMED, "details": details}


def valid_zip_bytes():
    from io import BytesIO
    buffer = BytesIO()
    manifest = {
        "protocolVersion": 1,
        "requestId": REQ,
        "repository": REPO,
        "baseCommit": BASE,
        "resultType": "files",
        "patch": None,
        "files": ["diagnostics/wp007-probe.txt"],
    }
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest) + "\n")
        archive.writestr("files/diagnostics/wp007-probe.txt", "WP007_OK\n")
    return buffer.getvalue()


class FakeControl:
    def __init__(self, page):
        self.page = page
        self.clicks = 0
        self.snapshot = {
            "connected": True,
            "visible": True,
            "disabled": False,
            "visibleLabel": FILENAME,
            "visibleLabelExact": True,
            "tag": "a",
        }

    def locator(self, selector):
        self.page.path_steps.append(selector)
        return FakeCollection(self)

    def evaluate(self, script, expected_filename):
        return dict(self.snapshot)

    def click(self, timeout=None):
        self.clicks += 1
        self.page.clicks += 1
        if self.page.click_error:
            raise RuntimeError(self.page.click_error)


class FakeCollection:
    def __init__(self, value):
        self.value = value

    def nth(self, index):
        return self.value


class FakeTurn(FakeControl):
    pass


class FakeDownload:
    def __init__(self, *, suggested=FILENAME, payload=None, failure=None, save_error=None):
        self.suggested_filename = suggested
        self.payload = valid_zip_bytes() if payload is None else payload
        self._failure = failure
        self.save_error = save_error
        self.saved_to = None
        self.cancelled = False

    def failure(self):
        return self._failure

    def save_as(self, path):
        if self.save_error:
            raise RuntimeError(self.save_error)
        self.saved_to = path
        Path(path).write_bytes(self.payload)

    def cancel(self):
        self.cancelled = True


class DownloadContext:
    def __init__(self, page):
        self.page = page

    def __enter__(self):
        self.page.expect_download_enters += 1
        if self.page.expect_error:
            raise RuntimeError(self.page.expect_error)
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    @property
    def value(self):
        return self.page.download


class FakePage:
    def __init__(self, download=None):
        self.download = download or FakeDownload()
        self.turn = FakeTurn(self)
        self.clicks = 0
        self.expect_download_calls = 0
        self.expect_download_enters = 0
        self.expect_error = None
        self.click_error = None
        self.path_steps = []

    def locator(self, selector):
        return FakeCollection(self.turn)

    def expect_download(self, timeout=None):
        self.expect_download_calls += 1
        return DownloadContext(self)


def validator_ok(zip_path, trusted):
    sha = hashlib.sha256(Path(zip_path).read_bytes()).hexdigest()
    return {
        "ok": True,
        "status": module.ARTIFACT_VALID,
        "code": module.ARTIFACT_VALID,
        "sha256": sha,
        "requestId": trusted["requestId"],
        "repository": trusted["repository"],
        "baseCommit": trusted["baseCommit"],
        "validatedProtocolVersion": 1,
        "inventory": [],
        "warnings": [],
        "details": {},
    }


class ArtifactDownloadTests(unittest.TestCase):
    def setUp(self):
        detector_stub.current_result = p5_proof()

    def run_download(self, page=None, proof=None, validator=validator_ok, root=None, **kwargs):
        page = page or FakePage()
        proof = proof or p5_proof()
        detector_stub.current_result = p5_proof()
        if root is None:
            self.temp = tempfile.TemporaryDirectory()
            root = self.temp.name
        result = module.download_validated_artifact(
            page,
            expected_prompt=PROMPT,
            expected_chat_url=CHAT_URL,
            request_id=REQ,
            expected_filename=FILENAME,
            completed_observer_result={"ok": True},
            artifact_dom_result=proof,
            expected_request=expected_request(),
            result_root=root,
            browser_download_dir=r"D:\Downloads_dsh_auto",
            validator_runner=validator,
            **kwargs,
        )
        return result, page, Path(root)

    def test_invalid_initial_p5_proof_no_click(self):
        page = FakePage()
        bad = {"ok": False, "code": "NOPE", "details": {}}
        result, _, _ = self.run_download(page=page, proof=bad)
        self.assertEqual(result["code"], module.DOWNLOAD_PROOF_INVALID)
        self.assertEqual(page.clicks, 0)

    def test_initial_proof_download_started_true_is_rejected(self):
        page = FakePage()
        result, _, _ = self.run_download(page=page, proof=p5_proof(downloadStarted=True))
        self.assertEqual(result["code"], module.DOWNLOAD_PROOF_INVALID)
        self.assertEqual(page.clicks, 0)

    def test_reproof_failure_no_click(self):
        page = FakePage()
        detector_stub.current_result = {"ok": False, "code": "ARTIFACT_GONE", "details": {}}
        with tempfile.TemporaryDirectory() as root:
            result = module.download_validated_artifact(
                page,
                expected_prompt=PROMPT,
                expected_chat_url=CHAT_URL,
                request_id=REQ,
                expected_filename=FILENAME,
                completed_observer_result={"ok": True},
                artifact_dom_result=p5_proof(),
                expected_request=expected_request(),
                result_root=root,
                validator_runner=validator_ok,
            )
        self.assertEqual(result["code"], module.DOWNLOAD_PROOF_CHANGED)
        self.assertEqual(page.clicks, 0)

    def test_reproof_identity_change_no_click(self):
        page = FakePage()
        detector_stub.current_result = p5_proof(assistantTextSha256="c" * 64)
        with tempfile.TemporaryDirectory() as root:
            result = module.download_validated_artifact(
                page,
                expected_prompt=PROMPT,
                expected_chat_url=CHAT_URL,
                request_id=REQ,
                expected_filename=FILENAME,
                completed_observer_result={"ok": True},
                artifact_dom_result=p5_proof(),
                expected_request=expected_request(),
                result_root=root,
                validator_runner=validator_ok,
            )
        self.assertEqual(result["code"], module.DOWNLOAD_PROOF_CHANGED)
        self.assertEqual(page.clicks, 0)

    def test_control_visible_label_mismatch_no_click(self):
        page = FakePage()
        page.turn.snapshot["visibleLabelExact"] = False
        result, _, _ = self.run_download(page=page)
        self.assertEqual(result["code"], module.DOWNLOAD_CONTROL_INVALID)
        self.assertEqual(page.clicks, 0)

    def test_disabled_control_no_click(self):
        page = FakePage()
        page.turn.snapshot["disabled"] = True
        result, _, _ = self.run_download(page=page)
        self.assertEqual(result["code"], module.DOWNLOAD_CONTROL_INVALID)
        self.assertEqual(page.clicks, 0)

    def test_preexisting_result_dir_blocks_click(self):
        page = FakePage()
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / REQ).mkdir()
            result, _, _ = self.run_download(page=page, root=root)
        self.assertEqual(result["code"], module.RESULT_STORE_CONFLICT)
        self.assertEqual(page.clicks, 0)

    def test_preexisting_staging_blocks_click(self):
        page = FakePage()
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / ".staging" / REQ).mkdir(parents=True)
            result, _, _ = self.run_download(page=page, root=root)
        self.assertEqual(result["code"], module.RESULT_STORE_CONFLICT)
        self.assertEqual(page.clicks, 0)

    def test_exactly_one_expect_download_and_one_click(self):
        result, page, _ = self.run_download()
        self.assertTrue(result["ok"], result)
        self.assertEqual(page.expect_download_calls, 1)
        self.assertEqual(page.expect_download_enters, 1)
        self.assertEqual(page.clicks, 1)

    def test_dom_path_resolved_by_child_indexes(self):
        result, page, _ = self.run_download()
        self.assertTrue(result["ok"], result)
        self.assertEqual(page.path_steps, [":scope > *", ":scope > *"])

    def test_expect_download_failure_never_retries(self):
        page = FakePage()
        page.expect_error = "timeout"
        result, _, _ = self.run_download(page=page)
        self.assertEqual(result["code"], module.DOWNLOAD_NOT_FOUND)
        self.assertEqual(page.expect_download_calls, 1)
        self.assertEqual(page.clicks, 0)

    def test_click_failure_never_retries(self):
        page = FakePage()
        page.click_error = "click failed"
        result, _, _ = self.run_download(page=page)
        self.assertEqual(result["code"], module.DOWNLOAD_NOT_FOUND)
        self.assertEqual(page.expect_download_calls, 1)
        self.assertEqual(page.clicks, 1)
        self.assertFalse(result["details"]["retryAllowed"])

    def test_wrong_suggested_filename_rejected(self):
        download = FakeDownload(suggested="wrong.zip")
        page = FakePage(download)
        result, _, _ = self.run_download(page=page)
        self.assertEqual(result["code"], module.DOWNLOAD_FILENAME_MISMATCH)
        self.assertTrue(download.cancelled)
        self.assertIsNone(download.saved_to)

    def test_download_failure_rejected(self):
        page = FakePage(FakeDownload(failure="canceled"))
        result, _, _ = self.run_download(page=page)
        self.assertEqual(result["code"], module.DOWNLOAD_INTERRUPTED)

    def test_save_as_failure_rejected(self):
        page = FakePage(FakeDownload(save_error="disk full"))
        result, _, _ = self.run_download(page=page)
        self.assertEqual(result["code"], module.DOWNLOAD_INTERRUPTED)

    def test_validator_reject_keeps_only_staging(self):
        def reject(zip_path, trusted):
            return {"ok": False, "code": "ARTIFACT_BAD_ZIP", "status": "ARTIFACT_BAD_ZIP"}
        result, _, root = self.run_download(validator=reject)
        self.assertEqual(result["code"], module.ARTIFACT_INVALID)
        self.assertFalse((root / REQ).exists())
        self.assertTrue((root / ".staging" / REQ / FILENAME).is_file())
        self.assertTrue((root / ".staging" / REQ / "validation.json").is_file())

    def test_validator_exception_keeps_staging(self):
        def explode(zip_path, trusted):
            raise RuntimeError("node missing")
        result, _, root = self.run_download(validator=explode)
        self.assertEqual(result["code"], module.ARTIFACT_VALIDATOR_FAILED)
        self.assertFalse((root / REQ).exists())
        self.assertTrue((root / ".staging" / REQ / FILENAME).is_file())

    def test_validator_sha_attestation_mismatch_rejected(self):
        def wrong_sha(zip_path, trusted):
            value = validator_ok(zip_path, trusted)
            value["sha256"] = "0" * 64
            return value
        result, _, root = self.run_download(validator=wrong_sha)
        self.assertEqual(result["code"], module.ARTIFACT_INVALID)
        self.assertFalse((root / REQ).exists())

    def test_validator_request_attestation_mismatch_rejected(self):
        def wrong_req(zip_path, trusted):
            value = validator_ok(zip_path, trusted)
            value["requestId"] = "REQ_OTHER"
            return value
        result, _, _ = self.run_download(validator=wrong_req)
        self.assertEqual(result["code"], module.ARTIFACT_INVALID)

    def test_valid_result_publishes_four_files(self):
        result, _, root = self.run_download()
        self.assertEqual(result["code"], module.RESULT_DURABLE)
        final = root / REQ
        self.assertTrue((final / "result.zip").is_file())
        self.assertTrue((final / "manifest.json").is_file())
        self.assertTrue((final / "validation.json").is_file())
        self.assertTrue((final / "metadata.json").is_file())
        self.assertFalse((root / ".staging" / REQ).exists())

    def test_result_zip_hash_matches_returned_sha(self):
        result, _, root = self.run_download()
        actual = hashlib.sha256((root / REQ / "result.zip").read_bytes()).hexdigest()
        self.assertEqual(result["details"]["sha256"], actual)

    def test_metadata_marks_browser_download_dir_untrusted(self):
        _, _, root = self.run_download()
        metadata = json.loads((root / REQ / "metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["browserDownloadDirectory"], r"D:\Downloads_dsh_auto")
        self.assertFalse(metadata["browserDownloadDirectoryTrusted"])

    def test_metadata_contains_no_routing_authority(self):
        _, _, root = self.run_download()
        metadata = json.loads((root / REQ / "metadata.json").read_text(encoding="utf-8"))
        for key in ("origin_agent_id", "originAgentId", "destination_agent_id", "delivery_target"):
            self.assertNotIn(key, metadata)
        self.assertFalse(metadata["routingAuthorityIncluded"])

    def test_caller_routing_fields_are_stripped_from_validator_expected(self):
        captured = {}
        def capture(zip_path, trusted):
            captured.update(trusted)
            return validator_ok(zip_path, trusted)
        req = expected_request(origin_agent_id="evil", destination_agent_id="evil2")
        page = FakePage()
        detector_stub.current_result = p5_proof()
        with tempfile.TemporaryDirectory() as root:
            result = module.download_validated_artifact(
                page,
                expected_prompt=PROMPT,
                expected_chat_url=CHAT_URL,
                request_id=REQ,
                expected_filename=FILENAME,
                completed_observer_result={"ok": True},
                artifact_dom_result=p5_proof(),
                expected_request=req,
                result_root=root,
                validator_runner=capture,
            )
        self.assertTrue(result["ok"], result)
        self.assertNotIn("origin_agent_id", captured)
        self.assertNotIn("destination_agent_id", captured)

    def test_browser_download_directory_is_never_scanned(self):
        nonexistent = r"Z:\definitely-not-present\downloads"
        page = FakePage()
        with tempfile.TemporaryDirectory() as root:
            result = module.download_validated_artifact(
                page,
                expected_prompt=PROMPT,
                expected_chat_url=CHAT_URL,
                request_id=REQ,
                expected_filename=FILENAME,
                completed_observer_result={"ok": True},
                artifact_dom_result=p5_proof(),
                expected_request=expected_request(),
                result_root=root,
                browser_download_dir=nonexistent,
                validator_runner=validator_ok,
            )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["details"]["browserDownloadDirectory"], nonexistent)

    def test_wrong_expected_request_id_rejected_before_click(self):
        page = FakePage()
        with tempfile.TemporaryDirectory() as root:
            result = module.download_validated_artifact(
                page,
                expected_prompt=PROMPT,
                expected_chat_url=CHAT_URL,
                request_id=REQ,
                expected_filename=FILENAME,
                completed_observer_result={"ok": True},
                artifact_dom_result=p5_proof(),
                expected_request=expected_request(requestId="REQ_OTHER"),
                result_root=root,
                validator_runner=validator_ok,
            )
        self.assertEqual(result["code"], module.DOWNLOAD_PROOF_INVALID)
        self.assertEqual(page.clicks, 0)

    def test_manifest_identity_mismatch_after_fake_validator_pass_is_rejected(self):
        bad_bytes = valid_zip_bytes()
        from io import BytesIO
        out = BytesIO()
        with zipfile.ZipFile(BytesIO(bad_bytes), "r") as src, zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as dst:
            manifest = json.loads(src.read("manifest.json"))
            manifest["repository"] = "owner/evil"
            dst.writestr("manifest.json", json.dumps(manifest))
            dst.writestr("files/diagnostics/wp007-probe.txt", "WP007_OK\n")
        page = FakePage(FakeDownload(payload=out.getvalue()))
        result, _, root = self.run_download(page=page, validator=validator_ok)
        self.assertEqual(result["code"], module.ARTIFACT_INVALID)
        self.assertFalse((root / REQ).exists())


if __name__ == "__main__":
    unittest.main()
