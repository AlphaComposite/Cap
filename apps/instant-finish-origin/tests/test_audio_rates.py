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


class MultiTrackTests(unittest.TestCase):
    def test_prepare_decodes_a0_click_not_surround(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "multi.mkv"
            # Neither audio stream is default, so an unmapped decode picks the 5.1 stream.
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
            with patch("lib_audio.subprocess.run") as run:
                second = lib_audio.prepare_presentation(source)
            self.assertTrue(second["reused"])
            self.assertEqual(second["resampled_from"], 44100)
            self.assertEqual(run.call_count, 0)

    def test_old_resampled_from_16000_is_reused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "tone48000.mp4"
            self._write_sine(source, 48000)
            first = _prepare(source)
            self.assertIsNone(first["resampled_from"])
            meta = lib_audio.presentation_meta_path(source)
            record = json.loads(meta.read_text())
            record["resampled_from"] = 16000
            meta.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
            with patch("lib_audio.subprocess.run") as run:
                second = lib_audio.prepare_presentation(source)
            self.assertTrue(second["reused"])
            self.assertEqual(second["resampled_from"], 16000)
            self.assertEqual(run.call_count, 0)


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
