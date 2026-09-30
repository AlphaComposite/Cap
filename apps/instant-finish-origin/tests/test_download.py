"""Revision MP4 download: build once, serve when ready, one-line failures."""
from __future__ import annotations

import contextlib
import http.client
import io
import hashlib
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
from publication import MemoryPublication, PublicationRow, RevisionRow, SourceRow, VideoRow
from server import OriginApp, serve
from service_auth import sign_request
from storage import LocalObjectStore

GRANT = b"grant-secret-grant-secret-grant-01"
SERVICE = b"service-token-service-token-svc01"
VIDEO = "viddownload1"
REV = "revdownload01"
SOURCE = "sourcedl001"


def claims(artifact: str | None = None) -> dict:
    ttl = grant_mod.ttl_for(artifact)
    row = {
        "exp": 1_000 + ttl,
        "grantId": "grant-download-01",
        "iat": 1_000,
        "policyEpoch": 3,
        "publicationEpoch": 2,
        "revisionId": REV,
        "v": 1,
        "videoId": VIDEO,
    }
    if artifact is not None:
        row["artifact"] = artifact
    return row


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

    def _write_source(self, duration: float = 1.2, gop: int = 60) -> str:
        key = f"owner/{VIDEO}/source/original.mp4"
        dest = self.objects / key
        dest.parent.mkdir(parents=True, exist_ok=True)
        encoded = self.root / "encoded.mp4"
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=320x180:rate=30:duration={duration}",
            "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
            "-c:v", "libx264", "-bf", "2", "-g", str(gop), "-pix_fmt", "yuv420p",
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
        if self.store.source(VIDEO) is None:
            self.store.put_source(SourceRow(VIDEO, key, hashlib.sha256((self.objects / key).read_bytes()).hexdigest(), "LIVE"))
        body = json.dumps({"sourceId": SOURCE, "sourceKey": key}).encode()
        path = f"/internal/sources/{VIDEO}/prepare"
        status, _, payload = self._req(path, "POST", self._service("POST", path, body), body)
        self.assertEqual(status, 200, payload)

    def _prepare_revision(self, end: float = 1.0) -> dict:
        self.store.put_revision(RevisionRow(REV, VIDEO, "pendinghash", SOURCE, 1, "READY"))
        body = json.dumps({
            "videoId": VIDEO,
            "sourceId": SOURCE,
            "keepRanges": [{"start": 0.0, "end": end}],
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

    def test_playback_grant_cannot_open_download(self) -> None:
        self.store.put_video(VideoRow(VIDEO, True, False, "cap"))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intent", SOURCE, 1, "CURRENT"))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        token = grant_mod.mint(GRANT, claims())
        status, headers, body = self._req(f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}")
        self.assertEqual(status, 403, body)
        self.assertEqual(body, b"forbidden")
        self.assertIn("no-store", headers.get("Cache-Control", headers.get("cache-control", "")))
        playlist = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertNotEqual(playlist[0], 403, playlist[2])

    def test_download_grant_cannot_open_playback_artifacts(self) -> None:
        self.store.put_video(VideoRow(VIDEO, True, False, "cap"))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intent", SOURCE, 1, "CURRENT"))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        token = grant_mod.mint(GRANT, claims(artifact="download"))
        for kind in (
            "playlist.m3u8",
            "init.mp4",
            "seg/0.m4s",
            "captions.vtt",
            "chapters.json",
            "thumbnail.jpg",
        ):
            status, _, body = self._req(f"/media/{VIDEO}/r/{REV}/{kind}?t={token}")
            self.assertEqual((kind, status, body), (kind, 403, b"forbidden"))

    def test_unauthorized_and_absent_stay_closed(self) -> None:
        status, _, _ = self._req(f"/internal/revisions/{REV}/download", "POST", body=b"{}")
        self.assertEqual(status, 401)
        self._write_source()
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        self._prepare_revision()
        token = grant_mod.mint(GRANT, claims(artifact="download"))
        status, headers, body = self._req(f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}")
        self.assertEqual(status, 202)
        self.assertIn(b"unavailable", body)
        self.assertIn("no-store", headers.get("Cache-Control", headers.get("cache-control", "")))

    def test_builds_once_and_serves_a_progressive_mp4(self) -> None:
        self._write_source()
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        prepared = self._prepare_revision()
        token = grant_mod.mint(GRANT, claims(artifact="download"))
        playback = grant_mod.mint(GRANT, claims())
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

        playlist = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={playback}")
        self.assertEqual(playlist[0], 200, playlist[2][:80])
        download_playlist = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertEqual(download_playlist[0], 403, download_playlist[2])
        self.assertEqual(download_playlist[2], b"forbidden")
        download_segment = self._req(f"/media/{VIDEO}/r/{REV}/seg/0.m4s?t={token}")
        self.assertEqual(download_segment[0], 403, download_segment[2])
        self.assertEqual(download_segment[2], b"forbidden")
        expected = self._playlist_duration(playlist[2])
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

    def _namespace(self) -> Path:
        found = list(self.cache.rglob("seg/0.m4s"))
        self.assertEqual(len(found), 1, found)
        return found[0].parent.parent

    def _wait_ready(self) -> None:
        status = 0
        body = b""
        for _ in range(80):
            status, _, body = self._post_download()
            if status == 200:
                return
            time.sleep(0.25)
        self.fail(body)

    def test_download_range_header_is_case_insensitive_over_http(self) -> None:
        self._write_source()
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        self._prepare_revision()
        payload = bytes(range(256)) * 16
        (self._namespace() / "download.mp4").write_bytes(payload)
        token = grant_mod.mint(GRANT, claims(artifact="download"))
        path = f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}"
        cases = [
            ("GET", "range", "bytes=2-17", 206, payload[2:18]),
            ("GET", "rAnGe", "bytes=2-17", 206, payload[2:18]),
            ("HEAD", "range", "bytes=2-17", 206, b""),
            ("GET", "range", "bytes=9999-10000", 416, b"range"),
            ("GET", None, None, 200, payload),
        ]
        for method, name, value, expected_status, expected_body in cases:
            with self.subTest(method=method, header=name, value=value):
                conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=30)
                try:
                    conn.request(method, path, headers={name: value} if name else {})
                    response = conn.getresponse()
                    body = response.read()
                    self.assertEqual(response.status, expected_status)
                    self.assertEqual(body, expected_body)
                    if expected_status == 206:
                        self.assertEqual(response.getheader("Content-Range"), f"bytes 2-17/{len(payload)}")
                        self.assertEqual(response.getheader("Content-Length"), "16")
                finally:
                    conn.close()

    def test_download_streams_in_bounded_chunks(self) -> None:
        self._write_source()
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        self._prepare_revision()
        dest = self._namespace() / "download.mp4"
        size = 4 * 1024 * 1024 + 17
        pattern = bytes(range(256)) * 64
        payload = (pattern * ((size // len(pattern)) + 1))[:size]
        dest.write_bytes(payload)
        token = grant_mod.mint(GRANT, claims(artifact="download"))
        playback = grant_mod.mint(GRANT, claims())
        path = f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}"
        refused = self._req(f"/media/{VIDEO}/r/{REV}/download.mp4?t={playback}")
        self.assertEqual(refused[0], 403, refused[2])
        self.assertEqual(refused[2], b"forbidden")
        opens: list[str] = []
        reads: list[int] = []
        real_open = Path.open

        def tracing_open(file_path, *args, **kwargs):
            handle = real_open(file_path, *args, **kwargs)
            if file_path.name != "download.mp4":
                return handle
            opens.append("open")
            real_read = handle.read

            def read(n=-1):
                reads.append(-1 if n is None else int(n))
                return real_read(n)

            handle.read = read
            return handle

        with patch.object(Path, "open", tracing_open):
            head = self._req(path, method="HEAD")
            self.assertEqual(head[0], 200, head[2])
            self.assertEqual(head[2], b"")
            self.assertEqual(head[1].get("Content-Length", head[1].get("content-length")), str(size))
            self.assertEqual(opens, [])
            self.assertEqual(reads, [])
            status, headers, body = self._req(path)
            self.assertEqual(status, 200, body[:40])
            self.assertEqual(body, payload)
            self.assertEqual(headers.get("Content-Length", headers.get("content-length")), str(size))
            self.assertIn("bytes", headers.get("Accept-Ranges", headers.get("accept-ranges", "")))
            self.assertTrue(reads)
            self.assertTrue(all(0 < item <= server.DOWNLOAD_CHUNK_BYTES for item in reads))
            reads.clear()
            ranged = self._req(path, headers={"Range": "bytes=1000-1099"})
            self.assertEqual(ranged[0], 206, ranged[2])
            self.assertEqual(ranged[2], payload[1000:1100])
            content_range = ranged[1].get("Content-Range", ranged[1].get("content-range", ""))
            self.assertEqual(content_range, f"bytes 1000-1099/{size}")
            wide_end = server.DOWNLOAD_CHUNK_BYTES + 1000
            reads.clear()
            wide = self._req(path, headers={"Range": f"bytes=0-{wide_end}"})
            self.assertEqual(wide[0], 206, wide[2][:40])
            self.assertEqual(wide[2], payload[: wide_end + 1])
            self.assertTrue(reads)
            self.assertTrue(all(0 < item <= server.DOWNLOAD_CHUNK_BYTES for item in reads))
            self.assertGreater(len(reads), 1)
            missing = self._req(path, headers={"Range": f"bytes={size}-"})
            self.assertEqual(missing[0], 416, missing[2])
            self.assertEqual(missing[2], b"range")

    def test_playback_waits_for_at_most_one_download_encode(self) -> None:
        self._write_source(duration=4.0, gop=30)
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        prepared = self._prepare_revision(end=3.8)
        self.assertGreater(int(prepared["segmentCount"]), 1, prepared)
        playback = grant_mod.mint(GRANT, claims())
        first_entered = threading.Event()
        release_first = threading.Event()
        later_entered = threading.Event()
        release_later = threading.Event()
        real = lib_origin._encode_pyav
        phase = {"n": 0}

        def encode(frames, dest, profile):
            index = phase["n"]
            phase["n"] += 1
            if index == 0:
                first_entered.set()
                self.assertTrue(release_first.wait(15), "first download encode was not released")
            else:
                later_entered.set()
                self.assertTrue(release_later.wait(15), "later download encode was not released")
            return real(frames, dest, profile)

        lib_origin._encode_pyav = encode
        try:
            status, _, body = self._post_download()
            self.assertEqual(status, 202, body)
            self.assertTrue(first_entered.wait(20), "download encode did not start")
            result: dict = {}

            def play() -> None:
                result["hit"] = self._req(f"/media/{VIDEO}/r/{REV}/seg/0.m4s?t={playback}")

            thread = threading.Thread(target=play)
            thread.start()
            deadline = time.time() + 5
            waiting = False
            while time.time() < deadline:
                origins = [item[0] for item in self.app._origins.values()]
                if any(origin.playback_waiting() for origin in origins):
                    waiting = True
                    break
                time.sleep(0.01)
            self.assertTrue(waiting, "playback did not register while the download encode held the lock")
            release_first.set()
            thread.join(15)
            self.assertFalse(thread.is_alive(), "playback waited behind a later download encode")
            self.assertFalse(later_entered.is_set(), phase)
            hit = result["hit"]
            self.assertEqual(hit[0], 200, hit[2][:80])
            self.assertGreater(len(hit[2]), 8)
            release_later.set()
            self._wait_ready()
        finally:
            release_first.set()
            release_later.set()
            lib_origin._encode_pyav = real
            self.app.drain_downloads(30)

    def test_multi_segment_download_keeps_frame_order(self) -> None:
        self._write_source(duration=4.0, gop=30)
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        prepared = self._prepare_revision(end=3.8)
        self.assertGreater(int(prepared["segmentCount"]), 1, prepared)
        token = grant_mod.mint(GRANT, claims(artifact="download"))
        playback = grant_mod.mint(GRANT, claims())
        status, _, body = self._post_download()
        self.assertEqual(status, 202, body)
        self._wait_ready()
        status, _, media = self._req(f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}")
        self.assertEqual(status, 200, media[:80])
        playlist = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={playback}")
        self.assertEqual(playlist[0], 200, playlist[2][:80])
        self.assertGreater(playlist[2].decode().count("#EXTINF:"), 1)
        expected = self._playlist_duration(playlist[2])
        self.assertAlmostEqual(expected, float(prepared["playlistDurationSeconds"]), delta=0.2)
        probed = self.root / "ordered.mp4"
        probed.write_bytes(media)
        duration_probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(probed)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(duration_probe.returncode, 0, duration_probe.stderr.decode()[-400:])
        self.assertAlmostEqual(float(duration_probe.stdout.decode().strip()), expected, delta=0.2)
        frames = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0",
                "-show_entries", "frame=pts_time", "-of", "csv=p=0", str(probed),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(frames.returncode, 0, frames.stderr.decode()[-400:])
        pts = []
        for line in frames.stdout.decode().splitlines():
            text = line.strip().rstrip(",")
            if text:
                pts.append(float(text))
        self.assertGreater(len(pts), 2)
        self.assertAlmostEqual(pts[0], 0.0, delta=0.05)
        self.assertAlmostEqual(pts[-1], expected, delta=0.2)
        self.assertGreater(pts[-1], pts[0])
        for prev, nxt in zip(pts, pts[1:]):
            self.assertGreaterEqual(nxt + 1e-6, prev)

    def test_corrupt_cached_segment_download_regenerates(self) -> None:
        self._write_source()
        self._prepare_source(f"owner/{VIDEO}/source/original.mp4")
        self._prepare_revision()
        playback = grant_mod.mint(GRANT, claims())
        status, _, seg = self._req(f"/media/{VIDEO}/r/{REV}/seg/0.m4s?t={playback}")
        self.assertEqual(status, 200, seg[:80])
        origin = next(iter(self.app._origins.values()))[0]
        self.assertIn(0, origin._segment_bytes)
        segment = origin.segment_path(0)
        segment.write_bytes(b"corrupt-segment")
        lib_origin.sidecar_path(segment).write_text("{")
        status, _, body = self._post_download()
        self.assertEqual(status, 202, body)
        deadline = time.time() + 30
        last = body
        while time.time() < deadline:
            status, _, last = self._post_download()
            if status == 200:
                break
            if status == 500:
                self.fail(f"download build failed on corrupt cached segment: {last!r}")
            time.sleep(0.05)
        self.assertEqual(status, 200, last)
        self.assertTrue(any(row.get("integrity_retry") for row in origin.productions))
        token = grant_mod.mint(GRANT, claims(artifact="download"))
        status, _, media = self._req(f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}")
        self.assertEqual(status, 200, media[:80])
        self.assertIn(b"ftyp", media)


if __name__ == "__main__":
    unittest.main(verbosity=2)
