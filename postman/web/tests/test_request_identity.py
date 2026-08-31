from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

WEB_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = WEB_DIR / "request_identity.py"
spec = importlib.util.spec_from_file_location("request_identity", MODULE_PATH)
identity = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(identity)


class RequestIdentityTests(unittest.TestCase):
    REQ = "REQ_20260831T043812Z_4827"

    def test_canonical_request_id(self):
        self.assertTrue(identity.is_canonical_request_id(self.REQ))
        self.assertFalse(identity.is_canonical_request_id("REQ_20261331T043812Z_4827"))
        self.assertFalse(identity.is_canonical_request_id("REQ_20260831T043812Z_ABC1"))
        self.assertFalse(identity.is_canonical_request_id("REQ_WP006_TEST"))

    def test_message_id_is_derived_from_same_key(self):
        self.assertEqual(identity.message_id_for_request_id(self.REQ), "MSG_20260831T043812Z_4827")

    def test_single_artifact_filename(self):
        name = identity.expected_artifact_filename(self.REQ)
        self.assertEqual(name, "POSTMAN_REQ_20260831T043812Z_4827_RESULT.zip")
        self.assertTrue(identity.validate_expected_artifact_filename(self.REQ, name))

    def test_numbered_artifact_filenames(self):
        one = identity.expected_artifact_filename(self.REQ, 1)
        two = identity.expected_artifact_filename(self.REQ, 2)
        self.assertEqual(one, "POSTMAN_REQ_20260831T043812Z_4827_RESULT-01.zip")
        self.assertEqual(two, "POSTMAN_REQ_20260831T043812Z_4827_RESULT-02.zip")
        self.assertTrue(identity.validate_expected_artifact_filename(self.REQ, one))
        self.assertTrue(identity.validate_expected_artifact_filename(self.REQ, two))
        self.assertFalse(identity.validate_expected_artifact_filename(self.REQ, "POSTMAN_REQ_20260831T043812Z_4827_RESULT-00.zip"))

    def test_filename_must_embed_exact_request_key(self):
        self.assertFalse(identity.validate_expected_artifact_filename(
            self.REQ,
            "POSTMAN_REQ_20260831T043813Z_4827_RESULT.zip",
        ))

    def test_prompt_key_line(self):
        self.assertEqual(identity.request_prompt_key_line(self.REQ), f"POSTMAN_REQUEST_ID: {self.REQ}")


if __name__ == "__main__":
    unittest.main()
