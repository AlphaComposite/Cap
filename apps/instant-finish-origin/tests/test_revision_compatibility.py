import hashlib
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lib_origin
import server
from publication import MemoryPublication, RevisionRow
from storage import LocalObjectStore

VIDEO, REV, SOURCE = "compatvideo01", "compatrevision01", "compatsource01"
RANGES = [{"start": 0, "end": 6}]


class RevisionCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cache = self.root / "cache"
        self.mezz = self.root / "mezz.mp4"
        self.mezz.write_bytes(b"mezz")
        self.audio = self.root / "audio.mp4"
        self.audio.write_bytes(b"audio")
        self.store = MemoryPublication()
        self.row = RevisionRow(REV, VIDEO, "intent", SOURCE, 1, "CURRENT")
        self.store.put_revision(self.row)
        self.app = server.OriginApp(self.store, LocalObjectStore(self.root), self.cache, b"g" * 32, b"s" * 32)
        self.addCleanup(lib_origin.reset_revision_encodes)
        self.addCleanup(self.app.drain_downloads, 3)
        self.app._persist_ranges(REV, RANGES)
        self.profile = lib_origin.Profile(1000, 320, 180)
        self.ticks = list(range(0, 6000, 100))
        self.durs = [100] * len(self.ticks)
        self.keys = [{"index": i, "pts": self.ticks[i]} for i in range(0, 60, 10)]
        for mock in (
            patch("lib_origin.cached_mezz_index", side_effect=lambda _: ("a" * 64, SimpleNamespace(timescale=1000, width=320, height=180, has_b_frames=False), self.ticks, self.durs, self.keys, {})),
            patch("lib_audio.load_audio_index", return_value=(SimpleNamespace(source_sha256="b" * 64), {})),
            patch("lib_audio.audio_source_for", return_value=self.audio),
            patch("lib_origin.encoder_implementation_ids", return_value={"audio": "frozen-aac", "video": "frozen-x264"}),
            patch("lib_origin.encoder_threads", return_value="2"),
            patch.object(self.app, "_source_files", return_value=(self.mezz, self.audio, "c" * 64)),
        ):
            mock.start()
            self.addCleanup(mock.stop)
        identity = lib_origin.encoder_identity(self.profile)
        identity["segment_plan"] = 2
        self.encoder = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        content = {"encoder": self.encoder, "mapping": 1, "segment_plan": 2, "source_sha256": "c" * 64, "spec": lib_origin.canonical_spec(RANGES).decode()}
        self.content_hash = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        self.namespace = f'{"a" * 64}/{"b" * 64}/{self.content_hash}/{self.encoder}'
        self.legacy_cache = self.cache / "ns" / self.namespace
        server._write_namespace(self.cache, REV, self.content_hash)
        self.init = lib_origin._box(b"avcC", b"v2-init")
        self.bind(self.legacy_cache / "init.mp4", self.init, "init", None)
        self.bind(self.legacy_cache / "seg/0.m4s", b"v2-seg0", "seg", 0)
        self.bind(self.legacy_cache / "seg/2.m4s", b"v2-seg2", "seg", 2)
        self.legacy_cache.joinpath("download.mp4").write_bytes(b"v2-download")
        record = {"audio": "b" * 64, "encoder": self.encoder, "mezz": "a" * 64, "namespace": self.namespace, "rev": self.content_hash, "segment_plan": 2, "source": "c" * 64, "source_kind": "mezzanine"}
        self.bind(self.legacy_cache / "namespace.json", (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode(), "namespace", None)
        self.namespace_before = self.legacy_cache.joinpath("namespace.json").read_bytes()
        self.snap = {"revision": self.row, "source_sha256": "c" * 64, "source_live_key": "original"}

    def bind(self, path, data, artifact, seg):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        binding = {"artifact": artifact, "audio_align": 6, "encoder": self.encoder, "namespace": self.namespace, "rev": self.content_hash, "seg": seg, "segment_plan": 2, "source": "a" * 64, "sha256": hashlib.sha256(data).hexdigest()}
        lib_origin.sidecar_path(path).write_text(json.dumps(binding))

    def artifact(self, kind):
        match = re.match(server.MEDIA_RE, f"/media/{VIDEO}/r/{REV}/{kind}")
        assert match is not None
        return self.app._artifact(self.snap, kind, match, "grant")[0]

    def test_persisted_v2_playlist_init_and_segment_keep_exact_namespace(self):
        playlist = self.artifact("playlist.m3u8")
        self.assertIn(b"#EXTINF:1.0,", playlist)
        self.assertEqual(self.artifact("init.mp4"), self.init)
        self.assertEqual(self.artifact("seg/0.m4s"), b"v2-seg0")
        self.assertEqual(self.artifact("seg/2.m4s"), b"v2-seg2")
        origin = next(iter(self.app._origins.values()))[0]
        self.assertEqual(origin.encoder_hash, self.encoder)
        self.assertEqual(origin.namespace, self.namespace)
        self.assertEqual([[f.index for f in s.frames] for s in origin.segments], [list(range(0, 10)), list(range(10, 30)), list(range(30, 50)), list(range(50, 60))])
        self.assertEqual(self.legacy_cache.joinpath("namespace.json").read_bytes(), self.namespace_before)
        self.assertEqual(server._namespace(self.cache, REV), self.content_hash)

    def test_v2_without_keyframes_retains_historical_whole_prefix(self):
        self.keys.clear()
        playlist = self.artifact("playlist.m3u8")
        self.assertIn(b"#EXTINF:6.0,", playlist)
        self.assertNotIn(b"seg/1.m4s", playlist)

    def test_new_prepare_is_v3_and_does_not_alias_existing_v2_origin(self):
        self.artifact("playlist.m3u8")
        fresh_rev = "compatfresh01"
        self.store.put_revision(RevisionRow(fresh_rev, VIDEO, "pendinghash", SOURCE, 2, "PREPARING"))
        body = json.dumps({"videoId": VIDEO, "sourceId": SOURCE, "keepRanges": RANGES}).encode()
        with patch.object(lib_origin.Origin, "ensure_init", return_value=b"init"), patch.object(lib_origin.Origin, "ensure", return_value=b"seg0"), patch("server._decode_check", return_value=2), patch("server.schedule_thumbnail"):
            status, payload, _, _ = self.app._prepare_revision(fresh_rev, {"_body": body})
        self.assertEqual(status, 200, payload)
        attested = json.loads(payload)
        self.assertEqual(attested["segmentPlanVersion"], 3)
        fresh = self.app._origin_for(VIDEO, SOURCE, RANGES)
        self.assertIs(self.app._origin_for(VIDEO, SOURCE, RANGES, revision_id=fresh_rev), fresh)
        self.assertEqual(fresh.segments[0].duration_ticks, 500)
        self.assertNotEqual(fresh.encoder_hash, self.encoder)
        self.assertNotEqual(fresh.rev, self.content_hash)
        self.assertEqual(server._namespace(self.cache, fresh_rev), fresh.rev)
        self.assertIn(b"#EXTINF:1.0,", self.artifact("playlist.m3u8"))
        self.assertEqual(server._namespace(self.cache, REV), self.content_hash)

    def test_range_internal_and_download_readers_select_persisted_v2(self):
        self.assertIsNone(self.app._range_segment(self.snap, 2, "bytes=0-1", "video/mp4"))
        ranged = self.app._range_segment(self.snap, 2, "bytes=0-1", "video/mp4")
        assert ranged is not None
        self.assertEqual(ranged[1], b"v2")
        match = re.match(server.ARTIFACT_RE, f"/internal/revisions/{REV}/artifact/playlist.m3u8")
        assert match is not None
        status, body, _, _ = self.app._internal_artifact(match)
        self.assertEqual(status, 200, body)
        self.assertIn(b"#EXTINF:1.0,", body)
        self.assertEqual(self.app._download_media_path(self.snap), self.legacy_cache / "download.mp4")

    def test_download_request_and_worker_select_persisted_v2(self):
        with patch("server.remux_download"):
            status = self.app._request_download(REV)[0]
            self.app.drain_downloads(3)
        self.assertEqual(status, 200)
        captured = []
        job = server.DownloadJob()
        with patch("server._lower_child_priority"), patch("server.remux_download", side_effect=lambda origin, slot: captured.append(origin)):
            self.app._run_download(REV, VIDEO, SOURCE, RANGES, job)
        self.assertFalse(job.failed)
        self.assertEqual(captured[0].namespace, self.namespace)
        self.assertEqual(captured[0].segments[0].duration_ticks, 1000)

    def test_existing_revision_namespace_cannot_be_relabelled(self):
        with self.assertRaises(lib_origin.CacheIntegrityError):
            server._write_namespace(self.cache, REV, "d" * 64)
        self.assertEqual(server._namespace(self.cache, REV), self.content_hash)

    def test_unknown_namespace_is_rejected_without_creating_origin_cache(self):
        server._namespace_path(self.cache, REV).write_text("d" * 64)
        before = sorted(str(p.relative_to(self.cache)) for p in self.cache.rglob("*"))
        with self.assertRaises(lib_origin.CacheIntegrityError):
            self.artifact("playlist.m3u8")
        self.assertEqual(sorted(str(p.relative_to(self.cache)) for p in self.cache.rglob("*")), before)


if __name__ == "__main__":
    unittest.main()
