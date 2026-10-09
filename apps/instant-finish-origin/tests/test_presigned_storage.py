"""Credential-free origin reads; local HTTP only, runnable with network=none."""
import json
import os
import sys
import tempfile
import threading
import time
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
        self.urls = {}
        self.trickle = None
        self.stop = threading.Event()
        test = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def slow_write(self, data, phase):
                if test.trickle == (self.command, phase):
                    until = time.monotonic() + 1
                    while data and time.monotonic() < until:
                        self.wfile.write(data[:1])
                        self.wfile.flush()
                        data = data[1:]
                        if test.stop.wait(0.02):
                            return
                self.wfile.write(data)

            def end_headers(self):
                self._headers_buffer.append(b"\r\n")
                self.slow_write(b"".join(self._headers_buffer), "headers")
                self._headers_buffer.clear()

            def handle(self):
                try:
                    super().handle()
                except (BrokenPipeError, ConnectionResetError):
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
                self.slow_write(json.dumps({"getUrl": test.base + "/object", "headUrl": test.base + "/object", "expiresIn": 300, **test.urls}).encode(), "body")

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
                    self.slow_write(DATA[:10] if test.truncated else DATA, "body")

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
        self.env = patch.dict(os.environ, {"ORIGIN_STORAGE_ORIGIN": self.base,
                                          "ORIGIN_OBJECT_FETCH_DEADLINE_S": "600"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.store = PresignedObjectStore(self.base + "/", SECRET)
        self.tmp = tempfile.TemporaryDirectory()
        self.dest = Path(self.tmp.name) / "cache" / "source.mp4"

    def tearDown(self):
        self.stop.set()
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def test_requires_valid_origin_and_positive_finite_deadline(self):
        self.assertEqual(self.store.fetch_deadline, 600)
        self.assertEqual(self.store.URL_FETCH_DEADLINE_S, 30)
        for origin in (None, "", "localhost", "ftp://localhost", self.base + "/", self.base + "/path",
                       self.base + "?", self.base + "#", "http://user@localhost", "http://localhost:bad",
                       "http://local host", "http://localhost\\other", "http://localhost:0", "http://localhost:"):
            with self.subTest(origin=origin), patch.dict(os.environ):
                if origin is None:
                    os.environ.pop("ORIGIN_STORAGE_ORIGIN")
                else:
                    os.environ["ORIGIN_STORAGE_ORIGIN"] = origin
                with self.assertRaises(StorageError):
                    PresignedObjectStore(self.base, SECRET)
        for deadline in ("0", "-1", "nan", "inf", "bad"):
            with self.subTest(deadline=deadline), patch.dict(os.environ, {"ORIGIN_OBJECT_FETCH_DEADLINE_S": deadline}):
                with self.assertRaises(StorageError):
                    PresignedObjectStore(self.base, SECRET)
        with patch.dict(os.environ):
            os.environ.pop("ORIGIN_OBJECT_FETCH_DEADLINE_S")
            self.assertEqual(PresignedObjectStore(self.base, SECRET).fetch_deadline, 600)
        self.assertEqual(self.calls, [])

    def test_any_mismatched_url_is_rejected_before_object_request(self):
        self.store.fetch_deadline = 0.35
        for field in ("getUrl", "headUrl"):
            for origin in (self.base.replace("127.0.0.1", "localhost"),
                           self.base.replace("http:", "https:"), "http://127.0.0.1:1"):
                self.urls = {field: origin + "/object"}
                for op in (lambda: self.store.get_to(KEY, self.dest), lambda: self.store.head(KEY)):
                    with self.subTest(field=field, origin=origin):
                        self.calls.clear()
                        with self.assertRaises(StorageError):
                            op()
                        self.assertEqual(self.calls, [("POST", self.store.URL_PATH)])
                        self.assertFalse(self.dest.exists())

    def test_environment_proxies_are_bypassed_for_web_and_objects(self):
        proxy_calls = []

        class Proxy(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_POST(self):
                proxy_calls.append(self.path)
                self.send_error(502)

            do_GET = do_HEAD = do_POST

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{proxy.server_port}"
            with patch.dict(os.environ, {"http_proxy": url, "https_proxy": url,
                                        "HTTP_PROXY": url, "HTTPS_PROXY": url,
                                        "no_proxy": "", "NO_PROXY": ""}, clear=True):
                self.store.get_to(KEY, self.dest)
                self.assertEqual(self.store.head(KEY).size, len(DATA))
            self.assertEqual(self.dest.read_bytes(), DATA)
            self.assertEqual(proxy_calls, [])
            self.assertEqual([method for method, _ in self.calls], ["POST", "GET", "POST", "HEAD"])
        finally:
            proxy.shutdown()
            proxy.server_close()
            thread.join()

    def assert_deadline(self, method, phase):
        with patch.dict(os.environ, {"ORIGIN_OBJECT_FETCH_DEADLINE_S": "0.35"}):
            self.store = PresignedObjectStore(self.base, SECRET)
        self.trickle = (method, phase)
        self.dest.parent.mkdir(exist_ok=True)
        self.dest.write_bytes(b"old")
        errors = []
        processes = []
        import subprocess
        popen = subprocess.Popen

        def tracked_popen(*args, **kwargs):
            process = popen(*args, **kwargs)
            processes.append(process)
            return process

        def run():
            try:
                if method == "HEAD":
                    self.store.head(KEY)
                else:
                    self.store.get_to(KEY, self.dest)
            except Exception as exc:
                errors.append(exc)

        with patch.object(self.store, "URL_FETCH_DEADLINE_S", 0.35), patch("storage.subprocess.Popen", side_effect=tracked_popen):
            start = time.monotonic()
            thread = threading.Thread(target=run)
            thread.start()
            thread.join(3)
            elapsed = time.monotonic() - start
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], StorageError)
        self.assertLess(elapsed, 0.85)
        self.assertTrue(processes)
        self.assertTrue(all(process.poll() is not None for process in processes))
        self.assertEqual(self.dest.read_bytes(), b"old")
        self.assertEqual(list(self.dest.parent.iterdir()), [self.dest])
        self.assertEqual([verb for verb, _ in self.calls], ["POST"] if method == "POST" else ["POST", method])

    def test_whole_web_deadline_includes_trickling_headers(self):
        self.assert_deadline("POST", "headers")

    def test_whole_web_deadline_includes_trickling_body(self):
        self.assert_deadline("POST", "body")

    def test_get_deadline_includes_trickling_headers(self):
        self.assert_deadline("GET", "headers")

    def test_get_deadline_includes_trickling_body_and_cleans_tmp(self):
        self.assert_deadline("GET", "body")

    def test_head_deadline_includes_trickling_headers(self):
        self.assert_deadline("HEAD", "headers")

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

    def test_web_mac_nonce_is_random_in_the_same_second(self):
        tokens = [sign_request(SECRET, "POST", self.store.URL_PATH, b"{}", now=1000,
                               audience="web-object-url") for _ in range(2)]
        self.assertNotEqual(tokens[0].split(".")[0], tokens[1].split(".")[0])
        for token in tokens:
            self.assertTrue(verify_request(SECRET, token, "POST", self.store.URL_PATH,
                                           b"{}", now=1000, audience="web-object-url"))
        self.assertEqual(sign_request(SECRET, "POST", self.store.URL_PATH, now=1000),
                         sign_request(SECRET, "POST", self.store.URL_PATH, now=1000))

    def test_mac_audiences_remain_separate(self):
        for audience in ("origin-service", "web-object-url"):
            token = sign_request(SECRET, "POST", self.store.URL_PATH, b"{}", audience=audience)
            self.assertTrue(verify_request(SECRET, token, "POST", self.store.URL_PATH, b"{}", audience=audience))
            other = "web-object-url" if audience == "origin-service" else "origin-service"
            self.assertFalse(verify_request(SECRET, token, "POST", self.store.URL_PATH, b"{}", audience=other))

    def test_server_selects_presign_without_storage_credentials_and_keeps_s3_rollback(self):
        import server
        env = {"ORIGIN_OBJECT_URL_ENDPOINT": self.base, "ORIGIN_STORAGE_ORIGIN": self.base, "ORIGIN_DATABASE_URL": "unused", "REVISION_MEDIA_GRANT_KEYS": "test:" + "g" * 32, "REVISION_ORIGIN_SERVICE_SECRET": SECRET.decode()}
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
