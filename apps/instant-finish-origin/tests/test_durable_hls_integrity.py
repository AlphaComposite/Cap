from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import grant
import server
from publication import MemoryPublication, PublicationRow, RevisionRow, VideoRow
from storage import LocalObjectStore
from test_durable_hls import DATA, REV, SECRET, SERVICE, VIDEO


class DurableNamespaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        publication = MemoryPublication()
        publication.put_video(VideoRow(VIDEO, True, False, None))
        publication.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, 1))
        publication.put_revision(RevisionRow(REV, VIDEO, "intent123", "source123", 1, "CURRENT"))
        self.app = server.OriginApp(publication, LocalObjectStore(root), root / "cache", SECRET, SERVICE, now=lambda: 1000)
        ranges = self.app.cache / "revisions" / REV / "ranges.json"
        ranges.parent.mkdir(parents=True)
        ranges.write_text("[]")
        server._write_namespace(self.app.cache, REV, "c" * 64)
        self.app._origin_for = Mock(side_effect=AssertionError("source construction forbidden"))
        self.app.objects.get_to = Mock(side_effect=AssertionError("source fetch forbidden"))
        self.namespace = "/".join(char * 64 for char in "abcd")
        self.token = grant.mint(SECRET, {"v": 1, "iat": 1000, "exp": 1060, "grantId": "namespace-grant-001", "videoId": VIDEO, "revisionId": REV, "publicationEpoch": 2, "policyEpoch": 3})

    def read(self, name, overrides=None):
        body = DATA[name]
        headers = {
            "X-Cap-Namespace": self.namespace,
            "X-Cap-Video-Id": VIDEO, "X-Cap-Revision-Id": REV,
            "X-Cap-Source-Id": "source123", "X-Cap-Generation": "1",
            "X-Cap-Publication-Epoch": "2", "X-Cap-Policy-Epoch": "3",
            "X-Cap-Sha256": hashlib.sha256(body).hexdigest(), "Content-Length": str(len(body)),
        }
        headers.update(overrides or {})
        response = json.dumps({"status": 200, "headers": headers}).encode() + b"\n" + body
        with patch.dict("os.environ", {"ORIGIN_OBJECT_URL_ENDPOINT": "http://unused.invalid"}), patch.object(server.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=response)) as fetch:
            result = self.app.handle("GET", f"/media/{VIDEO}/r/{REV}/{name}?t={self.token}", {})
        fetch.assert_called_once()
        self.app._origin_for.assert_not_called()
        self.app.objects.get_to.assert_not_called()
        return result

    def test_warm_cache_matches_media_component_of_complete_namespace(self):
        for name, body in DATA.items():
            with self.subTest(name=name):
                expected = server.lib_origin.playlist_with_grant(body.decode(), self.token) if name == "playlist.m3u8" else body
                self.assertEqual(self.read(name)[:2], (200, expected))
        self.assertEqual(server._namespace(self.app.cache, REV), "c" * 64)

    def test_cold_cache_accepts_complete_namespace_without_persisting_it(self):
        self.app.cache = self.app.cache / "cold"
        self.app.cache.mkdir()
        for name, body in DATA.items():
            with self.subTest(name=name):
                expected = server.lib_origin.playlist_with_grant(body.decode(), self.token) if name == "playlist.m3u8" else body
                self.assertEqual(self.read(name)[:2], (200, expected))
        self.assertEqual(list(self.app.cache.iterdir()), [])

    def test_wrong_media_component_never_falls_back(self):
        namespace = "/".join(char * 64 for char in "abed")
        for name in DATA:
            with self.subTest(name=name):
                self.assertEqual(self.read(name, {"X-Cap-Namespace": namespace})[0], 500)

    def test_malformed_full_namespace_never_falls_back(self):
        for namespace in ["c" * 64, self.namespace + "/", self.namespace.upper(), self.namespace.replace("a", "g"), "/".join(["a", "b" * 64, "c" * 64, "d" * 64])]:
            with self.subTest(namespace=namespace):
                self.assertEqual(self.read("init.mp4", {"X-Cap-Namespace": namespace})[0], 500)

    def test_identity_epochs_hash_and_size_remain_required(self):
        for header, value in {
            "X-Cap-Video-Id": "wrongvideo", "X-Cap-Revision-Id": "wrongrevision",
            "X-Cap-Source-Id": "wrongsource", "X-Cap-Generation": "2",
            "X-Cap-Publication-Epoch": "4", "X-Cap-Policy-Epoch": "4",
            "X-Cap-Sha256": "0" * 64, "Content-Length": "1",
        }.items():
            with self.subTest(header=header):
                self.assertEqual(self.read("init.mp4", {header: value})[0], 500)


class DurableIntegrityTests(unittest.TestCase):
    def test_internal_integrity_error_never_constructs_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            publication = MemoryPublication()
            publication.put_video(VideoRow("video1234", True, False, None))
            publication.put_publication(PublicationRow("video1234", "revision1234", 1, 2, 3, 1))
            publication.put_revision(RevisionRow("revision1234", "video1234", "intent123", "source123", 1, "CURRENT"))
            app = server.OriginApp(publication, LocalObjectStore(root), root / "cache", b"g" * 32, b"s" * 32, now=lambda: 1000)
            ranges = app.cache / "revisions" / "revision1234" / "ranges.json"
            ranges.parent.mkdir(parents=True)
            ranges.write_text("[]")
            app._origin_for = Mock(side_effect=AssertionError("source construction forbidden"))
            app.objects.get_to = Mock(side_effect=AssertionError("source fetch forbidden"))
            token = grant.mint(b"g" * 32, {"v": 1, "iat": 1000, "exp": 1060, "grantId": "integrity-grant-001", "videoId": "video1234", "revisionId": "revision1234", "publicationEpoch": 2, "policyEpoch": 3})
            with patch.dict("os.environ", {"ORIGIN_OBJECT_URL_ENDPOINT": "http://unused.invalid"}), patch.object(server.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "internal-503")) as fetch:
                status = app.handle("GET", f"/media/video1234/r/revision1234/init.mp4?t={token}", {})[0]
            self.assertEqual(status, 500)
            fetch.assert_called_once()
            app._origin_for.assert_not_called()
            app.objects.get_to.assert_not_called()


if __name__ == "__main__":
    unittest.main()
