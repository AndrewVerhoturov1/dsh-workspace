from __future__ import annotations

import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

MODULE = Path(__file__).resolve().parents[1] / "image_result.py"
spec = importlib.util.spec_from_file_location("image_result", MODULE)
image_result = importlib.util.module_from_spec(spec)
spec.loader.exec_module(image_result)

# A minimal real PNG; Pillow tests run only when the optional decoder is installed.
REQ = "REQ_20260929T224757Z_1049"
OTHER_REQ = "REQ_20260929T224758Z_1049"

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082")


class ImageResultTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "validated.zip"
        self.output = self.root / "durable"

    def make_zip(self, entries):
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_STORED) as archive:
            for name, data in entries:
                archive.writestr(name, data)
        with zipfile.ZipFile(self.archive) as archive:
            inventory = [{"path": info.filename, "kind": "directory" if info.is_dir() else "file", "compressedSize": info.compress_size, "uncompressedSize": info.file_size} for info in archive.infolist()]
        sha = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        return inventory, sha

    def extract(self, inventory, sha):
        return image_result.extract_validated_image(self.archive, inventory, self.output, expected_zip_sha256=sha, request_id=REQ)

    def assert_code(self, code, inventory, sha):
        with self.assertRaises(image_result.ImageResultError) as raised:
            self.extract(inventory, sha)
        self.assertEqual(raised.exception.code, code)
        self.assertFalse(self.output.exists())

    def test_one_image_extracts_to_fixed_name_not_archive_path(self):
        inv, sha = self.make_zip([(f"{REQ}_img1.png", PNG)])
        with patch.object(image_result, "_decode_image", return_value=("PNG", 1, 1)):
            result = self.extract(inv, sha)
        self.assertEqual(Path(result["path"]), self.output / "image.png")
        self.assertEqual(Path(result["path"]).read_bytes(), PNG)
        self.assertEqual(result["sourceEntry"], f"{REQ}_img1.png")
        self.assertEqual(result["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertEqual((result["width"], result["height"]), (1, 1))
        self.assertEqual(result["mime"], "image/png")
        with patch.object(image_result, "_decode_image", return_value=("PNG", 1, 1)):
            with self.assertRaises(image_result.ImageResultError) as raised:
                self.extract(inv, sha)
        self.assertEqual(raised.exception.code, "IMAGE_OUTPUT_EXISTS")

    def test_ambiguous_and_missing_images(self):
        for entries, count in [([(f"{REQ}_img1.png", PNG), ("b.webp", b"garbage")], 2), ([("readme.txt", b"x")], 0), ([("one.gif", b"GIF89a")], 0)]:
            inv, sha = self.make_zip(entries)
            with self.assertRaises(image_result.ImageResultError) as raised:
                self.extract(inv, sha)
            self.assertEqual(raised.exception.code, "IMAGE_ENTRY_COUNT")
            self.assertEqual(raised.exception.details["count"], count)

    def test_rejects_any_second_file_even_non_image(self):
        inv, sha = self.make_zip([(f"{REQ}_img1.png", PNG), ("notes.txt", b"not allowed")])
        self.assert_code("IMAGE_ENTRY_COUNT", inv, sha)

    def test_rejects_second_image_in_unsupported_format(self):
        inv, sha = self.make_zip([(f"{REQ}_img1.png", PNG), ("b.gif", b"GIF89a")])
        self.assert_code("IMAGE_ENTRY_COUNT", inv, sha)

    def test_rejects_noncanonical_names_and_directory_entries(self):
        bad_names = ("image.png", "dog.png", "спаниэль.png", f"{OTHER_REQ}_img1.png",
                     f"{REQ}_img2.png", f"{REQ}_img1.txt", f"{REQ}_img1.jpeg",
                     f"nested/{REQ}_img1.png")
        for name in bad_names:
            with self.subTest(name=name):
                inv, sha = self.make_zip([(name, PNG)])
                self.assert_code("IMAGE_ENTRY_COUNT" if name.endswith((".txt", ".jpeg")) else "IMAGE_ENTRY_NAME", inv, sha)
        inv, sha = self.make_zip([("nested/", b""), (f"nested/{REQ}_img1.png", PNG)])
        self.assert_code("IMAGE_ENTRY_COUNT", inv, sha)

    def test_changed_zip_and_forged_inventory_fail_closed(self):
        inv, sha = self.make_zip([(f"{REQ}_img1.png", PNG)])
        self.assert_code("IMAGE_ZIP_CHANGED", inv, "0" * 64)
        inv[0]["uncompressedSize"] += 1
        self.assert_code("IMAGE_INVENTORY_MISMATCH", inv, sha)

    def test_bad_bytes_and_wrong_format_do_not_create_file(self):
        inv, sha = self.make_zip([(f"{REQ}_img1.png", b"not an image")])
        try:
            import PIL  # noqa: F401
        except ImportError:
            self.assert_code("IMAGE_DECODER_UNAVAILABLE", inv, sha)
        else:
            self.assert_code("IMAGE_DECODE_FAILED", inv, sha)
        inv, sha = self.make_zip([(f"{REQ}_img1.webp", PNG)])
        with patch.object(image_result, "_decode_image", side_effect=image_result.ImageResultError("IMAGE_FORMAT_MISMATCH", "wrong format")):
            self.assert_code("IMAGE_FORMAT_MISMATCH", inv, sha)

    def test_real_decode_if_pillow_installed(self):
        from PIL import Image
        decoded = []
        for fmt, ext in (("PNG", ".png"), ("JPEG", ".jpg"), ("WEBP", ".webp")):
            buffer = io.BytesIO()
            Image.new("RGB", (2, 3), "red").save(buffer, format=fmt)
            inv, sha = self.make_zip([(f"{REQ}_img1" + ext, buffer.getvalue())])
            result = self.extract(inv, sha)
            self.assertEqual((result["format"], result["width"], result["height"]), (fmt, 2, 3))
            decoded.append(fmt)
            (self.output / ("image" + ext)).unlink()
        self.assertEqual(decoded, ["PNG", "JPEG", "WEBP"])
        self.output.rmdir()
        for fmt, ext in (("JPEG", ".png"), ("PNG", ".jpg")):
            with self.subTest(format=fmt, extension=ext):
                buffer = io.BytesIO()
                Image.new("RGB", (2, 3), "red").save(buffer, format=fmt)
                inv, sha = self.make_zip([(f"{REQ}_img1" + ext, buffer.getvalue())])
                self.assert_code("IMAGE_FORMAT_MISMATCH", inv, sha)


if __name__ == "__main__":
    unittest.main()
