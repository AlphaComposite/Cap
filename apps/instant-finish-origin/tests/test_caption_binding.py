from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from publication import MemoryPublication, PublicationRow, RevisionRow, SourceRow, VideoRow
from server import OriginApp, read_verified_side
from storage import LocalObjectStore
import service_auth

VIDEO = "captionbound01"
REVISION = "captionrevision01"
SHA = hashlib.sha256(b"synthetic source fixture").hexdigest()
VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nsynthetic fixture words\n"


class CaptionBindingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.store = MemoryPublication()
        self.store.put_video(VideoRow(VIDEO, True, False, None))
        self.store.put_publication(PublicationRow(VIDEO, REVISION, 9, 7, 3, 2))
        self.store.put_revision(RevisionRow(REVISION, VIDEO, "captionintent01", "captionsource01", 2, "CURRENT"))
        self.store.put_source(SourceRow(VIDEO, "private/source/captionbound01/original", SHA, "PURGED"))
        self.app = OriginApp(self.store, LocalObjectStore(root / "objects"), root / "cache", b"g" * 32, b"s" * 32)
        self.payload = {"videoId": VIDEO, "revisionId": REVISION, "intentId": "captionintent01", "sourceId": "captionsource01",
                        "generation": 2, "publicationEpoch": 7, "policyEpoch": 3, "sourceSha256": SHA, "captionsVtt": VTT}

    def request(self, payload=None, signed=True):
        path = f"/internal/revisions/{REVISION}/captions"
        body = json.dumps(self.payload if payload is None else payload).encode()
        headers = {"_body": body}
        if signed:
            headers[service_auth.SERVICE_HEADER] = service_auth.sign_request(b"s" * 32, "POST", path, body)
        return self.app.handle("POST", path, headers)

    def test_signed_bound_write_and_readback_never_prepare_media(self):
        with patch.object(self.app, "_prepare_revision", side_effect=AssertionError("caption operation cannot prepare media")):
            result = self.request()
        self.assertEqual(result[0], 200)
        self.assertEqual(json.loads(result[1])["sha256"], hashlib.sha256(VTT.encode()).hexdigest())
        self.assertEqual(read_verified_side(b"s" * 32, self.app.cache, REVISION, "captions.vtt"), VTT.encode())
        self.assertEqual(self.app.download_builds, 0)

    def test_tuple_mismatches_write_nothing(self):
        for key, value in {"videoId": "othervideo001", "revisionId": "wrongrevision", "intentId": "wrongintent", "sourceId": "wrongsource",
                           "generation": 9, "publicationEpoch": 8, "policyEpoch": 4, "sourceSha256": "0" * 64}.items():
            with self.subTest(key=key):
                result = self.request({**self.payload, key: value})
                self.assertNotEqual(result[0], 200)
                self.assertFalse((self.app.cache / "revisions" / REVISION / "captions.vtt").exists())

    def test_auth_header_only_and_stale_current_are_refused(self):
        self.assertEqual(self.request(signed=False)[0], 401)
        self.assertEqual(self.request({**self.payload, "captionsVtt": "WEBVTT\n"})[0], 400)
        self.store.put_publication(PublicationRow(VIDEO, "otherrevision", 10, 8, 3, 3))
        self.assertEqual(self.request()[0], 409)
        self.assertFalse((self.app.cache / "revisions" / REVISION / "captions.vtt").exists())
