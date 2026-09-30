"""Source-frame selection. Omits only ranges with no PTS. Does not construct Origin."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import lib_audio
import lib_origin
import limits
from publication import MemoryPublication
from server import OriginApp, cache_source_id
from service_auth import sign_request
from storage import LocalObjectStore

SERVICE = b"service-token-service-token-svc01"
GRANT = b"grant-secret-grant-secret-grant-01"
VIDEO = "vidselect01"
SOURCE = "sourcesel01"
TB = 16000
SOURCE_BYTES = b"synthetic-source-bytes"
SHA = hashlib.sha256(SOURCE_BYTES).hexdigest()
A1 = "cd" * 32


def _ticks() -> tuple[list[int], list[int]]:
    pts = [0.0, 0.25, 0.57, 1.0, 1.2, 1.57, 1.8]
    ticks = [int(round(item * TB)) for item in pts]
    return ticks, [800] * len(ticks)


class SelectRenderableKeepsTest(unittest.TestCase):
    def test_omits_only_islands_with_no_pts(self) -> None:
        ticks, _durs = _ticks()
        ranges = [
            {"start": 0.0, "end": 0.07},
            {"start": 0.50, "end": 0.57},
            {"start": 1.07, "end": 1.14},
            {"start": 1.50, "end": 1.57},
        ]
        selected = lib_origin.select_renderable_keeps(ticks, ranges, TB)
        self.assertEqual(selected, [ranges[0]])
        self.assertEqual(
            [item["end"] - item["start"] for item in selected],
            [0.07],
        )

    def test_planners_still_reject_an_interior_empty_range(self) -> None:
        ticks = [0, 1600, 3200]
        durs = [1600, 1600, 1600]
        ranges = [{"start": 0.0, "end": 0.3}, {"start": 0.50, "end": 0.57}]
        with self.assertRaisesRegex(RuntimeError, "keep range 1 contains no frames"):
            lib_audio.plan_timeline(ranges, ticks, durs, TB)
        with self.assertRaisesRegex(RuntimeError, "keep range 1 contains no frames"):
            lib_origin.range_snaps(ticks, durs, ranges, TB)


class SelectFramesRouteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.cache = root / "cache"
        self.app = OriginApp(
            MemoryPublication(),
            LocalObjectStore(root / "objects"),
            self.cache,
            GRANT,
            SERVICE,
            now=lambda: 1_000,
        )
        self.original = self._plant(SOURCE, SHA, A1)
        ticks, durs = _ticks()
        self.index = {
            "sha": A1,
            "ticks": ticks,
            "durs": durs,
            "tb": TB,
        }
        self._patch_index()
        self.constructed = 0
        real = lib_origin.Origin

        def _refuse(*_args, **_kwargs):
            self.constructed += 1
            raise AssertionError("selection must not construct Origin")

        lib_origin.Origin = _refuse
        self.addCleanup(lambda: setattr(lib_origin, "Origin", real))
        self.addCleanup(self._restore_cap)
        self._cap = limits.MAX_KEEP_RANGES

    def _restore_cap(self) -> None:
        limits.MAX_KEEP_RANGES = self._cap

    def _patch_index(self) -> None:
        index = self.index
        real = lib_origin.cached_mezz_index

        def _cached(mezz: Path):
            self.mezz_seen = mezz
            probed = type("Probe", (), {"timescale": index["tb"]})()
            return (
                index["sha"],
                probed,
                tuple(index["ticks"]),
                tuple(index["durs"]),
                (),
                {},
            )

        lib_origin.cached_mezz_index = _cached
        self.addCleanup(lambda: setattr(lib_origin, "cached_mezz_index", real))

    def _plant(self, source_id: str, sha: str, a1: str) -> Path:
        dest = self.cache / "sources" / cache_source_id(source_id) / "original.mp4"
        dest.parent.mkdir(parents=True)
        body = b"synthetic-source-bytes"
        dest.write_bytes(body)
        mezz = dest.with_name("mezz.mp4")
        mezz.write_bytes(b"synthetic-mezz")
        mezz.with_suffix(".source-bind.json").write_text(
            json.dumps({"source_sha256": sha, "mezz_sha256": a1})
        )
        return dest

    def _post(self, body: dict, *, source_id: str = SOURCE, signed: bool = True, video: str = VIDEO):
        raw = json.dumps(body).encode()
        path = f"/internal/sources/{video}/select-frames"
        headers = {"_body": raw}
        if signed:
            headers["x-cap-origin-service"] = sign_request(
                SERVICE, "POST", path, raw, now=1_000
            )
        return self.app.handle("POST", path, headers)

    def _body(self, **overrides) -> dict:
        ticks_ranges = [
            {"start": 0.0, "end": 0.3},
            {"start": 0.50, "end": 0.57},
            {"start": 1.07, "end": 1.14},
        ]
        body = {
            "videoId": VIDEO,
            "sourceId": SOURCE,
            "sourceSha256": SHA,
            "a1Digest": A1,
            "indexId": A1,
            "keepRanges": ticks_ranges,
        }
        body.update(overrides)
        return body

    def test_signed_selection_omits_empty_islands_without_origin(self) -> None:
        status, body, content_type, _headers = self._post(self._body())
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "application/json")
        payload = json.loads(body)
        self.assertEqual(payload["keepIndexes"], [0])
        self.assertEqual(payload["keepRanges"], [{"start": 0.0, "end": 0.3}])
        self.assertEqual(payload["sourceSha256"], SHA)
        self.assertEqual(payload["a1Digest"], A1)
        self.assertEqual(payload["indexId"], A1)
        self.assertEqual(self.constructed, 0)
        self.assertTrue(self.mezz_seen.is_file())
        text = body.decode()
        self.assertNotIn("grant", text)
        self.assertNotIn("playlist", text)
        self.assertNotIn(b"synthetic-source-bytes".decode(), text)

    def test_unsigned_and_wrong_binding_fail(self) -> None:
        status, _, _, _ = self._post(self._body(), signed=False)
        self.assertEqual(status, 401)
        status, _, _, _ = self._post(self._body(sourceSha256="ff" * 32))
        self.assertEqual(status, 409)
        status, _, _, _ = self._post(self._body(a1Digest="ee" * 32))
        self.assertEqual(status, 409)
        status, _, _, _ = self._post(self._body(indexId="index-forged"))
        self.assertEqual(status, 409)
        status, _, _, _ = self._post(self._body(sourceId="forgedsrc01"))
        self.assertEqual(status, 409)
        self.assertEqual(self.constructed, 0)

    def test_invalid_overcount_and_empty_fail_before_origin(self) -> None:
        status, _, _, _ = self._post(self._body(keepRanges=[{"start": 0.2, "end": 0.1}]))
        self.assertEqual(status, 400)
        status, _, _, _ = self._post(
            self._body(keepRanges=[{"start": 0.0, "end": 0.2}, {"start": 0.1, "end": 0.3}])
        )
        self.assertEqual(status, 400)
        limits.MAX_KEEP_RANGES = 1
        status, _, _, _ = self._post(
            self._body(
                keepRanges=[{"start": 0.0, "end": 0.2}, {"start": 0.3, "end": 0.4}]
            )
        )
        self.assertEqual(status, 400)
        limits.MAX_KEEP_RANGES = self._cap
        status, body, _, _ = self._post(
            self._body(keepRanges=[{"start": 0.50, "end": 0.57}, {"start": 1.07, "end": 1.14}])
        )
        self.assertEqual(status, 400)
        self.assertNotIn(b"synthetic-source-bytes", body)
        self.assertEqual(self.constructed, 0)


if __name__ == "__main__":
    unittest.main()
