"""Staged source admission. Synthetic keys only, not owner-video proof."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from publication import MemoryPublication, SourceRow
from server import OriginApp
from storage import LocalObjectStore

VIDEO = "vidstage0001"
OTHER = "vidstage0002"
PUBLIC = "owner/vidstage0001/result.mp4"
PRIVATE = "private/source/vidstage0001/original"
OTHER_PRIVATE = "private/source/vidstage0002/original"
ROLLBACK = "private/rollback/vidstage0001/original"
SHA = "a" * 64
OTHER_SHA = "b" * 64
SERVICE = b"service-token-service-token-svc01"
GRANT = b"grant-secret-grant-secret-grant-01"


class StagedSourceAdmissionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = MemoryPublication()
        self.store.sources[VIDEO] = SourceRow(VIDEO, PUBLIC, SHA, "LIVE")
        self.store.relocations = [  # type: ignore[attr-defined]
            {
                "videoId": VIDEO,
                "oldKey": PUBLIC,
                "newKey": PRIVATE,
                "sha256": SHA,
                "state": "COPIED",
            }
        ]
        self.app = OriginApp(
            self.store,
            LocalObjectStore(root / "objects"),
            root / "cache",
            GRANT,
            SERVICE,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _prepare(self, video: str, key: str) -> tuple[int, dict | str]:
        status, body, _content_type, _headers = self.app._prepare_source(
            video,
            {"_body": json.dumps({"sourceId": "srcstage01", "sourceKey": key}).encode()},
        )
        text = body.decode()
        try:
            parsed: dict | str = json.loads(text)
        except json.JSONDecodeError:
            parsed = text
        return status, parsed

    def test_live_public_row_admits_verified_staged_private_key(self) -> None:
        status, parsed = self._prepare(VIDEO, PRIVATE)
        self.assertNotEqual(parsed, {"error": "source_key_mismatch"})
        self.assertNotEqual(status, 401)
        self.assertEqual(self.store.sources[VIDEO].live_key, PUBLIC)
        self.assertEqual(self.store.sources[VIDEO].relocation_state, "LIVE")

    def test_rejects_cross_video_rollback_and_mismatched_sha(self) -> None:
        self.store.sources[OTHER] = SourceRow(OTHER, "owner/other/result.mp4", OTHER_SHA, "LIVE")
        self.store.relocations.append(
            {
                "videoId": OTHER,
                "oldKey": "owner/other/result.mp4",
                "newKey": OTHER_PRIVATE,
                "sha256": OTHER_SHA,
                "state": "COPIED",
            }
        )
        cross_status, cross = self._prepare(VIDEO, OTHER_PRIVATE)
        self.assertEqual(cross_status, 409)
        self.assertEqual(cross, {"error": "source_key_mismatch"})
        rollback = dict(self.store.relocations[0])
        rollback["newKey"] = ROLLBACK
        self.store.relocations.append(rollback)
        rollback_status, rollback_body = self._prepare(VIDEO, ROLLBACK)
        self.assertEqual(rollback_status, 409)
        self.assertEqual(rollback_body, {"error": "source_key_mismatch"})
        self.store.relocations[0]["sha256"] = OTHER_SHA
        mismatch_status, mismatch = self._prepare(VIDEO, PRIVATE)
        self.assertEqual(mismatch_status, 409)
        self.assertEqual(mismatch, {"error": "source_key_mismatch"})

    def test_absent_source_row_rejects_unregistered_private_key(self) -> None:
        del self.store.sources[VIDEO]
        self.store.relocations.clear()
        status, parsed = self._prepare(VIDEO, PRIVATE)
        self.assertEqual(status, 409)
        self.assertEqual(parsed, {"error": "source_key_mismatch"})


if __name__ == "__main__":
    unittest.main()
