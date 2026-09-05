from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

DIRECT = Path(__file__).resolve().parents[1]


class ReceiptPersistenceTests(unittest.TestCase):
    def test_ready_receipt_survives_process_boundary_and_validates(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            ready = root / "handoff" / "REQ_20260903T010203Z_1234" / "ready.json"
            writer = root / "writer.py"
            reader = root / "reader.py"
            writer.write_text(
                "import sys; sys.path.insert(0, sys.argv[2]); import finalization_common as c; "
                "p=sys.argv[1]; c.atomic_write_json(p, {'ok': True, 'code': 'READY_FOR_TEST', "
                "'requestId': 'REQ_20260903T010203Z_1234', 'repository': 'owner/repo', "
                "'branch': 'postman/req-20260903t010203z-1234', 'worktree': 'C:/task', "
                "'repoRoot': 'C:/repo', 'originMain': 'a'*40, 'changedFiles': ['sample.txt'], "
                "'readyJson': p})\n",
                encoding="utf-8",
            )
            reader.write_text(
                "import sys; sys.path.insert(0, sys.argv[2]); import finalization_common as c; "
                "d=c.validate_ready(c.load_json_file(sys.argv[1])); print(d['code'], d['requestId'])\n",
                encoding="utf-8",
            )
            written = subprocess.run(
                [sys.executable, "-X", "utf8", str(writer), str(ready), str(DIRECT)],
                capture_output=True, text=True, encoding="utf-8",
            )
            self.assertEqual(0, written.returncode, written.stderr)
            read = subprocess.run(
                [sys.executable, "-X", "utf8", str(reader), str(ready), str(DIRECT)],
                capture_output=True, text=True, encoding="utf-8",
            )
            self.assertEqual(0, read.returncode, read.stderr)
            self.assertEqual("READY_FOR_TEST REQ_20260903T010203Z_1234", read.stdout.strip())


if __name__ == "__main__":
    unittest.main()
