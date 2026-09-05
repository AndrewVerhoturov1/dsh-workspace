from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import sys
DIRECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIRECT))
import resume_request  # noqa: E402

REQ = "REQ_20260904T023423Z_8302"
REPO = "AndrewVerhoturov1/dsh-workspace"
BRANCH = "postman/req-20260904t023423z-8302"


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def ready(path: Path) -> dict:
    return {"ok": True, "code": "READY_FOR_TEST", "requestId": REQ, "repository": REPO,
            "branch": BRANCH, "worktree": str(path.parent / "wt"), "repoRoot": str(path.parent / "repo"),
            "originMain": "a" * 40, "changedFiles": ["x.txt"], "readyJson": str(path)}


def make_test_receipt(path: Path, r: dict) -> dict:
    return {"ok": True, "code": "TEST_PASSED", "requestId": REQ, "repository": REPO,
            "branch": BRANCH, "worktree": r["worktree"], "changedFiles": ["x.txt"],
            "readyJson": str(path.parent / "ready.json"), "readyJsonSha256": "a" * 64,
            "worktreeFingerprint": "b" * 64, "testCommand": ["python", "-c", "pass"], "testJson": str(path)}


def published(path: Path, r: dict) -> dict:
    return {"ok": True, "code": "PUBLISHED", "requestId": REQ, "repository": REPO,
            "branch": BRANCH, "worktree": r["worktree"], "publishedJson": str(path)}


class ResumeRequestTests(unittest.TestCase):
    def test_result_durable_calls_prepare_once_without_transport(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "handoff"
            rp = root / REQ / "ready.json"
            r = ready(rp)
            def prepare_once(**kwargs):
                write(rp, r)
                return r
            prepare = Mock(side_effect=prepare_once)
            with patch.object(resume_request.prepare_result, "prepare_from_request_id", prepare):
                out = resume_request.resume(request_id=REQ, repo_root=Path(td) / "repo", handoff_root=root)
            self.assertEqual("READY_FOR_TEST", out["state"])
            prepare.assert_called_once()

    def test_ready_is_idempotent_and_does_not_prepare(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "handoff"
            rp = root / REQ / "ready.json"
            r = ready(rp)
            write(rp, r)
            with patch.object(resume_request.prepare_result, "prepare_from_request_id", side_effect=AssertionError):
                out = resume_request.resume(request_id=REQ, repo_root=Path(td) / "repo", handoff_root=root)
            self.assertEqual("READY_FOR_TEST", out["state"])

    def test_test_passed_publishes_without_retesting(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "handoff"; stage = root / REQ
            rp = stage / "ready.json"; tp = stage / "test.json"
            r = ready(rp); t = make_test_receipt(tp, r); write(rp, r); write(tp, t)
            def publish_once(**kwargs):
                self.assertEqual(Path(r["readyJson"]).resolve(), kwargs["ready_json"])
                self.assertEqual(tp.resolve(), kwargs["test_json"])
                value = published(stage / "published.json", r)
                write(stage / "published.json", value)
                return value
            publisher = Mock(side_effect=publish_once)
            with patch.object(resume_request.test_result, "run_test", side_effect=AssertionError):
                out = resume_request.resume(request_id=REQ, repo_root=Path(td) / "repo", handoff_root=root, publisher=publisher)
            self.assertEqual("PUBLISHED", out["state"]); publisher.assert_called_once()

    def test_published_is_terminal_and_does_not_publish(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "handoff"; stage = root / REQ
            rp = stage / "ready.json"; tp = stage / "test.json"; pp = stage / "published.json"
            r = ready(rp); t = make_test_receipt(tp, r); p = published(pp, r)
            write(rp, r); write(tp, t); write(pp, p)
            publisher = Mock(side_effect=AssertionError)
            out = resume_request.resume(request_id=REQ, repo_root=Path(td) / "repo", handoff_root=root, publisher=publisher)
            self.assertEqual("PUBLISHED", out["state"]); self.assertEqual("TEST_PASSED", out["semanticTest"])


if __name__ == "__main__":
    unittest.main()
