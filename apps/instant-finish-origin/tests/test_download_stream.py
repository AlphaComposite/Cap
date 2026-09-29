"""Remux input is streamed so a background download holds one segment."""
from __future__ import annotations

import subprocess
import sys
import tempfile
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
