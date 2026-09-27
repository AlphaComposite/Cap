"""Overlapping revision prepares must not encode two specs at once."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import lib_origin
from publication import MemoryPublication, RevisionRow
from server import OriginApp, serve
from service_auth import sign_request
from storage import LocalObjectStore

os.environ.setdefault("ORIGIN_DEBUG", "1")

GRANT = b"grant-secret-grant-secret-grant-01"
SERVICE = b"service-token-service-token-svc01"
VIDEO = "vidorigin01"
SOURCE = "sourceid01"


class SupersededEncodeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cache = self.root / "cache"
        self.objects = self.root / "objects"
        self.objects.mkdir()
        self.store = MemoryPublication()
        self.app = OriginApp(
            self.store,
            LocalObjectStore(self.objects),
            self.cache,
            GRANT,
            SERVICE,
            now=lambda: 1_000,
        )
        self.httpd = serve(self.app, "127.0.0.1", 0)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self._real_encode = lib_origin._encode_pyav

    def tearDown(self) -> None:
        lib_origin._encode_pyav = self._real_encode
        self.httpd.shutdown()
        self.httpd.server_close()
        lib_origin.reset_process_state()
        self.tmp.cleanup()

    def _req(self, path: str, method: str = "GET", headers=None, body: bytes | None = None):
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def _service(self, method: str, path: str, body: bytes = b"") -> dict[str, str]:
        return {
            "x-cap-origin-service": sign_request(SERVICE, method, path, body, now=1_000),
            "Content-Type": "application/json",
        }

    def _write_source(self) -> str:
        key = f"owner/{VIDEO}/source/original.mp4"
        dest = self.objects / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        encoded = self.root / "encoded.mp4"
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1.2",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.2",
            "-c:v", "libx264", "-bf", "2", "-g", "60", "-pix_fmt", "yuv420p",
            "-video_track_timescale", "15360",
            "-c:a", "aac", "-ar", "48000", "-ac", "1",
            "-shortest", str(encoded),
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode:
            self.fail(result.stderr.decode()[-400:])
        dest.write_bytes(encoded.read_bytes())
        return key

    def _prepare_source(self, key: str) -> None:
        body = json.dumps({"sourceId": SOURCE, "sourceKey": key}).encode()
        path = f"/internal/sources/{VIDEO}/prepare"
        status, _, payload = self._req(path, "POST", self._service("POST", path, body), body)
        self.assertEqual(status, 200, payload)

    def _revision_body(self, ranges: list[dict]) -> bytes:
        return json.dumps({
            "videoId": VIDEO,
            "sourceId": SOURCE,
            "keepRanges": ranges,
            "captions": [],
            "chapters": [],
        }).encode()

    def _prepare_revision(self, revision_id: str, ranges: list[dict]):
        body = self._revision_body(ranges)
        path = f"/internal/revisions/{revision_id}/prepare"
        return self._req(path, "POST", self._service("POST", path, body), body)

    def test_different_specs_terminate_the_older_ffmpeg(self) -> None:
        key = self._write_source()
        self._prepare_source(key)
        self.store.put_revision(RevisionRow("revolder01", VIDEO, "pendinghash", SOURCE, 1, "READY"))
        self.store.put_revision(RevisionRow("revnewer01", VIDEO, "pendinghash", SOURCE, 2, "READY"))
        started = threading.Event()
        real = self._real_encode

        def encode(frames, dest, profile):
            slot = lib_origin.current_encode_slot()
            if slot is not None and slot.revision_id == "revolder01":
                started.set()
                self.assertTrue(slot.cancelled.wait(15), "older encode was not cancelled")
            return real(frames, dest, profile)

        lib_origin._encode_pyav = encode
        older: dict = {}

        def run_older() -> None:
            older["result"] = self._prepare_revision("revolder01", [{"start": 0.0, "end": 0.8}])

        thread = threading.Thread(target=run_older)
        thread.start()
        self.assertTrue(started.wait(15), "older encode did not start")
        status, _, payload = self._prepare_revision("revnewer01", [{"start": 0.0, "end": 0.4}])
        thread.join(60)
        self.assertFalse(thread.is_alive())
        self.assertEqual(status, 200, payload)
        self.assertTrue(json.loads(payload)["ready"])
        old_status, _, old_payload = older["result"]
        self.assertNotEqual(old_status, 200, old_payload)
        self.assertNotIn(b'"ready": true', old_payload)
        self.assertNotIn(b'"ready":true', old_payload)
        segs = list(self.cache.rglob("seg/*.m4s"))
        self.assertEqual(len(segs), 1, segs)

    def test_same_spec_encodes_once_and_both_succeed(self) -> None:
        key = self._write_source()
        self._prepare_source(key)
        self.store.put_revision(RevisionRow("revsame001", VIDEO, "pendinghash", SOURCE, 1, "READY"))
        self.store.put_revision(RevisionRow("revsame002", VIDEO, "pendinghash", SOURCE, 1, "READY"))
        entered: list[int] = []
        calls = {"n": 0}
        ranges = [{"start": 0.0, "end": 0.5}]
        real = self._real_encode

        def encode(frames, dest, profile):
            deadline = time.time() + 3
            while len(entered) < 2 and time.time() < deadline:
                time.sleep(0.01)
            time.sleep(0.4)
            calls["n"] += 1
            return real(frames, dest, profile)

        lib_origin._encode_pyav = encode
        results: list = []
        lock = threading.Lock()

        def run(revision_id: str) -> None:
            entered.append(1)
            result = self._prepare_revision(revision_id, ranges)
            with lock:
                results.append(result)

        threads = [
            threading.Thread(target=run, args=("revsame001",)),
            threading.Thread(target=run, args=("revsame002",)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
            self.assertFalse(thread.is_alive())
        self.assertEqual(len(results), 2)
        self.assertEqual(calls["n"], 1)
        for status, _, payload in results:
            self.assertEqual(status, 200, payload)
            self.assertTrue(json.loads(payload)["ready"])

    def test_unsuperseded_prepare_does_not_spawn_python(self) -> None:
        key = self._write_source()
        self._prepare_source(key)
        self.store.put_revision(RevisionRow("revnosub01", VIDEO, "pendinghash", SOURCE, 1, "READY"))
        spawned: list[list[str]] = []
        real_popen = subprocess.Popen

        def tracking(args, *pos, **kwargs):
            cmd = list(args) if isinstance(args, (list, tuple)) else [str(args)]
            spawned.append([str(part) for part in cmd])
            return real_popen(args, *pos, **kwargs)

        subprocess.Popen = tracking
        try:
            status, _, payload = self._prepare_revision("revnosub01", [{"start": 0.0, "end": 0.5}])
        finally:
            subprocess.Popen = real_popen
        self.assertEqual(status, 200, payload)
        self.assertTrue(json.loads(payload)["ready"])
        python = [cmd for cmd in spawned if _python_encode(cmd)]
        self.assertEqual(python, [], f"encode spawned python: {python}")


def _python_encode(cmd: list[str]) -> bool:
    if not cmd:
        return False
    head = cmd[0]
    if head == sys.executable or Path(head).name.startswith("python"):
        return True
    blob = " ".join(cmd)
    return "ORIGIN_ENCODE_CHILD" in blob or "lib_origin.Origin" in blob


if __name__ == "__main__":
    unittest.main()
