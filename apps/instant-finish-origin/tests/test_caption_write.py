"""Caption-only signed write. Synthetic VTT, not owner media."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from publication import MemoryPublication
from server import OriginApp
from storage import LocalObjectStore

SERVICE = b"service-token-service-token-svc01"
GRANT = b"grant-secret-grant-secret-grant-01"
VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsynthetic-hello\n"


class CaptionWriteTest(unittest.TestCase):
    def test_signed_caption_write_readback_does_not_prepare_media(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        app = OriginApp(
            MemoryPublication(),
            LocalObjectStore(root / "objects"),
            root / "cache",
            GRANT,
            SERVICE,
        )
        status, body, _content_type, _headers = app._write_captions(
            "revcaption01",
            {"_body": json.dumps({"captionsVtt": VTT}).encode()},
        )
        self.assertEqual(status, 400)
        self.assertFalse((root / "cache" / "revisions" / "revcaption01" / "captions.vtt").exists())
        self.assertEqual(app.download_builds, 0)
        header = app._write_captions(
            "revcaption01",
            {"_body": json.dumps({"captionsVtt": "WEBVTT\n"}).encode()},
        )
        self.assertEqual(header[0], 400)
