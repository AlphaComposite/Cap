"""Revision MP4 download: build once, serve when ready, one-line failures."""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import grant as grant_mod
import lib_origin
import server
from publication import MemoryPublication, PublicationRow, RevisionRow, VideoRow
from server import OriginApp, serve
from service_auth import sign_request
from storage import LocalObjectStore

GRANT = b"grant-secret-grant-secret-grant-01"
SERVICE = b"service-token-service-token-svc01"
VIDEO = "viddownload1"
REV = "revdownload01"
SOURCE = "sourcedl001"


def claims() -> dict:
    return {
        "exp": 1_060,
        "grantId": "grant-download-01",
        "iat": 1_000,
        "policyEpoch": 3,
        "publicationEpoch": 2,
        "revisionId": REV,
        "v": 1,
        "videoId": VIDEO,
    }


class DownloadTests(unittest.TestCase):
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
        self.release = threading.Event()

    def tearDown(self) -> None:
        self.release.set()
        self.app.download_gate = None
        self.app.drain_downloads(5)
        self.httpd.shutdown()
        self.httpd.server_close()
        lib_origin.reset_process_state()
        self.tmp.cleanup()

    def _req(self, path: str, method: str = "GET", headers=None, body: bytes | None = None):
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
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

    def _prepare_revision(self) -> dict:
        self.store.put_revision(RevisionRow(REV, VIDEO, "pendinghash", SOURCE, 1, "READY"))
        body = json.dumps({
            "videoId": VIDEO,
            "sourceId": SOURCE,
            "keepRanges": [{"start": 0.0, "end": 1.0}],
        }).encode()
        path = f"/internal/revisions/{REV}/prepare"
        status, _, payload = self._req(path, "POST", self._service("POST", path, body), body)
        self.assertEqual(status, 200, payload)
        prepared = json.loads(payload)
        self.store.put_video(VideoRow(VIDEO, True, False, "cap"))
        self.store.put_revision(RevisionRow(REV, VIDEO, prepared["intentId"], SOURCE, 1, "CURRENT"))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        return prepared

    def _post_download(self):
        body = json.dumps({"videoId": VIDEO}).encode()
        path = f"/internal/revisions/{REV}/download"
        return self._req(path, "POST", self._service("POST", path, body), body)

    def _playlist_duration(self, playlist: bytes) -> float:
        total = 0.0
        for line in playlist.decode().splitlines():
            if line.startswith("#EXTINF:"):
                total += float(line.split(":", 1)[1].split(",", 1)[0])
        return total

    def test_unauthorized_and_absent_stay_closed(self) -> None:
        status, _, _ = self._req(f"/internal/revisions/{REV}/download", "POST", body=b"{}")
        self.assertEqual(status, 401)
        self._write_source()
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        self._prepare_revision()
        token = grant_mod.mint(GRANT, claims())
        status, headers, body = self._req(f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}")
        self.assertEqual(status, 202)
        self.assertIn(b"unavailable", body)
        self.assertIn("no-store", headers.get("Cache-Control", headers.get("cache-control", "")))

    def test_builds_once_and_serves_a_progressive_mp4(self) -> None:
        self._write_source()
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        prepared = self._prepare_revision()
        token = grant_mod.mint(GRANT, claims())
        entered: list[int] = []

        def gate() -> None:
            entered.append(1)
            self.assertTrue(self.release.wait(5))

        self.app.download_gate = gate
        statuses: list[int] = []

        def post() -> None:
            status, _, _ = self._post_download()
            statuses.append(status)

        first = threading.Thread(target=post)
        second = threading.Thread(target=post)
        first.start()
        deadline = time.time() + 5
        while not entered and time.time() < deadline:
            time.sleep(0.01)
        self.assertEqual(entered, [1])
        self.assertEqual(self.app.download_builds, 0)
        second.start()
        second.join(5)
        self.assertEqual(entered, [1])
        self.assertEqual(self.app.download_builds, 0)
        self.release.set()
        first.join(30)
        self.app.drain_downloads(30)
        self.assertEqual(statuses, [202, 202])
        self.assertEqual(self.app.download_builds, 1)

        status, _, body = self._post_download()
        self.assertEqual(status, 200, body)
        self.assertIn(b"ready", body)
        self.assertEqual(self.app.download_builds, 1)

        status, headers, media = self._req(f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}")
        self.assertEqual(status, 200, media[:80])
        self.assertIn("video/mp4", headers.get("Content-Type", headers.get("content-type", "")))
        self.assertIn(b"ftyp", media)
        ranged = self._req(
            f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}",
            headers={"Range": "bytes=0-15"},
        )
        self.assertEqual(ranged[0], 206)
        self.assertEqual(len(ranged[2]), 16)
        self.assertTrue(ranged[1].get("Content-Range", ranged[1].get("content-range", "")).startswith("bytes 0-15/"))

        playlist = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")[2]
        expected = self._playlist_duration(playlist)
        self.assertAlmostEqual(expected, prepared["playlistDurationSeconds"], delta=0.2)
        probed = self.root / "download.mp4"
        probed.write_bytes(media)
        probe = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "csv=p=0", str(probed),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr.decode()[-400:])
        duration = float(probe.stdout.decode().strip())
        self.assertAlmostEqual(duration, expected, delta=0.2)

    def test_failure_logs_one_line(self) -> None:
        self._write_source()
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        self._prepare_revision()
        real = server.limits.run_cmd

        def fail(cmd, timeout, **kwargs):
            if "copy" in cmd:
                return subprocess.CompletedProcess(cmd, 1, b"", b"leaked /secret/path")
            return real(cmd, timeout, **kwargs)

        buf = io.StringIO()
        with patch("server.limits.run_cmd", side_effect=fail), contextlib.redirect_stderr(buf):
            status, _, body = self._post_download()
            self.assertEqual(status, 202, body)
            seen = status
            for _ in range(50):
                status, _, body = self._post_download()
                seen = status
                if status == 500:
                    break
                time.sleep(0.05)
            self.assertEqual(seen, 500, body)
            self.app.drain_downloads(2)
        lines = [line for line in buf.getvalue().splitlines() if line.startswith("revision-download-failed")]
        self.assertEqual(lines, ["revision-download-failed RuntimeError video=viddownload1 rev=revdownload01 kind=download.mp4"])
        self.assertNotIn("secret", lines[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
