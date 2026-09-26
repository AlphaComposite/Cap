"""Origin unit tests. Encode cases need ffmpeg and PyAV."""
from __future__ import annotations

import hashlib
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

import grant as grant_mod
import lib_audio
import lib_origin
from publication import MemoryPublication, PublicationRow, RevisionRow, SourceRow, VideoRow
from server import OriginApp, serve
from service_auth import sign_request
import service_auth
from storage import LocalObjectStore, StorageError, assert_original_key

os.environ.setdefault("ORIGIN_DEBUG", "1")

GRANT = b"grant-secret-grant-secret-grant-01"
SERVICE = b"service-token-service-token-svc01"
VIDEO = "vidorigin01"
REV = "revorigin01"
SOURCE = "sourceid01"
ORACLE_RANGES = Path("/srv/styrir/scratch/cap-fzp-8-gate/scout-4/keep-ranges.json")
ORACLE_TABLE = Path("/srv/styrir/scratch/cap-fzp-8-gate/build-7/media/data/frame-table.json")


def claims(now: int = 1_000, **overrides) -> dict:
    row = {
        "exp": now + 60,
        "grantId": "grant-origin-0001",
        "iat": now,
        "policyEpoch": 3,
        "publicationEpoch": 2,
        "revisionId": REV,
        "v": 1,
        "videoId": VIDEO,
    }
    row.update(overrides)
    return row


class PlanTests(unittest.TestCase):
    def test_vfr_15360_and_16000(self) -> None:
        for tb, step in ((15360, 512), (16000, 533)):
            ticks = []
            durs = []
            cursor = 0
            for _ in range(90):
                dur = step if len(ticks) % 5 else step + 40
                ticks.append(cursor)
                durs.append(dur)
                cursor += dur
            ranges = [{"start": 0.0, "end": 0.15}, {"start": 1.0, "end": 1.4}]
            keyframes = [{"index": 0, "pts": 0}, {"index": 30, "pts": ticks[30]}]
            segments = lib_origin.plan_segments(ranges, ticks, durs, tb, keyframes)
            self.assertLessEqual(segments[0].duration_ticks, tb)
            self.assertGreaterEqual(len(segments[0].frames), 2)
            self.assertEqual(lib_origin.duration_ticks(segments), sum(frame.dur for seg in segments for frame in seg.frames))
            for segment in segments:
                lib_origin.require_kept(segment.frames, ranges, tb)
                text = lib_origin.extinf(segment.duration_ticks, tb)
                self.assertEqual(round(float(text) * tb), segment.duration_ticks)
            playlist = lib_origin.playlist_text(segments, tb)
            self.assertIn("#EXT-X-ENDLIST", playlist)
            self.assertNotIn("EXT-X-DISCONTINUITY", playlist)

    def test_243_range_oracle(self) -> None:
        if not ORACLE_RANGES.is_file() or not ORACLE_TABLE.is_file():
            self.skipTest("frozen oracle fixtures are not on this host")
        ranges = json.loads(ORACLE_RANGES.read_text())
        table = json.loads(ORACLE_TABLE.read_text())
        self.assertEqual(len(ranges), 243)
        segments = lib_origin.plan_segments(ranges, table["pts_tick"], table["dur_tick"], 15360, None)
        frames = [frame for segment in segments for frame in segment.frames]
        self.assertEqual(len(frames), 22378)
        self.assertEqual(lib_origin.duration_ticks(segments), 11444224)
        self.assertEqual(lib_origin.join_count(segments), 242)
        self.assertAlmostEqual(11444224 / 15360, 745.0666666666667, places=9)
        for frame in frames:
            self.assertIsNotNone(lib_origin.range_index_for(frame.src_pts, ranges, 15360))

    def test_removed_frame_refused(self) -> None:
        ranges = [{"start": 0.0, "end": 0.1}]
        frame = lib_origin.FrameRec(0, 15360, 512, 0, 0)
        with self.assertRaises(lib_origin.RemovedRangeError):
            lib_origin.require_kept((frame,), ranges, 15360)

    def test_gate_encode_options_and_old_hash(self) -> None:
        profile = lib_origin.Profile(15360, 1670, 1080)
        opts = lib_origin.jit_options()
        self.assertEqual(opts["bf"], "0")
        self.assertEqual(opts["crf"], "18")
        self.assertEqual(opts["preset"], "veryfast")
        self.assertEqual(opts["x264-params"], "scenecut=0:open-gop=0:b-adapt=0:repeat-headers=1")
        args = lib_origin.jit_args(profile)
        self.assertIn("-fps_mode", args)
        self.assertEqual(args[args.index("-fps_mode") + 1], "passthrough")
        self.assertEqual(args[args.index("-enc_time_base:v") + 1], "1/15360")
        self.assertNotEqual(lib_origin.encoder_config_hash(profile), lib_origin.legacy_encoder_hash(profile))
        other = lib_origin.Profile(16000, 1920, 966)
        self.assertNotEqual(lib_origin.encoder_config_hash(profile), lib_origin.encoder_config_hash(other))

    def test_no_show_frames(self) -> None:
        for path in ROOT.glob("*.py"):
            text = path.read_text()
            self.assertNotIn("-show_frames", text, path.name)

    def test_audio_policy(self) -> None:
        self.assertEqual(lib_audio.audio_rate_policy(48000), "native")
        self.assertEqual(lib_audio.audio_rate_policy(16000), "resample-16k")
        with self.assertRaises(lib_audio.AudioRejected):
            lib_audio.audio_rate_policy(8000)

    def test_aac_tfdt_offset_and_removed_sample(self) -> None:
        self.assertEqual(lib_audio.audio_tfdt(0, leading=True), 0)
        self.assertEqual(lib_audio.audio_tfdt(0), 1024)
        self.assertEqual(lib_audio.audio_tfdt(3), 3 * 1024 + 1024)
        ticks = [0, 512, 1024, 1536]
        durs = [512, 512, 512, 512]
        timeline = lib_audio.plan_timeline([{"start": 0.0, "end": 512 / 15360}], ticks, durs, 15360)
        removed = int(round(1024 / 15360 * 48000))
        self.assertIsNone(lib_audio.frame_span_index(timeline, removed))
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "out.aac"
            dest.write_bytes(b"sentinel")
            with self.assertRaises(lib_audio.RemovedRangeError):
                lib_audio.refuse_removed_sample(removed, timeline, dest)
            self.assertFalse(dest.exists())


class GrantTests(unittest.TestCase):
    def test_round_trip_and_rejects(self) -> None:
        token = grant_mod.mint(GRANT, claims())
        parsed = grant_mod.verify(GRANT, token, now=1010)
        self.assertEqual(parsed.video_id, VIDEO)
        with self.assertRaises(grant_mod.GrantError):
            grant_mod.verify(GRANT, token + "x", now=1010)
        with self.assertRaises(grant_mod.GrantError):
            grant_mod.verify(GRANT, token, now=1066)
        with self.assertRaises(grant_mod.GrantError):
            grant_mod.verify(b"other-secret-other-secret-other-01", token, now=1010)


class HttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "cache"
        self.objects = Path(self.tmp.name) / "objects"
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

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()
        lib_origin.reset_process_state()

    def _req(self, path: str, method: str = "GET", headers=None, body: bytes | None = None):
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def test_auth_matrix_and_no_source_route(self) -> None:
        token = grant_mod.mint(GRANT, claims())
        status, headers, _body = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8")
        self.assertEqual(status, 401)
        self.assertIn("no-store", headers.get("Cache-Control", headers.get("cache-control", "")))
        status, _, _ = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertEqual(status, 410)
        self.store.put_video(VideoRow(VIDEO, True, False, None))
        self.store.put_publication(PublicationRow(VIDEO, "otherrev01", 1, 2, 3))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intent", SOURCE, 1, "CURRENT"))
        status, _, _ = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertEqual(status, 410)
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 9, 3))
        status, _, _ = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertEqual(status, 410)
        wrong = grant_mod.mint(GRANT, claims(videoId="othervid01"))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        status, _, _ = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={wrong}")
        self.assertEqual(status, 403)
        status, _, _ = self._req(f"/media/{VIDEO}/source/original.mp4?t={token}")
        self.assertEqual(status, 404)
        status, _, _ = self._req(f"/media/{VIDEO}/r/{REV}/result.mp4?t={token}")
        self.assertEqual(status, 404)
        status, headers, body = self._req(f"/media/{VIDEO}/r/{REV}/download.mp4?t={token}")
        self.assertEqual(status, 202)
        self.assertIn(b"unavailable", body)
        self.assertIn("no-store", headers.get("Cache-Control", headers.get("cache-control", "")))
        status, _, _ = self._req("/internal/sources/vidorigin01/prepare", "POST", body=b"{}")
        self.assertEqual(status, 401)

    def test_epoch_changes_before_send(self) -> None:
        token = grant_mod.mint(GRANT, claims())
        self.store.put_video(VideoRow(VIDEO, True, False, None))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        self.store.put_revision(RevisionRow(REV, VIDEO, "intent-not-ready", SOURCE, 1, "CURRENT"))

        def flip(_snap) -> None:
            self.store.put_publication(PublicationRow(VIDEO, REV, 1, 8, 3))

        self.app.before_send = flip
        status, _, _ = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertIn(status, {410, 500})

    def test_refuses_result_key(self) -> None:
        with self.assertRaises(StorageError):
            assert_original_key("owner/video/result.mp4")
        with self.assertRaises(StorageError):
            assert_original_key("https://s3.example/cap/original.mp4?X-Amz-Signature=abc")


class MediaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cache = self.root / "cache"
        self.objects = self.root / "objects"
        self.objects.mkdir()
        self.store = MemoryPublication()
        self.app = OriginApp(self.store, LocalObjectStore(self.objects), self.cache, GRANT, SERVICE, now=lambda: 1_000)
        self.httpd = serve(self.app, "127.0.0.1", 0)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        lib_origin.reset_process_state()
        lib_audio.reset_aac_pool()
        self.tmp.cleanup()

    def _req(self, path: str, method: str = "GET", headers=None, body: bytes | None = None):
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def _write_source(self, timescale: int, audio_rate: int, duration: float = 1.2) -> str:
        key = f"owner/{VIDEO}/source/original.mp4"
        dest = self.objects / key
        dest.parent.mkdir(parents=True)
        cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=320x180:rate=30:duration={duration}",
            "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={audio_rate}:duration={duration}",
            "-c:v", "libx264", "-bf", "2", "-g", "60", "-pix_fmt", "yuv420p",
            "-video_track_timescale", str(timescale),
            "-c:a", "aac", "-ar", str(audio_rate), "-ac", "1",
            "-shortest", str(dest),
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if result.returncode:
            self.fail(result.stderr.decode()[-400:])
        return key

    def _service(self, method: str, path: str, body: bytes = b"") -> dict[str, str]:
        return {
            "x-cap-origin-service": sign_request(SERVICE, method, path, body, now=1_000),
            "Content-Type": "application/json",
        }

    def _prepare(self, key: str) -> dict:
        body = json.dumps({"sourceId": SOURCE, "sourceKey": key}).encode()
        path = f"/internal/sources/{VIDEO}/prepare"
        status, _, payload = self._req(
            path,
            "POST",
            self._service("POST", path, body),
            body,
        )
        self.assertEqual(status, 200, payload)
        return json.loads(payload)

    def test_mezzanine_stss_sha_and_16k(self) -> None:
        key = self._write_source(15360, 16000)
        prepared = self._prepare(key)
        self.assertTrue(prepared["ready"])
        self.assertFalse(prepared["hasBFrames"])
        self.assertEqual(prepared["timescale"], 15360)
        mezz = self.cache / "sources" / SOURCE / "mezz.mp4"
        original = self.cache / "sources" / SOURCE / "original.mp4"
        self.assertNotEqual(lib_origin.sha256_file(mezz), lib_origin.sha256_file(original))
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=has_b_frames,time_base", "-of", "json", str(mezz)],
            stdout=subprocess.PIPE, check=True,
        )
        stream = json.loads(probe.stdout)["streams"][0]
        self.assertEqual(stream["has_b_frames"], 0)
        self.assertEqual(stream["time_base"], "1/15360")
        self.assertIn(b"stss", mezz.read_bytes())
        audio = json.loads((original.with_suffix(".mp4.ppcm.json")).read_text())
        self.assertEqual(audio["resampled_from"], 16000)
        self.assertGreater(audio["samples"], 16000)

    def test_16000_timescale_mezz(self) -> None:
        key = self._write_source(16000, 48000, 0.8)
        prepared = self._prepare(key)
        self.assertEqual(prepared["timescale"], 16000)
        mezz = self.cache / "sources" / SOURCE / "mezz.mp4"
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base,has_b_frames", "-of", "json", str(mezz)],
            stdout=subprocess.PIPE, check=True,
        )
        stream = json.loads(probe.stdout)["streams"][0]
        self.assertEqual(stream["time_base"], "1/16000")
        self.assertEqual(stream["has_b_frames"], 0)

    def test_seg0_range_cache_and_warm(self) -> None:
        key = self._write_source(15360, 48000, 1.5)
        self._prepare(key)
        ranges = [{"start": 0.0, "end": 0.15}, {"start": 0.45, "end": 0.9}]
        self.store.put_revision(RevisionRow(REV, VIDEO, "pendinghash", SOURCE, 1, "READY"))
        body = json.dumps({
            "videoId": VIDEO,
            "sourceId": SOURCE,
            "keepRanges": ranges,
            "captions": [{"start": 0.02, "end": 0.08, "text": "kept"}, {"start": 0.2, "end": 0.3, "text": "cut"}],
            "chapters": [{"start": 0.0, "end": 0.1, "title": "Open"}],
        }).encode()
        path = f"/internal/revisions/{REV}/prepare"
        status, headers, payload = self._req(
            path,
            "POST",
            self._service("POST", path, body),
            body,
        )
        self.assertEqual(status, 200, payload)
        mac = next((value for key, value in headers.items() if key.lower() == "x-cap-origin-attestation"), "")
        self.assertTrue(service_auth.verify_attestation(SERVICE, mac, payload))
        prepared = json.loads(payload)
        for field in (
            "captionsSha256",
            "chaptersSha256",
            "decodedFrames",
            "initSha256",
            "intentId",
            "playlistHasEndList",
            "playlistSha256",
            "seg0Sha256",
            "segmentCount",
            "thumbnailSha256",
        ):
            self.assertIn(field, prepared)
        self.assertTrue(prepared["playlistHasEndList"])
        self.assertGreaterEqual(prepared["decodedFrames"], 1)
        self.assertGreaterEqual(prepared["seg0DecodedFrames"], 2)
        self.assertLessEqual(prepared["durationSeconds"], 0.7)
        self.store.put_video(VideoRow(VIDEO, True, False, "cap"))
        self.store.put_source(SourceRow(VIDEO, key, lib_origin.sha256_file(self.cache / "sources" / SOURCE / "original.mp4"), "live"))
        self.store.put_revision(RevisionRow(REV, VIDEO, prepared["intentId"], SOURCE, 1, "CURRENT"))
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        token = grant_mod.mint(GRANT, claims())
        status, headers, playlist = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertEqual(status, 200, playlist)
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        self.assertIn(f"init.mp4?t=", playlist.decode())
        self.assertIn("#EXT-X-ENDLIST", playlist.decode())
        self.assertNotIn(b"source", playlist)
        status, headers, init = self._req(f"/media/{VIDEO}/r/{REV}/init.mp4?t={token}", "HEAD")
        self.assertEqual(status, 200)
        self.assertGreater(int(headers.get("Content-Length", "0")), 0)
        self.assertEqual(init, b"")
        status, headers, seg = self._req(f"/media/{VIDEO}/r/{REV}/seg/0.m4s?t={token}", headers={"Range": "bytes=0-15"})
        self.assertEqual(status, 206)
        self.assertTrue(headers.get("Content-Range", "").startswith("bytes 0-15/"))
        self.assertEqual(len(seg), 16)
        self.assertIn("no-store", headers.get("Cache-Control", ""))
        origin = next(iter(self.app._origins.values()))[0]
        self.assertTrue(origin.productions)
        self.assertFalse(all(row["hit"] for row in origin.productions))
        self.assertLessEqual(origin.segments[0].duration_ticks / origin.profile.timescale, 0.2)
        side = origin.segment_path(0).with_name("0.m4s.bind.json")
        attested = origin.ensure(0)
        side.write_text(json.dumps({"encoder": lib_origin.legacy_encoder_hash(origin.profile)}))
        status, _, served = self._req(f"/media/{VIDEO}/r/{REV}/seg/0.m4s?t={token}")
        self.assertEqual(status, 200, served)
        self.assertEqual(served, attested)
        self.assertEqual(hashlib.sha256(served).hexdigest(), prepared["seg0Sha256"])
        origin._segment_bytes.clear()
        status, _, retried = self._req(f"/media/{VIDEO}/r/{REV}/seg/0.m4s?t={token}")
        self.assertIn(status, {200, 500})
        if status == 200:
            self.assertTrue(any(row["integrity_retry"] for row in origin.productions))
            self.assertNotEqual(retried, b"")
        lib_origin.expire_warm(time.time() + 10_000)
        self.assertEqual(lib_origin.warm_status(SOURCE), "miss")
        self.assertTrue(any(row["event"] == "evict" for row in lib_origin.WARM_LOG))
        captions = self._req(f"/media/{VIDEO}/r/{REV}/captions.vtt?t={token}")[2]
        self.assertIn(b"kept", captions)
        self.assertNotIn(b"cut", captions)
        self.app.before_send = lambda _snap: self.store.put_publication(PublicationRow(VIDEO, REV, 1, 99, 3))
        status, _, _ = self._req(f"/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}")
        self.assertEqual(status, 410)
        self.app.before_send = None
        self.store.put_publication(PublicationRow(VIDEO, REV, 1, 2, 3, current_generation=1))
        seg_path = origin.segment_path(0)
        seg_path.unlink(missing_ok=True)
        seg_path.with_name("0.m4s.bind.json").unlink(missing_ok=True)
        (self.cache / "sources" / SOURCE / "mezz.mp4").unlink()
        status, _, body = self._req(f"/media/{VIDEO}/r/{REV}/seg/0.m4s?t={token}")
        self.assertEqual(status, 500, body)
        self.assertNotIn(b"ftyp", body)
        self.assertNotIn(b"moof", body)

    def test_missing_mezz_refuses_finish(self) -> None:
        self.store.put_revision(RevisionRow(REV, VIDEO, "pendinghash", SOURCE, 1, "READY"))
        body = json.dumps({"videoId": VIDEO, "sourceId": SOURCE, "keepRanges": [{"start": 0, "end": 1}]}).encode()
        path = f"/internal/revisions/{REV}/prepare"
        status, _, payload = self._req(
            path,
            "POST",
            self._service("POST", path, body),
            body,
        )
        self.assertEqual(status, 409, payload)
        self.assertIn(b"mezzanine_required", payload)

    def test_warm_expiry_and_contention(self) -> None:
        key = self._write_source(15360, 48000, 1.2)
        self._prepare(key)
        lib_origin.expire_warm(time.time() + 10_000)
        self.assertEqual(lib_origin.warm_status(SOURCE), "miss")
        mezz = self.cache / "sources" / SOURCE / "mezz.mp4"
        original = self.cache / "sources" / SOURCE / "original.mp4"
        lib_origin.warm_for_source(SOURCE, mezz, original, ttl_s=0.05)
        self.assertEqual(lib_origin.warm_status(SOURCE), "warm")
        time.sleep(0.06)
        self.assertEqual(lib_origin.expire_warm(), 1)
        self.assertEqual(lib_origin.warm_status(SOURCE), "miss")
        stop = threading.Event()

        def burn() -> None:
            while not stop.is_set():
                x = 0
                for i in range(10000):
                    x += i

        thread = threading.Thread(target=burn)
        thread.start()
        try:
            ranges = [{"start": 0.0, "end": 0.15}, {"start": 0.4, "end": 0.8}]
            origin = lib_origin.Origin(
                mezz,
                original,
                self.cache / "contention",
                ranges,
                lib_origin.sha256_file(original),
            )
            lib_audio.reset_aac_pool()
            body = origin.ensure(0)
            init = origin.ensure_init()
            self.assertTrue(body.startswith(b"\x00\x00\x00"))
            row = origin.productions[-1]
            self.assertFalse(row["hit"])
            self.assertTrue(row["aac_pool_miss"])
            reads = {"n": 0}
            real_read = origin._read_bound

            def counting(path, artifact, seg):
                reads["n"] += 1
                return real_read(path, artifact, seg)

            origin._read_bound = counting
            self.assertEqual(origin.ensure(0), body)
            self.assertEqual(origin.ensure_init(), init)
            self.assertEqual(reads["n"], 0)
            import index as index_mod
            probes = index_mod.probe_calls
            again = lib_origin.Origin(
                mezz,
                original,
                self.cache / "ctor-cache",
                [{"start": 0.1, "end": 0.5}],
                lib_origin.sha256_file(original),
            )
            self.assertEqual(index_mod.probe_calls, probes)
            self.assertEqual(again.profile.timescale, origin.profile.timescale)
            print(f"SEG0 ensure_ms={row['ensure_ms']} duration_s={row['duration_s']} aac_miss={row['aac_pool_miss']}")
        finally:
            stop.set()
            thread.join()


if __name__ == "__main__":
    unittest.main(verbosity=2)
