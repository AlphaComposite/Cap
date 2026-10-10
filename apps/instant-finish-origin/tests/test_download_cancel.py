"""An obsolete export must yield permanently to a newer revision."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_origin
import server
from publication import MemoryPublication
from storage import LocalObjectStore

class DownloadCancelTests(unittest.TestCase):
    def test_superseded_export_stops_but_can_be_requested_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app = server.OriginApp(MemoryPublication(), LocalObjectStore(root), root / "cache", b"g" * 32, b"s" * 32)
            calls = []
            def remux(_origin, slot):
                calls.append(slot)
                if len(calls) == 1:
                    slot.cancel("superseded")
                    raise lib_origin.EncodeCancelled("superseded")
            try:
                with patch.object(app, "_origin_for", return_value=object()), patch("server.remux_download", side_effect=remux):
                    job = server.DownloadJob()
                    app._run_download("revisionold", "video0001", "source001", [], job)
                    self.assertEqual(len(calls), 1, "obsolete export was restarted")
                    self.assertFalse(job.failed)
                    app._run_download("revisionold", "video0001", "source001", [], server.DownloadJob())
                    self.assertEqual(len(calls), 2, "an explicit retry must still work")
            finally:
                lib_origin.reset_revision_encodes()

if __name__ == "__main__":
    unittest.main()
