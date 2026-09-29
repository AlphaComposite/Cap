"""Presentation sample-rate policy. Sources are synthesized with ffmpeg."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import lib_audio
import lib_origin
from publication import MemoryPublication
from server import OriginApp, serve
from service_auth import sign_request
from storage import LocalObjectStore

CLICK_T = 1.0
DURATION = 1.5
FRAME_RATE = 30
OFFSET_LIMIT_MS = 33.3
AAC_OFFSET_LIMIT_MS = 2.0
SUPPORTED = (
    8000,
    11025,
    12000,
    16000,
    22050,
    24000,
    32000,
    44100,
    48000,
    64000,
    88200,
    96000,
)
GRANT = b"grant-secret-grant-secret-grant-01"
SERVICE = b"service-token-service-token-svc01"
VIDEO = "vidrate0001"
SOURCE = "sourcerate1"


def _ffmpeg(cmd: list[str]) -> None:
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise AssertionError(result.stderr.decode()[-500:])


def _click_expr(rate: int, duration: float = DURATION) -> str:
    sample = int(round(CLICK_T * rate))
    return f"aevalsrc=if(eq(n\\,{sample})\\,1\\,0):s={rate}:d={duration}"


def _write_click(path: Path, rate: int) -> None:
    _ffmpeg(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=320x180:rate={FRAME_RATE}:duration={DURATION}",
            "-f", "lavfi", "-i", _click_expr(rate),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
            "-c:a", "pcm_s16le", "-ar", str(rate), "-ac", "1",
            "-shortest", str(path),
        ]
    )


def _write_aac_click(path: Path, rate: int) -> None:
    _ffmpeg(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=320x180:rate={FRAME_RATE}:duration={DURATION}",
            "-f", "lavfi", "-i", _click_expr(rate),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
            "-c:a", "aac", "-ar", str(rate), "-ac", "1",
            "-movflags", "+faststart",
            "-shortest", str(path),
        ]
    )


def _audio_codec(path: Path) -> str:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr.decode()[-400:])
    return result.stdout.decode().strip()


def _iter_boxes(data: bytes, start: int, end: int):
    pos = start
    while pos + 8 <= end:
        size = int.from_bytes(data[pos:pos + 4], "big")
        kind = data[pos + 4:pos + 8]
        header = 8
        if size == 1 and pos + 16 <= end:
            size = int.from_bytes(data[pos + 8:pos + 16], "big")
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            break
        yield kind, pos, header, pos + size
        pos += size


def _child_boxes(data: bytes, start: int, end: int) -> list[tuple[bytes, int, int, int]]:
    return list(_iter_boxes(data, start, end))


def _handler_type(data: bytes, start: int, end: int) -> bytes | None:
    for kind, off, header, stop in _child_boxes(data, start, end):
        if kind == b"hdlr":
            body = data[off + header:stop]
            if len(body) >= 12:
                return body[8:12]
        if kind in (b"mdia", b"minf", b"stbl"):
            found = _handler_type(data, off + header, stop)
            if found is not None:
                return found
    return None


def _elst_media_times(data: bytes, start: int, end: int) -> list[int]:
    times: list[int] = []
    for kind, off, header, stop in _child_boxes(data, start, end):
        if kind == b"elst":
            body = data[off + header:stop]
            if len(body) < 8:
                continue
            version = body[0]
            count = int.from_bytes(body[4:8], "big")
            cursor = 8
            for _ in range(count):
                if version == 1:
                    if cursor + 16 > len(body):
                        break
                    times.append(int.from_bytes(body[cursor + 8:cursor + 16], "big", signed=True))
                    cursor += 20
                else:
                    if cursor + 8 > len(body):
                        break
                    times.append(int.from_bytes(body[cursor + 4:cursor + 8], "big", signed=True))
                    cursor += 12
        elif kind == b"edts":
            times.extend(_elst_media_times(data, off + header, stop))
    return times


def _audio_elst_media_time(blob: bytes) -> int:
    for kind, off, header, stop in _child_boxes(blob, 0, len(blob)):
        if kind != b"moov":
            continue
        if b"elst" not in blob[off:stop]:
            raise AssertionError("moov has no elst box")
        for child, coff, cheader, cstop in _child_boxes(blob, off + header, stop):
            if child != b"trak" or _handler_type(blob, coff + cheader, cstop) != b"soun":
                continue
            times = _elst_media_times(blob, coff + cheader, cstop)
            if not times:
                raise AssertionError("audio trak has no elst inside moov")
            return times[0]
    raise AssertionError("mp4 has no moov box")


def _aac_skip_samples(path: Path) -> int:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_packets", "-show_entries", "packet=pts_time:packet_side_data",
            "-read_intervals", "%+#1", "-of", "json", str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr.decode()[-400:])
    packets = json.loads(result.stdout).get("packets") or []
    if not packets:
        raise AssertionError(f"no audio packets in {path.name}")
    for item in packets[0].get("side_data_list") or []:
        if item.get("side_data_type") == "Skip Samples":
            return int(item["skip_samples"])
    raise AssertionError(f"aac stream has no skip_samples side data in {path.name}")


def _video_span(path: Path) -> tuple[float, float]:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration:stream=codec_type,r_frame_rate,duration",
            "-of", "json", str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr.decode()[-400:])
    probed = json.loads(result.stdout)
    video = next(stream for stream in probed["streams"] if stream["codec_type"] == "video")
    num, den = video["r_frame_rate"].split("/")
    frame_s = int(den) / int(num)
    duration = float(video["duration"]) if video.get("duration") else float(probed["format"]["duration"])
    return duration, frame_s


def _prepare(source: Path) -> dict:
    try:
        return lib_audio.prepare_presentation(source)
    except lib_audio.AudioRejected as exc:
        raise AssertionError(f"prepare rejected {source.name}: {exc}") from exc


def _click_stats(source: Path, rate: int) -> tuple[float, float, float, float]:
    record = _prepare(source)
    pcm = lib_audio.presentation_pcm_path(source)
    samples = int(record["samples"])
    stereo = np.fromfile(pcm, dtype="<f4").reshape(-1, 2)
    if len(stereo) != samples:
        raise AssertionError(f"pcm samples {len(stereo)} != record {samples}")
    mono = abs(stereo).max(axis=1)
    peak = int(mono.argmax())
    expected = int(round(CLICK_T * lib_audio.SR))
    offset_ms = abs(peak - expected) / lib_audio.SR * 1000
    video_s, frame_s = _video_span(source)
    pcm_s = samples / lib_audio.SR
    print(
        f"CLICK_OFFSET rate={rate} offset_ms={offset_ms:.3f} amp={float(mono[peak]):.4f} "
        f"pcm_s={pcm_s:.6f} video_s={video_s:.6f}"
    )
    return offset_ms, float(mono[peak]), abs(pcm_s - video_s), frame_s


class PolicyTests(unittest.TestCase):
    def test_supported_rates_resample_and_others_reject(self) -> None:
        self.assertEqual(lib_audio.audio_rate_policy(48000), "native")
        for rate in SUPPORTED:
            if rate == 48000:
                continue
            with self.subTest(rate=rate):
                try:
                    got = lib_audio.audio_rate_policy(rate)
                except lib_audio.AudioRejected as exc:
                    self.fail(f"policy rejected {rate}: {exc}")
                self.assertEqual(got, "resample")
        for bad in (7350, 0, None, "44100", 44100.0, True):
            with self.subTest(bad=bad):
                with self.assertRaises(lib_audio.AudioRejected) as caught:
                    lib_audio.audio_rate_policy(bad)
                self.assertIn(f"refusing audio sample rate {bad}", str(caught.exception))


class ClickTests(unittest.TestCase):
    def test_44100_click_lands_within_one_frame(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "click44100.mkv"
            _write_click(source, 44100)
            offset_ms, amp, drift_s, frame_s = _click_stats(source, 44100)
            record = json.loads(lib_audio.presentation_meta_path(source).read_text())
            self.assertEqual(record["resampled_from"], 44100)
            self.assertGreater(amp, 0.2)
            self.assertLessEqual(offset_ms, OFFSET_LIMIT_MS)
            self.assertLessEqual(drift_s, frame_s)

    def test_resampled_rates_click_offset(self) -> None:
        for rate in (16000, 22050, 32000):
            with self.subTest(rate=rate):
                with tempfile.TemporaryDirectory() as tmp:
                    source = Path(tmp) / f"click{rate}.mkv"
                    _write_click(source, rate)
                    offset_ms, amp, drift_s, frame_s = _click_stats(source, rate)
                    self.assertGreater(amp, 0.2)
                    self.assertLessEqual(offset_ms, OFFSET_LIMIT_MS)
                    self.assertLessEqual(drift_s, frame_s)

    def test_aac_mp4_faststart_click_matches_source(self) -> None:
        for rate in (44100, 48000, 32000):
            with self.subTest(rate=rate):
                with tempfile.TemporaryDirectory() as tmp:
                    source = Path(tmp) / f"click{rate}.mp4"
                    _write_aac_click(source, rate)
                    blob = source.read_bytes()
                    self.assertLess(blob.find(b"moov"), blob.find(b"mdat"))
                    self.assertEqual(_audio_codec(source), "aac")
                    media_time = _audio_elst_media_time(blob)
                    skip_samples = _aac_skip_samples(source)
                    print(
                        f"AAC_PRIMING rate={rate} elst_media_time={media_time} "
                        f"skip_samples={skip_samples}"
                    )
                    self.assertIn(b"elst", blob[blob.find(b"moov"):blob.find(b"mdat")])
                    self.assertGreater(media_time, 0)
                    self.assertGreater(skip_samples, 0)
                    offset_ms, amp, drift_s, frame_s = _click_stats(source, rate)
                    self.assertGreater(amp, 0.2)
                    self.assertLessEqual(offset_ms, AAC_OFFSET_LIMIT_MS)
                    self.assertLessEqual(drift_s, frame_s)
                    record = json.loads(lib_audio.presentation_meta_path(source).read_text())
                    self.assertEqual(record["audio_stream"], "0:a:0")


class MultiTrackTests(unittest.TestCase):
    def test_prepare_decodes_a0_click_not_surround(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "multi.mkv"
            _ffmpeg(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", f"{_click_expr(48000)},aformat=channel_layouts=stereo",
                    "-f", "lavfi", "-i", "anullsrc=channel_layout=5.1:sample_rate=44100:duration=1.5",
                    "-f", "lavfi", "-i", f"testsrc=size=320x180:rate={FRAME_RATE}:duration={DURATION}",
                    "-map", "2:v:0", "-map", "0:a:0", "-map", "1:a:0",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30",
                    "-c:a:0", "pcm_s16le", "-c:a:1", "aac", "-ac:a:1", "6",
                    "-disposition:a:0", "0", "-disposition:a:1", "0",
                    str(source),
                ]
            )
            self.assertEqual(lib_audio.probe_audio_rate(source), 48000)
            self.assertEqual(lib_audio.audio_rate_policy(48000), "native")
            offset_ms, amp, _drift_s, _frame_s = _click_stats(source, 48000)
            record = json.loads(lib_audio.presentation_meta_path(source).read_text())
            self.assertIsNone(record["resampled_from"])
            self.assertGreater(amp, 0.2)
            self.assertLessEqual(offset_ms, OFFSET_LIMIT_MS)


class ReuseTests(unittest.TestCase):
    def _write_sine(self, path: Path, rate: int) -> None:
        _ffmpeg(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", f"testsrc=size=320x180:rate={FRAME_RATE}:duration=0.6",
                "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={rate}:duration=0.6",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-ar", str(rate), "-ac", "1",
                "-shortest", str(path),
            ]
        )

    def test_44100_second_prepare_reuses_without_decode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "tone44100.mp4"
            self._write_sine(source, 44100)
            first = _prepare(source)
            self.assertFalse(first.get("reused"))
            self.assertEqual(first["resampled_from"], 44100)
            self.assertEqual(first["audio_stream"], "0:a:0")
            with self.subTest(check="stored_input_rate"):
                self.assertEqual(first.get("input_rate"), 44100)
            calls: list[list[str]] = []
            real_run = subprocess.run

            def spy(cmd, *args, **kwargs):
                calls.append([str(part) for part in cmd])
                return real_run(cmd, *args, **kwargs)

            with patch("lib_audio.subprocess.run", side_effect=spy):
                second = lib_audio.prepare_presentation(source)
            self.assertTrue(second["reused"])
            self.assertEqual(second["resampled_from"], 44100)
            self.assertEqual(second["audio_stream"], "0:a:0")
            with self.subTest(check="no_probe"):
                self.assertFalse(any(cmd and cmd[0] == "ffmpeg" for cmd in calls))
                self.assertFalse(any(cmd and cmd[0] == "ffprobe" for cmd in calls))
            with self.subTest(check="reused_input_rate"):
                self.assertEqual(second.get("input_rate"), 44100)

    def test_old_resampled_from_16000_is_reused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "tone48000.mp4"
            self._write_sine(source, 48000)
            first = _prepare(source)
            self.assertIsNone(first["resampled_from"])
            meta = lib_audio.presentation_meta_path(source)
            pcm = lib_audio.presentation_pcm_path(source)
            base = json.loads(meta.read_text())
            stale = {
                "no_marker": {key: value for key, value in base.items() if key != "audio_stream"},
                "rate_mismatch": {**base, "audio_stream": "0:a:0", "resampled_from": 16000},
            }
            for name, record in stale.items():
                with self.subTest(case=name):
                    meta.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
                    pcm.write_bytes(b"\x00" * (int(record["samples"]) * 8))
                    calls: list[list[str]] = []
                    real_run = subprocess.run

                    def spy(cmd, *args, **kwargs):
                        calls.append([str(part) for part in cmd])
                        return real_run(cmd, *args, **kwargs)

                    with patch("lib_audio.subprocess.run", side_effect=spy):
                        second = lib_audio.prepare_presentation(source)
                    self.assertFalse(second.get("reused"))
                    self.assertTrue(any(cmd and cmd[0] == "ffmpeg" for cmd in calls))
                    self.assertEqual(second["audio_stream"], "0:a:0")
                    self.assertIsNone(second["resampled_from"])
                    self.assertTrue(any(pcm.read_bytes()))

    def test_new_style_record_reuses_when_probe_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "tone48000.mp4"
            self._write_sine(source, 48000)
            _prepare(source)
            meta = lib_audio.presentation_meta_path(source)
            pcm = lib_audio.presentation_pcm_path(source)
            record = json.loads(meta.read_text())
            record["audio_stream"] = "0:a:0"
            record["input_rate"] = 48000
            record["resampled_from"] = None
            meta.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
            original = pcm.read_bytes()
            cases = (
                ("rejected", lib_audio.AudioRejected("probe down")),
                ("timeout", subprocess.TimeoutExpired(["ffprobe", str(source)], 1)),
            )
            for name, exc in cases:
                with self.subTest(case=name):
                    with patch("lib_audio.probe_audio_rate", side_effect=exc):
                        try:
                            second = lib_audio.prepare_presentation(source)
                        except Exception as got:
                            self.fail(f"reuse called probe and raised {type(got).__name__}: {got}")
                    self.assertTrue(second["reused"])
                    self.assertEqual(second["input_rate"], 48000)
                    self.assertIsNone(second["resampled_from"])
                    self.assertEqual(second["audio_stream"], "0:a:0")
                    self.assertEqual(pcm.read_bytes(), original)

    def test_inconsistent_input_rate_is_rebuilt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "tone48000.mp4"
            self._write_sine(source, 48000)
            _prepare(source)
            meta = lib_audio.presentation_meta_path(source)
            pcm = lib_audio.presentation_pcm_path(source)
            record = json.loads(meta.read_text())
            record["audio_stream"] = "0:a:0"
            record["input_rate"] = 44100
            record["resampled_from"] = None
            meta.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
            pcm.write_bytes(b"\x00" * (int(record["samples"]) * 8))
            second = lib_audio.prepare_presentation(source)
            self.assertFalse(second.get("reused"))
            self.assertEqual(second["input_rate"], 48000)
            self.assertIsNone(second["resampled_from"])
            self.assertEqual(second["audio_stream"], "0:a:0")
            self.assertTrue(any(pcm.read_bytes()))


class RejectionTests(unittest.TestCase):
    def test_video_only_still_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "silent.mp4"
            _ffmpeg(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", f"testsrc=size=320x180:rate={FRAME_RATE}:duration=0.4",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an",
                    str(source),
                ]
            )
            with self.assertRaises(lib_audio.AudioRejected) as caught:
                lib_audio.prepare_presentation(source)
            self.assertIn("no decodable audio stream", str(caught.exception))

    def test_7350_prepare_is_409_audio_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            objects = root / "objects"
            objects.mkdir()
            key = f"owner/{VIDEO}/source/original.mp4"
            dest = objects / key
            dest.parent.mkdir(parents=True)
            encoded = root / "encoded.mp4"
            _ffmpeg(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", f"testsrc=size=320x180:rate={FRAME_RATE}:duration=0.6",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=7350:duration=0.6",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-video_track_timescale", "15360",
                    "-c:a", "aac", "-ar", "7350", "-ac", "1",
                    "-shortest", str(encoded),
                ]
            )
            dest.write_bytes(encoded.read_bytes())
            app = OriginApp(
                MemoryPublication(),
                LocalObjectStore(objects),
                root / "cache",
                GRANT,
                SERVICE,
                now=lambda: 1_000,
            )
            httpd = serve(app, "127.0.0.1", 0)
            try:
                base = f"http://127.0.0.1:{httpd.server_address[1]}"
                body = json.dumps({"sourceId": SOURCE, "sourceKey": key}).encode()
                path = f"/internal/sources/{VIDEO}/prepare"
                headers = {
                    "x-cap-origin-service": sign_request(SERVICE, "POST", path, body, now=1_000),
                    "Content-Type": "application/json",
                }
                request = urllib.request.Request(base + path, data=body, method="POST", headers=headers)
                try:
                    with urllib.request.urlopen(request) as response:
                        status, payload = response.status, response.read()
                except urllib.error.HTTPError as exc:
                    status, payload = exc.code, exc.read()
            finally:
                httpd.shutdown()
                httpd.server_close()
                lib_origin.reset_process_state()
                lib_audio.reset_aac_pool()
            self.assertEqual(status, 409, payload)
            self.assertIn(b"audio_rejected", payload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
