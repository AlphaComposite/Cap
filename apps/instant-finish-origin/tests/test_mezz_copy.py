"""cap-ol0.8: an already-compliant source is stream-copied into the mezzanine; anything else is re-encoded."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mezzanine as m  # noqa: E402

COMMON = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=4",
          "-f", "lavfi", "-i", "sine=duration=4", "-c:a", "aac", "-pix_fmt", "yuv420p", "-c:v", "libx264"]
COMPLIANT = ["-bf", "0", "-force_key_frames", "expr:gte(t,n_forced*1)", "-forced-idr", "1", "-x264-params", m.MEZZ_X264]


class MezzCopy(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())

    def _make(self, name: str, extra: list[str]) -> Path:
        path = self.tmp / name
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *COMMON, *extra, str(path)], check=True)
        return path

    def _build(self, src: Path) -> tuple[dict, list[list[str]]]:
        calls: list[list[str]] = []
        real = m.limits.run_cmd

        def spy(cmd, *a, **k):
            calls.append(cmd)
            return real(cmd, *a, **k)

        with mock.patch.object(m.limits, "run_cmd", spy):
            return m.build_mezzanine(src, self.tmp / f"mezz-{src.stem}.mp4"), calls

    def test_compliant_source_is_stream_copied(self) -> None:
        rec, calls = self._build(self._make("ok.mp4", COMPLIANT))
        self.assertEqual(rec["has_b_frames"], 0)
        self.assertTrue(calls and all("libx264" not in c for c in calls), calls)

    def test_bframes_source_is_reencoded(self) -> None:
        _, calls = self._build(self._make("bf.mp4", ["-bf", "2", "-force_key_frames", "expr:gte(t,n_forced*1)"]))
        self.assertTrue(any("libx264" in c for c in calls))

    def test_sparse_keyframes_source_is_reencoded(self) -> None:
        _, calls = self._build(self._make("gop.mp4", ["-bf", "0", "-g", "90", "-x264-params", "scenecut=0"]))
        self.assertTrue(any("libx264" in c for c in calls))

    def test_dropped_frame_keyframe_gaps_still_copy(self) -> None:
        # Long real recordings drop frames: a few keyframe gaps reach ~1.14 s (y4z9zy4nsjqz84n).
        # Simulate with 7 fps (keyframe pts land at 0, 1.143, 2.286 ...).
        path = self.tmp / "drop.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        "testsrc2=size=320x240:rate=7:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                        "-bf", "0", "-g", "8", "-x264-params", "scenecut=0:open-gop=0", str(path)], check=True)
        _, calls = self._build(path)
        self.assertTrue(calls and all("libx264" not in c for c in calls), calls)

    def test_non_h264_source_is_reencoded(self) -> None:
        path = self.tmp / "mpeg4.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        "testsrc2=size=320x240:rate=30:duration=2", "-c:v", "mpeg4", "-bf", "0", "-g", "30", str(path)],
                       check=True)
        _, calls = self._build(path)
        self.assertTrue(any("libx264" in c for c in calls))


if __name__ == "__main__":
    unittest.main()
