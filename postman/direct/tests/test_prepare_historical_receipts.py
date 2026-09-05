from __future__ import annotations

import tempfile
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

DIRECT_DIR = Path(__file__).resolve().parents[1]
if str(DIRECT_DIR) not in sys.path:
    sys.path.insert(0, str(DIRECT_DIR))

import finalization_common as common
import prepare_result


REPO = "AndrewVerhoturov1/dsh-workspace"
OLD_REQ = "REQ_20260905T085740Z_8024"
OLD_BRANCH = "postman/req-20260905t085740z-8024"
OLD_SHA = "a" * 40


def _write_published(root: Path) -> Path:
    stage = root / "handoff" / OLD_REQ
    stage.mkdir(parents=True, exist_ok=True)
    path = stage / "published.json"
    common.atomic_write_json(
        path,
        {
            "ok": True,
            "code": "PUBLISHED",
            "requestId": OLD_REQ,
            "repository": REPO,
            "prNumber": 91,
            "branch": OLD_BRANCH,
            "commitSha": OLD_SHA,
            "remoteSha": OLD_SHA,
            "repoRoot": str(root / "primary"),
            "worktree": str(root / "old-worktree"),
            "worktreeRetained": True,
            "worktreeRemoved": False,
            "resultWorkspaceRegistrationRequired": True,
            "cleanupAfterMergeRequired": True,
        },
    )
    return path


def _gh_no_old_pr_lookup(repository, endpoint, *, gh_binary="gh", **kwargs):
    if endpoint.endswith("/pulls?state=open&per_page=100"):
        return []
    raise AssertionError(f"historical PR should not be queried: {endpoint}")


class PrepareHistoricalReceiptTests(unittest.TestCase):
    def _classify(
        self,
        root: Path,
        *,
        local_branches: list[str] | None = None,
        remote_branches: list[str] | None = None,
        registered_worktrees: list[Path] | None = None,
        gh_api=_gh_no_old_pr_lookup,
    ):
        primary = root / "primary"
        primary.mkdir(exist_ok=True)
        handoff = root / "handoff"
        handoff.mkdir(exist_ok=True)
        with (
            patch.object(prepare_result, "_local_branches", return_value=local_branches or ["main"]),
            patch.object(prepare_result, "_remote_branches", return_value=remote_branches or ["main"]),
            patch.object(common, "registered_worktree_paths", return_value=registered_worktrees or [primary.resolve()]),
        ):
            return prepare_result._classify_and_self_heal(
                primary,
                repository=REPO,
                handoff_root=handoff,
                gh_binary="gh",
                gh_api=gh_api,
            )

    def test_invalid_abandoned_history_without_live_resource_does_not_block(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            published = _write_published(root)
            common.atomic_write_json(
                published.parent / "abandoned.json",
                {
                    "ok": True,
                    "code": "ABANDONED",
                    "status": "ABANDONED",
                    "explicitDiscard": True,
                    "requestId": OLD_REQ,
                    "repository": REPO,
                    "prNumber": 91,
                    "branch": OLD_BRANCH,
                    "commitSha": "b" * 40,
                    "worktreeRemoved": True,
                    "branchRemoved": True,
                    "remoteBranchRemoved": True,
                },
            )
            result = self._classify(root)
            self.assertEqual(1, len(result))
            self.assertEqual("PREPARE_HISTORICAL_RECEIPT_IGNORED", result[0]["code"])
            self.assertFalse(result[0]["liveResource"])

    def test_closed_unmerged_history_without_live_resource_needs_no_pr_lookup(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            _write_published(root)
            result = self._classify(root)
            self.assertEqual("PREPARE_HISTORICAL_RECEIPT_IGNORED", result[0]["code"])

    def test_unreadable_historical_receipt_without_live_resource_is_audit_only(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            stage = root / "handoff" / OLD_REQ
            stage.mkdir(parents=True)
            (stage / "published.json").write_text("{not-json", encoding="utf-8")
            result = self._classify(root)
            self.assertEqual("PREPARE_HISTORICAL_RECEIPT_IGNORED", result[0]["code"])
            self.assertIn("unreadable", result[0]["reason"])

    def test_invalid_abandoned_receipt_with_live_branch_still_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            published = _write_published(root)
            common.atomic_write_json(
                published.parent / "abandoned.json",
                {
                    "ok": True,
                    "code": "ABANDONED",
                    "status": "ABANDONED",
                    "explicitDiscard": True,
                    "requestId": OLD_REQ,
                    "repository": REPO,
                    "prNumber": 91,
                    "branch": OLD_BRANCH,
                    "commitSha": "b" * 40,
                    "worktreeRemoved": True,
                    "branchRemoved": True,
                    "remoteBranchRemoved": True,
                },
            )
            with self.assertRaises(common.FinalizationError) as error:
                self._classify(root, local_branches=["main", OLD_BRANCH])
            self.assertEqual("PREPARE_STALE_RESOURCE_AMBIGUOUS", error.exception.code)

    def test_unreadable_receipt_cannot_hide_a_live_request_branch(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            stage = root / "handoff" / OLD_REQ
            stage.mkdir(parents=True)
            (stage / "published.json").write_text("{not-json", encoding="utf-8")
            with self.assertRaises(common.FinalizationError) as error:
                self._classify(root, local_branches=["main", OLD_BRANCH])
            self.assertEqual("PREPARE_UNKNOWN_POSTMAN_RESOURCE", error.exception.code)

    def test_open_task_pr_still_blocks_without_local_resources(self):
        def gh_api(repository, endpoint, *, gh_binary="gh", **kwargs):
            if endpoint.endswith("/pulls?state=open&per_page=100"):
                return [{"number": 99, "head": {"ref": OLD_BRANCH}}]
            raise AssertionError(endpoint)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(common.FinalizationError) as error:
                self._classify(root, gh_api=gh_api)
            self.assertEqual("PREPARE_STALE_PR_OPEN", error.exception.code)


if __name__ == "__main__":
    unittest.main()
