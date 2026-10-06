"""Silent (video-only) sources must prepare: synthesized silent audio track, not 409."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import lib_audio  # noqa: E402
import mezzanine  # noqa: E402


def _video_only(dest: Path, seconds: float = 2.0) -> Path:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", f"testsrc=size=160x120:rate=30:duration={seconds}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(dest)],
        check=True,
    )
    return dest


class SilentSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        lib_audio.clear_sha_cache()
        lib_audio.clear_presentation_cache()

    def test_silent_source_gets_full_length_silent_presentation(self) -> None:
        src = _video_only(self.tmp / "original.mp4")
        mezz = self.tmp / "mezz.mp4"
        mezzanine.build_mezzanine(src, mezz, "silentvid01")
        audio = lib_audio.audio_source_for(src, mezz)
        self.assertNotEqual(audio, src)
        self.assertEqual(lib_audio.audio_source_for(src, mezz), audio, "must be stable/reused")
        lib_audio.build_audio_index(audio)
        record = lib_audio.prepare_presentation(audio)
        self.assertGreaterEqual(record["samples"], int(1.9 * lib_audio.SR))
        pcm, _ = lib_audio.load_presentation(audio)
        self.assertEqual(float(abs(pcm).max()), 0.0)

    def test_equal_length_silent_sources_get_distinct_audio_identity(self) -> None:
        shas = []
        for n, pattern in enumerate(("testsrc", "testsrc2")):
            d = self.tmp / str(n)
            d.mkdir()
            src = d / "original.mp4"
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                 "-i", f"{pattern}=size=160x120:rate=30:duration=2",
                 "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(src)],
                check=True,
            )
            mezz = d / "mezz.mp4"
            mezzanine.build_mezzanine(src, mezz, f"silentvid0{n}")
            shas.append(lib_audio._sha256(lib_audio.audio_source_for(src, mezz)))
        self.assertNotEqual(shas[0], shas[1], "silent track content must be bound to its source")

    def test_source_with_audio_is_used_directly(self) -> None:
        src = self.tmp / "talk.mp4"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30:duration=1",
             "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)],
            check=True,
        )
        self.assertEqual(lib_audio.audio_source_for(src, src), src)

    def test_silent_source_builds_mezzanine(self) -> None:
        src = _video_only(self.tmp / "original.mp4")
        record = mezzanine.build_mezzanine(src, self.tmp / "mezz.mp4", "silentvid01")
        self.assertIsNone(record["audio_rate"])
        self.assertTrue((self.tmp / "mezz.mp4").is_file())


if __name__ == "__main__":
    unittest.main()
