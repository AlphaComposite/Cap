"""Expired warm must not reuse a same-size object with a different remote fingerprint."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from publication import MemoryPublication, SourceRow
from server import OriginApp
from storage import LocalObjectStore, ObjectIdentity

VIDEO = "vidwarm00001"
KEY = "private/source/vidwarm00001/original"
SERVICE = b"service-token-service-token-svc01"
GRANT = b"grant-secret-grant-secret-grant-01"


class FingerprintStore(LocalObjectStore):
    def __init__(self, root: Path, ident: ObjectIdentity) -> None:
        super().__init__(root)
        self.ident = ident

    def head(self, key: str) -> ObjectIdentity:
        return self.ident


class WarmFingerprintTest(unittest.TestCase):
    def test_same_size_changed_etag_does_not_reuse_old_bind(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        body = b"0123456789abcdef"
        dest = root / "cache" / "sources" / "src" / "original.mp4"
        dest.parent.mkdir(parents=True)
        dest.write_bytes(body)
        mezz = dest.with_name("mezz.mp4")
        mezz.write_bytes(b"mezz")
        mezz.with_suffix(".source-bind.json").write_text(
            json.dumps({"source_sha256": __import__("hashlib").sha256(body).hexdigest()})
        )
        dest.with_name("original.fingerprint.json").write_text(
            json.dumps({"etag": "etag-old", "version": "v1", "size": len(body)})
        )
        app = OriginApp(
            MemoryPublication(),
            FingerprintStore(root / "objects", ObjectIdentity(KEY, "etag-new", "v2", len(body))),
            root / "cache",
            GRANT,
            SERVICE,
        )
        self.assertFalse(app._local_bind_matches(dest, KEY))
        self.assertEqual(app.download_builds, 0)

    def test_prepare_redownloads_same_size_changed_etag(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        body = b"0123456789abcdef"
        downloads: list[str] = []

        class CountingStore(FingerprintStore):
            def get_to(self, key: str, dest: Path) -> None:
                downloads.append(key)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(body)

        cache = root / "cache"
        source_id = "srcwarm01"
        dest = cache / "sources" / source_id / "original.mp4"
        dest.parent.mkdir(parents=True)
        dest.write_bytes(body)
        mezz = dest.with_name("mezz.mp4")
        mezz.write_bytes(b"mezz")
        mezz.with_suffix(".source-bind.json").write_text(
            json.dumps({"source_sha256": __import__("hashlib").sha256(body).hexdigest()})
        )
        dest.with_name("original.fingerprint.json").write_text(
            json.dumps({"etag": "etag-old", "version": "v1", "size": len(body)})
        )
        store = MemoryPublication()
        store.sources[VIDEO] = SourceRow(VIDEO, KEY, "a" * 64, "LIVE")
        app = OriginApp(
            store,
            CountingStore(root / "objects", ObjectIdentity(KEY, "etag-new", "v2", len(body))),
            cache,
            GRANT,
            SERVICE,
        )
        status, _body, _content_type, _headers = app._prepare_source(
            VIDEO,
            {"_body": json.dumps({"sourceId": source_id, "sourceKey": KEY}).encode()},
        )
        self.assertEqual(downloads, [KEY])
        self.assertNotEqual(status, 409)
        self.assertEqual(app.download_builds, 1)
