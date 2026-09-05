from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

DIRECT_DIR = Path(__file__).resolve().parents[1]
WEB_DIR = DIRECT_DIR.parent / "web"
for item in (str(DIRECT_DIR), str(WEB_DIR)):
    if item not in sys.path:
        sys.path.insert(0, item)

import durable_handoff
import finalization_common as common
import prepare_result

REQ = "REQ_20260904T023423Z_8302"
OTHER_REQ = "REQ_20260904T023424Z_8303"
REPO = "AndrewVerhoturov1/dsh-workspace"
BASE = "a" * 40
PUBLICATION = "b" * 40
ARTIFACT = "c" * 64


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


def init_primary(root: Path) -> tuple[Path, Path, str]:
    bare = root / "origin.git"
    primary = root / "primary"
    git(root, "init", "--bare", str(bare))
    git(root, "clone", str(bare), str(primary))
    git(primary, "config", "user.email", "resume@example.invalid")
    git(primary, "config", "user.name", "Resume Tests")
    git(primary, "checkout", "-b", "main")
    (primary / "REPO_POLICY.md").write_text("# policy\n", encoding="utf-8")
    (primary / "sample.txt").write_text("before\n", encoding="utf-8")
    git(primary, "add", "REPO_POLICY.md", "sample.txt")
    git(primary, "commit", "-m", "base")
    git(primary, "push", "-u", "origin", "main")
    return bare, primary, git(primary, "rev-parse", "HEAD")


def legacy_state(direct_root: Path, request_id: str = REQ, **overrides: object) -> Path:
    state_path = durable_handoff.state_path(direct_root, request_id)
    state = {
        "directVersion": 3,
        "requestId": request_id,
        "repository": REPO,
        "branch": "main",
        "state": "RESULT_DURABLE",
        "baseCommit": BASE,
        "taskPublicationCommit": PUBLICATION,
        "taskUrl": f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{PUBLICATION}/{request_id}.md",
        "expectedFilename": f"POSTMAN_{request_id}_RESULT.zip",
        "resultZip": r"D:\Downloads_dsh_auto\REQ_20260904T023423Z_8302\result.zip",
        "artifactSha256": ARTIFACT,
        "resultRoot": r"D:\Downloads_dsh_auto",
    }
    state.update(overrides)
    common.atomic_write_json(state_path, state)
    return state_path


def terminal_handoff(direct_root: Path, request_id: str = REQ, **overrides: object) -> Path:
    state_path = durable_handoff.state_path(direct_root, request_id)
    handoff_path = durable_handoff.handoff_path(direct_root, request_id)
    data = {
        "ok": True,
        "code": "RESULT_DURABLE",
        "state": "RESULT_DURABLE",
        "requestId": request_id,
        "repository": REPO,
        "baseCommit": BASE,
        "taskPublicationCommit": PUBLICATION,
        "taskUrl": f"https://raw.githubusercontent.com/AndrewVerhoturov1/dsh-workspace/{PUBLICATION}/{request_id}.md",
        "expectedFilename": f"POSTMAN_{request_id}_RESULT.zip",
        "resultZip": r"D:\Downloads_dsh_auto\REQ_20260904T023423Z_8302\result.zip",
        "sha256": ARTIFACT,
        "resultRoot": r"D:\Downloads_dsh_auto",
        "statePath": str(state_path.resolve()),
        "resultHandoffPath": str(handoff_path.resolve()),
        "handoffVersion": 1,
    }
    data.update(overrides)
    common.atomic_write_json(handoff_path, data)
    return handoff_path


class DurableResultResumeTests(unittest.TestCase):
    def assert_resume_error(self, direct_root: Path, expected_code: str, **overrides: object) -> None:
        legacy_state(direct_root, **overrides)
        with self.assertRaises(common.FinalizationError) as ctx:
            prepare_result._load_resume_handoff(
                request_id=REQ,
                expected_repository=REPO,
                direct_root=direct_root,
            )
        self.assertEqual(expected_code, ctx.exception.code)

    def test_persisted_durable_handoff_uses_same_prepare_pipeline(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _, primary, base = init_primary(root)
            direct_root = root / "direct"
            terminal_handoff(direct_root)

            observed = {}
            def integrator(**kwargs):
                observed["result_json"] = kwargs["result_json"]
                worktree = Path(kwargs["repo_root"])
                (worktree / "sample.txt").write_text("after\n", encoding="utf-8")
                return {
                    "ok": True,
                    "code": "READY_FOR_TEST",
                    "requestId": REQ,
                    "repository": REPO,
                    "baseCommit": base,
                    "originMain": base,
                    "branch": common.canonical_branch_name(REQ),
                    "artifactSha256": ARTIFACT,
                    "resultType": "files",
                    "changedFiles": ["sample.txt"],
                }

            with patch.object(common, "normalize_remote_repository", return_value=REPO):
                ready = prepare_result.prepare_from_request_id(
                    request_id=REQ,
                    repo_root=primary,
                    direct_root=direct_root,
                    worktree_root=root / "worktrees",
                    handoff_root=root / "handoff",
                    gh_api=lambda *args, **kwargs: [],
                    integrator=integrator,
                )
            self.assertEqual("READY_FOR_TEST", ready["code"])
            self.assertTrue(Path(ready["readyJson"]).is_file())
            self.assertEqual(str(durable_handoff.handoff_path(direct_root, REQ)), observed["result_json"])

    def test_legacy_exact_result_durable_state_recovers_and_persists(self):
        with tempfile.TemporaryDirectory() as td:
            direct_root = Path(td) / "direct"
            source = legacy_state(direct_root)
            recovered = prepare_result._load_resume_handoff(
                request_id=REQ,
                expected_repository=REPO,
                direct_root=direct_root,
            )
            self.assertEqual(durable_handoff.handoff_path(direct_root, REQ), recovered)
            data = json.loads(recovered.read_text(encoding="utf-8"))
            self.assertEqual("RESULT_DURABLE", data["code"])
            self.assertEqual(REQ, data["requestId"])
            self.assertEqual(str(source.resolve()), data["statePath"])
            self.assertTrue(recovered.is_file())

    def test_init_state_blocks(self):
        self._assert_state_blocks("INIT")

    def test_task_published_state_blocks(self):
        self._assert_state_blocks("TASK_PUBLISHED")

    def test_web_running_state_blocks(self):
        self._assert_state_blocks("WEB_RUNNING")

    def test_failed_state_blocks(self):
        self._assert_state_blocks("FAILED")

    def _assert_state_blocks(self, state: str) -> None:
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(Path(td) / "direct", "PREPARE_RESUME_NOT_DURABLE", state=state)

    def test_wrong_request_id_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(
                Path(td) / "direct",
                "PREPARE_RESUME_REQUEST_MISMATCH",
                requestId=OTHER_REQ,
            )

    def test_wrong_repository_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(
                Path(td) / "direct",
                "PREPARE_RESUME_REPOSITORY_MISMATCH",
                repository="other/example",
            )

    def test_missing_result_zip_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(Path(td) / "direct", "PREPARE_RESUME_INVALID", resultZip=None)

    def test_missing_artifact_sha_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(Path(td) / "direct", "PREPARE_RESUME_INVALID", artifactSha256=None)

    def test_invalid_artifact_sha_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(Path(td) / "direct", "PREPARE_RESUME_INVALID", artifactSha256="not-a-sha")

    def test_missing_base_commit_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(Path(td) / "direct", "PREPARE_RESUME_INVALID", baseCommit=None)

    def test_missing_task_publication_commit_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(Path(td) / "direct", "PREPARE_RESUME_INVALID", taskPublicationCommit=None)

    def test_malformed_expected_filename_blocks(self):
        with tempfile.TemporaryDirectory() as td:
            self.assert_resume_error(Path(td) / "direct", "PREPARE_RESUME_INVALID", expectedFilename="wrong.zip")

    def test_resume_does_not_invoke_postman_or_create_request(self):
        with tempfile.TemporaryDirectory() as td:
            direct_root = Path(td) / "direct"
            state = legacy_state(direct_root)
            with patch.object(prepare_result, "prepare", return_value={"ok": True}) as pipeline:
                result = prepare_result.prepare_from_request_id(
                    request_id=REQ,
                    repo_root=Path(td) / "repo",
                    direct_root=direct_root,
                )
            self.assertEqual({"ok": True}, result)
            pipeline.assert_called_once()
            self.assertEqual([state], list((direct_root / "requests").glob("*.json")))
            self.assertEqual([REQ], [path.stem for path in (direct_root / "results").glob("*.json")])

    def test_existing_persisted_handoff_is_fail_closed_without_state_fallback(self):
        with tempfile.TemporaryDirectory() as td:
            direct_root = Path(td) / "direct"
            handoff = terminal_handoff(direct_root)
            handoff.write_text("{}\n", encoding="utf-8")
            legacy_state(direct_root)
            with self.assertRaises(common.FinalizationError) as ctx:
                prepare_result._load_resume_handoff(
                    request_id=REQ,
                    expected_repository=REPO,
                    direct_root=direct_root,
                )
            self.assertEqual("PREPARE_RESUME_INVALID", ctx.exception.code)


if __name__ == "__main__":
    unittest.main()
