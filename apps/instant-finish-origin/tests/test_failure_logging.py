"""500 unavailable responses name the exception class and nothing else."""
from __future__ import annotations

import contextlib
import io
import json
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
from publication import MemoryPublication, PublicationRow, RevisionRow, VideoRow
from server import OriginApp, serve
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
