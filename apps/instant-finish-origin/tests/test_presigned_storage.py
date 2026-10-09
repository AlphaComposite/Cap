"""Credential-free origin reads; local HTTP only, runnable with network=none."""
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from service_auth import SERVICE_HEADER, sign_request, verify_request
from storage import ObjectIdentity, PresignedObjectStore, StorageError

SECRET = b"test-only-service-secret" * 2
KEY = "private/source/vid/original.mp4"
DATA = b"original bytes" * 100000


class PresignedStoreTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.route_status = 200
        self.object_status = 200
        self.truncated = False
        self.old_dest = None
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                test.calls.append(("POST", self.path))
                if not verify_request(SECRET, self.headers.get(SERVICE_HEADER, ""), "POST", self.path, body, audience="web-object-url"):
                    self.send_response(401)
                    self.end_headers()
                    return
                test.assertEqual(json.loads(body), {"key": KEY})
                self.send_response(test.route_status)
                self.send_header("Location", test.base + "/redirected-url")
                self.end_headers()
                self.wfile.write(json.dumps({"getUrl": test.base + "/object", "headUrl": test.base + "/object", "expiresIn": 300}).encode())

            def object(self, head=False):
                test.calls.append(("HEAD" if head else "GET", self.path))
                if test.old_dest is not None:
                    test.assertEqual(test.old_dest.read_bytes(), b"old")
                self.send_response(200 if self.path == "/redirected-object" else test.object_status)
                self.send_header("Content-Length", str(len(DATA)))
                self.send_header("ETag", '"etag-value"')
                self.send_header("x-amz-version-id", "version-value")
                self.send_header("Location", test.base + "/redirected-object")
                self.end_headers()
                if not head and (test.object_status == 200 or self.path == "/redirected-object"):
                    self.wfile.write(DATA[:10] if test.truncated else DATA)

            def do_GET(self):
                if self.path == "/redirected-url":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps({"getUrl": test.base + "/object", "headUrl": test.base + "/object", "expiresIn": 300}).encode())
                else:
                    self.object()

            def do_HEAD(self):
                self.object(head=True)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.store = PresignedObjectStore(self.base + "/", SECRET)
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self.tmp.name) / "cache" / "source.mp4"

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def test_atomic_download_and_head_identity(self):
        self.dest.parent.mkdir()
        self.dest.write_bytes(b"old")
        self.old_dest = self.dest
        self.store.get_to(KEY, self.dest)
        self.old_dest = None
        self.assertEqual(self.dest.read_bytes(), DATA)
        self.assertEqual(self.dest.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.dest.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(self.dest.parent.iterdir()), [self.dest])
        self.assertEqual(self.store.head(KEY), ObjectIdentity(KEY, "etag-value", "version-value", len(DATA)))
        self.assertEqual(self.calls, [("POST", self.store.URL_PATH), ("GET", "/object"), ("POST", self.store.URL_PATH), ("HEAD", "/object")])

    def test_non_200_fails_closed_on_web_get_and_head(self):
        for status in (201, 302, 401, 403, 404, 500):
            for route in (True, False):
                with self.subTest(status=status, route=route):
                    self.route_status = status if route else 200
                    self.object_status = 200 if route else status
                    for op in (lambda: self.store.get_to(KEY, self.dest), lambda: self.store.head(KEY)):
                        with self.assertRaises(StorageError):
                            op()
                    self.assertFalse(self.dest.exists())
                    self.assertEqual(list(self.dest.parent.glob("*.tmp")), [])

    def test_partial_download_preserves_previous_file(self):
        self.dest.parent.mkdir()
        self.dest.write_bytes(b"old")
        self.truncated = True
        with self.assertRaises(StorageError):
            self.store.get_to(KEY, self.dest)
        self.assertEqual(self.dest.read_bytes(), b"old")
        self.assertEqual(list(self.dest.parent.iterdir()), [self.dest])

    def test_forbidden_keys_never_make_a_request(self):
        for key in ("", "/private/source/vid/a.mp4", "private/source/vid/../a.mp4", "owner/vid/result.mp4", "owner/vid/raw-upload/a.mp4", "owner/vid/segments/a.ts", "owner/vid/preview/a.mp4", "owner/vid/screenshot/a.png", "source.webm", "https://example/a?x-amz-signature=x"):
            for op in (lambda: self.store.get_to(key, self.dest), lambda: self.store.head(key)):
                with self.subTest(key=key), self.assertRaises(StorageError):
                    op()
        self.assertEqual(self.calls, [])

    def test_mac_audiences_remain_separate(self):
        for audience in ("origin-service", "web-object-url"):
            token = sign_request(SECRET, "POST", self.store.URL_PATH, b"{}", audience=audience)
            self.assertTrue(verify_request(SECRET, token, "POST", self.store.URL_PATH, b"{}", audience=audience))
            other = "web-object-url" if audience == "origin-service" else "origin-service"
            self.assertFalse(verify_request(SECRET, token, "POST", self.store.URL_PATH, b"{}", audience=other))

    def test_server_selects_presign_without_storage_credentials_and_keeps_s3_rollback(self):
        import server
        env = {"ORIGIN_OBJECT_URL_ENDPOINT": self.base, "ORIGIN_DATABASE_URL": "unused", "REVISION_MEDIA_GRANT_KEYS": "test:" + "g" * 32, "REVISION_ORIGIN_SERVICE_SECRET": SECRET.decode()}
        for presign in (True, False):
            with self.subTest(presign=presign):
                selected = dict(env)
                if not presign:
                    selected.pop("ORIGIN_OBJECT_URL_ENDPOINT")
                    selected.update(S3_INTERNAL_ENDPOINT="unused", S3_ACCESS_KEY="unused", S3_SECRET_KEY="unused")
                with patch.dict(os.environ, selected, clear=True), patch("publication.MySQLPublication"), patch("server.OriginApp") as app, patch("server.serve", side_effect=RuntimeError("test stop")), patch("storage.PresignedObjectStore") as signed, patch("storage.S3ObjectStore") as s3:
                    with self.assertRaisesRegex(RuntimeError, "test stop"):
                        server.main()
                    if presign:
                        signed.assert_called_once_with(self.base, SECRET)
                        s3.assert_not_called()
                        self.assertIs(app.call_args.args[1], signed.return_value)
                    else:
                        s3.assert_called_once()
                        signed.assert_not_called()
                        self.assertIs(app.call_args.args[1], s3.return_value)


if __name__ == "__main__":
    unittest.main()
