"""Small verified artifacts must not construct or compete with media work."""
import concurrent.futures
import http.client
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import grant
import service_auth
from publication import MemoryPublication, PublicationRow, RevisionRow, VideoRow
from server import OriginApp, SideArtifactRejected, read_verified_side, serve, write_signed_side
from storage import LocalObjectStore

VIDEO, REV = "thumbvideo01", "thumbrevision01"
SECRET, SERVICE = b"g" * 32, b"s" * 32
DATA = {"thumbnail.jpg": b"\xff\xd8\xff\xc0synthetic-frame\xff\xd9", "captions.vtt": b"WEBVTT\n", "chapters.json": b'{"chapters":[]}'}


class SideAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.store = MemoryPublication()
        self.store.put_video(VideoRow(VIDEO, True, False, None))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, 1))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intent01", "source01", 1, "CURRENT"))
        self.app = OriginApp(self.store, LocalObjectStore(root), root / "cache", SECRET, SERVICE, now=lambda: 1000)
        for name, data in DATA.items():
            write_signed_side(SERVICE, self.app.cache, REV, name, data)
        (self.app.cache / "revisions" / REV / "ranges.json").write_text("[]")
        self.token = grant.mint(SECRET, {"v": 1, "iat": 1000, "exp": 1060, "grantId": "grant-thumbnail-0001",
            "videoId": VIDEO, "revisionId": REV, "publicationEpoch": 2, "policyEpoch": 3})
        self.path = f"/media/{VIDEO}/r/{REV}/thumbnail.jpg?t={self.token}"

    def test_side_reads_and_authorization_without_source(self):
        with patch.object(self.app, "_origin_for", side_effect=AssertionError("no media construction")):
            for name, data in DATA.items():
                public = f"/media/{VIDEO}/r/{REV}/{name}?t={self.token}"
                internal = f"/internal/revisions/{REV}/artifact/{name}"
                headers = {service_auth.SERVICE_HEADER: service_auth.sign_request(SERVICE, "GET", internal, now=1000)}
                self.assertEqual(self.app.handle("GET", public, {})[:2], (200, data))
                self.assertEqual(self.app.handle("GET", internal, headers)[:2], (200, data))
                self.assertEqual(self.app.handle("GET", internal, {})[0], 401)
            self.assertEqual(self.app.handle("GET", self.path.split('?')[0], {})[0], 401)
            self.assertEqual(self.app.handle("GET", self.path.replace(VIDEO, "othervideo01"), {})[0], 403)
            self.assertEqual(self.app.handle("GET", self.path, {"Range": "bytes=0-1"})[:2], (206, b"\xff\xd8"))
            self.app.before_send = lambda _: self.store.put_publication(PublicationRow(VIDEO, REV, 1, 9, 3, 1))
            self.assertEqual(self.app.handle("GET", self.path, {})[0], 410)

    def test_fifteen_reads_with_all_heavy_slots_held(self):
        httpd = serve(self.app, "127.0.0.1", 0)
        def request(path, method="GET"):
            conn = http.client.HTTPConnection("127.0.0.1", httpd.server_port, timeout=5)
            try:
                conn.request(method, path)
                response = conn.getresponse()
                return response.status, response.read(), response.getheader("Retry-After")
            finally:
                conn.close()
        for _ in range(8):
            self.assertTrue(httpd.admit.acquire(blocking=False))
        try:
            barrier = threading.Barrier(15)
            def thumbnail(_):
                barrier.wait(timeout=5)
                return request(self.path)
            with concurrent.futures.ThreadPoolExecutor(max_workers=15) as pool:
                results = list(pool.map(thumbnail, range(15)))
            self.assertEqual([r[:2] for r in results], [(200, DATA['thumbnail.jpg'])] * 15)
            self.assertEqual(request(self.path, "HEAD")[:2], (200, b""))
            for name in ['playlist.m3u8', 'init.mp4', 'seg/0.m4s', 'download.mp4']:
                status, _, retry = request(self.path.replace('thumbnail.jpg', name))
                self.assertEqual((status, retry), (503, '1'))
            self.assertEqual(request(self.path.split('?')[0])[0], 401)
        finally:
            for _ in range(8):
                httpd.admit.release()
            httpd.shutdown()
            httpd.server_close()

    def test_signed_oversized_side_is_refused(self):
        write_signed_side(SERVICE, self.app.cache, REV, 'captions.vtt', b'x' * (4 * 1024 * 1024 + 1))
        with self.assertRaises(SideArtifactRejected):
            read_verified_side(SERVICE, self.app.cache, REV, 'captions.vtt')


if __name__ == '__main__':
    unittest.main()
