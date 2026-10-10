"""Deferred startup continuity uses the existing thumbnail worker."""
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

class StartupNextTests(unittest.TestCase):
    def test_next_segment_precedes_thumbnail_without_blocking_prepare(self):
        calls = []
        started, release, finished = threading.Event(), threading.Event(), threading.Event()
        def ensure(index):
            calls.append(index)
            started.set()
            release.wait(2)
        def thumbnail(*args):
            calls.append('thumbnail')
            finished.set()
        origin = SimpleNamespace(cache=Path('/unused'), segments=[0, 1], ensure=ensure)
        with patch('server._thumbnail', side_effect=thumbnail):
            server.schedule_thumbnail(origin, 3.0, revision_id='revisionnext')
            self.assertTrue(started.wait(1))
            self.assertFalse(finished.is_set())
            release.set()
            server.drain_thumbnails()
        self.assertEqual(calls, [1, 'thumbnail'])

    def test_failed_prefetch_does_not_block_thumbnail(self):
        origin = SimpleNamespace(cache=Path('/unused'), segments=[0, 1], ensure=lambda _: (_ for _ in ()).throw(RuntimeError('cold failure')))
        with patch('server._thumbnail') as thumbnail, patch('server._log_failed') as log:
            server.schedule_thumbnail(origin, 3.0, revision_id='revisionnext')
            server.drain_thumbnails()
            thumbnail.assert_called_once()
            log.assert_called_once()

if __name__ == '__main__':
    unittest.main()
