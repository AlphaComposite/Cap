"""Real origin thumbnails select output time, not the source's first frame."""
from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

import av

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_audio
import lib_origin
import mezzanine
import server
from publication import MemoryPublication, RevisionRow
from service_auth import sign_request
from storage import LocalObjectStore

SERVICE = b"service-token-service-token-svc01"
GRANT = b"grant-secret-grant-secret-grant-01"
REV = "revthumbnail01"
VIDEO = "vidthumbnail01"


class ThumbnailSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.fixture.cleanup)
        root = Path(cls.fixture.name)
        cls.source = root / "original.mp4"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
             "-f", "lavfi", "-i", "color=red:size=160x120:rate=25:duration=0.2",
             "-f", "lavfi", "-i", "color=blue:size=160x120:rate=25:duration=3",
             "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=3.2",
             "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
             "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-bf", "2",
             "-pix_fmt", "yuv420p", "-video_track_timescale", "16000",
             "-c:a", "aac", "-shortest", str(cls.source)],
            check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        cls.mezz = root / "mezz.mp4"
        mezzanine.build_mezzanine(cls.source, cls.mezz, VIDEO)
        cls.audio = lib_audio.audio_source_for(cls.source, cls.mezz)
        lib_audio.build_audio_index(cls.audio)
        lib_audio.prepare_presentation(cls.audio)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(lib_audio.reset_aac_pool)
        self.addCleanup(lib_origin.reset_process_state)
        self.addCleanup(server.drain_thumbnails)
        self.cache = Path(self.tmp.name) / "cache"
        self.origin = self.make_origin([{"start": 0, "end": 3.2}])
        self.store = MemoryPublication()
        self.app = server.OriginApp(
            self.store, LocalObjectStore(Path(self.tmp.name) / "objects"),
            self.cache, GRANT, SERVICE, now=lambda: 1000,
        )

    def make_origin(self, ranges):
        return lib_origin.Origin(
            self.mezz, self.audio, self.cache, ranges, lib_origin.sha256_file(self.source),
        )

    def assert_color(self, jpeg, color):
        self.assertTrue(server._jpeg_has_frame(jpeg))
        self.assertIn(b"duration_seconds=9.750", jpeg)
        with av.open(io.BytesIO(jpeg)) as container:
            rgb = next(container.decode(video=0)).to_ndarray(format="rgb24").mean(axis=(0, 1))
        expected, other = (2, 0) if color == "blue" else (0, 2)
        self.assertGreater(rgb[expected], 200, f"expected {color}, RGB={rgb}")
        self.assertLess(rgb[other], 30, f"expected {color}, RGB={rgb}")

    def write_side(self, **body):
        self.app._write_side_artifacts(
            REV, self.origin,
            {"captionsVtt": "WEBVTT\n", "chaptersJson": '{"chapters":[]}',
             "durationSeconds": 9.75, **body}, 3.2,
        )
        server.drain_thumbnails()
        return server.read_verified_side(SERVICE, self.cache, REV, "thumbnail.jpg")

    def test_selected_offset_is_blue_while_legacy_first_frame_is_red(self):
        self.assert_color(self.write_side(), "red")
        self.assert_color(self.write_side(thumbnailAtSeconds=0.5), "blue")

    def test_signed_prepare_passes_selected_offset_to_side_worker(self):
        self.store.put_revision(RevisionRow(REV, VIDEO, "pendinghash", "sourcethumb01", 1, "CURRENT"))
        path = f"/internal/revisions/{REV}/prepare"
        # Replaying prepare can also regenerate an existing CURRENT revision's JPEG.
        for at, color in ((0, "red"), (0.5, "blue")):
            raw = json.dumps({
                "videoId": VIDEO, "sourceId": "sourcethumb01", "keepRanges": self.origin.ranges,
                "durationSeconds": 9.75, "thumbnailAtSeconds": at,
            }).encode()
            with patch.object(self.app, "_origin_for", return_value=self.origin):
                status, payload, _, _ = self.app.handle("POST", path, {
                    "_body": raw, "x-cap-origin-service": sign_request(SERVICE, "POST", path, raw, now=1000),
                })
            self.assertEqual(status, 200, payload)
            server.drain_thumbnails()
            self.assertEqual(server._namespace(self.cache, REV), self.origin.rev)
            self.assert_color(server.read_verified_side(SERVICE, self.cache, REV, "thumbnail.jpg"), color)

    def test_nonzero_segment_seeks_relative_to_fragment_start(self):
        # A short first keep puts the red/blue transition inside segment 1.
        self.origin = self.make_origin([{"start": 0, "end": 0.08}, {"start": 0.08, "end": 3.2}])
        tb = self.origin.profile.timescale
        for at, color in ((0.08, "red"), (0.12, "red"), (0.28, "blue"), (3.0, "blue"), (3.19, "blue")):
            with self.subTest(at=at):
                segment = next(s for s in self.origin.segments if s.out_pts / tb <= at < (s.out_pts + s.duration_ticks) / tb)
                self.assertGreater(segment.index, 0)
                with patch.object(self.origin, "ensure", wraps=self.origin.ensure) as ensure:
                    self.assert_color(self.write_side(thumbnailAtSeconds=at), color)
                self.assertIn(call(segment.index), ensure.call_args_list)
                self.assertNotIn(call(0), ensure.call_args_list)

    def test_invalid_offsets_fall_back_to_first_frame(self):
        for at in (None, "0.5", True, False, -0.1, float("nan"), float("inf"),
                   float("-inf"), [], {}, 3.2, 9.0, 10**1000):
            with self.subTest(at=at):
                self.assert_color(self.write_side(thumbnailAtSeconds=at), "red")
        self.assert_color(self.write_side(thumbnailAtSeconds=0), "red")

    def test_selected_thumbnail_still_rejects_tampering(self):
        self.assert_color(self.write_side(thumbnailAtSeconds=0.5), "blue")
        (self.cache / "revisions" / REV / "thumbnail.jpg").write_bytes(b"not a jpeg")
        with self.assertRaises(server.SideArtifactRejected):
            server.read_verified_side(SERVICE, self.cache, REV, "thumbnail.jpg")


if __name__ == "__main__":
    unittest.main()
