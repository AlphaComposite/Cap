"""500 unavailable responses log one class or reason and nothing else."""
from __future__ import annotations

import contextlib
import io
import json
import socket
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import grant as grant_mod
import lib_origin
from publication import MemoryPublication, PublicationRow, RevisionRow, SourceRow, VideoRow
from server import OriginApp, SideArtifactMissing, SideArtifactRejected, serve
from service_auth import sign_request
from storage import LocalObjectStore

GRANT = b"grant-secret-grant-secret-grant-01"
SERVICE = b"service-token-service-token-svc01"
VIDEO = "vidlogfail1"
REV = "revlogfail1"
SOURCE = "sourcelog1"
LEAK = "Table 'cap.origin_video' doesn't exist"


class ProgrammingError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(code, message)


class LookupFailureStore(MemoryPublication):
    def authorize(self, video_id: str, revision_id: str):
        raise ProgrammingError(1146, LEAK)


def _failed(text: str, prefix: str) -> list[str]:
    head = prefix + " "
    return [line for line in text.splitlines() if line == prefix or line.startswith(head)]


class FailureLoggingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "cache"
        self.objects = Path(self.tmp.name) / "objects"
        self.objects.mkdir()
        self.store = LookupFailureStore()
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

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        lib_origin.reset_process_state()
        self.tmp.cleanup()

    def _req(self, path: str, method: str = "GET", headers=None, body: bytes | None = None):
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def _service(self, method: str, path: str, body: bytes = b"") -> dict[str, str]:
        return {"x-cap-origin-service": sign_request(SERVICE, method, path, body, now=1_000)}

    def _raw(self, target: str) -> tuple[int, bytes]:
        address = self.httpd.server_address
        host = str(address[0])
        port = int(address[1])
        request = (
            f"GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        ).encode("ascii")
        raw = b""
        try:
            with socket.create_connection((host, port), timeout=5) as sock:
                sock.settimeout(5)
                sock.sendall(request)
                chunks: list[bytes] = []
                while True:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    chunks.append(chunk)
                raw = b"".join(chunks)
        except OSError:
            return 0, raw
        head, sep, rest = raw.partition(b"\r\n\r\n")
        if not sep:
            return 0, raw
        parts = head.split(b"\r\n", 1)[0].split()
        if len(parts) < 2 or not parts[1].isdigit():
            return 0, rest
        length = None
        for line in head.split(b"\r\n")[1:]:
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1].strip())
        return int(parts[1]), rest if length is None else rest[:length]

    def _media_token(self, grant_id: str) -> str:
        ready = MemoryPublication()
        ready.put_video(VideoRow(VIDEO, True, False, None))
        ready.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        ready.put_revision(RevisionRow(REV, VIDEO, "intentlog1", SOURCE, 1, "CURRENT"))
        self.app.store = ready
        return grant_mod.mint(
            GRANT,
            {
                "exp": 1_060,
                "grantId": grant_id,
                "iat": 1_000,
                "policyEpoch": 3,
                "publicationEpoch": 2,
                "revisionId": REV,
                "v": 1,
                "videoId": VIDEO,
            },
        )

    def test_media_lookup_failure_logs_class_only(self) -> None:
        token = grant_mod.mint(
            GRANT,
            {
                "exp": 1_060,
                "grantId": "grant-log-fail-001",
                "iat": 1_000,
                "policyEpoch": 3,
                "publicationEpoch": 2,
                "revisionId": REV,
                "v": 1,
                "videoId": VIDEO,
            },
        )
        path = f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}"
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            status, body = self._req(path)
        self.assertEqual(status, 500)
        self.assertEqual(body, b"unavailable")
        lines = _failed(buf.getvalue(), "media-failed ProgrammingError")
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertIn(VIDEO, line)
        self.assertIn(REV, line)
        self.assertIn("kind=playlist.m3u8", line)
        self.assertNotIn(token, line)
        self.assertNotIn("doesn't exist", line)
        self.assertNotIn("t=", line)
        self.assertNotIn(token, buf.getvalue())

    def test_media_artifact_failure_logs_class_only(self) -> None:
        ready = MemoryPublication()
        ready.put_video(VideoRow(VIDEO, True, False, None))
        ready.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        ready.put_revision(RevisionRow(REV, VIDEO, "intentlog1", SOURCE, 1, "CURRENT"))
        self.app.store = ready
        token = grant_mod.mint(
            GRANT,
            {
                "exp": 1_060,
                "grantId": "grant-log-fail-002",
                "iat": 1_000,
                "policyEpoch": 3,
                "publicationEpoch": 2,
                "revisionId": REV,
                "v": 1,
                "videoId": VIDEO,
            },
        )
        leaked = ProgrammingError(1146, LEAK + " t=grant-token")
        buf = io.StringIO()
        with patch.object(self.app, "_artifact", side_effect=leaked):
            with contextlib.redirect_stderr(buf):
                status, body = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertEqual(status, 500)
        self.assertEqual(body, b"unavailable")
        lines = _failed(buf.getvalue(), "media-failed ProgrammingError")
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertIn(VIDEO, line)
        self.assertIn(REV, line)
        self.assertIn("kind=playlist.m3u8", line)
        self.assertNotIn(token, line)
        self.assertNotIn("doesn't exist", line)
        self.assertNotIn("t=", line)

    def test_unauthorized_media_is_not_logged_as_failure(self) -> None:
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            status, body = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8")
        self.assertEqual(status, 401)
        self.assertEqual(body, b"unauthorized")
        self.assertEqual(_failed(buf.getvalue(), "media-failed"), [])

    def test_revision_prepare_failure_logs_class_only(self) -> None:
        self.store.put_video(VideoRow(VIDEO, True, False, None))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intentlog1", SOURCE, 1, "CURRENT"))
        body = json.dumps(
            {
                "keepRanges": [{"start": 0.0, "end": 1.0}],
                "sourceId": SOURCE,
                "videoId": VIDEO,
            }
        ).encode()
        path = f"/internal/revisions/{REV}/prepare"
        headers = {
            "x-cap-origin-service": sign_request(SERVICE, "POST", path, body, now=1_000),
            "_body": body,
        }
        leaked = ProgrammingError(1146, "Table 'cap.edit_revision' doesn't exist t=grant-token")
        buf = io.StringIO()
        with patch.object(self.app, "_origin_for", side_effect=leaked):
            with contextlib.redirect_stderr(buf):
                status, payload, content_type, _extra = self.app.handle("POST", path, headers)
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(content_type, "text/plain")
        lines = _failed(buf.getvalue(), "revision-prepare-failed ProgrammingError")
        self.assertEqual(len(lines), 1)
        line = lines[0]
        self.assertIn(VIDEO, line)
        self.assertIn(REV, line)
        self.assertNotIn("doesn't exist", line)
        self.assertNotIn("t=", line)
        self.assertNotIn("grant-token", line)
        self.assertNotIn("doesn't exist", buf.getvalue())

    def test_source_prepare_unbound_logs_exact_reason(self) -> None:
        path = f"/internal/sources/{VIDEO}/prepare"
        body = json.dumps({"sourceId": SOURCE, "sourceKey": "sources/log-key"}).encode()
        self.store.put_source(SourceRow(VIDEO, "sources/log-key", "0" * 64, "LIVE"))
        original = self.cache / "original.mp4"
        original.write_bytes(b"x")
        buf = io.StringIO()
        with patch.object(self.app, "_materialize_original", return_value=original), patch(
            "server._reject_bad_media", return_value=None
        ), patch.object(self.app, "_bound_mezzanine", return_value=None), contextlib.redirect_stderr(buf):
            status, payload = self._req(path, "POST", self._service("POST", path, body), body)
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(buf.getvalue(), f"source-prepare-failed MezzanineUnbound video={VIDEO}\n")

    def test_revision_prepare_join_timeout_logs_exact_reason(self) -> None:
        self.store.put_video(VideoRow(VIDEO, True, False, None))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intentlog1", SOURCE, 1, "CURRENT"))
        body = json.dumps(
            {"keepRanges": [{"start": 0.0, "end": 1.0}], "sourceId": SOURCE, "videoId": VIDEO}
        ).encode()
        path = f"/internal/revisions/{REV}/prepare"
        slot = lib_origin.EncodeSlot(VIDEO, "spec", REV)
        buf = io.StringIO()
        with patch("server.lib_origin.begin_revision_encode", return_value=(slot, True)), patch(
            "server.limits.FFMPEG_TIMEOUT_S", 0
        ), contextlib.redirect_stderr(buf):
            status, payload = self._req(path, "POST", self._service("POST", path, body), body)
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(
            buf.getvalue(),
            f"revision-prepare-start revision={REV}\n"
            f"revision-prepare-failed JoinTimeout video={VIDEO} rev={REV}\n",
        )

    def test_revision_prepare_undecoded_logs_exact_reason(self) -> None:
        self.store.put_video(VideoRow(VIDEO, True, False, None))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intentlog1", SOURCE, 1, "CURRENT"))
        body = json.dumps(
            {"keepRanges": [{"start": 0.0, "end": 1.0}], "sourceId": SOURCE, "videoId": VIDEO}
        ).encode()
        path = f"/internal/revisions/{REV}/prepare"
        slot = lib_origin.EncodeSlot(VIDEO, "spec", REV)
        slot.done.set()

        class _Origin:
            rev = "ns-log-fail"
            playlist = b"#EXTM3U\n"
            segments: list = []
            profile = type("Profile", (), {"timescale": 90000})()

            def ensure_init(self) -> bytes:
                return b"init"

            def ensure(self, _index: int) -> bytes:
                return b"seg"

        buf = io.StringIO()
        with patch("server.lib_origin.begin_revision_encode", return_value=(slot, True)), patch(
            "server.limits.FFMPEG_TIMEOUT_S", 0
        ), patch.object(self.app, "_origin_for", return_value=_Origin()), patch(
            "server._decode_check", return_value=3
        ), patch.object(
            self.app, "_write_side_artifacts", return_value=(b"vtt", b"chap")
        ), contextlib.redirect_stderr(buf):
            status, payload = self._req(path, "POST", self._service("POST", path, body), body)
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(
            buf.getvalue(),
            f"revision-prepare-start revision={REV}\n"
            f"revision-prepare-failed Undecoded video={VIDEO} rev={REV} decoded=3\n",
        )

    def test_artifact_namespace_mismatch_logs_exact_reason(self) -> None:
        self.store.put_revision(RevisionRow(REV, VIDEO, "intentlog1", SOURCE, 1, "CURRENT"))
        root = self.cache / "revisions" / REV
        root.mkdir(parents=True)
        (root / "ranges.json").write_text("[]")
        (root / "namespace.txt").write_text("bound-namespace")
        path = f"/internal/revisions/{REV}/artifact/playlist.m3u8"

        class _Origin:
            rev = "other-namespace"

        buf = io.StringIO()
        with patch.object(self.app, "_origin_for", return_value=_Origin()), contextlib.redirect_stderr(buf):
            status, payload = self._req(path, headers=self._service("GET", path))
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(
            buf.getvalue(),
            f"artifact-failed NamespaceMismatch video={VIDEO} rev={REV} kind=playlist.m3u8\n",
        )

    def test_internal_artifact_missing_side_logs_exact_class(self) -> None:
        self.store.put_revision(RevisionRow(REV, VIDEO, "intentlog1", SOURCE, 1, "CURRENT"))
        root = self.cache / "revisions" / REV
        root.mkdir(parents=True)
        (root / "ranges.json").write_text("[]")
        (root / "namespace.txt").write_text("bound-namespace")
        path = f"/internal/revisions/{REV}/artifact/captions.vtt"

        class _Origin:
            rev = "bound-namespace"

        buf = io.StringIO()
        with patch.object(self.app, "_origin_for", return_value=_Origin()), contextlib.redirect_stderr(buf):
            status, payload = self._req(path, headers=self._service("GET", path))
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(
            buf.getvalue(),
            f"artifact-failed SideArtifactMissing video={VIDEO} rev={REV} kind=captions.vtt\n",
        )

    def test_media_side_artifact_rejected_logs_exact_class(self) -> None:
        token = self._media_token("grant-log-fail-003")
        leaked = SideArtifactRejected(LEAK + " t=grant-token")
        path = f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}"
        buf = io.StringIO()
        with patch.object(self.app, "_artifact", side_effect=leaked), contextlib.redirect_stderr(buf):
            status, payload = self._req(path)
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(
            buf.getvalue(),
            f"media-failed SideArtifactRejected video={VIDEO} rev={REV} kind=playlist.m3u8\n",
        )

    def test_media_missing_side_artifact_is_not_logged(self) -> None:
        token = self._media_token("grant-log-fail-004")
        path = f"/media/{VIDEO}/r/{REV}/captions.vtt?t={token}"
        buf = io.StringIO()
        with patch.object(
            self.app, "_artifact", side_effect=SideArtifactMissing("captions.vtt")
        ), contextlib.redirect_stderr(buf):
            status, payload = self._req(path)
        self.assertEqual(status, 404)
        self.assertEqual(payload, b"not found")
        self.assertEqual(buf.getvalue(), "")

    def test_dispatch_handle_failure_logs_exact_class(self) -> None:
        buf = io.StringIO()
        with patch.object(self.app, "handle", side_effect=ProgrammingError(1146, LEAK)), contextlib.redirect_stderr(
            buf
        ):
            status, payload = self._req("/missing")
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(buf.getvalue(), "dispatch-failed ProgrammingError\n")

    def test_dispatch_media_path_failure_logs_exact_route_line(self) -> None:
        token = "grant-token-must-not-leak"
        path = f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}"
        buf = io.StringIO()
        with patch.object(
            self.app, "handle", side_effect=ProgrammingError(1146, LEAK + " " + token)
        ), contextlib.redirect_stderr(buf):
            status, payload = self._req(path)
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(
            buf.getvalue(),
            f"media-failed ProgrammingError video={VIDEO} rev={REV} kind=playlist.m3u8\n",
        )

    def test_dispatch_unparseable_target_still_unavailable(self) -> None:
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            status, payload = self._raw("http://[")
        self.assertEqual(status, 500)
        self.assertEqual(payload, b"unavailable")
        self.assertEqual(buf.getvalue(), "dispatch-failed ValueError\n")

    def test_not_found_writes_no_failure_line(self) -> None:
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            status, payload = self._req("/missing")
        self.assertEqual(status, 404)
        self.assertEqual(payload, b"not found")
        self.assertEqual(buf.getvalue(), "")
