"""Origin thumbnails use the first frame of the first >=1 s keep, not a sub-second sliver."""
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

    def thumb(self, ranges):
        self.origin = self.make_origin(ranges)
        return self.write_side()

    def test_uncut_video_keeps_first_frame(self):
        self.assert_color(self.thumb([{"start": 0, "end": 3.2}]), "red")

    def test_skips_sub_second_slivers_to_first_long_keep(self):
        # Non-frame-aligned slivers (25 fps): requested lengths != kept frame time.
        self.assert_color(self.thumb([
            {"start": 0, "end": 0.13}, {"start": 0.15, "end": 0.19}, {"start": 0.2, "end": 3.2},
        ]), "blue")

    def test_long_keep_inside_later_segment(self):
        tb_ranges = [{"start": 0, "end": 0.08}, {"start": 0.1, "end": 0.18}, {"start": 0.2, "end": 3.2}]
        self.origin = self.make_origin(tb_ranges)
        index, _ = server._thumbnail_frame(self.origin)
        frame_ranges = {f.range_index for f in self.origin.segments[index].frames}
        self.assertIn(2, frame_ranges)
        self.assert_color(self.write_side(), "blue")

    def test_all_short_keeps_fall_back_to_first_frame(self):
        self.assert_color(self.thumb([{"start": 0, "end": 0.12}, {"start": 0.2, "end": 0.9}]), "red")

    def test_first_long_keep_at_zero_keeps_first_frame(self):
        self.assert_color(self.thumb([{"start": 0, "end": 1.5}, {"start": 2, "end": 3}]), "red")

    def test_selected_thumbnail_still_rejects_tampering(self):
        self.assert_color(self.thumb([{"start": 0, "end": 0.12}, {"start": 0.2, "end": 3.2}]), "blue")
        (self.cache / "revisions" / REV / "thumbnail.jpg").write_bytes(b"not a jpeg")
        with self.assertRaises(server.SideArtifactRejected):
            server.read_verified_side(SERVICE, self.cache, REV, "thumbnail.jpg")

if __name__ == "__main__":
    unittest.main()
