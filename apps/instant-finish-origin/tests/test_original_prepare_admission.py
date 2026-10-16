"""Original-upload admission is leased, video-scoped and prepare-only."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import lib_origin
from publication import MemoryPublication, MySQLPublication, RevisionRow, SourceRow, VideoRow
from server import OriginApp, cache_source_id, drain_thumbnails
from service_auth import SERVICE_HEADER, verify_request
from storage import LocalObjectStore, PresignedObjectStore, S3ObjectStore, StorageError, assert_original_key

VIDEO = "vidoriginal01"
OTHER = "vidoriginal02"
OWNER = "owneroriginal01"
KEY = f"{OWNER}/{VIDEO}/result.mp4"
PRIVATE = f"private/source/{VIDEO}/original"
SOURCE = "earlysource01"
SHA = "a" * 64
SECRET = b"original-prepare-test-secret" * 2


class OriginalPrepareAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = MemoryPublication()
        # Assign owner after constructing: even the old application loads these
        # tests, then fails its missing admission rather than failing collection.
        video = VideoRow(VIDEO, True, False, None)
        object.__setattr__(video, "owner_id", OWNER)
        self.store.put_video(video)
        self.job = {
            "videoId": VIDEO, "job": "source-prepare",
            "payload": {"videoId": VIDEO, "ownerId": OWNER, "sourceObjectKey": KEY,
                        "leaseToken": "active-worker", "leaseUntilMs": time.time() * 1000 + 60000},
        }
        self.store.outbox = [self.job]
        self.env = patch.dict(os.environ, {"ORIGIN_STORAGE_ORIGIN": "http://storage.test"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.objects = PresignedObjectStore("http://web.test", SECRET)
        self.app = OriginApp(self.store, self.objects, self.root / "cache", b"original-prepare-grant-secret" * 2, SECRET)

    def prepare(self, key=KEY, video=VIDEO, source=SOURCE):
        return self.app._prepare_source(video, {"_body": json.dumps({
            "sourceId": source, "sourceKey": key,
        }).encode()})

    def admitted_control(self):
        with patch.object(self.app, "_prepare_source_locked", return_value=self.app._json(200, {"ready": True})) as locked:
            self.assertEqual(self.prepare()[0], 200)
            locked.assert_called_once()

    def denied(self, key=KEY, video=VIDEO):
        with patch.object(self.app, "_prepare_source_locked", side_effect=AssertionError("must not prepare")):
            response = self.prepare(key, video)
        self.assertEqual(response[0], 409)
        self.assertEqual(json.loads(response[1]), {"error": "source_key_mismatch"})

    def test_fresh_and_live_original_require_matching_active_job(self):
        self.admitted_control()
        baseline = copy.deepcopy(self.job)
        cases = [("job", "revision-prepare"), ("videoId", OTHER)]
        for field, value in cases:
            with self.subTest(row=field):
                self.job[field] = value
                self.denied()
                self.job.clear()
                self.job.update(copy.deepcopy(baseline))
        for field, value in (("videoId", OTHER), ("ownerId", "anotherowner"),
                             ("sourceObjectKey", PRIVATE), ("finished", True),
                             ("exhausted", True), ("peaksOnly", True),
                             ("leaseToken", ""), ("leaseToken", None),
                             ("leaseUntilMs", 0), ("leaseUntilMs", time.time() * 1000 - 1),
                             ("leaseUntilMs", "99999999999999"), ("leaseUntilMs", True)):
            with self.subTest(payload=field, value=value):
                self.job["payload"][field] = value
                self.denied()
                self.job["payload"] = copy.deepcopy(baseline["payload"])
        self.store.sources[VIDEO] = SourceRow(VIDEO, KEY, SHA, "LIVE")
        self.admitted_control()
        self.store.outbox.clear()
        self.denied()
        self.store.outbox = [baseline]
        self.store.videos.clear()
        self.denied()

    def test_original_denied_at_every_post_copy_stage_and_nonlive_pointer(self):
        self.admitted_control()
        for source in (None, SourceRow(VIDEO, KEY, SHA, "LIVE")):
            self.store.sources.clear()
            if source:
                self.store.put_source(source)
            for state in ("COPIED", "POINTER", "DELETED", "PURGED"):
                with self.subTest(source=source, stage=state):
                    self.store.relocations = [{"videoId": VIDEO, "oldKey": KEY,
                                               "newKey": PRIVATE, "sha256": SHA, "state": state}]
                    self.denied()
        self.store.relocations.clear()
        for state in ("COPIED", "POINTER", "PURGED", "", "live"):
            self.store.put_source(SourceRow(VIDEO, KEY, SHA, state))
            self.denied()
        self.store.put_source(SourceRow(VIDEO, PRIVATE, SHA, "LIVE"))
        self.denied()

    def test_exact_owner_video_original_only_not_private_rollback_or_url(self):
        self.admitted_control()
        for key in (f"other/{VIDEO}/result.mp4", f"{OWNER}/{OTHER}/result.mp4",
                    f"{OWNER}/{VIDEO}/result.MP4", f"{OWNER}/{VIDEO}/../result.mp4",
                    f"{OWNER}/{VIDEO}/nested/result.mp4", KEY + "?token=1", "/" + KEY,
                    "https://storage.test/" + KEY, PRIVATE,
                    f"private/rollback/{VIDEO}/original", f"{OWNER}/{VIDEO}/raw-upload.webm"):
            with self.subTest(key=key):
                self.denied(key)
        self.denied(video=OTHER)
        video = VideoRow(VIDEO, True, False, None)
        object.__setattr__(video, "owner_id", "newowner")
        self.store.put_video(video)
        self.denied()

    def test_peaks_cannot_borrow_prepare_original_exception(self):
        self.admitted_control()
        self.store.put_source(SourceRow(VIDEO, KEY, SHA, "LIVE"))
        with patch.object(self.app, "_peaks_locked", side_effect=AssertionError("peaks cannot read original")):
            response = self.app._prepare_peaks(VIDEO, {"_body": json.dumps({
                "sourceId": SOURCE, "sourceKey": KEY, "sourceSha256": SHA,
            }).encode()})
        self.assertEqual(response[0], 409)
        self.assertEqual(json.loads(response[1]), {"error": "source_key_mismatch"})
        self.assertFalse(self.app._admit_prepare_key(VIDEO, KEY, original_prepare=False))

    def test_presigned_scope_exact_thread_local_revalidated_and_always_cleared(self):
        calls = []

        def fetch(request, timeout, dest=None):
            calls.append(json.loads(request.data))
            self.assertTrue(verify_request(SECRET, request.get_header(SERVICE_HEADER.capitalize()),
                                           "POST", self.objects.URL_PATH, request.data,
                                           audience="web-object-url"))
            return {"getUrl": "http://storage.test/object", "headUrl": "http://storage.test/object"}

        def denied_url(key=KEY):
            with self.assertRaises(StorageError):
                self.objects._url(key, "getUrl")

        with patch.object(self.objects, "_fetch", side_effect=fetch):
            denied_url()
            with self.assertRaisesRegex(RuntimeError, "abort"):
                with self.objects.prepare_original(VIDEO, KEY, lambda: self.app._admit_prepare_key(VIDEO, KEY)):
                    self.assertEqual(self.objects._url(KEY, "getUrl"), "http://storage.test/object")
                    self.assertEqual(calls, [{"key": KEY, "prepareVideoId": VIDEO}])
                    denied_url(f"{OWNER}/{OTHER}/result.mp4")
                    errors = []

                    def other_thread():
                        try:
                            self.objects._url(KEY, "headUrl")
                        except StorageError:
                            errors.append("denied")

                    thread = threading.Thread(target=other_thread)
                    thread.start()
                    thread.join()
                    self.assertEqual(errors, ["denied"])
                    self.job["payload"]["finished"] = True
                    denied_url()
                    raise RuntimeError("abort")
            denied_url()
            self.objects._url(PRIVATE, "getUrl")
            self.assertEqual(calls[-1], {"key": PRIVATE})
        for key in (f"{OWNER}/{OTHER}/result.mp4", f"{OWNER}/{VIDEO}/../result.mp4",
                    PRIVATE, KEY + "?token=1"):
            with self.assertRaises(StorageError):
                with self.objects.prepare_original(VIDEO, key, lambda: True):
                    self.fail("scope must be an exact original key")
        for key in (KEY, f"{OWNER}/{OTHER}/result.mp4", f"{OWNER}/{VIDEO}/../result.mp4"):
            with self.assertRaises(StorageError):
                with self.objects.prepare_original(VIDEO, key, lambda: False):
                    self.fail("unadmitted scope")
        with self.assertRaises(StorageError):
            assert_original_key(KEY)
        with self.assertRaises(StorageError):
            LocalObjectStore(self.root).head(KEY)
        s3 = S3ObjectStore("unused", "unused", "unused", "unused", "unused")
        with patch.object(s3, "_client", side_effect=AssertionError("no direct S3")):
            with self.assertRaises(StorageError):
                s3.head(KEY)
            with self.assertRaises(StorageError):
                s3.get_to(KEY, self.root / "forbidden")

    def test_mysql_gate_has_owner_job_lease_live_and_no_copy_predicates(self):
        store = MySQLPublication("unused")
        with patch.object(store, "_one", return_value={"id": VIDEO}) as one:
            self.assertTrue(store.active_original_prepare(VIDEO, KEY))
            sql, args = one.call_args.args
        self.assertEqual(args, (VIDEO, KEY, KEY, KEY))
        for fragment in ("origin_video v", "revision_outbox j", "BINARY j.videoId=BINARY v.id",
                         "BINARY v.id=BINARY %s", "BINARY j.job='source-prepare'",
                         "CONCAT(v.owner_id,'/',v.id,'/result.mp4')", "$.videoId", "$.ownerId",
                         "$.sourceObjectKey", "$.finished", "$.exhausted", "$.peaksOnly",
                         "$.leaseToken", "$.leaseUntilMs", "CURRENT_TIMESTAMP(3)",
                         "s.videoId IS NULL", "BINARY s.liveKey=BINARY %s", "s.relocationState='LIVE'",
                         "NOT EXISTS", "r.videoId=v.id", "('COPIED','POINTER','DELETED','PURGED')"):
            self.assertIn(fragment, sql)
        with patch.object(store, "_one", return_value=None):
            self.assertFalse(store.active_original_prepare(VIDEO, KEY))

    def test_copied_on_get_needs_no_later_original_head_and_publish_reuses_mezz(self):
        fixture = self.root / "fixture.mp4"
        subprocess.run([
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1.2",
            "-c:v", "libx264", "-bf", "2", "-g", "10", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-threads", "1", "-y", str(fixture),
        ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        digest = hashlib.sha256(fixture.read_bytes()).hexdigest()
        calls = []

        def fetch(request, timeout, dest=None):
            method = request.get_method()
            calls.append(method)
            if method == "POST":
                payload = json.loads(request.data)
                if payload["key"] == KEY:
                    self.assertFalse(self.store.relocations, "no original URL request after COPIED")
                    self.assertEqual(payload, {"key": KEY, "prepareVideoId": VIDEO})
                else:
                    self.assertEqual(payload, {"key": PRIVATE})
                return {"getUrl": "http://storage.test/object", "headUrl": "http://storage.test/object"}
            if method == "HEAD":
                return {"content-length": str(fixture.stat().st_size), "etag": "source-etag"}
            self.assertEqual(method, "GET")
            self.assertIsNotNone(dest)
            shutil.copyfile(fixture, dest)
            self.store.put_source(SourceRow(VIDEO, KEY, digest, "LIVE"))
            self.store.relocations.append({"videoId": VIDEO, "oldKey": KEY, "newKey": PRIVATE,
                                           "sha256": digest, "state": "COPIED"})

        try:
            with patch.object(self.objects, "_fetch", side_effect=fetch):
                response = self.prepare()
                self.assertEqual(response[0], 200, response[1])
                self.assertEqual(calls, ["POST", "HEAD", "POST", "GET"])
                self.assertFalse(self.app._admit_prepare_key(VIDEO, KEY))
                self.assertTrue(self.app._admit_prepare_key(VIDEO, PRIVATE))
                prepared = json.loads(response[1])
                self.assertEqual(prepared["sha256"], digest)
                early_mezz = self.root / "cache" / "sources" / SOURCE / "mezz.mp4"
                before = (early_mezz.stat().st_mtime_ns, early_mezz.read_bytes())
                revision_source = json.dumps({"key": PRIVATE, "sha256": digest})
                self.assertNotEqual(cache_source_id(revision_source), SOURCE)
                self.store.put_revision(RevisionRow("revoriginal01", VIDEO, "pendinghash", revision_source, 1, "READY"))
                with patch("server.build_mezzanine", side_effect=AssertionError("must reuse early A1")):
                    mezz, original, sha = self.app._source_files(VIDEO, revision_source, digest, PRIVATE)
                    self.assertEqual(mezz, early_mezz)
                    self.assertEqual(sha, digest)
                    self.assertTrue(original.is_file())
                    published = self.app._prepare_revision("revoriginal01", {"_body": json.dumps({
                        "videoId": VIDEO, "sourceId": revision_source,
                        "keepRanges": [{"start": 0, "end": 1}],
                    }).encode()})
                    self.assertEqual(published[0], 200, published[1])
                    self.assertTrue(json.loads(published[1])["decoded"])
                self.assertEqual((early_mezz.stat().st_mtime_ns, early_mezz.read_bytes()), before)
                self.assertEqual(calls.count("GET"), 1)
                self.assertFalse((self.root / "cache" / "sources" / cache_source_id(revision_source)).exists())
                with self.assertRaises(StorageError):
                    self.objects.head(KEY)
        finally:
            drain_thumbnails()
            lib_origin.expire_warm(time.time() + 100000)


if __name__ == "__main__":
    unittest.main()
