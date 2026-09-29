"""Origin latency and WebKit fragment-alignment contracts."""
from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import index as index_mod
import lib_audio
import lib_origin
import limits
import service_auth
from service_auth import sign_request

VECTORS = json.loads((Path(__file__).parent / "vectors" / "attestation.json").read_text())
SERVICE = b"service-token-service-token-svc01"


def _rate_48k_source() -> bytes:
    rate, channels, bits = 48000, 1, 16
    payload = b"\x00\x00" * 8
    fmt = struct.pack("<HHIIHH", 1, channels, rate, rate * channels * bits // 8, channels * bits // 8, bits)
    fmt_chunk = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    data_chunk = b"data" + struct.pack("<I", len(payload)) + payload
    body = b"WAVE" + fmt_chunk + data_chunk
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _synthetic_moof(durations: list[int]) -> bytes:
    def box(typ: bytes, payload: bytes) -> bytes:
        return (8 + len(payload)).to_bytes(4, "big") + typ + payload

    def fullbox(typ: bytes, flags: int, payload: bytes) -> bytes:
        return box(typ, bytes([0, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]) + payload)

    mfhd = fullbox(b"mfhd", 0, (1).to_bytes(4, "big"))
    tfhd = fullbox(b"tfhd", 0x020000, (1).to_bytes(4, "big"))
    payload = len(durations).to_bytes(4, "big") + (0).to_bytes(4, "big", signed=True)
    for dur in durations:
        payload += int(dur).to_bytes(4, "big") + (4).to_bytes(4, "big")
    trun = fullbox(b"trun", 0x000301, payload)
    moof = box(b"moof", mfhd + box(b"traf", tfhd + trun))
    mdat = box(b"mdat", b"abcd" * len(durations))
    return moof + mdat


class TfhdTests(unittest.TestCase):
    def test_default_duration_covers_the_longest_vfr_frame(self) -> None:
        payload = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + (512).to_bytes(4, "big") + (100).to_bytes(4, "big") + (0x01010000).to_bytes(4, "big")
        tfhd = (8 + 4 + len(payload)).to_bytes(4, "big") + b"tfhd" + bytes([0, 0x02, 0x00, 0x3A]) + payload
        patched = lib_origin._tfhd_default_duration(tfhd, 3072)
        self.assertEqual(int.from_bytes(patched[20:24], "big"), 3072)
        self.assertEqual(len(patched), len(tfhd))


class PlaylistTests(unittest.TestCase):
    def test_targetduration_is_ceil_of_extinf(self) -> None:
        ticks = 32384
        frame = lib_origin.FrameRec(0, 0, ticks, 0, 0)
        segment = lib_origin.Segment(0, (frame,), 0, ticks)
        text = lib_origin.playlist_text([segment], 15360)
        self.assertIn("#EXT-X-TARGETDURATION:3\n", text)
        self.assertIn("#EXTINF:", text)
        exact = lib_origin.Segment(0, (lib_origin.FrameRec(0, 0, 30720, 0, 0),), 0, 30720)
        exact_text = lib_origin.playlist_text([exact], 15360)
        self.assertIn("#EXT-X-TARGETDURATION:2\n", exact_text)


class AlignmentTests(unittest.TestCase):
    def test_vfr_segments_share_one_presentation_interval(self) -> None:
        tb = 15360
        ticks: list[int] = []
        durs: list[int] = []
        cursor = 0
        for index in range(420):
            dur = 512 if index % 3 else 640
            ticks.append(cursor)
            durs.append(dur)
            cursor += dur
        keyframes = [{"index": index, "pts": ticks[index]} for index in range(0, 420, 30)]
        ranges = [
            {"start": 0.04, "end": 1.25},
            {"start": 1.55, "end": 3.4},
            {"start": 4.1, "end": 6.35},
        ]
        segments = lib_origin.plan_segments(ranges, ticks, durs, tb, keyframes)
        timeline = lib_audio.plan_timeline(ranges, ticks, durs, tb)
        grid = lib_audio.assign_grid(segments, timeline)
        previous_end = None
        for segment, (j0, j1) in zip(segments, grid, strict=True):
            leading = segment.index == 0
            count = (j1 - j0) + (1 if leading else 0)
            tfdt, durations = lib_audio.align_audio_timing(
                count,
                leading=leading,
                video_start_ticks=segment.out_pts,
                video_duration_ticks=segment.duration_ticks,
                video_tb=tb,
            )
            kept = sum(durations)
            start = lib_audio.presentation_samples(segment.out_pts, tb)
            end = lib_audio.presentation_samples(segment.out_pts + segment.duration_ticks, tb)
            self.assertEqual(kept, end - start, segment.index)
            self.assertEqual(tfdt, start, segment.index)
            if previous_end is not None:
                self.assertEqual(tfdt, previous_end, segment.index)
            previous_end = tfdt + sum(durations)
            media = _synthetic_moof([frame.dur for frame in segment.frames])
            muxed = lib_audio.mux_audio(
                media,
                [b"\x00\x01"] * count,
                0,
                video_start_ticks=segment.out_pts,
                video_duration_ticks=segment.duration_ticks,
                video_tb=tb,
                leading=leading,
            )
            spans = lib_audio.fragment_track_spans(muxed)
            self.assertEqual(spans["video_ticks"], segment.duration_ticks)
            audio_s = spans["audio_samples"] / lib_audio.SR
            video_s = segment.duration_ticks / tb
            self.assertAlmostEqual(audio_s, video_s, places=6, msg=segment.index)
        text = lib_origin.playlist_text(segments, tb)
        target = int(text.split("TARGETDURATION:")[1].splitlines()[0])
        for line in text.splitlines():
            if line.startswith("#EXTINF:"):
                self.assertGreaterEqual(target, int(float(line.split(":")[1].rstrip(",")) + 0.999999))


class PresentationReuseTests(unittest.TestCase):
    def test_skips_decode_when_pcm_record_matches_source_sha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "original.mp4"
            source.write_bytes(_rate_48k_source())
            dest = lib_audio.presentation_pcm_path(source)
            dest.write_bytes(b"\x00" * 16)
            record = {
                "pcm": dest.name,
                "pcm_sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
                "prepare_ms": 12.5,
                "input_rate": 48000,
                "resampled_from": None,
                "samples": 2,
                "source": source.name,
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "audio_stream": "0:a:0",
            }
            lib_audio.presentation_meta_path(source).write_text(json.dumps(record))
            got = lib_audio.prepare_presentation(source)
            self.assertTrue(got["reused"])
            self.assertEqual(got["source_sha256"], record["source_sha256"])
            self.assertEqual(dest.read_bytes(), b"\x00" * 16)

    def test_mismatch_does_not_claim_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "original.mp4"
            source.write_bytes(b"source-bytes-not-a-real-mp4")
            dest = lib_audio.presentation_pcm_path(source)
            dest.write_bytes(b"\x00" * 16)
            record = {
                "pcm": dest.name,
                "pcm_sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
                "prepare_ms": 12.5,
                "resampled_from": None,
                "samples": 2,
                "source": source.name,
                "source_sha256": "0" * 64,
            }
            lib_audio.presentation_meta_path(source).write_text(json.dumps(record))
            with self.assertRaises(Exception):
                lib_audio.prepare_presentation(source)


class PrepareLabelTests(unittest.TestCase):
    def test_prepare_ms_source_names_the_mezzanine_build(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mezz = Path(tmp) / "mezz.mp4"
            mezz.write_bytes(b"mezz-bytes")
            sha = hashlib.sha256(mezz.read_bytes()).hexdigest()
            record = index_mod.write_keyframe_index(mezz, [{"index": 0, "pts": 0}], sha, 12.5)
            self.assertEqual(record["prepare_ms_source"], "mezzanine")
            self.assertEqual(record["keyframe_source"], "stss")
            rows, loaded = lib_origin.load_keyframes(mezz, sha)
            self.assertEqual(rows[0]["index"], 0)
            self.assertEqual(loaded["prepare_ms_source"], "mezzanine")

    def test_legacy_stss_label_still_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            mezz = Path(tmp) / "mezz.mp4"
            mezz.write_bytes(b"mezz-bytes")
            sha = hashlib.sha256(mezz.read_bytes()).hexdigest()
            rows = [{"index": 0, "pts": 0}]
            dest = mezz.with_suffix(".keyframes.json")
            dest.write_bytes(json.dumps(rows).encode())
            record = {
                "index": dest.name,
                "index_sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
                "keyframe_count": 1,
                "mezz": mezz.name,
                "mezz_sha256": sha,
                "prepare_ms": 1,
                "prepare_ms_source": "stss",
            }
            mezz.with_suffix(".prep.json").write_text(json.dumps(record))
            loaded_rows, loaded = lib_origin.load_keyframes(mezz, sha)
            self.assertEqual(loaded_rows, rows)
            self.assertEqual(loaded["prepare_ms_source"], "stss")


class ThreadTests(unittest.TestCase):
    def test_encoder_threads_follow_origin_cpus(self) -> None:
        with patch.dict(os.environ, {"ORIGIN_CPUS": "8"}):
            self.assertEqual(limits.origin_cpus(), 8)
            self.assertEqual(lib_origin.jit_options()["threads"], "8")
            self.assertEqual(lib_origin.jit_args(lib_origin.Profile(15360, 320, 180))[lib_origin.jit_args(lib_origin.Profile(15360, 320, 180)).index("-threads") + 1], "8")
            cmd = __import__("mezzanine").mezz_command(Path("in.mp4"), Path("out.mp4"), 15360)
            self.assertEqual(cmd[cmd.index("-threads") + 1], "8")
        with patch.dict(os.environ, {"ORIGIN_CPUS": "2"}):
            self.assertEqual(lib_origin.jit_options()["threads"], "2")
            cmd = __import__("mezzanine").mezz_command(Path("in.mp4"), Path("out.mp4"), 15360)
            self.assertEqual(cmd[cmd.index("-threads") + 1], "2")


class AttestationTests(unittest.TestCase):
    def test_shared_vector(self) -> None:
        secret = VECTORS["serviceSecret"].encode()
        body = VECTORS["body"].encode()
        self.assertEqual(service_auth.canonical_json(json.loads(VECTORS["body"])), body)
        self.assertEqual(service_auth.sign_attestation(secret, body), VECTORS["mac"])
        self.assertTrue(service_auth.verify_attestation(secret, VECTORS["mac"], body))
        flipped = bytearray(body)
        flipped[0] ^= 1
        self.assertFalse(service_auth.verify_attestation(secret, VECTORS["mac"], bytes(flipped)))
        self.assertEqual(VECTORS["header"], service_auth.ATTESTATION_HEADER)

    def test_request_mac_secret_signs_the_body(self) -> None:
        body = service_auth.canonical_json({"intentId": "abc", "ready": True})
        mac = service_auth.sign_attestation(SERVICE, body)
        token = sign_request(SERVICE, "POST", "/internal/revisions/revorigin01/prepare", b"{}", now=50)
        self.assertNotEqual(mac, token)
        self.assertTrue(service_auth.verify_attestation(SERVICE, mac, body))
        self.assertFalse(service_auth.verify_attestation(b"other-service-secret-other-service-1", mac, body))


if __name__ == "__main__":
    unittest.main(verbosity=2)
