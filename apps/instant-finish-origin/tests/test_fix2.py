"""Fix-2 origin contracts: index reuse, deferred thumbnail, optional VUI."""
from __future__ import annotations

import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import lib_audio
import lib_vui


class AudioReuseTests(unittest.TestCase):
    def test_unchanged_sha_does_not_probe_or_rewrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.mp4"
            source.write_bytes(b"stable-source-bytes")

            def fake_run(_cmd, **_kwargs):
                class Result:
                    returncode = 0
                    stdout = b"0,1024,32,64\n"
                    stderr = b""

                return Result()

            with patch("lib_audio.subprocess.run", side_effect=fake_run) as run:
                first = lib_audio.build_audio_index(source)
                self.assertNotIn("reused", first)
                before = lib_audio.index_path(source).read_bytes()
                calls = run.call_count
                second = lib_audio.build_audio_index(source)
            self.assertTrue(second["reused"])
            self.assertEqual(run.call_count, calls)
            self.assertEqual(lib_audio.index_path(source).read_bytes(), before)
            self.assertFalse(any("ffprobe" in " ".join(call.args[0]) for call in run.call_args_list[calls:]))


class VuiSwitchTests(unittest.TestCase):
    def test_unset_leaves_bytes_alone(self) -> None:
        raw = b"\x00\x00\x00\x08avcCxxxx"
        self.assertIsNone(lib_vui.configured_tick_rate({}))
        self.assertEqual(lib_vui.apply_vui_tick_rate(raw, {}), raw)

    def test_invalid_rate_is_rejected(self) -> None:
        with self.assertRaises(RuntimeError):
            lib_vui.configured_tick_rate({"ORIGIN_H264_VUI_TICK_RATE": "fast"})


class ThumbnailDeferTests(unittest.TestCase):
    def test_schedule_returns_before_the_encode(self) -> None:
        import server

        gate = threading.Event()
        started = threading.Event()

        def block(_origin, _dest, _duration):
            started.set()
            gate.wait(2)

        origin = type("Origin", (), {"cache": Path(tempfile.mkdtemp())})()
        with patch("server._thumbnail", block):
            server.schedule_thumbnail(origin, 1.0)
            self.assertTrue(started.wait(1))
        gate.set()
        server.drain_thumbnails()


if __name__ == "__main__":
    unittest.main()
