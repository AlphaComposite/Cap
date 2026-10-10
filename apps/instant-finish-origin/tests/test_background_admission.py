"""Automatic exports and future segments yield to every video's startup work."""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_origin
import server
import service_auth
from publication import MemoryPublication, PublicationRow, RevisionRow
from storage import LocalObjectStore

VIDEO, REV, SOURCE = 'videoauto01', 'revisionauto01', 'sourceauto01'
SECRET = b's' * 32


class BackgroundAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.store = MemoryPublication()
        self.store.put_revision(RevisionRow(REV, VIDEO, 'intentauto', SOURCE, 1, 'CURRENT'))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, 1))
        self.app = server.OriginApp(self.store, LocalObjectStore(root), root / 'cache', b'g' * 32, SECRET, now=lambda: 1000)
        self.app._persist_ranges(REV, [])
        self.origin = SimpleNamespace(cache=root / 'media', segments=[0, 1, 2])
        self.origin.cache.mkdir()
        self.addCleanup(lib_origin.reset_revision_encodes)
        self.addCleanup(self.app.drain_downloads, 3)

    def request(self, automatic=True):
        body = json.dumps({'videoId': VIDEO, 'automatic': automatic}).encode()
        path = f'/internal/revisions/{REV}/download'
        return self.app.handle('POST', path, {
            '_body': body,
            service_auth.SERVICE_HEADER: service_auth.sign_request(SECRET, 'POST', path, body, now=1000),
        })

    def test_automatic_non_current_never_resolves_source(self):
        with patch.object(self.app, '_origin_for', return_value=self.origin) as source, patch('server.remux_download') as remux:
            for state in ('READY', 'PREPARING', 'SUPERSEDED', 'FAILED'):
                with self.subTest(state=state):
                    self.store.put_revision(RevisionRow(REV, VIDEO, 'intentauto', SOURCE, 1, state))
                    self.assertEqual(self.request()[0], 409)
            self.app.drain_downloads(2)
            source.assert_not_called()
            remux.assert_not_called()

    def test_automatic_checks_publication_pointer_and_current_generation(self):
        with patch.object(self.app, '_origin_for', return_value=self.origin) as source, patch('server.remux_download'):
            for pub in (None, PublicationRow(VIDEO, 'revisionother', 2, 3, 3, 2), PublicationRow(VIDEO, REV, 2, 2, 3, None), PublicationRow(VIDEO, REV, 2, 2, 3, 2)):
                with self.subTest(publication=pub):
                    if pub is None:
                        self.store.pubs.pop(VIDEO, None)
                    else:
                        self.store.put_publication(pub)
                    self.assertEqual(self.request()[0], 409)
            self.app.drain_downloads(2)
            source.assert_not_called()

    def test_explicit_non_current_export_remains_functional(self):
        self.store.put_revision(RevisionRow(REV, VIDEO, 'intentauto', SOURCE, 1, 'SUPERSEDED'))
        self.store.pubs.pop(VIDEO)
        with patch.object(self.app, '_origin_for', return_value=self.origin), patch('server.remux_download') as remux, patch('server._lower_child_priority'):
            self.assertEqual(self.request(automatic=False)[0], 202)
            self.app.drain_downloads(2)
            remux.assert_called_once()
            self.assertFalse(self.app._downloads[REV].failed)

    def test_automatic_current_export_runs(self):
        with patch.object(self.app, '_origin_for', return_value=self.origin), patch('server.remux_download') as remux, patch('server._lower_child_priority'):
            self.assertEqual(self.request()[0], 202)
            self.app.drain_downloads(2)
            remux.assert_called_once()
            self.assertFalse(self.app._downloads[REV].failed)

    def test_automatic_rechecks_after_waiting_before_source_work(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def gate():
            entered.set()
            release.wait(2)
        self.app.download_gate = gate
        with patch.object(self.app, '_origin_for', return_value=self.origin) as source, patch('server.remux_download') as remux, patch('server._lower_child_priority'):
            self.assertEqual(self.request()[0], 202)
            self.assertTrue(entered.wait(1))
            initial_calls = source.call_count
            self.store.put_publication(PublicationRow(VIDEO, 'revisionother', 2, 3, 3, 2))
            release.set()
            self.app.drain_downloads(2)
            self.assertEqual(source.call_count, initial_calls)
            remux.assert_not_called()
            self.assertFalse(self.app._downloads[REV].failed)

    def test_automatic_rechecks_each_segment_and_discards_partial_export(self):
        calls = []
        self.origin.read_init_for_download = lambda: b'init'
        self.origin.playback_waiting = lambda: False
        def segment(index):
            calls.append(index)
            self.store.put_publication(PublicationRow(VIDEO, 'revisionother', 2, 3, 3, 2))
            return b'segment'
        self.origin.read_segment_for_download = segment
        with patch.object(self.app, '_origin_for', return_value=self.origin), patch('server._lower_child_priority'), patch('server.limits.run_cmd') as ffmpeg:
            self.assertEqual(self.request()[0], 202)
            self.app.drain_downloads(2)
            self.assertEqual(calls, [0])
            ffmpeg.assert_not_called()
            self.assertEqual(list(self.origin.cache.iterdir()), [])
            self.assertFalse(self.app._downloads[REV].failed)

    @staticmethod
    def playback_origin():
        origin = lib_origin.Origin.__new__(lib_origin.Origin)
        origin.rev = 'different-origin'
        origin._playback_lock = threading.Lock()
        origin._playback_waiting = 0
        return origin

    def test_all_startup_entry_points_block_cross_video_export_admission_and_yield(self):
        for kind in (0, 1, 'init'):
            with self.subTest(kind=kind):
                origin = self.playback_origin()
                entered, release = threading.Event(), threading.Event()
                def read(index=None):
                    entered.set()
                    release.wait(2)
                    return b'media'
                origin._ensure = read
                origin._ensure_init = read
                export = lib_origin.begin_download_hold(VIDEO, REV)
                assert export is not None
                method = origin.ensure_init if isinstance(kind, str) else lambda: origin.ensure(kind)
                thread = threading.Thread(target=method)
                thread.start()
                try:
                    self.assertTrue(entered.wait(1))
                    with self.assertRaises(lib_origin.EncodeCancelled):
                        server._slot_cancelled(export)
                    self.assertIsNone(lib_origin.begin_download_hold('thirdvideo', 'thirdrevision'))
                finally:
                    release.set()
                    thread.join(2)
                    export.finish()
                slot = lib_origin.begin_download_hold('thirdvideo', 'thirdrevision')
                self.assertIsNotNone(slot, 'startup slot was leaked')
                assert slot is not None
                slot.finish()

    def test_future_segment_waits_for_publish_before_taking_origin_lock(self):
        origin = self.playback_origin()
        entered, finished = threading.Event(), threading.Event()
        slot, _ = lib_origin.begin_revision_encode(VIDEO, 'publish', REV)
        origin._ensure = lambda index: (entered.set(), b'media')[1]
        thread = threading.Thread(target=lambda: (origin.ensure(2), finished.set()))
        thread.start()
        try:
            self.assertFalse(entered.wait(0.15), 'future segment ran during publish')
            slot.finish()
            self.assertTrue(finished.wait(1))
        finally:
            slot.finish()
            thread.join(2)

    def test_superseded_publish_still_blocks_background_until_its_worker_finishes(self):
        previous, _ = lib_origin.begin_revision_encode(VIDEO, 'old-spec', 'revisionprevious')
        current, _ = lib_origin.begin_revision_encode(VIDEO, 'new-spec', REV)
        self.assertTrue(previous.cancelled.is_set())
        current.finish()
        self.assertIsNone(lib_origin.begin_download_hold('othervideo', 'otherrevision'))
        previous.finish()
        export = lib_origin.begin_download_hold('othervideo', 'otherrevision')
        self.assertIsNotNone(export)
        assert export is not None
        export.finish()

    def test_all_concurrent_startups_must_finish_before_background_admission(self):
        workers = []
        try:
            for index in (0, 1):
                origin = self.playback_origin()
                entered, release = threading.Event(), threading.Event()
                def read(index, entered=entered, release=release):
                    entered.set()
                    release.wait(2)
                    return b'media'
                origin._ensure = read
                worker = threading.Thread(target=origin.ensure, args=(index,))
                workers.append((worker, release))
                worker.start()
                self.assertTrue(entered.wait(1))
            workers[0][1].set()
            workers[0][0].join(1)
            self.assertIsNone(lib_origin.begin_download_hold(VIDEO, REV))
        finally:
            for worker, release in workers:
                release.set()
                worker.join(2)
        slot = lib_origin.begin_download_hold(VIDEO, REV)
        self.assertIsNotNone(slot)
        assert slot is not None
        slot.finish()

    def test_deferred_seg1_uses_shared_startup_admission(self):
        origin = self.playback_origin()
        origin.cache = self.origin.cache
        origin.segments = [0, 1]
        entered, release = threading.Event(), threading.Event()
        def read(index):
            entered.set()
            release.wait(2)
            return b'media'
        origin._ensure = read
        with patch('server._thumbnail'):
            server.schedule_thumbnail(origin, 3.0, revision_id=REV)
            try:
                self.assertTrue(entered.wait(1))
                self.assertIsNone(lib_origin.begin_download_hold(VIDEO, REV))
            finally:
                release.set()
                server.drain_thumbnails()

    def test_future_encode_yields_and_retries_without_holding_the_origin_lock(self):
        origin = self.playback_origin()
        calls = []
        def read(index):
            calls.append(index)
            if len(calls) == 1:
                publish, _ = lib_origin.begin_revision_encode(VIDEO, 'publish', REV)
                try:
                    lib_origin._raise_if_encode_cancelled()
                finally:
                    publish.finish()
            return b'media'
        origin._ensure = read
        self.assertEqual(origin.ensure(2), b'media')
        self.assertEqual(calls, [2, 2])
        self.assertIsNone(lib_origin.current_encode_slot())
        self.assertFalse(origin.playback_waiting())

    def test_future_segment_waits_for_other_video_startup(self):
        startup, future = self.playback_origin(), self.playback_origin()
        entered, release, warmed = threading.Event(), threading.Event(), threading.Event()
        startup._ensure = lambda index: (entered.set(), release.wait(2), b'startup')[2]
        future._ensure = lambda index: (warmed.set(), b'future')[1]
        first = threading.Thread(target=lambda: startup.ensure(1))
        first.start()
        self.assertTrue(entered.wait(1))
        second = threading.Thread(target=lambda: future.ensure(2))
        second.start()
        try:
            self.assertFalse(warmed.wait(0.15), 'future segment ran during another startup')
        finally:
            release.set()
            first.join(2)
            second.join(2)
        self.assertTrue(warmed.is_set())

    def test_download_source_resolution_waits_for_foreground(self):
        slot, _ = lib_origin.begin_revision_encode('othervideo', 'publish', 'otherrevision')
        with patch.object(self.app, '_origin_for', return_value=self.origin) as source, patch('server.remux_download') as remux, patch('server._lower_child_priority'):
            self.assertEqual(self.request()[0], 202)
            try:
                source.assert_not_called()
            finally:
                slot.finish()
                self.app.drain_downloads(2)
            remux.assert_called_once()

    def test_download_encode_yields_mid_segment_to_other_video_startup(self):
        export = lib_origin.begin_download_hold(VIDEO, REV)
        assert export is not None
        startup = self.playback_origin()
        entered, release = threading.Event(), threading.Event()
        startup._ensure = lambda index: (entered.set(), release.wait(2), b'media')[2]
        thread = threading.Thread(target=lambda: startup.ensure(1))
        thread.start()
        try:
            self.assertTrue(entered.wait(1))
            lib_origin.bind_encode_slot(export)
            with self.assertRaises(lib_origin.EncodeCancelled):
                lib_origin._raise_if_encode_cancelled()
        finally:
            lib_origin.bind_encode_slot(None)
            release.set()
            thread.join(2)
            export.finish()


if __name__ == '__main__':
    unittest.main()
