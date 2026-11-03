from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class ArtifactNamespaceTests(unittest.TestCase):
    def test_every_warm_artifact_names_the_complete_persisted_namespace(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = object.__new__(server.OriginApp)
            app.cache = Path(tmp)
            app.service_secret = b"fixture-secret" * 3
            row = SimpleNamespace(video_id="video1234", revision_id="revision1234", source_id="source1234", generation=1)
            app.store = Mock()
            app.store.revision.return_value = row
            namespace = "/".join(char * 64 for char in "abcd")
            origin = SimpleNamespace(rev="c" * 64, namespace=namespace, playlist=b"playlist", ensure_init=lambda: b"init", ensure=lambda n: b"segment")
            app._origin_for = Mock(return_value=origin)
            ranges = app.cache / "revisions" / row.revision_id / "ranges.json"
            ranges.parent.mkdir(parents=True)
            ranges.write_text(json.dumps([[2, 5]]))
            server._write_namespace(app.cache, row.revision_id, origin.rev)
            for name in ["playlist.m3u8", "init.mp4", "seg/0.m4s", "captions.vtt", "chapters.json", "thumbnail.jpg"]:
                with self.subTest(name=name), patch.object(server, "read_verified_side", return_value=b"side"):
                    match = re.fullmatch(r"(?P<rev>[^/]+)/(?P<name>seg/(?P<n>\d+)\.m4s|.+)", f"{row.revision_id}/{name}")
                    assert match is not None
                    status, _, _, headers = app._internal_artifact(match)
                    self.assertEqual(status, 200)
                    self.assertEqual(headers["X-Cap-Namespace"], namespace)


if __name__ == "__main__":
    unittest.main()
