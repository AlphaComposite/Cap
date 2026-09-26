"""Revision-scoped side artifacts must not cross owners or grants."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from server import (  # noqa: E402
    SideArtifactRejected,
    read_verified_side,
    write_signed_side,
)


class SideArtifactIsolationTests(unittest.TestCase):
    def test_two_revisions_keep_private_text_and_refuse_tamper(self) -> None:
        secret = b"service-token-service-token-svc01"
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            write_signed_side(secret, cache, "rev-owner-a", "captions.vtt", b"WEBVTT\n\nPRIVATE-A\n")
            write_signed_side(secret, cache, "rev-owner-a", "chapters.json", b'{"chapters":[{"title":"A"}]}\n')
            write_signed_side(secret, cache, "rev-owner-b", "captions.vtt", b"WEBVTT\n\nPRIVATE-B\n")
            write_signed_side(secret, cache, "rev-owner-b", "chapters.json", b'{"chapters":[{"title":"B"}]}\n')
            write_signed_side(secret, cache, "rev-owner-b", "captions.vtt", b"WEBVTT\n\nPRIVATE-B-AGAIN\n")
            self.assertIn(b"PRIVATE-A", read_verified_side(secret, cache, "rev-owner-a", "captions.vtt"))
            self.assertIn(b"PRIVATE-B-AGAIN", read_verified_side(secret, cache, "rev-owner-b", "captions.vtt"))
            self.assertNotIn(b"PRIVATE-B", read_verified_side(secret, cache, "rev-owner-a", "captions.vtt"))
            self.assertFalse((cache / "captions.vtt").exists())
            self.assertFalse((cache / "chapters.json").exists())
            tampered = cache / "revisions" / "rev-owner-a" / "captions.vtt"
            tampered.write_bytes(b"WEBVTT\n\nTAMPERED\n")
            with self.assertRaises(SideArtifactRejected):
                read_verified_side(secret, cache, "rev-owner-a", "captions.vtt")
            self.assertEqual(
                json.loads((cache / "revisions" / "rev-owner-b" / "chapters.json").read_text())["chapters"][0]["title"],
                "B",
            )
            digest = hashlib.sha256(b"WEBVTT\n\nPRIVATE-A\n").hexdigest()
            attestation = json.loads((cache / "revisions" / "rev-owner-a" / "captions.vtt.attestation.json").read_text())
            self.assertIn(digest, attestation["body"])


if __name__ == "__main__":
    unittest.main()
