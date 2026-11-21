from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import lib_audio
import lib_origin
import mezzanine
import server


class UncutDownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source_tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.source_tmp.cleanup)
        cls.root = Path(cls.source_tmp.name)
        cls.source = cls.root / "original.mp4"
        cls.mezz = cls.root / "mezz.mp4"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=30000/1001:duration=2.07",
            "-itsoffset", "0.049", "-f", "lavfi", "-i",
            "sine=frequency=440:sample_rate=48000:duration=2.2",
            "-c:v", "libx264", "-bf", "0", "-g", "30", "-pix_fmt", "yuv420p",
            "-video_track_timescale", "30000", "-c:a", "aac", str(cls.source),
        ], check=True, timeout=30)
        mezzanine.build_mezzanine(cls.source, cls.mezz)
        lib_audio.build_audio_index(cls.source)
        lib_audio.prepare_presentation(cls.source)
        _, cls.probed, cls.ticks, cls.durs, _, _ = lib_origin.cached_mezz_index(cls.mezz)
        cls.end = lib_origin.source_end_ticks(cls.ticks, cls.durs) / cls.probed.timescale
        cls.addClassCleanup(lib_origin.reset_process_state)

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.origin = self.make_origin([{"start": 0, "end": self.end}])
        self.slot = lib_origin.EncodeSlot("viduncut01", "download:uncut", "revuncut01")
        self.addCleanup(self.slot.finish)

    def make_origin(self, ranges) -> lib_origin.Origin:
        return lib_origin.Origin(self.mezz, self.source, Path(self.tmp.name), ranges,
                                 lib_origin.sha256_file(self.source))

    def probe(self, path: Path, stream: str, packets: bool = False):
        cmd = ["ffprobe", "-v", "error", "-select_streams", stream, "-of", "json"]
        if packets:
            cmd += ["-show_packets", "-show_data_hash", "sha256",
                    "-show_entries", "packet=pts,dts,duration,data_hash"]
        else:
            cmd += ["-show_entries", "stream=start_pts,duration_ts,time_base"]
        return json.loads(subprocess.check_output([*cmd, str(path)], timeout=30))

    def assert_clean(self) -> None:
        self.assertFalse((self.origin.cache / "download.mp4").exists())
        self.assertFalse(list(self.origin.cache.glob(".download-*")))

    def test_uncut_copies_packets_and_exact_canonical_audio_without_segments(self) -> None:
        expected = lib_audio.render_cut_pcm(self.source, self.origin.timeline).tobytes()
        real_popen = subprocess.Popen
        real_assemble = lib_audio.assemble_cut
        windows = []
        commands = []

        def assemble(source, timeline, lo, hi):
            windows.append((lo, hi))
            self.assertLessEqual(hi - lo, lib_audio.SR)
            return real_assemble(source, timeline, lo, hi)

        def spawn(cmd, **kwargs):
            commands.append(cmd)
            audio = Path(cmd[cmd.index("-ac") + 3])
            self.assertEqual(audio.read_bytes(), expected)
            self.assertEqual(audio.stat().st_mode & 0o777, 0o600)
            return real_popen(cmd, **kwargs)

        with patch.object(self.origin, "read_init_for_download", side_effect=AssertionError("uncut produced segments")), \
             patch.object(self.origin, "read_segment_for_download", side_effect=AssertionError("uncut produced segments")), \
             patch.object(lib_audio, "assemble_cut", side_effect=assemble), \
             patch.object(server.subprocess, "Popen", side_effect=spawn), \
             patch.object(server.limits, "timeout_for_duration", wraps=server.limits.timeout_for_duration) as timeout:
            server.remux_download(self.origin, self.slot)
        dest = self.origin.cache / "download.mp4"
        self.assertEqual(self.probe(dest, "v:0", True), self.probe(self.mezz, "v:0", True))
        self.assertEqual(self.probe(dest, "a:0")["streams"][0], {
            "time_base": "1/48000", "start_pts": 0, "duration_ts": self.origin.timeline.samples,
        })
        self.assertEqual(windows[0][0], 0)
        self.assertEqual(windows[-1][1], self.origin.timeline.samples)
        self.assertTrue(all(a[1] == b[0] for a, b in zip(windows, windows[1:])))
        timeout.assert_called_once_with(self.origin.timeline.samples / lib_audio.SR)
        cmd = commands[0]
        self.assertEqual(cmd[cmd.index("-c:v") + 1], "copy")
        self.assertEqual(cmd[cmd.index("-b:a") + 1], lib_audio.AUDIO_BITRATE)
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "aac")
        for option, value in zip(lib_audio.AAC_ENCODER_ARGS[::2], lib_audio.AAC_ENCODER_ARGS[1::2]):
            self.assertEqual(cmd[cmd.index(option) + 1], value)
        self.assertNotEqual(self.probe(self.source, "a:0")["streams"][0]["start_pts"], 0)
        self.assertNotIn("-shortest", cmd)
        self.assertNotIn("-t", cmd)
        raw = dest.read_bytes()
        movie_ts = lib_audio.movie_timescale(raw)
        self.assertEqual(movie_ts, math.lcm(self.origin.profile.timescale, lib_audio.SR))
        moov = next(b for b in lib_audio._children(raw, 0, len(raw)) if b[3] == b"moov")
        audio = next(b for b in lib_audio._children(raw, moov[0] + moov[2], moov[0] + moov[1])
                     if b[3] == b"trak" and lib_audio._track_id(raw, b) == 2)
        edts = next(b for b in lib_audio._children(raw, audio[0] + audio[2], audio[0] + audio[1]) if b[3] == b"edts")
        elst = next(b for b in lib_audio._children(raw, edts[0] + edts[2], edts[0] + edts[1]) if b[3] == b"elst")
        at = elst[0]
        self.assertEqual(raw[at + 8], 0)
        self.assertEqual(int.from_bytes(raw[at + 16:at + 20], "big") * lib_audio.SR,
                         self.origin.timeline.samples * movie_ts)
        self.assertEqual(int.from_bytes(raw[at + 20:at + 24], "big", signed=True), lib_audio.FRAME)
        self.assertLess(raw.index(b"moov"), raw.index(b"mdat"))
        self.assertEqual(dest.stat().st_mode & 0o777, 0o600)
        self.assertFalse(list(self.origin.cache.glob(".download-*")))
        self.assertFalse(self.origin.productions)
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(dest), "-f", "null", "-"], check=True, timeout=30)
        with patch.object(server.subprocess, "Popen", side_effect=AssertionError("ready rebuilt")):
            server.remux_download(self.origin, self.slot)

    def test_partial_cut_multiple_ranges_and_uncertain_plans_use_segmented_path(self) -> None:
        cases = [
            "partial", "cut", "multiple", "last-frame-trim", "discontinuous", "nonzero",
            "duplicate", "missing", "retimed", "duration", "packet-duration", "timescale",
        ]
        for case in cases:
            with self.subTest(case=case):
                ranges = [{"start": 0, "end": self.end}]
                if case == "partial":
                    ranges = [{"start": 0.3, "end": self.end}]
                elif case == "cut":
                    ranges = [{"start": 0, "end": 0.7}, {"start": 1.1, "end": self.end}]
                elif case == "multiple":
                    ranges = [{"start": 0, "end": 1}, {"start": 1, "end": self.end}]
                elif case == "last-frame-trim":
                    ranges[0]["end"] -= 0.0001
                origin = self.make_origin(ranges)
                bound = lib_origin.cached_mezz_index(origin.mezz)
                if case in {"discontinuous", "nonzero"}:
                    origin.ticks = [tick + int(case == "nonzero" or index > 0)
                                    for index, tick in enumerate(origin.ticks)]
                    origin.ranges = [{"start": 0, "end": self.end + 1 / origin.profile.timescale}]
                    origin.segments = [replace(segment, frames=tuple(
                        replace(frame, src_pts=origin.ticks[frame.index]) for frame in segment.frames
                    )) for segment in origin.segments]
                    bound = (bound[0], replace(bound[1], packets=tuple(
                        replace(packet, pts=origin.ticks[index]) for index, packet in enumerate(bound[1].packets)
                    )), *bound[2:])
                elif case == "timescale":
                    origin.profile = replace(origin.profile, timescale=2_147_483_647)
                elif case == "packet-duration":
                    packets = bound[1].packets
                    bound = (bound[0], replace(bound[1], packets=(replace(packets[0], dur=packets[0].dur - 1), *packets[1:])), *bound[2:])
                elif case in {"duplicate", "missing", "retimed", "duration"}:
                    segment = origin.segments[0]
                    frames = list(segment.frames)
                    if case == "duplicate":
                        frames[1] = frames[0]
                    elif case == "missing":
                        frames.pop()
                    elif case == "retimed":
                        frames[0] = replace(frames[0], out_pts=1)
                    else:
                        frames[0] = replace(frames[0], dur=frames[0].dur + 1)
                    origin.segments[0] = replace(segment, frames=tuple(frames))

                def remux(cmd, *args, **kwargs):
                    Path(cmd[-1]).write_bytes(b"segmented-ok")
                    return subprocess.CompletedProcess(cmd, 0)

                with patch.object(origin, "read_init_for_download", return_value=b"init") as init, \
                     patch.object(origin, "read_segment_for_download", return_value=b"segment") as segments, \
                     patch.object(lib_origin, "cached_mezz_index", return_value=bound), \
                     patch.object(server.limits, "run_cmd", side_effect=remux), \
                     patch.object(lib_audio, "assemble_cut", side_effect=AssertionError("unsafe copy")):
                    server.remux_download(origin, self.slot)
                init.assert_called_once()
                self.assertEqual(segments.call_count, len(origin.segments))
                (origin.cache / "download.mp4").unlink()

    def test_interrupts_during_pcm_and_encode_never_publish_and_reap_children(self) -> None:
        real_assemble = lib_audio.assemble_cut
        real_popen = subprocess.Popen
        for phase in ("pcm", "encode"):
            for reason in ("cancel", "superseded", "playback"):
                with self.subTest(phase=phase, reason=reason):
                    slot = lib_origin.EncodeSlot("viduncut01", "download:uncut", "revuncut01")
                    self.addCleanup(slot.finish)
                    interrupted = False
                    children = []

                    def interrupt():
                        nonlocal interrupted
                        interrupted = True
                        if reason == "cancel":
                            slot.cancel("cancelled")

                    def assemble(source, timeline, lo, hi):
                        self.assertLessEqual(hi - lo, lib_audio.SR)
                        result = real_assemble(source, timeline, lo, hi)
                        interrupt()
                        return result

                    def spawn(cmd, **kwargs):
                        child = real_popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
                        children.append(child)
                        real_wait = child.wait

                        def wait(timeout=None):
                            try:
                                return real_wait(timeout=timeout)
                            except subprocess.TimeoutExpired:
                                interrupt()
                                raise

                        child.wait = wait
                        return child

                    expected = server.DownloadYield if reason == "playback" else lib_origin.EncodeCancelled
                    with patch.object(lib_audio, "assemble_cut", side_effect=assemble if phase == "pcm" else real_assemble), \
                         patch.object(server.subprocess, "Popen", side_effect=spawn), \
                         patch.object(self.origin, "playback_waiting", side_effect=lambda: interrupted and reason == "playback"), \
                         patch.object(self.origin, "read_init_for_download", side_effect=AssertionError("uncut produced segments")):
                        with self.assertRaises(expected):
                            server.remux_download(self.origin, slot, lambda: not (interrupted and reason == "superseded"))
                    self.assert_clean()
                    self.assertEqual(len(children), int(phase == "encode"))
                    for child in children:
                        self.assertIsNotNone(child.poll())
                        self.assertEqual(child.wait(timeout=1), child.returncode)
                    if reason == "superseded":
                        self.assertEqual(slot.reason, "superseded")

    def test_encoder_failure_and_scaled_timeout_clean_only_owned_temps(self) -> None:
        real_popen = subprocess.Popen
        sentinel = self.origin.cache / ".download-other-worker.mp4"
        sentinel.write_bytes(b"unrelated")
        for failure in ("exit", "timeout"):
            with self.subTest(failure=failure):
                children = []

                def spawn(cmd, **kwargs):
                    Path(cmd[-1]).write_bytes(b"partial-output")
                    child = real_popen([sys.executable, "-c", "raise SystemExit(1)" if failure == "exit" else "import time; time.sleep(30)"], **kwargs)
                    children.append(child)
                    return child

                with patch.object(server.subprocess, "Popen", side_effect=spawn), \
                     patch.object(server.limits, "timeout_for_duration", return_value=30 if failure == "exit" else 0.05), \
                     patch.object(self.origin, "read_init_for_download", side_effect=AssertionError("uncut produced segments")):
                    with self.assertRaises((RuntimeError, server.limits.InputRejected)):
                        server.remux_download(self.origin, self.slot)
                self.assertFalse((self.origin.cache / "download.mp4").exists())
                self.assertEqual(list(self.origin.cache.glob(".download-*")), [sentinel])
                self.assertEqual(sentinel.read_bytes(), b"unrelated")
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].poll())
        self.assertGreater(server.limits.timeout_for_duration(4 * 60 * 60), 120)


if __name__ == "__main__":
    unittest.main()
