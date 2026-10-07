"""Editor waveform peaks: reducer, header, and the internal producer."""

from __future__ import annotations

import base64
import hashlib
import json
import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import lib_audio
import service_auth
from publication import MemoryPublication, SourceRow
from server import OriginApp
from storage import LocalObjectStore


SHA = "ab" * 32
VIDEO = "vidorigin01"
KEY = f"private/source/{VIDEO}/original"
SERVICE = b"s" * 32
GRANT = b"g" * 32


WINDOW_SAMPLES = 48_010
TAIL_SAMPLES = 4_176
DECLARED_SOURCE_SECONDS = WINDOW_SAMPLES / 48_000
SHORT_FRAMES = 490
SHORT_WINDOW_SAMPLES = 1_440
SHORT_SOURCE_SECONDS = SHORT_WINDOW_SAMPLES / 48_000


def _duration_rejected(pair_count: int, source_seconds: float) -> bool:
    return abs(pair_count - source_seconds * 100) > 0.05 * 100 + 1


def _pair_count(body: bytes) -> int:
    return struct.unpack_from("<I", body, 14)[0]


def _pairs(body: bytes) -> list[tuple[int, int]]:
    count = _pair_count(body)
    raw = body[64 : 64 + count * 2]
    return list(zip(raw[0::2], raw[1::2], strict=True))


def _windowed(source: Path, source_seconds: float) -> bytes:
    try:
        return lib_audio.reduce_presentation_peaks(
            source, SHA, source_duration=source_seconds
        )
    except TypeError as exc:
        if "source_duration" not in str(exc):
            raise
        raw = lib_audio.reduce_presentation_peaks(source, SHA)
        count = _pair_count(raw)
        raise AssertionError(
            f"reducer has no source presentation window; raw pair count {count} is the rejected old count"
        ) from exc


def _pcm(frames: int, fill) -> tuple[Path, tempfile.TemporaryDirectory]:
    tmp = tempfile.TemporaryDirectory()
    source = Path(tmp.name) / "original.mp4"
    source.write_bytes(b"not-a-real-mp4")
    pcm = source.with_suffix(source.suffix + ".ppcm")
    stereo = np.zeros((frames, 2), np.float32)
    fill(stereo)
    stereo.astype("<f4").tofile(pcm)
    meta = {
        "pcm_sha256": hashlib.sha256(pcm.read_bytes()).hexdigest(),
        "samples": frames,
        "source_sha256": SHA,
        "audio_stream": "0:a:0",
        "input_rate": 48000,
        "resampled_from": None,
    }
    source.with_suffix(source.suffix + ".ppcm.json").write_text(json.dumps(meta))
    return source, tmp


class ReducerTests(unittest.TestCase):
    def test_header_partial_tail_and_10ms_spike(self) -> None:
        frames = 480 + 10

        def fill(stereo: np.ndarray) -> None:
            stereo[480:490, 0] = 1.0
            stereo[480:490, 1] = 1.0

        source, tmp = _pcm(frames, fill)
        try:
            body = lib_audio.reduce_presentation_peaks(source, SHA)
        finally:
            tmp.cleanup()
        self.assertEqual(body[:5], b"CAPW1")
        self.assertEqual(body[5], 1)
        self.assertEqual(body[6], 0)
        self.assertEqual(body[7], 100)
        rate, samples, count = struct.unpack_from("<IHI", body, 8)
        self.assertEqual((rate, samples, count), (48000, 480, 2))
        self.assertEqual(body[18:50], bytes.fromhex(SHA))
        self.assertEqual(body[50:64], b"\x00" * 14)
        self.assertEqual(body[64:66], bytes([0, 0]))
        self.assertEqual(list(body[66:68]), [127, 127])

    def test_silence_and_non_finite_are_zero_and_quiet_voice_survives(self) -> None:
        self.assertEqual(lib_audio.quantize_peak_sample(0.0), 0)
        self.assertEqual(lib_audio.quantize_peak_sample(float("nan")), 0)
        self.assertEqual(lib_audio.quantize_peak_sample(float("inf")), 0)
        quiet = 10 ** (-50 / 20)
        self.assertGreater(lib_audio.quantize_peak_sample(quiet), 0)
        self.assertEqual(lib_audio.quantize_peak_sample(-(10 ** (-70 / 20))), 0)
        self.assertEqual(lib_audio.quantize_peak_sample(1.0), 127)
        self.assertEqual(lib_audio.quantize_peak_sample(-1.0), -127)

    def test_reduction_reads_bounded_chunks(self) -> None:
        frames = 480 * 4

        def fill(stereo: np.ndarray) -> None:
            stereo[:, 0] = 0.25
            stereo[:, 1] = 0.25

        source, tmp = _pcm(frames, fill)
        spans: list[int] = []
        real = np.memmap

        class Tracking(np.memmap):
            def __getitem__(self, item):
                if isinstance(item, slice):
                    start = 0 if item.start is None else int(item.start)
                    stop = int(self.shape[0] if item.stop is None else item.stop)
                    spans.append(stop - start)
                return super().__getitem__(item)

        try:
            with patch("numpy.memmap", Tracking):
                body = lib_audio.reduce_presentation_peaks(source, SHA, chunk_frames=480)
        finally:
            tmp.cleanup()
        self.assertEqual(len(body), 64 + 8)
        self.assertTrue(spans)
        self.assertLessEqual(max(spans), 480 * 2)
        self.assertIs(real, np.memmap)

    def test_87ms_tail_beyond_declared_source_is_not_in_the_final_bucket(self) -> None:
        frames = WINDOW_SAMPLES + TAIL_SAMPLES

        def fill(stereo: np.ndarray) -> None:
            stereo[0, :] = 1.0
            stereo[48_000:WINDOW_SAMPLES, :] = 1.0
            stereo[WINDOW_SAMPLES : WINDOW_SAMPLES + 8, :] = -1.0

        source, tmp = _pcm(frames, fill)
        pcm = source.with_suffix(source.suffix + ".ppcm")
        try:
            before = (
                pcm.stat().st_size,
                pcm.stat().st_mtime_ns,
                hashlib.sha256(pcm.read_bytes()).hexdigest(),
            )
            raw = lib_audio.reduce_presentation_peaks(source, SHA)
            old_count = _pair_count(raw)
            expected = math.ceil(WINDOW_SAMPLES / 480)
            self.assertTrue(
                _duration_rejected(old_count, DECLARED_SOURCE_SECONDS),
                msg=f"old count {old_count} was not rejected",
            )
            stops: list[int] = []

            class Tracking(np.memmap):
                def __getitem__(self, item):
                    if isinstance(item, slice) and item.stop is not None:
                        stops.append(int(item.stop))
                    return super().__getitem__(item)

            with patch("numpy.memmap", Tracking):
                body = _windowed(source, DECLARED_SOURCE_SECONDS)
            after = (
                pcm.stat().st_size,
                pcm.stat().st_mtime_ns,
                hashlib.sha256(pcm.read_bytes()).hexdigest(),
            )
        finally:
            tmp.cleanup()
        self.assertEqual(
            _pair_count(body),
            expected,
            msg=f"rejected old count {old_count} was not clipped to the source window",
        )
        self.assertNotEqual(old_count, expected)
        pairs = _pairs(body)
        self.assertEqual(pairs[0], (0, 127))
        self.assertEqual(pairs[100], (127, 127))
        self.assertNotIn((129, 127), pairs)
        self.assertTrue(stops)
        self.assertLessEqual(max(stops), WINDOW_SAMPLES * 2)
        self.assertEqual(after, before)


class ProducerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "cache"
        self.objects = Path(self.tmp.name) / "objects"
        self.objects.mkdir()
        self.store = MemoryPublication()
        self.store.sources[VIDEO] = SourceRow(VIDEO, KEY, SHA, "PURGED")
        self.app = OriginApp(
            self.store,
            LocalObjectStore(self.objects),
            self.cache,
            GRANT,
            SERVICE,
            now=lambda: 1_000,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _post(self, body: dict, *, signed: bool = True, path: str | None = None):
        raw = json.dumps(body).encode()
        route = path or f"/internal/sources/{VIDEO}/peaks"
        headers = {"_body": raw}
        if signed:
            headers["x-cap-origin-service"] = service_auth.sign_request(
                SERVICE, "POST", route, raw, now=1_000
            )
        return self.app.handle("POST", route, headers)

    def test_registered_private_live_key_is_admitted_and_stale_keys_are_not(self) -> None:
        live = f"private/source/{VIDEO}/legacy-a1"
        source = Path(self.tmp.name) / "original.mp4"
        source.write_bytes(b"source-bytes")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        pcm = source.with_suffix(".mp4.ppcm")
        stereo = np.ones((480, 2), np.float32)
        stereo.astype("<f4").tofile(pcm)
        meta = {
            "pcm_sha256": hashlib.sha256(pcm.read_bytes()).hexdigest(),
            "samples": 480,
            "source_sha256": digest,
            "audio_stream": "0:a:0",
            "input_rate": 48000,
            "resampled_from": None,
        }
        source.with_suffix(".mp4.ppcm.json").write_text(json.dumps(meta))
        self.store.sources[VIDEO] = SourceRow(VIDEO, live, digest, "PURGED")
        other = "vidorigin02"
        self.store.sources[other] = SourceRow(
            other, f"private/source/{other}/legacy-b2", "cd" * 32, "PURGED"
        )
        body = {"sourceId": "src", "sourceKey": live, "sourceSha256": digest}
        with patch.object(self.app, "_materialize_original", return_value=source), patch(
            "subprocess.run", side_effect=AssertionError("ffmpeg")
        ):
            status, raw, _, _ = self._post(body)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["audio"], "peaks")
        self.assertNotIn(b"source_key_mismatch", raw)
        stale = {"sourceId": "src", "sourceKey": KEY, "sourceSha256": digest}
        status, raw, _, _ = self._post(stale)
        self.assertEqual(status, 409)
        self.assertIn(b"source_key_mismatch", raw)
        wrong_sha = {"sourceId": "src", "sourceKey": live, "sourceSha256": "cd" * 32}
        status, raw, _, _ = self._post(wrong_sha)
        self.assertEqual(status, 409)
        self.assertIn(b"source_key_mismatch", raw)
        status, raw, _, _ = self._post(
            {"sourceId": "src", "sourceKey": live, "sourceSha256": digest},
            path=f"/internal/sources/{other}/peaks",
        )
        self.assertEqual(status, 409)
        self.assertIn(b"source_key_mismatch", raw)

    def test_unsigned_and_wrong_key_are_refused(self) -> None:
        status, body, _, _ = self._post({"sourceId": "src", "sourceKey": KEY, "sourceSha256": SHA}, signed=False)
        self.assertEqual(status, 401)
        status, body, _, _ = self._post(
            {"sourceId": "src", "sourceKey": "owner/video/result.mp4", "sourceSha256": SHA}
        )
        self.assertEqual(status, 409)
        self.assertIn(b"source_key_mismatch", body)

    def test_reuse_does_not_decode_again_and_cold_calls_prepare_once(self) -> None:
        source = Path(self.tmp.name) / "original.mp4"
        source.write_bytes(b"source-bytes")
        pcm = source.with_suffix(".mp4.ppcm")
        stereo = np.zeros((480, 2), np.float32)
        stereo[:, :] = 1.0
        stereo.astype("<f4").tofile(pcm)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        meta = {
            "pcm_sha256": hashlib.sha256(pcm.read_bytes()).hexdigest(),
            "samples": 480,
            "source_sha256": digest,
            "audio_stream": "0:a:0",
            "input_rate": 44100,
            "resampled_from": 44100,
        }
        source.with_suffix(".mp4.ppcm.json").write_text(json.dumps(meta))
        self.store.sources[VIDEO] = SourceRow(VIDEO, KEY, digest, "PURGED")
        calls = {"prepare": 0, "ffmpeg": 0}

        def prepare(path: Path) -> dict:
            calls["prepare"] += 1
            raise AssertionError("reuse must not prepare")

        with patch.object(self.app, "_materialize_original", return_value=source), patch.object(
            lib_audio, "prepare_presentation", side_effect=prepare
        ), patch("subprocess.run", side_effect=AssertionError("ffmpeg")):
            status, raw, _, headers = self._post(
                {"sourceId": "src", "sourceKey": KEY, "sourceSha256": digest}
            )
        self.assertEqual(status, 200)
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        payload = json.loads(raw)
        self.assertEqual(payload["audio"], "peaks")
        decoded = base64.b64decode(payload["peaks"])
        self.assertEqual(hashlib.sha256(decoded).hexdigest(), payload["peaksSha256"])
        self.assertEqual(decoded[64:66], bytes([127, 127]))
        self.assertEqual(struct.unpack_from("<I", decoded, 8)[0], 48000)
        self.assertEqual(calls["prepare"], 0)

        source.with_suffix(".mp4.ppcm").unlink()

        def present(_source: Path) -> str:
            return "present"

        def cold(path: Path) -> dict:
            calls["prepare"] += 1
            stereo.astype("<f4").tofile(pcm)
            source.with_suffix(".mp4.ppcm.json").write_text(json.dumps(meta))
            return meta

        with patch.object(self.app, "_materialize_original", return_value=source), patch.object(
            lib_audio, "audio_track_status", side_effect=present
        ), patch.object(lib_audio, "prepare_presentation", side_effect=cold):
            status, raw, _, _ = self._post(
                {"sourceId": "src", "sourceKey": KEY, "sourceSha256": digest}
            )
        self.assertEqual(status, 200)
        self.assertEqual(calls["prepare"], 1)
        self.assertEqual(json.loads(raw)["audio"], "peaks")

    def test_absent_track_is_a_sentinel_and_unsupported_rate_is_not(self) -> None:
        source = Path(self.tmp.name) / "silent.mp4"
        source.write_bytes(b"silent")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        self.store.sources[VIDEO] = SourceRow(VIDEO, KEY, digest, "PURGED")

        def absent(_source: Path) -> str:
            return "absent"

        with patch.object(self.app, "_materialize_original", return_value=source), patch.object(
            lib_audio, "audio_track_status", side_effect=absent
        ), patch.object(lib_audio, "prepare_presentation", side_effect=AssertionError("decode")):
            status, raw, _, _ = self._post(
                {"sourceId": "src", "sourceKey": KEY, "sourceSha256": digest}
            )
        self.assertEqual(status, 200)
        payload = json.loads(raw)
        self.assertEqual(payload["audio"], "none")
        decoded = base64.b64decode(payload["peaks"])
        self.assertEqual(len(decoded), 64)
        self.assertEqual(decoded[6], 1)
        self.assertEqual(struct.unpack_from("<I", decoded, 14)[0], 0)

        def rejected(_source: Path) -> str:
            raise lib_audio.AudioRejected("refusing audio sample rate 7350")

        with patch.object(self.app, "_materialize_original", return_value=source), patch.object(
            lib_audio, "audio_track_status", side_effect=rejected
        ):
            status, raw, _, _ = self._post(
                {"sourceId": "src", "sourceKey": KEY, "sourceSha256": digest}
            )
        self.assertEqual(status, 409)
        self.assertIn(b"audio_rejected", raw)
        self.assertNotIn(b"none", raw)

    def test_same_length_corrupt_pcm_cannot_return_peaks(self) -> None:
        source = Path(self.tmp.name) / "original.mp4"
        source.write_bytes(b"source-bytes")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        pcm = source.with_suffix(".mp4.ppcm")
        stereo = np.ones((480, 2), np.float32)
        stereo.astype("<f4").tofile(pcm)
        meta = {
            "pcm_sha256": hashlib.sha256(pcm.read_bytes()).hexdigest(),
            "samples": 480,
            "source_sha256": digest,
            "audio_stream": "0:a:0",
            "input_rate": 48000,
            "resampled_from": None,
        }
        source.with_suffix(".mp4.ppcm.json").write_text(json.dumps(meta))
        mutated = bytearray(pcm.read_bytes())
        mutated[0] ^= 0xFF
        self.assertEqual(len(mutated), 480 * 8)
        pcm.write_bytes(mutated)
        self.store.sources[VIDEO] = SourceRow(VIDEO, KEY, digest, "PURGED")
        with patch.object(self.app, "_materialize_original", return_value=source), patch(
            "subprocess.run", side_effect=AssertionError("ffmpeg")
        ):
            status, raw, _, _ = self._post(
                {"sourceId": "src", "sourceKey": KEY, "sourceSha256": digest}
            )
        self.assertNotEqual(status, 200)
        self.assertNotIn(b'"peaks"', raw)

    def _install_pcm(self, frames: int, fill) -> tuple[Path, str]:
        source = Path(self.tmp.name) / "original.mp4"
        source.write_bytes(b"source-bytes")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        pcm = source.with_suffix(".mp4.ppcm")
        stereo = np.zeros((frames, 2), np.float32)
        fill(stereo)
        stereo.astype("<f4").tofile(pcm)
        meta = {
            "pcm_sha256": hashlib.sha256(pcm.read_bytes()).hexdigest(),
            "samples": frames,
            "source_sha256": digest,
            "audio_stream": "0:a:0",
            "input_rate": 48000,
            "resampled_from": None,
        }
        source.with_suffix(".mp4.ppcm.json").write_text(json.dumps(meta))
        self.store.sources[VIDEO] = SourceRow(VIDEO, KEY, digest, "PURGED")
        return source, digest

    def _decoded_pairs(self, raw: bytes) -> list[tuple[int, int]]:
        payload = json.loads(raw)
        return _pairs(base64.b64decode(payload["peaks"]))

    def test_endpoint_forwards_validated_full_source_window(self) -> None:
        def fill(stereo: np.ndarray) -> None:
            stereo[0, :] = 1.0
            stereo[48_000:WINDOW_SAMPLES, :] = 1.0
            stereo[WINDOW_SAMPLES : WINDOW_SAMPLES + 8, :] = -1.0

        source, digest = self._install_pcm(WINDOW_SAMPLES + TAIL_SAMPLES, fill)
        body = {"sourceId": "src", "sourceKey": KEY, "sourceSha256": digest}
        with patch.object(self.app, "_materialize_original", return_value=source), patch(
            "subprocess.run", side_effect=AssertionError("ffmpeg")
        ), patch.object(lib_audio, "prepare_presentation", side_effect=AssertionError("decode")):
            omitted_status, omitted_raw, _, _ = self._post(body)
            status, raw, _, _ = self._post({**body, "sourceDuration": DECLARED_SOURCE_SECONDS})
        self.assertEqual(omitted_status, 200)
        omitted = self._decoded_pairs(omitted_raw)
        self.assertTrue(_duration_rejected(len(omitted), DECLARED_SOURCE_SECONDS))
        self.assertEqual(status, 200, msg=raw)
        payload = json.loads(raw)
        self.assertEqual(payload["audio"], "peaks")
        self.assertEqual(payload["sourceSha256"], digest)
        pairs = self._decoded_pairs(raw)
        self.assertEqual(
            len(pairs),
            math.ceil(WINDOW_SAMPLES / 480),
            msg=f"rejected old count {len(omitted)} was forwarded instead of the source window",
        )
        self.assertEqual(pairs[0], (0, 127))
        self.assertEqual(pairs[100], (127, 127))
        self.assertNotIn((129, 127), pairs)

    def test_short_audio_flat_tail_keeps_spike_alignment_and_pcm(self) -> None:
        def fill(stereo: np.ndarray) -> None:
            stereo[5, :] = 1.0
            stereo[485, :] = 1.0

        source, digest = self._install_pcm(SHORT_FRAMES, fill)
        pcm = source.with_suffix(".mp4.ppcm")
        meta = source.with_suffix(".mp4.ppcm.json")
        before = (
            pcm.stat().st_size,
            pcm.stat().st_mtime_ns,
            hashlib.sha256(pcm.read_bytes()).hexdigest(),
            hashlib.sha256(meta.read_bytes()).hexdigest(),
        )
        body = {
            "sourceId": "src",
            "sourceKey": KEY,
            "sourceSha256": digest,
            "sourceDuration": SHORT_SOURCE_SECONDS,
        }
        prepares = {"n": 0}

        def prepare(_path: Path) -> dict:
            prepares["n"] += 1
            raise AssertionError("decode")

        with patch.object(self.app, "_materialize_original", return_value=source), patch.object(
            lib_audio, "prepare_presentation", side_effect=prepare
        ), patch("subprocess.run", side_effect=AssertionError("ffmpeg")):
            first_status, first_raw, _, _ = self._post(body)
            second_status, second_raw, _, _ = self._post(body)
        self.assertEqual(first_status, 200, msg=first_raw)
        self.assertEqual(second_status, 200, msg=second_raw)
        pairs = self._decoded_pairs(first_raw)
        self.assertEqual(
            pairs,
            [(0, 127), (0, 127), (0, 0)],
            msg="short audio was retimed instead of ending in a flat source-window tail",
        )
        self.assertEqual(self._decoded_pairs(second_raw), pairs)
        self.assertEqual(prepares["n"], 0)
        self.assertEqual(
            (
                pcm.stat().st_size,
                pcm.stat().st_mtime_ns,
                hashlib.sha256(pcm.read_bytes()).hexdigest(),
                hashlib.sha256(meta.read_bytes()).hexdigest(),
            ),
            before,
        )

    def test_invalid_source_duration_is_rejected_without_decode(self) -> None:
        source, digest = self._install_pcm(480, lambda stereo: None)
        body = {"sourceId": "src", "sourceKey": KEY, "sourceSha256": digest}
        bad = (
            True,
            False,
            "142.933",
            "20",
            float("nan"),
            float("inf"),
            float("-inf"),
            0,
            -0.0,
            -1,
            14_400.001,
            14_401,
            None,
        )
        with patch.object(
            self.app, "_materialize_original", side_effect=AssertionError("materialize")
        ) as materialize, patch("subprocess.run", side_effect=AssertionError("ffmpeg")), patch.object(
            lib_audio, "prepare_presentation", side_effect=AssertionError("decode")
        ):
            for value in bad:
                with self.subTest(value=value):
                    status, raw, _, _ = self._post({**body, "sourceDuration": value})
                    self.assertEqual(status, 400, msg=f"{value!r} -> {status} {raw!r}")
                    self.assertNotIn(b'"peaks"', raw)
            self.assertEqual(materialize.call_count, 0)


if __name__ == "__main__":
    unittest.main()
