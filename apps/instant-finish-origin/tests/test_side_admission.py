"""Side reads keep source/namespace authorization without taking a heavy slot."""
import concurrent.futures
import http.client
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

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
        self.revision_root = self.app.cache / "revisions" / REV
        (self.revision_root / "ranges.json").write_text("[]")
        (self.revision_root / "namespace.txt").write_text("bound-namespace")
        origin_patch = patch.object(self.app, "_origin_for", return_value=SimpleNamespace(rev="bound-namespace"))
        self.origin_for = origin_patch.start()
        self.addCleanup(origin_patch.stop)
        self.token = grant.mint(SECRET, {"v": 1, "iat": 1000, "exp": 1060, "grantId": "grant-thumbnail-0001",
            "videoId": VIDEO, "revisionId": REV, "publicationEpoch": 2, "policyEpoch": 3})
        self.path = f"/media/{VIDEO}/r/{REV}/thumbnail.jpg?t={self.token}"

    def test_side_reads_and_authorization(self):
        for name, data in DATA.items():
            public = f"/media/{VIDEO}/r/{REV}/{name}?t={self.token}"
            internal = f"/internal/revisions/{REV}/artifact/{name}"
            headers = {service_auth.SERVICE_HEADER: service_auth.sign_request(SERVICE, "GET", internal, now=1000)}
            self.assertEqual(self.app.handle("GET", public, {})[:2], (200, data))
            self.origin_for.assert_called_with(VIDEO, "source01", [], expected_sha=None, source_key=None)
            self.assertEqual(self.app.handle("GET", internal, headers)[:2], (200, data))
            self.origin_for.assert_called_with(VIDEO, "source01", [])
            self.assertEqual(self.app.handle("GET", internal, {})[0], 401)
        self.assertEqual(self.app.handle("GET", self.path.split('?')[0], {})[0], 401)
        self.assertEqual(self.app.handle("GET", self.path.replace(VIDEO, "othervideo01"), {})[0], 403)
        self.assertEqual(self.app.handle("GET", self.path, {"Range": "bytes=0-1"})[:2], (206, b"\xff\xd8"))
        self.app.before_send = lambda _: self.store.put_publication(PublicationRow(VIDEO, REV, 1, 9, 3, 1))
        self.assertEqual(self.app.handle("GET", self.path, {})[0], 410)

    def test_side_namespace_missing_or_mismatched_is_rejected(self):
        namespace = self.revision_root / "namespace.txt"
        for value in [None, "different-namespace"]:
            if value is None:
                namespace.unlink()
            else:
                namespace.write_text(value)
            for name in DATA:
                for method in ["GET", "HEAD"]:
                    with self.subTest(namespace=value, kind=name, method=method):
                        public = f"/media/{VIDEO}/r/{REV}/{name}?t={self.token}"
                        internal = f"/internal/revisions/{REV}/artifact/{name}"
                        headers = {service_auth.SERVICE_HEADER: service_auth.sign_request(SERVICE, method, internal, now=1000)}
                        self.assertEqual(self.app.handle(method, public, {})[0], 500)
                        self.assertEqual(self.app.handle(method, internal, headers)[0], 500)

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


class PostAdmissionTest(unittest.TestCase):
    def setUp(self):
        self.app = SimpleNamespace(max_inflight=8, handle=Mock(return_value=(200, b"ok", "text/plain", {})))
        self.httpd = serve(self.app, "127.0.0.1", 0)
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def headers_only(self, length):
        # No body and no EOF: rejection must arrive without waiting for a body read.
        with socket.create_connection(("127.0.0.1", self.httpd.server_port), timeout=1) as sock:
            start = time.monotonic()
            sock.sendall(f"POST /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: {length}\r\n\r\n".encode())
            response = http.client.HTTPResponse(sock)
            response.begin()
            body = response.read()
            self.assertLess(time.monotonic() - start, 1)
            return response.status, body, response.getheader("Retry-After")

    def test_invalid_lengths_rejected_before_read(self):
        for length, status in [("-1", 400), ("+1", 400), ("1.0", 400), ("bad", 400), ("", 400), ("1000001", 413), ("9" * 5000, 413)]:
            with self.subTest(length=length[:20]):
                self.assertEqual(self.headers_only(length)[0], status)
        self.app.handle.assert_not_called()

    def test_saturated_post_never_reads_body(self):
        for _ in range(8):
            self.assertTrue(self.httpd.admit.acquire(blocking=False))
        setup = self.httpd.RequestHandlerClass.setup
        reads = []
        def guard(handler):
            setup(handler)
            handler.rfile.read = Mock(side_effect=AssertionError("body read before admission"))
            reads.append(handler.rfile.read)
        try:
            with patch.object(self.httpd.RequestHandlerClass, "setup", guard):
                status, _, retry = self.headers_only("10")
            self.assertEqual((status, retry), (503, "1"))
            self.assertEqual(len(reads), 1)
            reads[0].assert_not_called()
            self.app.handle.assert_not_called()
        finally:
            for _ in range(8):
                self.httpd.admit.release()

    def test_post_slot_covers_body_read_and_is_released_on_error(self):
        for _ in range(7):
            self.assertTrue(self.httpd.admit.acquire(blocking=False))
            self.addCleanup(self.httpd.admit.release)
        setup = self.httpd.RequestHandlerClass.setup
        def fail_read(handler):
            setup(handler)
            def read(length):
                self.assertFalse(self.httpd.admit.acquire(blocking=False))
                raise OSError("test body read failure")
            handler.rfile.read = read
        with patch.object(self.httpd.RequestHandlerClass, "setup", fail_read):
            conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=1)
            try:
                conn.request("POST", "/health", body=b"x")
                with self.assertRaises(http.client.RemoteDisconnected):
                    conn.getresponse()
            finally:
                conn.close()
        self.assertTrue(self.httpd.admit.acquire(timeout=1))
        self.httpd.admit.release()
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=1)
        try:
            conn.request("POST", "/health", body=b"x")
            response = conn.getresponse()
            self.assertEqual((response.status, response.read()), (200, b"ok"))
            self.app.handle.assert_called_once()
            self.assertEqual(self.app.handle.call_args.args[2]["_body"], b"x")
            self.assertTrue(self.httpd.admit.acquire(timeout=1))
            self.httpd.admit.release()
        finally:
            conn.close()


if __name__ == '__main__':
    unittest.main()
