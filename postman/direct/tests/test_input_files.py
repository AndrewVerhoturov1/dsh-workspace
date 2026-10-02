import base64
import hashlib
from pathlib import Path
import tempfile
import unittest

from postman import task_package, text_task_package, input_files
from postman.direct import postman_direct

REQ = "REQ_20260101T000000Z_0001"
COMMIT = "a" * 40
SHA = "b" * 64
REPO = "AndrewVerhoturov1/dsh-workspace"


def descriptor(name="note.md", path="docs/note.md", raw=True):
    value = dict(name=name, repository=REPO, commit=COMMIT, path=path, sha256=SHA, byte_length=12)
    if raw:
        value["raw_url"] = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/{path}"
    return value


def render(inputs=()):
    return task_package.render_direct_task_manifest(request_id=REQ, user_intent="exact intent\nsecond line", repository=REPO,
        base_commit=COMMIT, expected_filename=f"POSTMAN_{REQ}_RESULT.zip", allowed_paths=["docs"], forbidden_paths=["settings.yaml"], input_files=inputs)


class InputFilesTest(unittest.TestCase):
    def test_task_without_inputs_unchanged(self):
        self.assertEqual(render(), render([]))
        self.assertNotIn("## Input files", render())
        self.assertEqual(text_task_package.render_direct_text_task_manifest(request_id=REQ, user_intent="exact", repository=REPO, base_commit=COMMIT),
                         text_task_package.render_direct_text_task_manifest(request_id=REQ, user_intent="exact", repository=REPO, base_commit=COMMIT, input_files=[]))

    def test_text_image_binary_and_multiple(self):
        values = [descriptor(), descriptor("reference.png", "img/reference.png"), descriptor("sources.zip", "data/sources.zip", False)]
        result = render(values)
        self.assertEqual(result.count("### "), 3)
        self.assertIn("## Input retrieval contract", result)
        self.assertNotIn("GitHub connector", result)
        self.assertIn("### sources.zip\n\nrepository:", result)
        self.assertNotIn("raw_url:", result.split("### sources.zip", 1)[1])
        self.assertIn("## User intent\n\nexact intent\nsecond line\n\n## Input files", result)
        self.assertIn("## Input files", text_task_package.render_direct_text_task_manifest(request_id=REQ,
            user_intent="exact", repository=REPO, base_commit=COMMIT, input_files=values))

    def test_invalid_descriptors(self):
        for change in ({"commit": "preview"}, {"sha256": "x"}, {"path": "../secret"},
                       {"path": "C:/bad"}, {"byte_length": 0}, {"raw_url": "https://raw.githubusercontent.com/" + REPO + "/" + "c"*40 + "/docs/note.md"}):
            with self.subTest(change=change), self.assertRaises(task_package.TaskPackageError):
                render([{**descriptor(), **change}])

    def test_image_first_prompt_only(self):
        prompt = postman_direct.build_image_generation_prompt("Draw", [descriptor("reference.png", "img/reference.png")])
        self.assertIn("приложенное изображение как visual reference", prompt)
        self.assertNotIn("raw_url", prompt)
        self.assertNotIn("github", prompt.lower())
        self.assertNotIn(SHA, prompt)
        self.assertTrue(prompt.endswith("Draw\n\nСделай ровно одно изображение."))
        with self.assertRaisesRegex(Exception, "COUNT_UNSUPPORTED"):
            postman_direct.build_image_generation_prompt("Draw", [descriptor(), descriptor()])
        with self.assertRaisesRegex(Exception, "TYPE_UNSUPPORTED"):
            postman_direct.build_image_generation_prompt("Draw", [descriptor()])
        self.assertNotIn("reference.png", postman_direct.build_image_packaging_intent(REQ))

    def test_existing_file_descriptor_never_stages(self):
        data = b"GITHUB_EXISTING_MARKER"
        endpoints = []
        def api(endpoint, method="GET", payload=None):
            endpoints.append((endpoint, method))
            return {"type": "file", "encoding": "base64", "content": base64.b64encode(data).decode("ascii")}
        result = input_files.GitHubInputPublisher(api).existing(COMMIT, "docs/marker.md")
        self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(result["byte_length"], len(data))
        self.assertEqual(endpoints, [(f"repos/{REPO}/contents/docs/marker.md?ref={COMMIT}", "GET")])

    def test_stage_exact_selected_bytes_and_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            one = Path(tmp) / "note.md"; one.write_bytes(b"MARKER-one")
            two = Path(tmp) / "file.zip"; two.write_bytes(b"PK\x03\x04MARKER-two")
            calls = []
            def api(endpoint, method="GET", payload=None):
                calls.append((endpoint, method, payload))
                if endpoint.endswith("git/ref/heads/transport%2Fpostman-inputs"):
                    return {"object": {"sha": COMMIT}}
                if endpoint.endswith("git/commits/" + COMMIT):
                    return {"tree": {"sha": SHA[:40]}}
                if endpoint.endswith("git/trees/" + COMMIT + "?recursive=1"):
                    paths = [entry["path"] for _, meth, p in calls if meth == "POST" and isinstance(p, dict) for entry in p.get("tree", []) if isinstance(entry, dict) and entry.get("sha")]
                    return {"tree": [{"path": path, "type": "blob"} for path in paths]}
                if endpoint.endswith("git/blobs"):
                    return {"sha": "c"*40}
                if endpoint.endswith("git/trees"):
                    return {"sha": "d"*40}
                if endpoint.endswith("git/commits"):
                    return {"sha": "e"*40}
                return {}
            publisher = input_files.GitHubInputPublisher(api)
            with self.assertRaisesRegex(input_files.InputStageError, "PUBLIC_APPROVAL_REQUIRED"):
                publisher.stage_public_fallback([str(one), str(two)])
            self.assertEqual(calls, [])
            result = publisher.stage_public_fallback([str(one), str(two)], public_fallback_confirmed=True)
            self.assertEqual(len(result["descriptors"]), 2)
            for item, data in zip(result["descriptors"], [one.read_bytes(), two.read_bytes()]):
                self.assertEqual(item["sha256"], hashlib.sha256(data).hexdigest())
                self.assertEqual(item["byte_length"], len(data))
                self.assertEqual(item["commit"], "e"*40)
            blobs = [p for _, meth, p in calls if meth == "POST" and isinstance(p, dict) and p.get("encoding") == "base64"]
            self.assertEqual([base64.b64decode(p["content"]) for p in blobs], [one.read_bytes(), two.read_bytes()])
            self.assertEqual(publisher.cleanup(result["bundle_id"])["removed"], 2)
            self.assertFalse(any(p and p.get("force") is True for _, _, p in calls))
            self.assertTrue(any(method == "PATCH" and p.get("force") is False for _, method, p in calls if isinstance(p, dict)))
            self.assertTrue(all(path.startswith("tmp/") for _, method, p in calls if method == "POST" and isinstance(p, dict) for path in [entry["path"] for entry in p.get("tree", []) if isinstance(entry, dict)]))
            with self.assertRaises(input_files.InputStageError):
                publisher.stage([tmp])
            attachments = Path(tmp) / "attachments"; attachments.mkdir()
            image = attachments / "reference.png"; image.write_bytes(b"PNG-marker")
            self.assertEqual(input_files.selected_file(str(image)), ("reference.png", b"PNG-marker"))
            with self.assertRaises(input_files.InputStageError):
                input_files.selected_file(str(attachments))
            link = attachments / "linked.png"
            try:
                link.symlink_to(image)
            except (OSError, NotImplementedError):
                pass
            else:
                with self.assertRaises(input_files.InputStageError):
                    input_files.selected_file(str(link))
            for name in ("private.key", "error.log", ".env", "id_rsa"):
                target = attachments / name; target.write_bytes(b"secret")
                with self.assertRaises(input_files.InputStageError):
                    input_files.selected_file(str(target))
            sensitive = Path(tmp) / "settings.yaml"; sensitive.write_text("secret")
            with self.assertRaises(input_files.InputStageError):
                publisher.stage([str(sensitive)])


if __name__ == "__main__":
    unittest.main()
