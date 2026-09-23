from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import tarfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
PACKAGE_ROOT = ROOT / "packages" / "dsh-codex-oauth"
VENDOR = ROOT / "vendor" / "dsh-codex-oauth-0.1.8.tgz"


class VendoredCodexPackageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.archive = tarfile.open(VENDOR, "r:gz")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.archive.close()

    def read_vendor_text(self, member: str) -> str:
        handle = self.archive.extractfile(f"package/{member}")
        self.assertIsNotNone(handle, member)
        return handle.read().decode("utf-8")

    def test_vendor_metadata_and_catalog_sources_match_repository(self) -> None:
        package = json.loads(self.read_vendor_text("package.json"))
        self.assertEqual(package["version"], "0.1.8")
        self.assertEqual(package["dependencies"]["@earendil-works/pi-ai"], "0.85.1")

        for relative in ("src/adapter.ts", "src/convert.ts", "src/index.ts", "src/catalog.ts"):
            repository_text = (PACKAGE_ROOT / relative).read_text(encoding="utf-8")
            self.assertEqual(self.read_vendor_text(relative), repository_text, relative)

    def test_image_regression_fix_is_present_for_gpt6_catalog(self) -> None:
        adapter = self.read_vendor_text("src/adapter.ts")
        convert = self.read_vendor_text("src/convert.ts")
        catalog = self.read_vendor_text("src/catalog.ts")
        index = self.read_vendor_text("src/index.ts")

        self.assertGreaterEqual(adapter.count("inputModalities: [...model.input]"), 1)
        self.assertIn("inputModalities: [...resolved.input]", adapter)
        self.assertIn("containsImage && !model.input.includes('image')", adapter)
        self.assertIn("Buffer.from(version.data).toString('base64')", convert)
        self.assertIn("type: 'image'", convert)

        self.assertIn("gpt6CodexModel('gpt-6-sol'", catalog)
        self.assertIn("gpt6CodexModel('gpt-6-luna'", catalog)
        self.assertIn("input: ['text', 'image']", catalog)
        self.assertIn("withGpt6CodexModels(openaiCodexProvider())", index)

    def test_profile_and_lockfile_reference_exact_vendor_integrity(self) -> None:
        profile = json.loads((ROOT / "profiles" / "web" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(
            profile["dependencies"]["dsh-codex-oauth"],
            "file:../../vendor/dsh-codex-oauth-0.1.8.tgz",
        )

        digest = base64.b64encode(hashlib.sha512(VENDOR.read_bytes()).digest()).decode("ascii")
        lock = (ROOT / "profiles" / "web" / "pnpm-lock.yaml").read_text(encoding="utf-8")
        self.assertIn("dsh-codex-oauth-0.1.8.tgz", lock)
        self.assertIn(f"integrity: sha512-{digest}", lock)
        self.assertGreater(VENDOR.stat().st_size, 50_000)


if __name__ == "__main__":
    unittest.main(verbosity=2)
