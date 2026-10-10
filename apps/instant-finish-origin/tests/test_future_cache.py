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
import limits
import server


class FutureCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lib_origin.reset_revision_encodes)
        self.origin = lib_origin.Origin.__new__(lib_origin.Origin)
        self.origin.cache = Path(self.tmp.name)
        self.origin.rev = "future-revision"
        self.origin.encoder_hash = "encoder"
        self.origin.namespace = "future-namespace"
        self.origin.mezz_sha256 = "a" * 64
        self.origin.segment_plan_version = 3
        self.origin.profile = lib_origin.Profile(1000, 320, 180)
        self.origin.segments = [None] * 4
        self.origin._segment_bytes = {}
        self.origin._lock = threading.Lock()
        self.origin._playback_lock = threading.Lock()
        self.origin._playback_waiting = 0
        self.origin._record = lambda *args, **kwargs: None
        self.path = self.origin.segment_path(2)

    def prepared(self, memory=True):
        self.origin._write_bound(self.path, b"verified-segment", "seg", 2)
        if memory:
            self.origin._segment_bytes[2] = b"verified-segment"

    def test_verified_memory_and_disk_hits_bypass_foreground_admission_and_encode_lock(self):
        for memory in (False, True):
            with self.subTest(memory=memory):
                self.origin._segment_bytes.clear()
                self.prepared(memory)
                foreground, _ = lib_origin.begin_revision_encode("other-video", "publish", "other-revision")
                self.origin._lock.acquire()
                try:
                    with patch("lib_origin.begin_download_hold", side_effect=AssertionError("cached bytes requested background admission")), patch.object(self.origin, "produce", side_effect=AssertionError("cached bytes encoded")):
                        self.assertEqual(self.origin.ensure(2), b"verified-segment")
                    self.assertFalse(foreground.finished)
                    self.assertEqual(self.origin._playback_waiting, 0)
                finally:
                    self.origin._lock.release()
                    foreground.finish()

    def test_mutated_digest_binding_and_orphans_are_repaired_only_after_admission(self):
        for damage in ("bytes", "binding", "digest", "json", "missing-sidecar", "missing-media"):
            with self.subTest(damage=damage):
                self.prepared()
                side = lib_origin.sidecar_path(self.path)
                if damage == "bytes":
                    self.path.write_bytes(b"tampered-segment")
                elif damage in ("binding", "digest"):
                    doc = json.loads(side.read_text())
                    doc["namespace" if damage == "binding" else "sha256"] = "wrong"
                    side.write_text(json.dumps(doc))
                elif damage == "json":
                    side.write_text("{")
                elif damage == "missing-sidecar":
                    side.unlink()
                else:
                    self.path.unlink()
                produced = []
                def produce(index):
                    self.assertIsNotNone(lib_origin.current_encode_slot())
                    produced.append(index)
                    self.origin._write_bound(self.path, b"repaired", "seg", index)
                    self.origin._segment_bytes[index] = b"repaired"
                    self.origin._served_body = b"repaired"
                with patch.object(self.origin, "produce", side_effect=produce):
                    self.assertEqual(self.origin.ensure(2), b"repaired")
                self.assertEqual(produced, [2])
                self.assertEqual(self.origin._read_bound(self.path, "seg", 2), b"repaired")
                self.assertIsNone(lib_origin.current_encode_slot())

    def test_cold_admission_uses_existing_deadline_and_releases_request_state(self):
        foreground, _ = lib_origin.begin_revision_encode("other-video", "publish", "other-revision")
        attempts = []
        clock = iter(i / 10 for i in range(20))
        def wait(_):
            attempts.append(1)
            if len(attempts) > 6:
                raise AssertionError("cold wait ignored its deadline")
        with patch.object(limits, "FFMPEG_TIMEOUT_S", 0.25), patch("lib_origin.time.monotonic", side_effect=lambda: next(clock)), patch("lib_origin.time.sleep", side_effect=wait), patch.object(self.origin, "produce", side_effect=AssertionError("cold bytes bypassed foreground")):
            with self.assertRaisesRegex(TimeoutError, "encode busy"):
                self.origin.ensure(2)
        self.assertFalse(self.origin.playback_waiting())
        self.assertIsNone(lib_origin.current_encode_slot())
        foreground.finish()
        self.prepared()
        self.assertEqual(self.origin.ensure(2), b"verified-segment")

    def test_yield_retries_share_one_deadline_and_release_every_hold(self):
        clock = iter(i / 10 for i in range(30))
        attempts = []
        def yield_encode(index):
            attempts.append(lib_origin.current_encode_slot())
            if len(attempts) > 6:
                raise AssertionError("yield retries reset their deadline")
            raise lib_origin.EncodeCancelled("cancelled")
        with patch.object(limits, "FFMPEG_TIMEOUT_S", 0.25), patch("lib_origin.time.monotonic", side_effect=lambda: next(clock)), patch.object(self.origin, "_ensure", side_effect=yield_encode):
            with self.assertRaisesRegex(TimeoutError, "encode busy"):
                self.origin.ensure(2)
        self.assertTrue(attempts)
        self.assertTrue(all(slot.finished for slot in attempts))
        self.assertFalse(self.origin.playback_waiting())
        self.assertIsNone(lib_origin.current_encode_slot())
        self.assertFalse(lib_origin._ACTIVE_ENCODES)

    def test_materialized_during_admission_wait_is_served_without_a_hold(self):
        foreground, _ = lib_origin.begin_revision_encode("other-video", "publish", "other-revision")
        calls = []
        def wait(_):
            calls.append(1)
            if len(calls) > 1:
                raise AssertionError("verified bytes still waiting for foreground")
            self.prepared(memory=False)
        try:
            with patch("lib_origin.time.sleep", side_effect=wait):
                self.assertEqual(self.origin.ensure(2), b"verified-segment")
            self.assertFalse(foreground.finished)
        finally:
            foreground.finish()

    def test_public_and_internal_cold_timeouts_return_retryable_503(self):
        app = server.OriginApp.__new__(server.OriginApp)
        app._authorize = lambda *args: {"revision": object()}
        app._artifact = lambda *args: self.origin.ensure(2)
        match = server.MEDIA_RE.match("/media/futurevideo01/r/futurerevision01/seg/2.m4s")
        assert match is not None
        parsed = type("Grant", (), {"video_id": "futurevideo01", "revision_id": "futurerevision01", "artifact": "playback"})()
        with patch("server.grant_mod.verify", return_value=parsed), patch.object(self.origin, "ensure", side_effect=TimeoutError("encode busy")):
            app.grant_keys = {}
            app.now = lambda: 1000
            status, _, _, headers = app._media("GET", match, {}, {})
        self.assertEqual(status, 503)
        self.assertEqual(headers["Retry-After"], limits.RETRY_AFTER_S)
        with tempfile.TemporaryDirectory() as tmp:
            app.cache = Path(tmp)
            app._persist_ranges("futurerevision01", [])
            app.store = SimpleNamespace(revision=lambda _: SimpleNamespace(video_id="futurevideo01", source_id="futuresource01"))
            app._origin_for = lambda *args, **kwargs: self.origin
            self.origin.rev = "future-revision"
            server._write_namespace(app.cache, "futurerevision01", self.origin.rev)
            internal = server.ARTIFACT_RE.match("/internal/revisions/futurerevision01/artifact/seg/2.m4s")
            assert internal is not None
            with patch.object(self.origin, "ensure", side_effect=TimeoutError("encode busy")):
                status, _, _, headers = app._internal_artifact(internal)
            self.assertEqual(status, 503)
            self.assertEqual(headers["Retry-After"], limits.RETRY_AFTER_S)


if __name__ == "__main__":
    unittest.main()
