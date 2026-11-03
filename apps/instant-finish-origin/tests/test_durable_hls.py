from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import grant
import server
import service_auth
from publication import MemoryPublication, PublicationRow, RevisionRow, VideoRow
from storage import LocalObjectStore

VIDEO, REV = "video1234", "revision1234"
SECRET, SERVICE = b"g" * 32, b"s" * 32
NAMESPACE = "/".join(["a" * 64] * 4)
DATA = {
    "playlist.m3u8": b'#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nseg/0.m4s\n#EXT-X-ENDLIST\n',
    "init.mp4": b"exact-init", "seg/0.m4s": b"exact-edited-fragment",
    "captions.vtt": b"WEBVTT\n", "chapters.json": b'{"chapters":[]}\n',
    "thumbnail.jpg": b"exact-thumbnail",
}


class DurableHlsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = MemoryPublication()
        self.store.put_video(VideoRow(VIDEO, True, False, None))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, 1))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intent123", "source123", 1, "CURRENT"))
        root = Path(self.tmp.name)
        self.app = server.OriginApp(self.store, LocalObjectStore(root), root / "empty", SECRET, SERVICE, now=lambda: 1000)
        self.app._origin_for = Mock(side_effect=AssertionError("source regeneration forbidden"))
        self.app.objects.get_to = Mock(side_effect=AssertionError("source fetch forbidden"))
        self.calls = []
        self.corrupt = False
        self.wrong_identity = False
        self.missing = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_GET(self):
                if not service_auth.verify_request(SERVICE, self.headers.get(service_auth.SERVICE_HEADER) or "", "GET", self.path, audience="web-revision-artifact"):
                    self.send_error(401)
                    return
                query = parse_qs(urlparse(self.path).query)
                name = query["name"][0]
                owner.calls.append(name)
                if owner.missing:
                    self.send_response(204)
                    self.end_headers()
                    return
                data = DATA[name]
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("X-Cap-Sha256", "0" * 64 if owner.corrupt else hashlib.sha256(data).hexdigest())
                self.send_header("X-Cap-Namespace", NAMESPACE)
                self.send_header("X-Cap-Video-Id", VIDEO)
                self.send_header("X-Cap-Revision-Id", "wrongrevision" if owner.wrong_identity else REV)
                self.send_header("X-Cap-Source-Id", "source123")
                self.send_header("X-Cap-Generation", "1")
                self.send_header("X-Cap-Publication-Epoch", "2")
                self.send_header("X-Cap-Policy-Epoch", "3")
                self.end_headers()
                self.wfile.write(data)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        env = patch.dict(os.environ, {"ORIGIN_OBJECT_URL_ENDPOINT": f"http://127.0.0.1:{self.http.server_port}"})
        env.start()
        self.addCleanup(env.stop)
        self.token = grant.mint(SECRET, {"v": 1, "iat": 1000, "exp": 1060, "grantId": "cold-hls-grant-0001", "videoId": VIDEO, "revisionId": REV, "publicationEpoch": 2, "policyEpoch": 3})

    def read(self, name, headers=None, method="GET"):
        return self.app.handle(method, f"/media/{VIDEO}/r/{REV}/{name}?t={self.token}", headers or {})

    def test_empty_cache_serves_exact_media_and_sides_without_original_or_encoder(self):
        self.assertEqual(list(self.app.cache.iterdir()), [])
        for name, expected in DATA.items():
            with self.subTest(name=name):
                status, body, _, _ = self.read(name)
                self.assertEqual(status, 200)
                if name == "playlist.m3u8":
                    expected = server.lib_origin.playlist_with_grant(expected.decode(), self.token)
                self.assertEqual(body, expected)
        self.app._origin_for.assert_not_called()
        self.app.objects.get_to.assert_not_called()
        self.assertEqual(list(self.app.cache.iterdir()), [])

    def test_cold_range_uses_exact_fragment_bytes(self):
        status, body, _, headers = self.read("seg/0.m4s", {"Range": "bytes=2-6"})
        self.assertEqual((status, body), (206, DATA["seg/0.m4s"][2:7]))
        self.assertEqual(headers["Content-Range"], f'bytes 2-6/{len(DATA["seg/0.m4s"])}')
        self.app._origin_for.assert_not_called()

    def test_checksum_failure_never_falls_back_to_source(self):
        self.corrupt = True
        self.assertEqual(self.read("init.mp4")[0], 500)
        self.app._origin_for.assert_not_called()
        self.assertEqual(len(self.calls), 1)

    def test_wrong_revision_is_rejected_without_source_fallback(self):
        self.wrong_identity = True
        self.assertEqual(self.read("init.mp4")[0], 500)
        self.app._origin_for.assert_not_called()
        self.assertEqual(len(self.calls), 1)

    def test_post_fetch_epoch_change_is_fenced(self):
        self.app.before_send = lambda _: self.store.put_publication(PublicationRow(VIDEO, REV, 1, 4, 3, 1))
        self.assertEqual(self.read("init.mp4")[0], 410)
        self.app._origin_for.assert_not_called()

    def test_revoked_grant_never_fetches_artifact(self):
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 4, 3, 1))
        self.assertEqual(self.read("init.mp4")[0], 410)
        self.assertEqual(self.calls, [])

    def test_internal_cold_side_read_uses_same_exact_artifact(self):
        path = f"/internal/revisions/{REV}/artifact/captions.vtt"
        token = service_auth.sign_request(SERVICE, "GET", path, now=1000)
        status, body, _, _ = self.app.handle("GET", path, {service_auth.SERVICE_HEADER: token})
        self.assertEqual((status, body), (200, DATA["captions.vtt"]))
        self.app._origin_for.assert_not_called()

    def test_renewed_grant_changes_only_playlist_bearer_not_media(self):
        self.app.now = lambda: 1100
        self.token = grant.mint(SECRET, {"v": 1, "iat": 1100, "exp": 1160, "grantId": "renewed-hls-grant01", "videoId": VIDEO, "revisionId": REV, "publicationEpoch": 2, "policyEpoch": 3})
        self.assertEqual(self.read("init.mp4")[:2], (200, DATA["init.mp4"]))
        self.assertEqual(self.read("playlist.m3u8")[1], server.lib_origin.playlist_with_grant(DATA["playlist.m3u8"].decode(), self.token))

    def test_expired_grant_is_rejected_before_durable_read(self):
        self.app.now = lambda: 1100
        self.assertEqual(self.read("init.mp4")[0], 401)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
