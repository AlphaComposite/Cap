"""Contract tests for F5, F7, F8, and F9. These failed on dc30f6674a."""
from __future__ import annotations

import json
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import grant as grant_mod
import service_auth
from publication import MemoryPublication, PublicationRow, RevisionRow, VideoRow
from server import NO_STORE, OriginApp, serve
from storage import LocalObjectStore

VECTORS = json.loads((Path(__file__).parent / "vectors" / "grant-service.json").read_text())
GRANT = b"grant-secret-grant-secret-grant-01"
SERVICE = b"service-token-service-token-svc01"
VIDEO = "vidorigin01"
R1 = "revorigin01"
R2 = "revorigin02"
SOURCE = "sourceid01"


def _ring(ids: list[str]) -> list[tuple[str, bytes]]:
    return [(kid, VECTORS["keys"][kid].encode()) for kid in ids]


class GrantVectorTests(unittest.TestCase):
    def test_shared_vectors(self) -> None:
        failures = []
        for case in VECTORS["cases"]:
            if case["kind"] != "grant":
                continue
            try:
                grant_mod.verify(_ring(case["ring"]), case["token"], now=case["now"])
                got = "accept"
            except grant_mod.GrantError:
                got = "reject"
            if got != case["expect"]:
                failures.append(f"{case['id']}: got {got} expected {case['expect']}")
        self.assertEqual(failures, [])


class ServiceVectorTests(unittest.TestCase):
    def test_shared_vectors(self) -> None:
        secret = VECTORS["serviceSecret"].encode()
        failures = []
        for case in VECTORS["cases"]:
            if case["kind"] != "service":
                continue
            ok = service_auth.verify_request(
                secret,
                case["token"],
                case["method"],
                case["path"],
                case["body"].encode(),
                now=case["now"],
            )
            got = "accept" if ok else "reject"
            if got != case["expect"]:
                failures.append(f"{case['id']}: got {got} expected {case['expect']}")
        self.assertEqual(failures, [])

    def test_signer_ttl_is_thirty(self) -> None:
        token = service_auth.sign_request(SERVICE, "POST", "/internal/sources/vidorigin01/prepare", b"{}", now=50)
        encoded = token.split(".", 1)[0]
        claims = json.loads(service_auth.b64url_decode(encoded))
        self.assertEqual(claims["exp"] - claims["iat"], 30)


class CurrentGenerationTests(unittest.TestCase):
    def test_allocated_r2_leaves_r1_playable(self) -> None:
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        try:
            store = MemoryPublication()
            store.put_video(VideoRow(VIDEO, True, False, "cap"))
            store.put_revision(RevisionRow(R1, VIDEO, "intent-r1", SOURCE, 1, "CURRENT"))
            store.put_revision(RevisionRow(R2, VIDEO, "intent-r2", SOURCE, 2, "PREPARING"))
            store.put_publication(
                PublicationRow(
                    VIDEO,
                    R1,
                    2,
                    4,
                    7,
                    current_generation=1,
                )
            )
            app = OriginApp(store, LocalObjectStore(root), root / "cache", GRANT, SERVICE, now=lambda: 1_000)
            token = grant_mod.mint(GRANT, {
                "v": 1,
                "videoId": VIDEO,
                "revisionId": R1,
                "publicationEpoch": 4,
                "policyEpoch": 7,
                "iat": 1_000,
                "exp": 1_060,
                "grantId": "grant-origin-0001",
            })
            parsed = grant_mod.verify(GRANT, token, now=1_000)
            snap = app._authorize(VIDEO, R1, parsed)
            self.assertIsInstance(snap, dict, snap)
            self.assertEqual(snap["generation"], 1)
            self.assertNotEqual(snap.get("allocated_generation", snap["generation"]), snap["generation"])
            r2 = grant_mod.mint(GRANT, {
                "v": 1,
                "videoId": VIDEO,
                "revisionId": R2,
                "publicationEpoch": 4,
                "policyEpoch": 7,
                "iat": 1_000,
                "exp": 1_060,
                "grantId": "grant-origin-0002",
            })
            parsed_r2 = grant_mod.verify(GRANT, r2, now=1_000)
            denied = app._authorize(VIDEO, R2, parsed_r2)
            self.assertIsInstance(denied, tuple)
            self.assertEqual(denied[0], 410)
        finally:
            tmp.cleanup()


class HeaderAndLimitTests(unittest.TestCase):
    def test_media_sets_referrer_policy(self) -> None:
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        try:
            app = OriginApp(
                MemoryPublication(),
                LocalObjectStore(Path(tmp.name)),
                Path(tmp.name) / "cache",
                GRANT,
                SERVICE,
                now=lambda: 1_000,
            )
            _status, _body, _ctype, headers = app._text(401, b"unauthorized")
            self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")
            _status, _body, _ctype, headers = app._json(200, {"ok": True})
            self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")
        finally:
            tmp.cleanup()

    def test_overload_returns_retry_after(self) -> None:
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        try:
            app = OriginApp(
                MemoryPublication(),
                LocalObjectStore(Path(tmp.name)),
                Path(tmp.name) / "cache",
                GRANT,
                SERVICE,
                now=lambda: 1_000,
                max_inflight=1,
            )
            httpd = serve(app, "127.0.0.1", 0)
            self.assertTrue(httpd.admit.acquire(blocking=False))
            request = urllib.request.Request(f"http://127.0.0.1:{httpd.server_address[1]}/health")
            try:
                with urllib.request.urlopen(request, timeout=3) as response:
                    status, retry = response.status, response.headers.get("Retry-After", "")
            except urllib.error.HTTPError as exc:
                status, retry = exc.code, exc.headers.get("Retry-After", "")
            httpd.admit.release()
            httpd.shutdown()
            httpd.server_close()
            self.assertEqual(status, 503)
            self.assertEqual(retry, "1")
        finally:
            tmp.cleanup()

    def test_garbage_media_is_4xx(self) -> None:
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        try:
            cache = Path(tmp.name) / "cache"
            objects = Path(tmp.name) / "objects"
            objects.mkdir()
            key = f"owner/{VIDEO}/source/original.mp4"
            dest = objects / key
            dest.parent.mkdir(parents=True)
            dest.write_bytes(b"\x00\x00\x00\x18ftypmp42garbage-not-a-movie")
            store = MemoryPublication()
            app = OriginApp(store, LocalObjectStore(objects), cache, GRANT, SERVICE, now=lambda: 1_000)
            httpd = serve(app, "127.0.0.1", 0)
            base = f"http://127.0.0.1:{httpd.server_address[1]}"
            body = json.dumps({"sourceId": SOURCE, "sourceKey": key}).encode()
            path = f"/internal/sources/{VIDEO}/prepare"
            header = service_auth.sign_request(SERVICE, "POST", path, body, now=1_000)
            request = urllib.request.Request(
                base + path,
                data=body,
                method="POST",
                headers={"x-cap-origin-service": header, "Content-Type": "application/json"},
            )
            started = time.perf_counter()
            try:
                with urllib.request.urlopen(request, timeout=8) as response:
                    status, payload = response.status, response.read()
            except urllib.error.HTTPError as exc:
                status, payload = exc.code, exc.read()
            elapsed = time.perf_counter() - started
            httpd.shutdown()
            httpd.server_close()
            self.assertGreaterEqual(status, 400)
            self.assertLess(status, 500, payload)
            self.assertLess(elapsed, 5)
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
