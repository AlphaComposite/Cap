import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_audio
import lib_origin
import server

class PrepareReuseTests(unittest.TestCase):
    def test_bound_audio_index_avoids_a_new_ffprobe(self):
        source = Path("/cache/source/original.mp4")
        with patch("lib_audio._reusable_audio_index", return_value={"reused": True}), patch("lib_audio._has_audio_stream", side_effect=AssertionError("duplicate ffprobe")):
            self.assertEqual(lib_audio.audio_source_for(source, source.with_name("mezz.mp4")), source)

    def test_decoder_and_readback_use_existing_cpu_bound(self):
        stream = SimpleNamespace(thread_count=0)
        container = MagicMock()
        container.streams.video = [stream]
        container.decode.return_value = iter([SimpleNamespace(pts=1)])
        try:
            with patch("av.open", return_value=container), patch("limits.origin_cpus", return_value=2):
                lib_origin._decoder(Path("/cache/decoder-thread-test.mp4"))
                self.assertEqual(stream.thread_count, 2)
                stream.thread_count = 0
                self.assertEqual(server._decode_check(b"init", b"media"), 1)
                self.assertEqual(stream.thread_count, 2)
        finally:
            lib_origin.close_source()

if __name__ == "__main__":
    unittest.main()
