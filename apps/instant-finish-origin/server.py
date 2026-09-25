"""Private origin. Public /media grants, internal prepare, no source route."""
from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import grant as grant_mod
import lib_audio
import lib_origin
import limits
import service_auth
from mezzanine import MezzanineError, build_mezzanine, load_source_bind
from publication import PublicationStore
from storage import ObjectIdentity, ObjectStore, ShaIdentityCache, StorageError, atomic_write, private

MEDIA_RE = re.compile(
    r"^/media/(?P<video>[A-Za-z0-9_-]{8,64})/r/(?P<rev>[A-Za-z0-9_-]{8,128})/"
    r"(?P<kind>playlist\.m3u8|init\.mp4|seg/(?P<n>\d+)\.m4s|captions\.vtt|chapters\.json|thumbnail\.jpg|download\.mp4)$"
)
SOURCE_PREPARE_RE = re.compile(r"^/internal/sources/(?P<video>[A-Za-z0-9_-]{8,64})/prepare$")
REVISION_PREPARE_RE = re.compile(r"^/internal/revisions/(?P<rev>[A-Za-z0-9_-]{8,128})/prepare$")
ARTIFACT_RE = re.compile(
    r"^/internal/revisions/(?P<rev>[A-Za-z0-9_-]{8,128})/artifact/"
    r"(?P<name>playlist\.m3u8|init\.mp4|seg/(?P<n>\d+)\.m4s|captions\.vtt|chapters\.json|thumbnail\.jpg)$"
)
SERVICE_HEADER = service_auth.SERVICE_HEADER
NO_STORE = "private, no-store"
REFERRER = "no-referrer"


class OriginApp:
    def __init__(
        self,
        store: PublicationStore,
        objects: ObjectStore,
        cache: Path,
        grant_secret: bytes | list[tuple[str, bytes]],
        service_token: bytes,
        *,
        now=None,
        before_send=None,
        max_inflight: int | None = None,
    ) -> None:
        if isinstance(grant_secret, (bytes, bytearray)):
            grant_keys = [("k1", bytes(grant_secret))]
        else:
            grant_keys = [(kid, bytes(secret)) for kid, secret in grant_secret]
        if not grant_keys or any(len(secret) < 32 for _, secret in grant_keys) or len(service_token) < 32:
            raise RuntimeError("refusing short origin secrets")
        if any(hmac_equal(secret, service_token) for _, secret in grant_keys):
            raise RuntimeError("grant secret and service token must differ")
        self.store = store
        self.objects = objects
        self.cache = cache
        self.cache.mkdir(mode=0o700, parents=True, exist_ok=True)
        private(self.cache)
        self.grant_keys = grant_keys
        self.grant_secret = grant_keys[0][1]
        self.service_secret = service_token
        self.now = now or (lambda: int(time.time()))
        self.before_send = before_send
        self.max_inflight = limits.MAX_INFLIGHT if max_inflight is None else max_inflight
        self._origins: dict[str, tuple[lib_origin.Origin, float]] = {}
        self._lock = threading.Lock()
        self._sha_cache = ShaIdentityCache(limits.SHA_CACHE_MAX)
        self._sha_ident: dict[str, tuple[ObjectIdentity, float]] = {}
        self._validated: dict[str, float] = {}
        self.sha_hashes = 0
        self.sha_hits = 0
        self.timings: list[tuple[float, dict]] = []

    def handle(self, method: str, raw_path: str, headers) -> tuple[int, bytes, str, dict[str, str]]:
        if method not in {"GET", "HEAD", "POST"}:
            return self._text(405, b"method")
        parsed = urlparse(raw_path)
        path = parsed.path
        if ".." in path or path.startswith("/media/") and "source" in path:
            return self._text(404, b"not found")
        if path in {"/source", "/result.mp4"} or path.endswith("/result.mp4") or "/source/" in path:
            return self._text(404, b"not found")
        if path == "/health":
            return self._json(200, {"ok": True})
        if path.startswith("/internal/"):
            return self._internal(method, path, headers)
        match = MEDIA_RE.match(path)
        if match is None:
            return self._text(404, b"not found")
        return self._media(method, match, parse_qs(parsed.query), headers)

    def _internal(self, method: str, path: str, headers) -> tuple[int, bytes, str, dict[str, str]]:
        body = headers.get("_body") or b""
        if isinstance(body, str):
            body = body.encode()
        presented = ""
        wanted = SERVICE_HEADER.lower()
        for key, value in headers.items():
            if str(key).lower() == wanted:
                presented = value if isinstance(value, str) else str(value)
                break
        if not service_auth.verify_request(
            self.service_secret,
            presented,
            method,
            path,
            body,
            now=int(self.now()),
        ):
            return self._text(401, b"unauthorized")
        artifact = ARTIFACT_RE.match(path)
        if artifact and method in {"GET", "HEAD"}:
            return self._internal_artifact(artifact)
        if method != "POST":
            return self._text(405, b"method")
        source = SOURCE_PREPARE_RE.match(path)
        if source:
            return self._prepare_source(source.group("video"), headers)
        revision = REVISION_PREPARE_RE.match(path)
        if revision:
            return self._prepare_revision(revision.group("rev"), headers)
        return self._text(404, b"not found")

    def _prepare_source(self, video_id: str, headers) -> tuple[int, bytes, str, dict[str, str]]:
        try:
            body = json.loads(headers.get("_body") or b"{}")
            source_id = str(body["sourceId"])
            key = str(body["sourceKey"])
        except (json.JSONDecodeError, KeyError, TypeError):
            return self._text(400, b"bad request")
        try:
            cache_id = cache_source_id(source_id)
            original = self._materialize_original(cache_id, key)
            rejected = _reject_bad_media(original)
            if rejected:
                return self._text(400, b"bad media")
            mezz = original.with_name("mezz.mp4")
            if not mezz.is_file():
                build_mezzanine(original, mezz)
            bind = load_source_bind(mezz)
            if bind["source_sha256"] != lib_origin.sha256_file(original):
                return self._text(500, b"unavailable")
            self._remember_sha(key, bind["source_sha256"])
            lib_audio.build_audio_index(original)
            lib_audio.prepare_presentation(original)
            warm = lib_origin.warm_for_source(cache_id, mezz, original)
            self._remember_source(video_id, cache_id, key)
            probed = _probe_source(original, bind)
        except limits.InputRejected:
            return self._text(400, b"bad media")
        except lib_audio.AudioRejected:
            return self._json(409, {"error": "audio_rejected"})
        except (StorageError, MezzanineError, lib_origin.MezzanineRequired):
            return self._json(409, {"error": "mezzanine_required"})
        except Exception:
            return self._text(500, b"unavailable")
        ttl = float(os.environ.get("ORIGIN_WARM_TTL_S", "600"))
        expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + ttl))
        payload = {
            "a1Digest": bind["mezz_sha256"],
            "audioPolicy": "prepared",
            "codec": probed["codec"],
            "frameMode": probed["frameMode"],
            "hasBFrames": False,
            "indexId": bind["mezz_sha256"],
            "keyed": "source",
            "ready": True,
            "sha256": bind["source_sha256"],
            "sourceId": source_id,
            "sourceKey": key,
            "timebase": probed["timebase"],
            "timescale": bind["timescale"],
            "warmExpiresAt": expires,
            "warmMs": warm.get("total_ms"),
        }
        return self._json(200, payload)

    def _prepare_revision(self, revision_id: str, headers) -> tuple[int, bytes, str, dict[str, str]]:
        try:
            body = json.loads(headers.get("_body") or b"{}")
            video_id = str(body["videoId"])
            ranges = list(body["keepRanges"]) if body.get("keepRanges") is not None else list(body["editSpec"]["keepRanges"])
            source_id = str(body["sourceId"])
            if not isinstance(ranges, list) or not ranges or len(ranges) > limits.MAX_KEEP_RANGES:
                return self._text(400, b"bad request")
        except (json.JSONDecodeError, KeyError, TypeError):
            return self._text(400, b"bad request")
        row = self.store.revision(revision_id)
        if row is None or row.video_id != video_id:
            return self._text(404, b"not found")
        requested_intent = body.get("intentId")
        if requested_intent and row.intent_id not in {requested_intent, "pendinghash"} and row.intent_id != requested_intent:
            return self._json(409, {"error": "intent_mismatch"})
        try:
            origin = self._origin_for(video_id, source_id, ranges)
            self._persist_ranges(revision_id, ranges)
            _write_namespace(self.cache, revision_id, origin.rev)
            init = origin.ensure_init()
            seg0 = origin.ensure(0)
            decoded = _decode_check(init, seg0)
            duration = lib_origin.duration_ticks(origin.segments) / origin.profile.timescale
            self._write_side_artifacts(origin, body, duration)
        except lib_origin.MezzanineRequired:
            return self._text(409, b'{"error":"mezzanine_required"}\n', "application/json")
        except Exception:
            return self._text(500, b"unavailable")
        if decoded < 1 or b"#EXT-X-ENDLIST" not in origin.playlist:
            return self._text(500, b"unavailable")
        intent_id = str(requested_intent) if requested_intent else origin.rev
        return self._json(200, {
            "decoded": True,
            "decodedFrames": decoded,
            "durationSeconds": duration,
            "durationTicks": lib_origin.duration_ticks(origin.segments),
            "encoderHash": origin.encoder_hash,
            "initSha256": hashlib.sha256(init).hexdigest(),
            "intentId": intent_id,
            "playlistDurationSeconds": duration,
            "playlistHasEndList": True,
            "ready": True,
            "seg0DecodedFrames": decoded,
            "seg0Sha256": hashlib.sha256(seg0).hexdigest(),
            "segmentCount": len(origin.segments),
            "segmentPlanVersion": lib_origin.SEGMENT_PLAN_VERSION,
        })

    def _media(self, method: str, match: re.Match, query: dict, headers) -> tuple[int, bytes, str, dict[str, str]]:
        video_id = match.group("video")
        revision_id = match.group("rev")
        token = (query.get("t") or [""])[0]
        try:
            parsed = grant_mod.verify(self.grant_keys, token, now=int(self.now()))
        except grant_mod.GrantError:
            return self._text(401, b"unauthorized")
        if parsed.video_id != video_id or parsed.revision_id != revision_id:
            return self._text(403, b"forbidden")
        snap = self._authorize(video_id, revision_id, parsed)
        if isinstance(snap, tuple):
            return snap
        kind = match.group("kind")
        if kind == "download.mp4":
            return self._json(202, {"status": "unavailable"})
        range_header = headers.get("Range")
        prefetched = None
        try:
            if range_header and kind.startswith("seg/"):
                prefetched = self._range_segment(snap, int(match.group("n")), range_header, "video/mp4")
            if prefetched is None:
                body, content_type = self._artifact(snap, kind, match, token)
            else:
                body, content_type = prefetched[1], prefetched[2]
        except IndexError:
            return self._text(404, b"not found")
        except (lib_origin.MezzanineRequired, lib_origin.CacheIntegrityError, Exception):
            return self._text(500, b"unavailable")
        if self.before_send is not None:
            self.before_send(snap)
        again = self._recheck(video_id, revision_id)
        if again is None:
            return self._text(410, b"gone")
        if (
            again["current_revision_id"] != snap["current_revision_id"]
            or again["current_generation"] != snap["generation"]
            or int(again["publication_epoch"]) != snap["publication_epoch"]
            or int(again["policy_epoch"]) != snap["policy_epoch"]
            or again["revision_state"] not in {"CURRENT", "READY"}
            or int(again["revision_generation"]) != snap["generation"]
        ):
            return self._text(410, b"gone")
        if prefetched is not None:
            return prefetched
        extra = {
            "Accept-Ranges": "bytes",
            "Cache-Control": NO_STORE,
            "Referrer-Policy": REFERRER,
        }
        if range_header:
            status, chunk, content_range = _slice(body, range_header)
            if status != 206:
                return self._text(status, chunk)
            extra["Content-Range"] = content_range
            return status, chunk, content_type, extra
        return 200, body, content_type, extra

    def _recheck(self, video_id: str, revision_id: str) -> dict | None:
        return self.store.recheck(video_id, revision_id)

    def _authorize(self, video_id: str, revision_id: str, parsed) -> dict | tuple:
        snap = self.store.authorize(video_id, revision_id)
        if snap is None:
            return self._text(410, b"gone")
        video = snap.video
        pub = snap.publication
        rev = snap.revision
        if pub is None or rev is None or rev.video_id != video_id:
            return self._text(410, b"gone")
        if pub.current_revision_id != revision_id or rev.state not in {"CURRENT", "READY"}:
            return self._text(410, b"gone")
        if int(pub.publication_epoch) != parsed.publication_epoch or int(pub.policy_epoch) != parsed.policy_epoch:
            return self._text(410, b"gone")
        if pub.current_generation is None or int(rev.generation) != int(pub.current_generation):
            return self._text(410, b"gone")
        if video.bucket not in {None, "", "cap"}:
            return self._text(403, b"forbidden")
        return {
            "allocated_generation": int(pub.generation),
            "current_revision_id": pub.current_revision_id,
            "generation": int(pub.current_generation),
            "policy_epoch": int(pub.policy_epoch),
            "publication_epoch": int(pub.publication_epoch),
            "revision": rev,
            "source_live_key": snap.source_live_key,
            "source_sha256": snap.source_sha256,
            "video_id": video_id,
        }

    def _artifact(self, snap: dict, kind: str, match: re.Match, token: str) -> tuple[bytes, str]:
        rev = snap["revision"]
        ranges = json.loads((self.cache / "revisions" / rev.revision_id / "ranges.json").read_text())
        origin = self._origin_for(
            rev.video_id,
            rev.source_id,
            ranges,
            expected_sha=snap.get("source_sha256"),
            source_key=snap.get("source_live_key"),
        )
        if origin.rev != _namespace(self.cache, rev.revision_id):
            raise lib_origin.CacheIntegrityError("intent mismatch")
        if kind == "playlist.m3u8":
            return lib_origin.playlist_with_grant(origin.playlist.decode(), token), "application/vnd.apple.mpegurl"
        if kind == "init.mp4":
            return origin.ensure_init(), "video/mp4"
        if kind.startswith("seg/"):
            return origin.ensure(int(match.group("n"))), "video/mp4"
        if kind == "captions.vtt":
            return _read_cache(origin, "captions.vtt"), "text/vtt"
        if kind == "chapters.json":
            return _read_cache(origin, "chapters.json"), "application/json"
        if kind == "thumbnail.jpg":
            return _read_cache(origin, "thumbnail.jpg"), "image/jpeg"
        if kind == "download.mp4":
            path = origin.cache / "download.mp4"
            if not path.is_file():
                raise FileNotFoundError("revision mp4 is not required before finish")
            return path.read_bytes(), "video/mp4"
        raise FileNotFoundError(kind)

    def _origin_for(
        self,
        video_id: str,
        source_id: str,
        ranges: list[dict],
        expected_sha: str | None = None,
        source_key: str | None = None,
    ) -> lib_origin.Origin:
        mezz, original, source_sha = self._source_files(video_id, source_id, expected_sha, source_key)
        key = f"{source_sha}:{lib_origin.canonical_spec(ranges).hex()}"
        now = time.monotonic()
        with self._lock:
            self._evict_origins(now)
            found = self._origins.get(key)
            if found is not None:
                origin, _seen = found
                self._origins[key] = (origin, now)
                return origin
            origin = lib_origin.Origin(mezz, original, self.cache, ranges, source_sha)
            self._origins[key] = (origin, now)
            self._evict_origins(now)
            return origin

    def _evict_origins(self, now: float) -> None:
        stale = [key for key, (_origin, seen) in self._origins.items() if now - seen > limits.ORIGIN_CACHE_TTL_S]
        for key in stale:
            self._origins.pop(key, None)
        while len(self._origins) > limits.ORIGIN_CACHE_MAX:
            oldest = min(self._origins, key=lambda item: self._origins[item][1])
            self._origins.pop(oldest, None)

    def _identity(self, key: str) -> ObjectIdentity | None:
        now = time.monotonic()
        with self._lock:
            remembered = self._sha_ident.get(key)
            if remembered is not None and now - remembered[1] < limits.SHA_IDENT_TTL_S:
                return remembered[0]
        try:
            ident = self.objects.head(key)
        except StorageError:
            return None
        with self._lock:
            self._sha_ident[key] = (ident, now)
            while len(self._sha_ident) > limits.SHA_CACHE_MAX:
                self._sha_ident.pop(next(iter(self._sha_ident)))
        return ident

    def _source_files(
        self,
        video_id: str,
        source_id: str,
        expected_sha: str | None = None,
        source_key: str | None = None,
    ) -> tuple[Path, Path, str]:
        root = self.cache / "sources" / self._cache_id(video_id, source_id)
        original = root / "original.mp4"
        mezz = root / "mezz.mp4"
        if not mezz.is_file() or not original.is_file():
            raise lib_origin.MezzanineRequired("mezzanine missing")
        bind = load_source_bind(mezz)
        bound = bind.get("source_sha256")
        key = source_key or self._remembered_key(video_id)
        ident = self._identity(key) if key and os.environ.get("ORIGIN_SHA_REHASH") != "1" else None
        cached = self._sha_cache.get(ident) if ident is not None else None
        if cached is None:
            cached = lib_origin.sha256_file(original)
            self.sha_hashes += 1
            if ident is not None:
                self._sha_cache.put(ident, cached)
        else:
            self.sha_hits += 1
        if bound != cached:
            raise lib_origin.CacheIntegrityError("source sha mismatch")
        if expected_sha is not None and expected_sha != cached:
            raise lib_origin.CacheIntegrityError("source projection mismatch")
        return mezz, original, cached

    def _remembered_key(self, video_id: str) -> str | None:
        mapped = self.cache / "by-video" / f"{_safe(video_id)}.json"
        if not mapped.is_file():
            return None
        return str(json.loads(mapped.read_text()).get("sourceKey") or "") or None

    def _range_segment(self, snap: dict, index: int, header: str, content_type: str) -> tuple | None:
        rev = snap["revision"]
        ranges = json.loads((self.cache / "revisions" / rev.revision_id / "ranges.json").read_text())
        origin = self._origin_for(
            rev.video_id,
            rev.source_id,
            ranges,
            expected_sha=snap.get("source_sha256"),
            source_key=snap.get("source_live_key"),
        )
        path = origin.segment_path(index)
        marker = str(path)
        now = time.monotonic()
        if marker not in self._validated or not path.is_file():
            origin.ensure(index)
            self._validated[marker] = now
            while len(self._validated) > limits.ORIGIN_CACHE_MAX:
                self._validated.pop(next(iter(self._validated)))
            return None
        status, chunk, content_range = read_file_range(path, header)
        if status != 206:
            return self._text(status, chunk)
        return status, chunk, content_type, {
            "Accept-Ranges": "bytes",
            "Cache-Control": NO_STORE,
            "Content-Range": content_range,
            "Referrer-Policy": REFERRER,
        }

    def _materialize_original(self, source_id: str, key: str) -> Path:
        root = self.cache / "sources" / _safe(source_id)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        dest = root / "original.mp4"
        self.objects.get_to(key, dest)
        private(dest)
        return dest

    def _persist_ranges(self, revision_id: str, ranges: list[dict]) -> None:
        path = self.cache / "revisions" / _safe(revision_id) / "ranges.json"
        atomic_write(path, json.dumps(ranges).encode(), sync=False)

    def _write_side_artifacts(self, origin: lib_origin.Origin, body: dict, duration: float) -> None:
        if isinstance(body.get("captionsVtt"), str):
            vtt = body["captionsVtt"].encode()
        else:
            captions = lib_origin.remap_cues(list(body.get("captions") or []), origin.ranges, text_key="text")
            vtt = _vtt(captions)
        if isinstance(body.get("chaptersJson"), str):
            chapters_doc = body["chaptersJson"].encode()
        else:
            chapters = lib_origin.remap_cues(list(body.get("chapters") or []), origin.ranges, text_key="title")
            chapters_doc = (json.dumps({"chapters": chapters}, sort_keys=True) + "\n").encode()
        atomic_write(origin.cache / "captions.vtt", vtt, sync=False)
        atomic_write(origin.cache / "chapters.json", chapters_doc, sync=False)
        thumb = origin.cache / "thumbnail.jpg"
        note_duration = body.get("durationSeconds")
        bound = float(note_duration) if isinstance(note_duration, (int, float)) else duration
        _thumbnail(origin, thumb, bound)

    def _remember_source(self, video_id: str, cache_id: str, source_key: str) -> None:
        path = self.cache / "by-video" / f"{_safe(video_id)}.json"
        atomic_write(
            path,
            json.dumps({"cacheId": cache_id, "sourceKey": source_key}).encode(),
            sync=False,
        )

    def _cache_id(self, video_id: str, source_id: str) -> str:
        mapped = self.cache / "by-video" / f"{_safe(video_id)}.json"
        if mapped.is_file():
            return str(json.loads(mapped.read_text())["cacheId"])
        return cache_source_id(source_id)

    def _internal_artifact(self, match: re.Match) -> tuple[int, bytes, str, dict[str, str]]:
        revision_id = match.group("rev")
        kind = match.group("name")
        ranges_path = self.cache / "revisions" / revision_id / "ranges.json"
        if not ranges_path.is_file():
            return self._text(404, b"not found")
        row = self.store.revision(revision_id)
        if row is None:
            return self._text(404, b"not found")
        try:
            ranges = json.loads(ranges_path.read_text())
            origin = self._origin_for(row.video_id, row.source_id, ranges)
            if origin.rev != _namespace(self.cache, revision_id):
                return self._text(500, b"unavailable")
            if kind == "playlist.m3u8":
                body, content_type = origin.playlist, "application/vnd.apple.mpegurl"
            elif kind == "init.mp4":
                body, content_type = origin.ensure_init(), "video/mp4"
            elif kind.startswith("seg/"):
                body, content_type = origin.ensure(int(match.group("n"))), "video/mp4"
            elif kind == "captions.vtt":
                body, content_type = _read_cache(origin, "captions.vtt"), "text/vtt"
            elif kind == "chapters.json":
                body, content_type = _read_cache(origin, "chapters.json"), "application/json"
            elif kind == "thumbnail.jpg":
                body, content_type = _read_cache(origin, "thumbnail.jpg"), "image/jpeg"
            else:
                return self._text(404, b"not found")
        except Exception:
            return self._text(500, b"unavailable")
        return 200, body, content_type, {"Cache-Control": NO_STORE, "Accept-Ranges": "bytes"}

    def _text(self, status: int, body: bytes, content_type: str = "text/plain") -> tuple[int, bytes, str, dict[str, str]]:
        return status, body, content_type, {"Cache-Control": NO_STORE, "Referrer-Policy": REFERRER}

    def _json(self, status: int, payload: dict) -> tuple[int, bytes, str, dict[str, str]]:
        return status, (json.dumps(payload, sort_keys=True) + "\n").encode(), "application/json", {
            "Cache-Control": NO_STORE,
            "Referrer-Policy": REFERRER,
        }

    def note_timing(self, row: dict) -> None:
        now = time.monotonic()
        self.timings.append((now, row))
        cutoff = now - limits.ORIGIN_CACHE_TTL_S
        if len(self.timings) > limits.TIMINGS_MAX:
            self.timings = [item for item in self.timings if item[0] >= cutoff][-limits.TIMINGS_MAX:]

    def _remember_sha(self, key: str, sha256: str) -> None:
        try:
            ident = self.objects.head(key)
        except StorageError:
            return
        self._sha_cache.put(ident, sha256)


def cache_source_id(source_id: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]{8,128}", source_id):
        return source_id
    return hashlib.sha256(source_id.encode()).hexdigest()[:32]


def _namespace_path(cache: Path, revision_id: str) -> Path:
    return cache / "revisions" / revision_id / "namespace.txt"


def _write_namespace(cache: Path, revision_id: str, namespace: str) -> None:
    atomic_write(_namespace_path(cache, revision_id), namespace.encode(), sync=False)


def _namespace(cache: Path, revision_id: str) -> str:
    path = _namespace_path(cache, revision_id)
    if not path.is_file():
        return ""
    return path.read_text()


def _probe_source(path: Path, bind: dict) -> dict:
    codec = "h264"
    frame_mode = "cfr"
    timebase = f"1/{int(bind['timescale'])}"
    try:
        import av

        container = av.open(str(path))
        try:
            stream = container.streams.video[0]
            codec = stream.codec_context.name or codec
            if stream.time_base:
                timebase = f"{stream.time_base.numerator}/{stream.time_base.denominator}"
            average = getattr(stream, "average_rate", None)
            base = getattr(stream, "base_rate", None)
            if average and base and float(average) != float(base):
                frame_mode = "vfr"
        finally:
            container.close()
    except Exception:
        pass
    return {"codec": codec, "frameMode": frame_mode, "timebase": timebase}


def _bind_jpeg_duration(jpeg: bytes, duration_seconds: float) -> bytes:
    note = f"duration_seconds={duration_seconds:.3f}".encode()
    marker = b"\xff\xfe" + (len(note) + 2).to_bytes(2, "big") + note
    if jpeg[:2] != b"\xff\xd8":
        raise RuntimeError("thumbnail is not jpeg")
    return jpeg[:2] + marker + jpeg[2:]


def hmac_equal(left: bytes, right: bytes) -> bool:
    import hmac
    if len(left) != len(right):
        return False
    return hmac.compare_digest(left, right)


def _safe(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", value):
        raise lib_origin.MezzanineRequired("bad source id")
    return value


def _ranges_from_intent(app: OriginApp, rev) -> list[dict]:
    path = app.cache / "intents" / rev.intent_id / "ranges.json"
    if not path.is_file():
        raise lib_origin.MezzanineRequired("revision spec missing")
    return json.loads(path.read_text())


def remember_ranges(cache: Path, intent_id: str, ranges: list[dict]) -> None:
    path = cache / "intents" / intent_id / "ranges.json"
    atomic_write(path, json.dumps(ranges).encode(), sync=False)


def _read_cache(origin: lib_origin.Origin, name: str) -> bytes:
    path = origin.cache / name
    if not path.is_file():
        raise FileNotFoundError(name)
    return path.read_bytes()


def _vtt(cues: list[dict]) -> bytes:
    lines = ["WEBVTT", ""]
    for index, cue in enumerate(cues, start=1):
        lines.append(str(index))
        lines.append(f"{_ts(float(cue['start']))} --> {_ts(float(cue['end']))}")
        lines.append(str(cue.get("text", "")))
        lines.append("")
    return ("\n".join(lines) + "\n").encode()


def _ts(value: float) -> str:
    ms = int(round(value * 1000))
    hours, rem = divmod(ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def read_file_range(path: Path, header: str) -> tuple[int, bytes, str]:
    size = path.stat().st_size
    if not header.startswith("bytes=") or "," in header:
        return 416, b"range", ""
    start_s, end_s = header.split("=", 1)[1].split("-", 1)
    if start_s == "":
        return 416, b"range", ""
    start = int(start_s)
    end = int(end_s) if end_s else size - 1
    if start < 0 or start >= size or end < start:
        return 416, b"range", ""
    end = min(end, size - 1)
    with path.open("rb") as stream:
        stream.seek(start)
        chunk = stream.read(end - start + 1)
    return 206, chunk, f"bytes {start}-{end}/{size}"


def _slice(body: bytes, header: str) -> tuple[int, bytes, str]:
    if not header.startswith("bytes=") or "," in header:
        return 416, b"range", ""
    start_s, end_s = header.split("=", 1)[1].split("-", 1)
    if start_s == "":
        return 416, b"range", ""
    start = int(start_s)
    end = int(end_s) if end_s else len(body) - 1
    if start < 0 or start >= len(body) or end < start:
        return 416, b"range", ""
    end = min(end, len(body) - 1)
    return 206, body[start:end + 1], f"bytes {start}-{end}/{len(body)}"


def _without_styp(segment: bytes) -> bytes:
    if len(segment) >= 8 and segment[4:8] == b"styp":
        size = int.from_bytes(segment[:4], "big")
        if 8 <= size <= len(segment):
            return segment[size:]
    return segment


def _decode_check(init: bytes, seg0: bytes) -> int:
    import av
    import io
    blob = init + _without_styp(seg0)
    container = av.open(io.BytesIO(blob))
    try:
        stream = container.streams.video[0]
        count = 0
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            count += 1
        return count
    finally:
        container.close()


def _thumbnail(origin: lib_origin.Origin, dest: Path, duration_seconds: float) -> None:
    init = origin.ensure_init()
    seg0 = origin.ensure(0)
    blob = init + _without_styp(seg0)
    tmp = dest.with_suffix(".in.mp4")
    atomic_write(tmp, blob, sync=False)
    result = limits.run_cmd(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(tmp), "-frames:v", "1", str(dest)],
        limits.FFMPEG_TIMEOUT_S,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if tmp.exists():
        tmp.unlink()
    if result.returncode or not dest.is_file():
        raise RuntimeError("thumbnail failed")
    bound = _bind_jpeg_duration(dest.read_bytes(), duration_seconds)
    atomic_write(dest, bound, sync=False)
    private(dest)


def _reject_overload(request) -> None:
    body = b"overloaded\n"
    raw = (
        b"HTTP/1.1 503 Service Unavailable\r\n"
        b"Content-Type: text/plain\r\n"
        b"Content-Length: " + str(len(body)).encode() + b"\r\n"
        b"Retry-After: " + limits.RETRY_AFTER_S.encode() + b"\r\n"
        b"Cache-Control: private, no-store\r\n"
        b"Referrer-Policy: no-referrer\r\n"
        b"Connection: close\r\n\r\n" + body
    )
    try:
        request.sendall(raw)
    except Exception:
        pass
    try:
        request.shutdown(socket.SHUT_RDWR)
    except Exception:
        pass
    request.close()


class BoundedHTTPServer(ThreadingHTTPServer):
    def __init__(self, server_address, request_handler, max_inflight: int) -> None:
        super().__init__(server_address, request_handler)
        self.admit = threading.BoundedSemaphore(max(1, max_inflight))

    def process_request(self, request, client_address) -> None:
        if not self.admit.acquire(blocking=False):
            _reject_overload(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.admit.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.admit.release()


def _reject_bad_media(path: Path) -> str | None:
    try:
        size = path.stat().st_size
    except OSError:
        return "bad media"
    if size < 8 or size > limits.MAX_SOURCE_BYTES:
        return "too large"
    box: dict = {}

    def run() -> None:
        try:
            from index import probe

            box["probe"] = probe(path)
        except Exception as exc:
            box["error"] = exc

    thread = threading.Thread(target=run, name="origin-probe", daemon=True)
    thread.start()
    thread.join(limits.PROBE_TIMEOUT_S)
    if thread.is_alive() or "error" in box or "probe" not in box:
        return "undecodable"
    probed = box["probe"]
    if probed.width > limits.MAX_WIDTH or probed.height > limits.MAX_HEIGHT:
        return "resolution"
    if probed.packets and probed.timescale:
        ticks = max(row.pts + max(row.dur, 0) for row in probed.packets)
        if ticks / probed.timescale > limits.MAX_DURATION_S:
            return "duration"
    return None


def serve(app: OriginApp, host: str, port: int) -> ThreadingHTTPServer:
    if host == "0.0.0.0" and os.environ.get("ORIGIN_HOST_PUBLISH", "127.0.0.1") == "0.0.0.0":
        raise RuntimeError("refusing 0.0.0.0 host publish")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_HEAD(self) -> None:
            self._dispatch("HEAD")

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length > 1_000_000:
                self._emit(413, b"too large", "text/plain", {})
                return
            body = self.rfile.read(length) if length else b""
            headers = {key: value for key, value in self.headers.items()}
            headers["_body"] = body
            self._dispatch("POST", headers)

        def _dispatch(self, method: str, headers=None) -> None:
            hdrs = headers if headers is not None else {key: value for key, value in self.headers.items()}
            try:
                status, body, content_type, extra = app.handle(method, self.path, hdrs)
            except Exception:
                status, body, content_type, extra = 500, b"unavailable", "text/plain", {"Cache-Control": NO_STORE}
            self._emit(status, body, content_type, extra)

        def _emit(self, status: int, body: bytes, content_type: str, extra: dict) -> None:
            extra.setdefault("Cache-Control", NO_STORE)
            extra.setdefault("Referrer-Policy", REFERRER)
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for key, value in extra.items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD" and body:
                self.wfile.write(body)

        def log_message(self, fmt: str, *args) -> None:
            return

    httpd = BoundedHTTPServer((host, port), Handler, app.max_inflight)
    thread = threading.Thread(target=httpd.serve_forever, name="instant-finish-origin", daemon=True)
    thread.start()
    return httpd


def main() -> None:
    host_publish = os.environ.get("ORIGIN_HOST_PUBLISH", "127.0.0.1")
    if host_publish == "0.0.0.0":
        raise SystemExit("refusing 0.0.0.0 host publish")
    from publication import MySQLPublication
    from storage import S3ObjectStore

    cache = Path(os.environ.get("ORIGIN_CACHE", "/var/cache/origin"))
    store = MySQLPublication(os.environ["ORIGIN_DATABASE_URL"])
    objects = S3ObjectStore(
        os.environ["S3_INTERNAL_ENDPOINT"],
        os.environ.get("S3_BUCKET", "cap"),
        os.environ["S3_ACCESS_KEY"],
        os.environ["S3_SECRET_KEY"],
        os.environ.get("S3_REGION", "us-east-1"),
    )
    grant_keys = grant_mod.parse_key_ring(os.environ.get("REVISION_MEDIA_GRANT_KEYS", ""))
    service = os.environ.get("REVISION_ORIGIN_SERVICE_SECRET", "")
    if not grant_keys or len(service) < 32:
        raise SystemExit("revision grant ring and origin service secret are required")
    app = OriginApp(
        store,
        objects,
        cache,
        grant_keys,
        service.encode(),
    )
    bind = os.environ.get("ORIGIN_BIND", "0.0.0.0")
    port = int(os.environ.get("ORIGIN_PORT", "3020"))
    httpd = serve(app, bind, port)
    try:
        threading.Event().wait()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
