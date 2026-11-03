from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import grant
import server
from publication import MemoryPublication, PublicationRow, RevisionRow, VideoRow
from storage import LocalObjectStore


class DurableIntegrityTests(unittest.TestCase):
    def test_internal_integrity_error_never_constructs_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            publication = MemoryPublication()
            publication.put_video(VideoRow("video1234", True, False, None))
            publication.put_publication(PublicationRow("video1234", "revision1234", 1, 2, 3, 1))
            publication.put_revision(RevisionRow("revision1234", "video1234", "intent123", "source123", 1, "CURRENT"))
            app = server.OriginApp(publication, LocalObjectStore(root), root / "cache", b"g" * 32, b"s" * 32, now=lambda: 1000)
            ranges = app.cache / "revisions" / "revision1234" / "ranges.json"
            ranges.parent.mkdir(parents=True)
            ranges.write_text("[]")
            app._origin_for = Mock(side_effect=AssertionError("source construction forbidden"))
            app.objects.get_to = Mock(side_effect=AssertionError("source fetch forbidden"))
            token = grant.mint(b"g" * 32, {"v": 1, "iat": 1000, "exp": 1060, "grantId": "integrity-grant-001", "videoId": "video1234", "revisionId": "revision1234", "publicationEpoch": 2, "policyEpoch": 3})
            with patch.dict("os.environ", {"ORIGIN_OBJECT_URL_ENDPOINT": "http://unused.invalid"}), patch.object(server.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "internal-503")) as fetch:
                status = app.handle("GET", f"/media/video1234/r/revision1234/init.mp4?t={token}", {})[0]
            self.assertEqual(status, 500)
            fetch.assert_called_once()
            app._origin_for.assert_not_called()
            app.objects.get_to.assert_not_called()


if __name__ == "__main__":
    unittest.main()
