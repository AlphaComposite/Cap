"""cap-ol0.9: audio ending a few ms before video must not break the final HLS segment (pads with silence)."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_audio  # noqa: E402
import lib_origin  # noqa: E402
import mezzanine  # noqa: E402
from index import probe  # noqa: E402


class ShortAudio(unittest.TestCase):
    def test_last_segment_builds_when_audio_ends_before_video(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        src = tmp / "original.mp4"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3",
             "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2.985",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(src)],
            check=True,
        )
        mezz = tmp / "mezz.mp4"
        mezzanine.build_mezzanine(src, mezz, "shortaudio01")
        audio = lib_audio.audio_source_for(src, mezz)
        lib_audio.build_audio_index(audio)
        lib_audio.prepare_presentation(audio)
        pcm, _ = lib_audio.load_presentation(audio)
        built = probe(mezz)
        end = max(r.pts + max(r.dur, 0) for r in built.packets)
        self.assertLess(len(pcm), end / built.timescale * 48000, "fixture must have audio shorter than video")
        origin = lib_origin.Origin(mezz, audio, tmp / "cache", [{"start": 0, "end": end}], lib_origin.sha256_file(src))
        for index in range(len(origin.segments)):
            self.assertGreater(len(origin.ensure(index)), 0, index)

    def test_large_overrun_still_fails(self) -> None:
        pcm = np.zeros((48000, 2), np.float32)
        with mock.patch.object(lib_audio, "load_presentation", return_value=(pcm, {})):
            tail = lib_audio._read_presentation(Path("x"), 47000, 49000)
            self.assertEqual(tail.shape, (2000, 2))
            self.assertFalse(tail[1000:].any())
            with self.assertRaises(RuntimeError):
                lib_audio._read_presentation(Path("x"), 0, 48000 + lib_audio.TAIL_SILENCE_MAX + 1)


if __name__ == "__main__":
    unittest.main()
