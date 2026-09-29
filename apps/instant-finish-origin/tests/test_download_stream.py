"""Remux input is streamed so a background download holds one segment."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import cast
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import grant as grant_mod
import lib_origin
import server
from server import _without_styp, remux_download


class Tracked(bytes):
    live = 0
    peak = 0

    def __new__(cls, data: bytes):
        obj = bytes.__new__(cls, data)
        cls.live += 1
        cls.peak = max(cls.peak, cls.live)
        return obj

    def __del__(self) -> None:
        type(self).live -= 1


class StreamRemuxTests(unittest.TestCase):
    def test_remux_holds_one_segment_and_matches_joined_input(self) -> None:
        payloads = [b"init-box-bytes"] + [bytes([index + 1]) * 48 for index in range(4)]
        styp = b"\x00\x00\x00\x0cstyp" + b"isom"
        produced = [payloads[0], styp + payloads[1], *payloads[2:]]
        expected = b"".join(_without_styp(part) for part in produced)
        captured: dict[str, bytes] = {}
        Tracked.live = 0
        Tracked.peak = 0

        class Origin:
            def __init__(self, cache: Path) -> None:
                self.cache = cache
                self.segments = produced[1:]

            def playback_waiting(self) -> bool:
                return False

            def read_init_for_download(self) -> bytes:
                return Tracked(produced[0])

            def read_segment_for_download(self, index: int) -> bytes:
                return Tracked(produced[index + 1])

            def ensure_init(self) -> bytes:
                return Tracked(produced[0])

            def ensure(self, index: int) -> bytes:
                return Tracked(produced[index + 1])

        slot = lib_origin.EncodeSlot("vidstream01", "download:rev", "revstream01")

        def fake_run(cmd, *_args, **_kwargs):
            input_at = cmd.index("-i") + 1
            captured["input"] = Path(cmd[input_at]).read_bytes()
            Path(cmd[-1]).write_bytes(b"remuxed-ok")
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with tempfile.TemporaryDirectory() as tmp:
            origin = Origin(Path(tmp))
            with patch.object(server.limits, "run_cmd", fake_run):
                remux_download(cast(lib_origin.Origin, origin), slot)
            self.assertTrue((Path(tmp) / "download.mp4").is_file())
            self.assertFalse(list(Path(tmp).glob(".download-*")))

        self.assertEqual(captured["input"], expected)
        self.assertLessEqual(Tracked.peak, 1)
        self.assertEqual(Tracked.live, 0)

    def test_download_build_does_not_grow_segment_cache(self) -> None:
        count = 4
        playback_kept = b"playback-kept-segment"

        def fake_run(cmd, *_args, **_kwargs):
            Path(cmd[-1]).write_bytes(b"remuxed-ok")
            return subprocess.CompletedProcess(cmd, 0, b"", b"")

        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            origin = object.__new__(lib_origin.Origin)
            origin.cache = cache
            origin.segments = list(range(count))
            origin._segment_bytes = {}
            origin._lock = threading.Lock()
            origin._playback_lock = threading.Lock()
            origin._playback_waiting = 0
            origin._init_bytes = None
            origin._init_avcc = None
            origin._served_body = b""
            origin._last_produce = None
            origin.productions = []
            origin.init_path = cache / "init.mp4"
            payload = b"avcC" + b"\x01" * 8
            origin.init_path.write_bytes((4 + len(payload)).to_bytes(4, "big") + payload)
            seg0 = origin.segment_path(0)
            seg0.parent.mkdir(parents=True, exist_ok=True)
            seg0.write_bytes(playback_kept)
            lib_origin.sidecar_path(seg0).write_text("{}\n")
            origin._segment_bytes[0] = playback_kept
            before = len(origin._segment_bytes)

            def produce(index: int):
                body = bytes([index + 1]) * 24
                path = origin.segment_path(index)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
                lib_origin.sidecar_path(path).write_text("{}\n")
                origin._segment_bytes[index] = body
                origin._served_body = body
                origin._last_produce = {}
                if origin._init_bytes is None:
                    origin._init_bytes = origin.init_path.read_bytes()
                return body, 0.0

            origin.produce = produce
            origin._read_bound = lambda path, _artifact, _seg: path.read_bytes()
            origin._record = lambda *_args, **_kwargs: None
            slot = lib_origin.EncodeSlot("vidcache01", "download:rev", "revcache01")
            lib_origin.bind_encode_slot(slot)
            try:
                with patch.object(server.limits, "run_cmd", fake_run):
                    remux_download(cast(lib_origin.Origin, origin), slot)
            finally:
                lib_origin.bind_encode_slot(None)
                slot.finish()
            self.assertEqual(len(origin._segment_bytes), before)
            self.assertIs(origin._segment_bytes.get(0), playback_kept)
            self.assertEqual(set(origin._segment_bytes), {0})
            played = origin.ensure(1)
            self.assertEqual(played, bytes([2]) * 24)
            self.assertIn(1, origin._segment_bytes)


class CachedDownloadRepairTests(unittest.TestCase):
    def _origin(self, cache: Path) -> lib_origin.Origin:
        origin = object.__new__(lib_origin.Origin)
        origin.cache = cache
        origin.segments = [0]
        origin.encoder_hash = "enc"
        origin.namespace = "ns"
        origin.rev = "rev"
        origin.mezz_sha256 = "mezz"
        origin._segment_bytes = {}
        origin._lock = threading.Lock()
        origin._playback_lock = threading.Lock()
        origin._playback_waiting = 0
        origin._init_bytes = None
        origin._init_avcc = None
        origin._served_body = b""
        origin._last_produce = {}
        origin.productions = []
        origin.init_path = cache / "init.mp4"
        origin._record = lambda *_args, **_kwargs: None
        return origin

    def test_corrupt_cached_segment_is_regenerated_for_download(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            origin = self._origin(Path(tmp))
            produced: list[int] = []

            def produce(index: int):
                body = b"regenerated-segment"
                path = origin.segment_path(index)
                path.parent.mkdir(parents=True, exist_ok=True)
                origin._write_bound(path, body, "seg", index)
                origin._segment_bytes[index] = body
                origin._served_body = body
                produced.append(index)
                return body, 0.0

            origin.produce = produce
            path = origin.segment_path(0)
            path.parent.mkdir(parents=True, exist_ok=True)
            origin._write_bound(path, b"original-segment", "seg", 0)
            origin._segment_bytes[0] = b"original-segment"
            path.write_bytes(b"corrupt-segment")
            body = origin.read_segment_for_download(0)
            self.assertEqual(body, b"regenerated-segment")
            self.assertEqual(produced, [0])
            self.assertEqual(path.read_bytes(), b"regenerated-segment")

    def test_corrupt_cached_init_is_regenerated_for_download(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            origin = self._origin(Path(tmp))
            produced: list[int] = []

            def produce(index: int):
                body = b"regenerated-init"
                origin._write_bound(origin.init_path, body, "init", None)
                origin._init_bytes = body
                origin._init_avcc = b"avcc"
                origin._served_body = body
                produced.append(index)
                return body, 0.0

            origin.produce = produce
            origin._write_bound(origin.init_path, b"original-init", "init", None)
            origin._init_bytes = b"original-init"
            origin.init_path.write_bytes(b"corrupt-init")
            body = origin.read_init_for_download()
            self.assertEqual(body, b"regenerated-init")
            self.assertEqual(produced, [0])
            self.assertEqual(origin.init_path.read_bytes(), b"regenerated-init")


class GrantTtlTests(unittest.TestCase):
    def test_download_grant_lasts_thirty_minutes_and_playback_stays_sixty(self) -> None:
        secret = b"grant-secret-grant-secret-grant-01"
        now = 1_000
        playback = {
            "v": 1,
            "videoId": "vidorigin01",
            "revisionId": "revorigin01",
            "publicationEpoch": 2,
            "policyEpoch": 3,
            "iat": now,
            "exp": now + 60,
            "grantId": "grant-origin-0001",
        }
        download = {
            **playback,
            "artifact": "download",
            "exp": now + 30 * 60,
            "grantId": "grant-download-01",
        }
        self.assertEqual(grant_mod.ttl_for(None), 60)
        self.assertEqual(grant_mod.ttl_for("download"), 30 * 60)
        playback_token = grant_mod.mint(secret, playback)
        download_token = grant_mod.mint(secret, download)
        self.assertEqual(grant_mod.verify(secret, playback_token, now=now).exp - now, 60)
        parsed = grant_mod.verify(secret, download_token, now=now + 120)
        self.assertEqual(parsed.artifact, "download")
        self.assertEqual(parsed.exp - parsed.iat, 30 * 60)
        with self.assertRaises(grant_mod.GrantError):
            grant_mod.verify(secret, download_token, now=now + 30 * 60 + 6)
        short = {**download, "exp": now + 60}
        with self.assertRaises(grant_mod.GrantError):
            grant_mod.mint(secret, short)


if __name__ == "__main__":
    unittest.main(verbosity=2)
