from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

DIRECT = Path(__file__).resolve().parents[1]
WEB = DIRECT.parent / "web"
sys.path[:0] = [str(DIRECT), str(WEB)]
spec = importlib.util.spec_from_file_location("durable_handoff", DIRECT / "durable_handoff.py")
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class ImageHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.first = "REQ_20260929T120000Z_1234"
        self.results = self.root / "results"
        directory = self.results / self.first
        directory.mkdir(parents=True)
        self.image = directory / "image.png"
        self.image.write_bytes(b"image fixture bytes")
        publication = "a" * 40
        self.state = self.root / "requests" / (self.first + ".json")
        self.receipt = self.root / "direct-results" / (self.first + ".json")
        self.data = {
            "ok": True, "code": handoff.IMAGE_RESULT_DURABLE, "state": handoff.IMAGE_RESULT_DURABLE,
            "requestId": self.first,
            "repository": "AndrewVerhoturov1/dsh-workspace", "baseCommit": "b" * 40,
            "taskPublicationCommit": publication,
            "taskUrl": f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{publication}/{self.first}.md",
            "expectedFilename": f"POSTMAN_{self.first}_RESULT.zip",
            "resultRoot": str(self.results), "resultImage": str(self.image), "imageFormat": "png",
            "imageSha256": hashlib.sha256(self.image.read_bytes()).hexdigest(),
            "imageByteLength": self.image.stat().st_size, "statePath": str(self.state),
            "resultHandoffPath": str(self.receipt),
        }

    def validate(self, data):
        return handoff.validate_image_terminal(data, expected_repository=self.data["repository"],
            request_id=self.first, expected_state_path=self.state, expected_handoff_path=self.receipt)

    def test_valid_exact_image_receipt(self):
        result = self.validate(self.data)
        self.assertEqual(result["resultImage"], str(self.image))
        self.assertEqual(result["code"], "IMAGE_RESULT_DURABLE")
        self.assertNotIn("secondRequestId", result)

    def test_jpeg_extension_matches_jpg_format(self):
        jpeg = self.image.with_name("image.jpeg")
        self.image.rename(jpeg)
        result = self.validate({**self.data, "resultImage": str(jpeg), "imageFormat": "jpg"})
        self.assertEqual(result["resultImage"], str(jpeg))

    def test_rejects_zip_descriptor_and_changed_bytes(self):
        with self.assertRaises(handoff.DurableHandoffError):
            self.validate({**self.data, "resultZip": "a.zip"})
        self.image.write_bytes(b"modified")
        with self.assertRaises(handoff.DurableHandoffError):
            self.validate(self.data)

    def test_rejects_foreign_image_or_request(self):
        other = self.root / "other" / "image.png"
        other.parent.mkdir()
        other.write_bytes(self.image.read_bytes())
        with self.assertRaises(handoff.DurableHandoffError):
            self.validate({**self.data, "resultImage": str(other)})
        with self.assertRaises(handoff.DurableHandoffError):
            self.validate({**self.data, "secondRequestId": "REQ_20260929T120001Z_1235"})


if __name__ == "__main__":
    unittest.main()
