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
                with patch("server._lower_child_priority"), patch.object(app, "_origin_for", return_value=object()), patch("server.remux_download", side_effect=remux):
                    job = server.DownloadJob()
                    app._run_download("revisionold", "video0001", "source001", [], job)
                    self.assertEqual(len(calls), 1, "obsolete export was restarted")
                    self.assertFalse(job.failed)
                    app._run_download("revisionold", "video0001", "source001", [], server.DownloadJob())
                    self.assertEqual(len(calls), 2, "an explicit retry must still work")
            finally:
                lib_origin.reset_revision_encodes()

    def test_export_lowers_priority_before_source_work(self):
        import threading
        from types import SimpleNamespace
        with patch("server.os.nice") as nice, patch("server.remux_download") as remux:
            def source(*args):
                nice.assert_called_once_with(10)
                return object()
            app = SimpleNamespace(download_gate=None, _download_lock=threading.Lock(), download_builds=0, _origin_for=source)
            job = server.DownloadJob()
            try:
                server.OriginApp._run_download(app, "revisionpriority", "videopriority", "sourcepriority", [], job)
                nice.assert_called_once_with(10)
                remux.assert_called_once()
                self.assertFalse(job.failed)
            finally:
                lib_origin.reset_revision_encodes()

    def test_exports_share_existing_slot_across_videos(self):
        try:
            first = lib_origin.begin_download_hold("videoone", "revisionone")
            self.assertIsNotNone(first)
            self.assertIsNone(lib_origin.begin_download_hold("videotwo", "revisiontwo"))
            first.finish()
            second = lib_origin.begin_download_hold("videotwo", "revisiontwo")
            self.assertIsNotNone(second)
            second.finish()
            prepare, _ = lib_origin.begin_revision_encode("videoone", "spec", "revisionnew")
            self.assertIsNone(lib_origin.begin_download_hold("videotwo", "revisiontwo"))
            prepare.finish()
        finally:
            lib_origin.reset_revision_encodes()

    def test_export_yields_to_other_video_prepare(self):
        try:
            export = lib_origin.begin_download_hold("videoone", "revisionone")
            prepare, _ = lib_origin.begin_revision_encode("videotwo", "spec", "revisionnew")
            with self.assertRaises(lib_origin.EncodeCancelled):
                server._slot_cancelled(export)
            prepare.finish()
            server._slot_cancelled(export)
        finally:
            lib_origin.reset_revision_encodes()

if __name__ == "__main__":
    unittest.main()
