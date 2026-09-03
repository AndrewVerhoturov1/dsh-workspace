from __future__ import annotations

import importlib
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

import finalization_common as common
import prepare_result
import publish_result
import test_result

REQ = "REQ_20260903T010203Z_1234"
REPO = "AndrewVerhoturov1/dsh-workspace"


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


def init_primary(root: Path) -> tuple[Path, Path, str]:
    bare = root / "origin.git"
    primary = root / "primary"
    git(root, "init", "--bare", str(bare))
    git(root, "clone", str(bare), str(primary))
    git(primary, "config", "user.email", "postman-tests@example.invalid")
    git(primary, "config", "user.name", "Postman Tests")
    git(primary, "checkout", "-b", "main")
    (primary / "REPO_POLICY.md").write_text("# policy\n", encoding="utf-8")
    (primary / "sample.txt").write_text("before\n", encoding="utf-8")
    git(primary, "add", "REPO_POLICY.md", "sample.txt")
    git(primary, "commit", "-m", "base")
    git(primary, "push", "-u", "origin", "main")
    base = git(primary, "rev-parse", "HEAD")
    return bare, primary, base


class FakePRApi:
    def __init__(self):
        self.pr = None

    def __call__(self, repository, endpoint, *, gh_binary="gh", method=None, payload=None):
        if endpoint.endswith("/pulls?state=open&per_page=100"):
            return [] if self.pr is None else [self.pr]
        if endpoint.endswith("/pulls") and method == "POST":
            self.pr = {
                "number": 77,
                "html_url": "https://example.invalid/pr/77",
                "state": "open",
                "base": {"ref": "main"},
                "head": {"ref": payload["head"], "sha": ""},
            }
            return dict(self.pr)
        if "/pulls/" in endpoint:
            return dict(self.pr)
        raise AssertionError((repository, endpoint, method, payload))


class FinalizationPipelineTests(unittest.TestCase):
    def test_canonical_branch_name(self):
        self.assertEqual(
            common.canonical_branch_name(REQ),
            "postman/req-20260903t010203z-1234",
        )

    def test_prepare_creates_one_worktree_and_ready_json(self):
        with tempfile.TemporaryDirectory() as td:
            temp = Path(td)
            _, primary, base = init_primary(temp)
            result_path = temp / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "code": "RESULT_DURABLE",
                        "state": "RESULT_DURABLE",
                        "requestId": REQ,
                        "repository": REPO,
                    }
                ),
                encoding="utf-8",
            )

            def fake_integrator(**kwargs):
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
                    "artifactSha256": "a" * 64,
                    "resultType": "files",
                    "changedFiles": ["sample.txt"],
                    "payloadPaths": ["sample.txt"],
                    "functionalAdvancement": [],
                }

            with patch.object(common, "normalize_remote_repository", return_value=REPO):
                ready = prepare_result.prepare(
                    result_json=str(result_path),
                    repo_root=primary,
                    worktree_root=temp / "worktrees",
                    handoff_root=temp / "handoff",
                    gh_api=lambda *args, **kwargs: [],
                    integrator=fake_integrator,
                )

            self.assertEqual("READY_FOR_TEST", ready["code"])
            self.assertEqual(common.canonical_branch_name(REQ), ready["branch"])
            self.assertTrue(Path(ready["worktree"]).is_dir())
            self.assertTrue(Path(ready["readyJson"]).is_file())
            self.assertEqual(["sample.txt"], common.changed_paths(ready["worktree"]))

    def test_test_receipt_and_publish_are_bound_to_same_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            temp = Path(td)
            _, primary, base = init_primary(temp)
            branch = common.canonical_branch_name(REQ)
            worktree = temp / "task"
            git(primary, "worktree", "add", "-b", branch, str(worktree), "main")
            (worktree / "sample.txt").write_text("after\n", encoding="utf-8")

            ready_path = temp / "handoff" / REQ / "ready.json"
            ready = {
                "ok": True,
                "code": "READY_FOR_TEST",
                "requestId": REQ,
                "repository": REPO,
                "baseCommit": base,
                "originMain": base,
                "branch": branch,
                "artifactSha256": "b" * 64,
                "resultType": "files",
                "changedFiles": ["sample.txt"],
                "payloadPaths": ["sample.txt"],
                "functionalAdvancement": [],
                "repoRoot": str(primary),
                "worktree": str(worktree),
                "readyJson": str(ready_path),
            }
            common.atomic_write_json(ready_path, ready)

            receipt = test_result.run_test(
                ready_json=ready_path,
                test_command=[
                    sys.executable,
                    "-c",
                    "from pathlib import Path; assert Path('sample.txt').read_text() == 'after\\n'",
                ],
            )
            self.assertEqual("TEST_PASSED", receipt["code"])
            self.assertTrue(Path(receipt["testJson"]).is_file())

            fake = FakePRApi()

            def gh_api(repository, endpoint, *, gh_binary="gh", method=None, payload=None):
                if endpoint.endswith("/pulls?state=open&per_page=100"):
                    return [] if fake.pr is None else [fake.pr]
                if endpoint.endswith("/pulls") and method == "POST":
                    commit_sha = git(worktree, "rev-parse", "HEAD")
                    fake.pr = {
                        "number": 77,
                        "html_url": "https://example.invalid/pr/77",
                        "state": "open",
                        "base": {"ref": "main"},
                        "head": {"ref": payload["head"], "sha": commit_sha},
                    }
                    return dict(fake.pr)
                if endpoint.endswith("/pulls/77"):
                    return dict(fake.pr)
                raise AssertionError((endpoint, method, payload))

            published = publish_result.publish(
                ready_json=ready_path,
                test_json=Path(receipt["testJson"]),
                gh_api=gh_api,
            )
            self.assertEqual("PUBLISHED", published["code"])
            self.assertTrue(published["remoteVerified"])
            self.assertFalse(published["worktreeRemoved"])
            self.assertTrue(published["worktreeRetained"])
            self.assertEqual(str(worktree.resolve()), published["worktree"])
            self.assertTrue(worktree.exists())
            remote = git(primary, "ls-remote", "--heads", "origin", f"refs/heads/{branch}")
            self.assertIn(published["commitSha"], remote)
            self.assertIn(branch, git(primary, "branch", "--format=%(refname:short)").splitlines())

    def test_test_gate_rejects_mutating_test(self):
        with tempfile.TemporaryDirectory() as td:
            temp = Path(td)
            _, primary, base = init_primary(temp)
            branch = common.canonical_branch_name(REQ)
            worktree = temp / "task"
            git(primary, "worktree", "add", "-b", branch, str(worktree), "main")
            (worktree / "sample.txt").write_text("after\n", encoding="utf-8")
            ready_path = temp / "ready.json"
            common.atomic_write_json(
                ready_path,
                {
                    "ok": True,
                    "code": "READY_FOR_TEST",
                    "requestId": REQ,
                    "repository": REPO,
                    "baseCommit": base,
                    "originMain": base,
                    "branch": branch,
                    "artifactSha256": "c" * 64,
                    "changedFiles": ["sample.txt"],
                    "repoRoot": str(primary),
                    "worktree": str(worktree),
                },
            )
            with self.assertRaises(common.FinalizationError) as ctx:
                test_result.run_test(
                    ready_json=ready_path,
                    test_command=[
                        sys.executable,
                        "-c",
                        "from pathlib import Path; Path('sample.txt').write_text('mutated\\n')",
                    ],
                )
            self.assertEqual("TEST_MUTATED_WORKTREE", ctx.exception.code)


if __name__ == "__main__":
    unittest.main()
