from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server
import service_auth


class DurableExportTests(unittest.TestCase):
    def test_authenticated_get_streams_finalized_current_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = object.__new__(server.OriginApp)
            app.cache = Path(tmp)
            app.service_secret = b"service-token-service-token-svc01"
            app.now = lambda: 1000
            row = SimpleNamespace(video_id="video1234", revision_id="revision1234", source_id="source1234", generation=7)
            app.store = Mock()
            app.store.revision.return_value = row
            app._download_current = Mock(return_value=True)
            namespace = "/".join(["a" * 64] * 4)
            path = app.cache / "ns" / namespace / "download.mp4"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"edited-final-bytes")
            app._download_media_path = Mock(return_value=path)
            server._write_namespace(app.cache, row.revision_id, "a" * 64)
            route = f"/internal/revisions/{row.revision_id}/download"
            auth = service_auth.sign_request(app.service_secret, "GET", route, b"", now=1000)
            status, body, content_type, headers = app.handle("GET", route, {server.SERVICE_HEADER: auth})
            self.assertEqual(status, 200)
            self.assertIsInstance(body, server.StreamedBody)
            assert isinstance(body, server.StreamedBody)
            self.assertEqual(b"".join(body), b"edited-final-bytes")
            self.assertEqual(headers["X-Cap-Revision-Id"], row.revision_id)
            self.assertEqual(headers["X-Cap-Source-Id"], row.source_id)
            self.assertEqual(headers["X-Cap-Namespace"], namespace)
            self.assertEqual(content_type, "video/mp4")
            self.assertEqual(app.handle("GET", route, {})[0], 401)
            app._download_current.return_value = False
            self.assertEqual(app.handle("GET", route, {server.SERVICE_HEADER: auth})[0], 409)
            self.assertTrue(path.is_file())


if __name__ == "__main__":
    unittest.main()
