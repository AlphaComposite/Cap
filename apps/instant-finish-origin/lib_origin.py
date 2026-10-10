"""Revision-addressed JIT origin. Gated PyAV x264 settings, source timescale and geometry parameterized."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from urllib.parse import quote

import numpy as np

import lib_audio
from storage import atomic_write, private, sha256_file

JIT_X264 = "scenecut=0:open-gop=0:b-adapt=0:repeat-headers=1"
SEGMENT_PLAN_VERSION = 3
ATTESTATION_VERSION = 2
AUDIO_ALIGN_VERSION = 6
MAPPING_VERSION = 1
# Gated placeholder. rewrite_fragment stamps real durations afterwards.
# One 30 fps step is timescale//30 (512 at 15360, 533 at 16000). A fixed 512
# step duplicates dts on a 16000 timescale and the muxer returns EINVAL.
PLACEHOLDER_PTS_STEP = 512
DECODER_IDLE_TTL_S = 600.0

_IMPL_IDS: dict | None = None
_DECODERS: dict[str, tuple] = {}
_DECODER_USED: dict[str, float] = {}
_DECODER_GUARD = threading.RLock()
_WARM: dict[str, dict] = {}
_WARM_LOCK = threading.Lock()
WARM_LOG: list[dict] = []


class RemovedRangeError(RuntimeError):
    pass


class CacheIntegrityError(RuntimeError):
    pass


class MezzanineRequired(RuntimeError):
    pass


@dataclass(frozen=True)
class FrameRec:
    index: int
    src_pts: int
    dur: int
    range_index: int | None
    out_pts: int


@dataclass(frozen=True)
class Segment:
    index: int
    frames: tuple[FrameRec, ...]
    out_pts: int
    duration_ticks: int

    @property
    def source_span_ticks(self) -> int:
        return self.frames[-1].src_pts - self.frames[0].src_pts


@dataclass(frozen=True)
class Profile:
    timescale: int
    width: int
    height: int
    encoder_thread_count: str | None = None


def encoder_threads() -> str:
    import limits
    return str(limits.origin_cpus())


def jit_options(threads: str | None = None) -> dict[str, str]:
    return {
        "bf": "0",
        "crf": "18",
        "forced-idr": "1",
        "g": "300",
        "level": "4.1",
        "preset": "veryfast",
        "profile": "high",
        "threads": threads or encoder_threads(),
        "x264-params": JIT_X264,
    }


def jit_args(profile: Profile) -> list[str]:
    return [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1",
        "-bf", "0", "-g", "300", "-forced-idr", "1", "-threads", profile.encoder_thread_count or encoder_threads(),
        "-x264-params", JIT_X264,
        "-fps_mode", "passthrough",
        "-enc_time_base:v", f"1/{profile.timescale}",
        "-video_track_timescale", str(profile.timescale),
        "-an", "-muxdelay", "0", "-muxpreload", "0",
        "-fflags", "+bitexact", "-flags", "+bitexact",
        "-f", "mp4", "-movflags", "+frag_keyframe+empty_moov+default_base_moof+cmaf",
    ]


def canonical_spec(ranges: list[dict]) -> bytes:
    items = [
        json.dumps({"end": item["end"], "start": item["start"]}, sort_keys=True, separators=(",", ":"))
        for item in ranges
    ]
    return f'{{"keep_ranges":[{",".join(items)}],"mapping":{MAPPING_VERSION}}}'.encode()


def revision_content_hash(ranges: list[dict], source_sha: str, encoder_hash: str, segment_plan_version: int = SEGMENT_PLAN_VERSION) -> str:
    payload = {
        "encoder": encoder_hash,
        "mapping": MAPPING_VERSION,
        "segment_plan": segment_plan_version,
        "source_sha256": source_sha,
        "spec": canonical_spec(ranges).decode(),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()


def _ffmpeg_lavc() -> str:
    result = subprocess.run(["ffmpeg", "-version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    text = result.stdout.decode("utf-8", "replace")
    for line in text.splitlines():
        if "libavcodec" not in line:
            continue
        parts = line.replace("libavcodec", " ", 1).split("/")[0]
        nums = [token for token in parts.replace(".", " ").split() if token.isdigit()]
        if len(nums) >= 3:
            return ".".join(nums[:3])
    raise RuntimeError("ffmpeg -version did not report libavcodec")


def _libx264_build() -> str:
    import av
    root = Path(getattr(av, "__file__", None) or ".").resolve().parent
    matches = sorted((root / "libs").glob("libx264*.so*")) if (root / "libs").is_dir() else []
    if not matches:
        matches = sorted(root.joinpath("..").resolve().glob("av.libs/libx264*.so*"))
    return matches[0].name if matches else "libx264-missing"


def encoder_implementation_ids() -> dict:
    global _IMPL_IDS
    if _IMPL_IDS is not None:
        return _IMPL_IDS
    import av
    _IMPL_IDS = {
        "audio": f"ffmpeg-aac@{_ffmpeg_lavc()}",
        "video": f"pyav-libx264@{getattr(av, '__version__', 'unknown')}/{_libx264_build()}",
    }
    return _IMPL_IDS


def encoder_identity(profile: Profile, segment_plan_version: int = SEGMENT_PLAN_VERSION) -> dict:
    from lib_vui import configured_tick_rate

    identity = {
        "audio": lib_audio.AUDIO_SPEC,
        "encoder_impl": encoder_implementation_ids(),
        "height": profile.height,
        "jit_args": jit_args(profile),
        "segment_plan": segment_plan_version,
        "timescale": profile.timescale,
        "width": profile.width,
        "x264": JIT_X264,
    }
    rate = configured_tick_rate()
    if rate is not None:
        identity["vui_tick_rate"] = rate
    return identity


def encoder_config_hash(profile: Profile, segment_plan_version: int = SEGMENT_PLAN_VERSION) -> str:
    raw = json.dumps(encoder_identity(profile, segment_plan_version), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def legacy_encoder_hash(profile: Profile) -> str:
    spec = {
        "audio": lib_audio.AUDIO_SPEC,
        "height": profile.height,
        "jit_args": jit_args(profile),
        "timescale": profile.timescale,
        "width": profile.width,
        "x264": JIT_X264,
    }
    return hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def range_index_for(src_pts: int, ranges: list[dict], tb: int) -> int | None:
    pts_s = src_pts / tb
    for index, item in enumerate(ranges):
        if float(item["start"]) <= pts_s < float(item["end"]):
            return index
    return None


def require_kept(frames: list[FrameRec] | tuple[FrameRec, ...], ranges: list[dict], tb: int) -> None:
    if not frames:
        raise RemovedRangeError("refusing empty frame list")
    for frame in frames:
        hit = range_index_for(frame.src_pts, ranges, tb)
        if hit is None or frame.range_index != hit:
            raise RemovedRangeError(f"refusing frame {frame.index} source_pts={frame.src_pts}")


def kept_frame_ids(ticks: list[int], ranges: list[dict], tb: int) -> list[list[int]]:
    pts = np.asarray(ticks, dtype=np.float64) / tb
    grouped = []
    for item in ranges:
        grouped.append(np.flatnonzero((pts >= float(item["start"])) & (pts < float(item["end"]))).tolist())
    return grouped


def select_renderable_keeps(ticks: list[int], ranges: list[dict], tb: int) -> list[dict]:
    if isinstance(tb, bool) or not isinstance(tb, int) or tb <= 0:
        raise RuntimeError(f"bad video timescale {tb}")
    selected = [
        ranges[index]
        for index, ids in enumerate(kept_frame_ids(ticks, ranges, tb))
        if ids
    ]
    if not selected:
        raise RuntimeError("selection is empty")
    return selected


def max_hold_ticks(durs: list[int]) -> int:
    if not durs:
        raise RuntimeError("frame table is empty")
    return max(int(dur) for dur in durs)


def source_end_ticks(ticks: list[int], durs: list[int]) -> int:
    if not ticks or len(ticks) != len(durs):
        raise RuntimeError("frame table is empty")
    last = max(range(len(ticks)), key=lambda index: int(ticks[index]))
    return int(ticks[last]) + int(durs[last])


def range_snaps(ticks: list[int], durs: list[int], ranges: list[dict], tb: int) -> list[dict]:
    grouped = kept_frame_ids(ticks, ranges, tb)
    snaps = []
    for index, ids in enumerate(grouped):
        if not ids:
            raise RuntimeError(f"keep range {index} contains no frames")
        first = ids[0]
        last = ids[-1]
        snaps.append(
            {
                "firstPts": int(ticks[first]),
                "lastPts": int(ticks[last]),
                "lastDur": int(durs[last]),
            }
        )
    return snaps


def _prefix_to_keyframe(frames: tuple[FrameRec, ...], keyframes: list[dict] | None, tb: int, segment_plan_version: int) -> tuple[FrameRec, ...]:
    if not frames:
        raise RuntimeError("segment 0 plan is empty")
    if segment_plan_version == 2 and not keyframes:
        return frames
    first = frames[0].index
    nxt = next((item["index"] for item in (keyframes or []) if item["index"] > first), None)
    chosen: list[FrameRec] = []
    acc = 0
    for frame in frames:
        if nxt is not None and frame.index >= nxt and chosen:
            break
        if chosen and acc >= (tb if segment_plan_version == 2 else tb // 2):
            break
        chosen.append(frame)
        acc += frame.dur
    if len(chosen) < 2 and len(frames) >= 2 and (nxt is None or frames[1].index < nxt):
        return frames[:2]
    return tuple(chosen)


def _segment(index: int, frames: tuple[FrameRec, ...]) -> Segment:
    return Segment(index, frames, frames[0].out_pts, sum(frame.dur for frame in frames))


def _merge_short(segments: list[Segment], min_ticks: int) -> list[Segment]:
    groups = [list(segment.frames) for segment in segments]
    guard = 0
    while len(groups) > 1 and guard < len(segments) + 2:
        guard += 1
        short = next(
            (index for index, frames in enumerate(groups) if index > 0 and sum(frame.dur for frame in frames) < min_ticks),
            None,
        )
        if short is None:
            break
        ranges_here = {frame.range_index for frame in groups[short]}
        prev_ok = short > 1 and {frame.range_index for frame in groups[short - 1]} == ranges_here
        next_ok = short + 1 < len(groups) and {frame.range_index for frame in groups[short + 1]} == ranges_here
        if prev_ok:
            groups[short - 1] = groups[short - 1] + groups[short]
            del groups[short]
        elif next_ok:
            groups[short + 1] = groups[short] + groups[short + 1]
            del groups[short]
        else:
            break
    merged = [_segment(index, tuple(frames)) for index, frames in enumerate(groups)]
    for index, segment in enumerate(merged):
        if not segment.frames:
            raise RuntimeError(f"segment {index} is empty after short merge")
        if index and segment.out_pts != merged[index - 1].out_pts + merged[index - 1].duration_ticks:
            raise RuntimeError(f"segment {index} is not contiguous after short merge")
    return merged


def plan_segments(
    ranges: list[dict],
    ticks: list[int],
    durs: list[int],
    tb: int,
    keyframes: list[dict] | None = None,
    segment_plan_version: int = SEGMENT_PLAN_VERSION,
) -> list[Segment]:
    if segment_plan_version not in {2, 3}:
        raise CacheIntegrityError("unsupported segment plan")
    grouped = kept_frame_ids(ticks, ranges, tb)
    if not grouped or not grouped[0]:
        raise RuntimeError("keep range 0 contains no frames")
    kept: list[FrameRec] = []
    cursor = 0
    for range_index, ids in enumerate(grouped):
        for frame_index in ids:
            kept.append(FrameRec(frame_index, ticks[frame_index], durs[frame_index], range_index, cursor))
            cursor += durs[frame_index]
    segments: list[Segment] = []
    range0 = tuple(frame for frame in kept if frame.range_index == 0)
    segments.append(_segment(0, _prefix_to_keyframe(range0, keyframes, tb, segment_plan_version)))
    bucket: list[FrameRec] = []
    acc = 0
    consumed = {frame.index for frame in segments[0].frames}
    target = 2 * tb
    for frame in kept:
        if frame.index in consumed:
            continue
        if bucket and acc >= target:
            segments.append(_segment(len(segments), tuple(bucket)))
            bucket = []
            acc = 0
        bucket.append(frame)
        acc += frame.dur
    if bucket:
        segments.append(_segment(len(segments), tuple(bucket)))
    return _merge_short(segments, tb // 2)


def duration_ticks(segments: list[Segment]) -> int:
    return sum(segment.duration_ticks for segment in segments)


def join_count(segments: list[Segment]) -> int:
    frames = [frame for segment in segments for frame in segment.frames]
    return sum(1 for left, right in zip(frames, frames[1:]) if left.range_index != right.range_index)


def extinf(ticks: int, tb: int) -> str:
    text = format(ticks / tb, ".12f")
    if round(float(text) * tb) != ticks:
        text = format(ticks / tb, ".15f")
    if round(float(text) * tb) != ticks:
        raise RuntimeError(f"EXTINF does not round-trip {ticks}")
    trimmed = text.rstrip("0").rstrip(".")
    if "." not in trimmed:
        trimmed += ".0"
    if round(float(trimmed) * tb) != ticks:
        return text
    return trimmed


def playlist_text(segments: list[Segment], tb: int) -> str:
    if tb <= 0:
        raise RuntimeError(f"bad timescale {tb}")
    target = 1
    for segment in segments:
        target = max(target, (segment.duration_ticks + tb - 1) // tb)
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        f"#EXT-X-TARGETDURATION:{target}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        '#EXT-X-MAP:URI="init.mp4"',
    ]
    for segment in segments:
        lines.append(f"#EXTINF:{extinf(segment.duration_ticks, tb)},")
        lines.append(f"seg/{segment.index}.m4s")
    lines.append("#EXT-X-ENDLIST")
    text = "\n".join(lines) + "\n"
    if "EXT-X-DISCONTINUITY" in text:
        raise RuntimeError("playlist emitted a discontinuity tag")
    return text


def playlist_with_grant(text: str, token: str) -> bytes:
    quoted = quote(token, safe="")
    lines = []
    for line in text.splitlines():
        if line.startswith("#EXT-X-MAP:"):
            line = line.replace('URI="init.mp4"', f'URI="init.mp4?t={quoted}"')
        elif line.startswith("seg/") and line.endswith(".m4s"):
            line = f"{line}?t={quoted}"
        lines.append(line)
    return ("\n".join(lines) + "\n").encode()


def _box(typ: bytes, payload: bytes) -> bytes:
    return (8 + len(payload)).to_bytes(4, "big") + typ + payload


def _iter_boxes(buf: bytes, start: int, end: int):
    cursor = start
    while cursor + 8 <= end:
        size = int.from_bytes(buf[cursor:cursor + 4], "big")
        header = 8
        if size == 1:
            if cursor + 16 > end:
                break
            size = int.from_bytes(buf[cursor + 8:cursor + 16], "big")
            header = 16
        if size < header or cursor + size > end:
            break
        yield cursor, size, header, buf[cursor + 4:cursor + 8]
        cursor += size


def avcc_bytes(buf: bytes) -> bytes:
    start = buf.find(b"avcC")
    if start < 4:
        raise RuntimeError("no avcC")
    off = start - 4
    size = int.from_bytes(buf[off:off + 4], "big")
    if size < 8 or off + size > len(buf):
        raise RuntimeError("truncated avcC")
    return bytes(buf[off:off + size])


def _parse_trun(buf: bytes, off: int, size: int) -> dict:
    payload = buf[off + 8:off + size]
    flags = int.from_bytes(payload[1:4], "big")
    count = int.from_bytes(payload[4:8], "big")
    cursor = 8
    first_flags = 0
    if flags & 0x1:
        cursor += 4
    if flags & 0x4:
        first_flags = int.from_bytes(payload[cursor:cursor + 4], "big")
        cursor += 4
    if not flags & 0x200:
        raise RuntimeError(f"trun lacks per-sample sizes flags={flags:#x}")
    sizes = []
    for _ in range(count):
        if flags & 0x100:
            cursor += 4
        sizes.append(int.from_bytes(payload[cursor:cursor + 4], "big"))
        cursor += 4
        if flags & 0x400:
            cursor += 4
        if flags & 0x800:
            cursor += 4
    return {"count": count, "sizes": sizes, "first_flags": first_flags}


def _is_sync(flags: int) -> bool:
    depends = (flags >> 24) & 0x3
    non_sync = (flags >> 16) & 0x1
    return depends == 2 and non_sync == 0


def _tfhd_default_duration(tfhd: bytes, duration: int) -> bytes:
    """Default sample duration must cover the longest sample. It does not close WebKit's VFR hold gaps."""
    if duration <= 0:
        raise RuntimeError(f"bad default sample duration {duration}")
    flags = int.from_bytes(tfhd[9:12], "big")
    if not flags & 0x08:
        return tfhd
    cursor = 16
    if flags & 0x01:
        cursor += 8
    if flags & 0x02:
        cursor += 4
    patched = bytearray(tfhd)
    patched[cursor:cursor + 4] = int(duration).to_bytes(4, "big")
    return bytes(patched)


def rewrite_fragment(data: bytes, durations: list[int], tfdt0: int, sequence: int) -> tuple[bytes, bytes, bytes]:
    top = list(_iter_boxes(data, 0, len(data)))
    init = bytearray()
    moofs = []
    for index, (off, size, _header, name) in enumerate(top):
        if name in {b"ftyp", b"moov"}:
            init += data[off:off + size]
        elif name == b"moof":
            mdat = None
            for nxt_off, nxt_size, _nxt_header, nxt_name in top[index + 1:]:
                if nxt_name == b"mdat":
                    mdat = data[nxt_off:nxt_off + nxt_size]
                    break
            if mdat is None:
                raise RuntimeError("moof without mdat")
            moofs.append((data[off:off + size], mdat))
    if not init or not moofs:
        raise RuntimeError("fragmented file missing init or moof")
    avcc = avcc_bytes(bytes(init))
    consumed = 0
    base = tfdt0
    pieces = bytearray()
    seq = sequence
    for moof, mdat in moofs:
        mfhd = tfhd = None
        trun_info = None
        for off, size, header, name in _iter_boxes(moof, 8, len(moof)):
            if name == b"mfhd":
                mfhd = bytearray(moof[off:off + size])
            if name != b"traf":
                continue
            for toff, tsize, _theader, tname in _iter_boxes(moof, off + header, off + size):
                if tname == b"tfhd":
                    tfhd = moof[toff:toff + tsize]
                    flags = int.from_bytes(tfhd[9:12], "big")
                    if not flags & 0x20000:
                        raise RuntimeError(f"tfhd missing default-base-is-moof flags={flags:#x}")
                if tname == b"trun":
                    trun_info = _parse_trun(moof, toff, tsize)
        if mfhd is None or tfhd is None or trun_info is None:
            raise RuntimeError("incomplete moof")
        if not _is_sync(trun_info["first_flags"]):
            raise RuntimeError(f"fragment does not start on a sync sample flags={trun_info['first_flags']:#x}")
        count = trun_info["count"]
        durs = durations[consumed:consumed + count]
        if len(durs) != count:
            raise RuntimeError(f"sample count {count} exceeds remaining durations")
        tfhd = _tfhd_default_duration(tfhd, max(durs))
        header_len = 16 if int.from_bytes(mdat[:4], "big") == 1 else 8
        if sum(trun_info["sizes"]) != len(mdat) - header_len:
            raise RuntimeError("trun sizes do not match mdat")
        mfhd[12:16] = seq.to_bytes(4, "big")
        body = bytearray()
        body += bytes([1, 0x00, 0x03, 0x05])
        body += count.to_bytes(4, "big")
        body += (0).to_bytes(4, "big", signed=True)
        body += trun_info["first_flags"].to_bytes(4, "big")
        for dur, sample_size in zip(durs, trun_info["sizes"], strict=True):
            body += int(dur).to_bytes(4, "big")
            body += int(sample_size).to_bytes(4, "big")
        trun = _box(b"trun", bytes(body))
        tfdt = _box(b"tfdt", bytes([1, 0, 0, 0]) + int(base).to_bytes(8, "big"))
        traf = _box(b"traf", tfhd + tfdt + trun)
        built = bytearray(_box(b"moof", bytes(mfhd) + traf))
        trun_at = 8 + len(mfhd) + 8 + len(tfhd) + len(tfdt)
        built[trun_at + 16:trun_at + 20] = (len(built) + 8).to_bytes(4, "big", signed=True)
        pieces += built
        pieces += mdat
        consumed += count
        base += sum(durs)
        seq += 1
    if consumed != len(durations):
        raise RuntimeError(f"encoded {consumed} samples, expected {len(durations)}")
    return bytes(init), avcc, bytes(pieces)


def styp() -> bytes:
    return _box(b"styp", b"msdh" + b"\x00\x00\x00\x00" + b"msdh" + b"msix")


def _keyframe_at_or_before(keyframes: list[dict], frame_index: int) -> dict:
    chosen = None
    for item in keyframes:
        if item["index"] <= frame_index:
            chosen = item
        else:
            break
    if chosen is None:
        raise RuntimeError(f"no keyframe at or before frame {frame_index}")
    return chosen


def _source_runs(frames: tuple[FrameRec, ...]) -> list[tuple[FrameRec, ...]]:
    runs: list[list[FrameRec]] = [[frames[0]]]
    for frame in frames[1:]:
        if frame.index == runs[-1][-1].index + 1:
            runs[-1].append(frame)
        else:
            runs.append([frame])
    return [tuple(run) for run in runs]


def _decoder(mezz: Path):
    key = str(mezz.resolve())
    with _DECODER_GUARD:
        found = _DECODERS.get(key)
        if found is None:
            import av
            import limits
            container = av.open(key)
            stream = container.streams.video[0]
            stream.thread_type = "SLICE"
            stream.thread_count = limits.origin_cpus()
            found = (container, stream, threading.Lock())
            _DECODERS[key] = found
            _evict_decoders()
        _DECODER_USED[key] = time.perf_counter()
        return found


def _evict_decoders() -> None:
    import limits

    _evict_idle()
    while len(_DECODERS) > limits.DECODER_MAX:
        oldest = min(_DECODER_USED, key=lambda item: _DECODER_USED[item])
        found = _DECODERS.pop(oldest, None)
        _DECODER_USED.pop(oldest, None)
        if found is None:
            continue
        container, _stream, lock = found
        with lock:
            container.close()


def close_source(mezz: Path | None = None) -> None:
    with _DECODER_GUARD:
        keys = list(_DECODERS) if mezz is None else [str(Path(mezz).resolve())]
        for key in keys:
            found = _DECODERS.pop(key, None)
            _DECODER_USED.pop(key, None)
            if found is None:
                continue
            container, _stream, lock = found
            with lock:
                container.close()


def _evict_idle(ttl: float | None = None) -> int:
    limit = DECODER_IDLE_TTL_S if ttl is None else ttl
    now = time.perf_counter()
    with _DECODER_GUARD:
        stale = [key for key, used in _DECODER_USED.items() if now - used >= limit]
        for key in stale:
            found = _DECODERS.pop(key, None)
            _DECODER_USED.pop(key, None)
            if found is not None:
                container, _stream, lock = found
                with lock:
                    container.close()
    return len(stale)


def _log_warm(event: str, source_id: str, **fields: object) -> None:
    WARM_LOG.append({"event": event, "keyed": "source", "source_id": source_id, **fields})
    del WARM_LOG[:-256]
    sys.stderr.write(
        f"warm event={event} keyed=source ttl_s={fields.get('ttl_s')} expires_at={fields.get('expires_at')}\n"
    )


def warm_for_source(source_id: str, mezz_path: Path, audio_source_path: Path, *, ttl_s: float = DECODER_IDLE_TTL_S) -> dict:
    """Editor-open warm. Keyed by source id, not by an edit spec. Does not mint a revision."""
    if not source_id or "/" in source_id:
        raise RuntimeError("refusing warm key")
    mezz_path = Path(mezz_path)
    audio_source_path = Path(audio_source_path)
    if not mezz_path.is_file():
        raise MezzanineRequired("warm requires an A1 mezzanine")
    phases: dict[str, float] = {}
    total = time.perf_counter()
    started = time.perf_counter()
    container, stream, lock = _decoder(mezz_path)
    with lock:
        container.seek(0, stream=stream, backward=True, any_frame=False)
        primed = 0
        for decoded in container.decode(stream):
            decoded.reformat(format="yuv420p")
            primed += 1
            if primed >= 2:
                break
    if primed < 2:
        raise RuntimeError("warm decode primed fewer than 2 frames")
    phases["decoder_open_prime_ms"] = round((time.perf_counter() - started) * 1000.0, 3)
    started = time.perf_counter()
    cached_mezz_index(mezz_path)
    phases["index_ms"] = round((time.perf_counter() - started) * 1000.0, 3)
    started = time.perf_counter()
    lib_audio._sha256(audio_source_path)
    phases["source_digest_ms"] = round((time.perf_counter() - started) * 1000.0, 3)
    started = time.perf_counter()
    lib_audio.warm_aac(2)
    phases["aac_pool_ms"] = round((time.perf_counter() - started) * 1000.0, 3)
    expires = time.time() + ttl_s
    with _WARM_LOCK:
        _WARM[source_id] = {
            "audio": str(audio_source_path),
            "expires_at": expires,
            "mezz": str(mezz_path),
            "ttl_s": ttl_s,
        }
    phases["total_ms"] = round((time.perf_counter() - total) * 1000.0, 3)
    _log_warm("open", source_id, ttl_s=ttl_s, expires_at=round(expires, 3))
    return phases


def expire_warm(now: float | None = None) -> int:
    wall = time.time() if now is None else now
    evicted = 0
    with _WARM_LOCK:
        stale = [key for key, row in _WARM.items() if float(row["expires_at"]) <= wall]
        for key in stale:
            row = _WARM.pop(key)
            close_source(Path(row["mezz"]))
            _log_warm("evict", key, ttl_s=row["ttl_s"], expires_at=row["expires_at"])
            evicted += 1
    return evicted


def warm_status(source_id: str, now: float | None = None) -> str:
    wall = time.time() if now is None else now
    with _WARM_LOCK:
        row = _WARM.get(source_id)
    if row is None:
        return "miss"
    if float(row["expires_at"]) <= wall:
        return "expired"
    return "warm"


class EncodeCancelled(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class EncodeSlot:
    def __init__(self, video_id: str, spec_key: str, revision_id: str) -> None:
        self.video_id = video_id
        self.spec_key = spec_key
        self.revision_id = revision_id
        self.cancelled = threading.Event()
        self.done = threading.Event()
        self.reason = ""
        self.finished = False
        self._lock = threading.Lock()
        self._logged = False

    def cancel(self, reason: str) -> None:
        with self._lock:
            if not self.reason:
                self.reason = reason
            self.cancelled.set()
        self._log_terminated()

    def finish(self) -> None:
        self.finished = True
        self.done.set()
        with _ENCODE_LOCK:
            # ponytail: scan active slots; index only if concurrency makes it costly.
            for key, slot in list(_ACTIVE_ENCODES.items()):
                if slot is self:
                    _ACTIVE_ENCODES.pop(key)

    def _log_terminated(self) -> None:
        with self._lock:
            if self._logged:
                return
            self._logged = True
        sys.stderr.write(
            f"revision-prepare-terminated revision={self.revision_id} reason={self.reason or 'cancelled'}\n"
        )
        sys.stderr.flush()


_ENCODE_LOCK = threading.Lock()
_ACTIVE_ENCODES: dict[str, EncodeSlot] = {}
_ENCODE_TLS = threading.local()


def begin_revision_encode(video_id: str, spec_key: str, revision_id: str) -> tuple[EncodeSlot, bool]:
    with _ENCODE_LOCK:
        current = _ACTIVE_ENCODES.get(video_id)
        if current is not None and not current.finished and current.spec_key == spec_key:
            return current, True
        if current is not None and not current.finished and current.spec_key != spec_key:
            current.cancel("superseded")
            # Cancelled native work remains in flight until its owner finishes.
            _ACTIVE_ENCODES[f"superseded:{id(current)}"] = current
        slot = EncodeSlot(video_id, spec_key, revision_id)
        _ACTIVE_ENCODES[video_id] = slot
        return slot, False


def begin_download_hold(video_id: str, revision_id: str) -> EncodeSlot | None:
    with _ENCODE_LOCK:
        # ponytail: one background export across videos; reuse the encode slots.
        if any(not slot.finished for slot in _ACTIVE_ENCODES.values()):
            return None
        slot = EncodeSlot(video_id, f"download:{revision_id}", revision_id)
        _ACTIVE_ENCODES[video_id] = slot
        return slot


def foreign_encode_active(video_id: str, own: EncodeSlot) -> bool:
    with _ENCODE_LOCK:
        current = _ACTIVE_ENCODES.get(video_id)
        return (current is not None and current is not own and not current.finished) or (
            own.spec_key.startswith("download:") and any(
                slot is not own and not slot.finished and not slot.spec_key.startswith("download:")
                for slot in _ACTIVE_ENCODES.values()
            )
        )


def bind_encode_slot(slot: EncodeSlot | None) -> None:
    _ENCODE_TLS.slot = slot


def current_encode_slot() -> EncodeSlot | None:
    return getattr(_ENCODE_TLS, "slot", None)


def reset_revision_encodes() -> None:
    with _ENCODE_LOCK:
        slots = list(_ACTIVE_ENCODES.values())
        _ACTIVE_ENCODES.clear()
    for slot in slots:
        if not slot.finished:
            slot.cancel("reset")
    bind_encode_slot(None)


def _raise_if_encode_cancelled() -> None:
    slot = current_encode_slot()
    if slot is not None and (slot.cancelled.is_set() or foreign_encode_active(slot.video_id, slot)):
        raise EncodeCancelled(slot.reason or "cancelled")


def reset_process_state() -> None:
    close_source()
    lib_audio.reset_aac_pool()
    lib_audio.clear_sha_cache()
    lib_audio.clear_presentation_cache()
    clear_mezz_index_cache()
    reset_revision_encodes()
    with _WARM_LOCK:
        _WARM.clear()


def _decode_kept(mezz: Path, keyframes: list[dict], frames: tuple[FrameRec, ...]):
    _raise_if_encode_cancelled()
    container, stream, lock = _decoder(mezz)
    wanted = {frame.src_pts for frame in frames}
    copied = {}
    with lock:
        for run in _source_runs(frames):
            _raise_if_encode_cancelled()
            anchor = _keyframe_at_or_before(keyframes, run[0].index)
            container.seek(int(anchor["pts"]), stream=stream, backward=True, any_frame=False)
            end_pts = run[-1].src_pts
            for decoded in container.decode(stream):
                _raise_if_encode_cancelled()
                pts = decoded.pts
                if pts is None or pts < anchor["pts"]:
                    continue
                if pts in wanted:
                    copied[pts] = decoded.reformat(format="yuv420p")
                if pts >= end_pts and all(item.src_pts in copied for item in run):
                    break
                if pts > end_pts and pts not in wanted:
                    break
    missing = [frame.index for frame in frames if frame.src_pts not in copied]
    if missing:
        raise RuntimeError(f"warm decode missed source frames {missing[:8]}")
    return [copied[frame.src_pts] for frame in frames]


def apply_configured_vui(dest: Path) -> None:
    from lib_vui import apply_vui_tick_rate, configured_tick_rate

    if configured_tick_rate() is None:
        return
    encoded = dest.read_bytes()
    patched = apply_vui_tick_rate(encoded)
    if patched != encoded:
        atomic_write(dest, patched, sync=False)
        private(dest)


def _encode_pyav(frames_yuv, dest: Path, profile: Profile) -> None:
    import av
    _raise_if_encode_cancelled()
    dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    out = av.open(
        str(dest),
        "w",
        format="mp4",
        options={
            "fflags": "+bitexact",
            "movflags": "+frag_keyframe+empty_moov+default_base_moof+cmaf",
        },
    )
    aborted = False
    try:
        stream = out.add_stream("libx264", rate=30)
        stream.width = profile.width
        stream.height = profile.height
        stream.pix_fmt = "yuv420p"
        stream.time_base = Fraction(1, profile.timescale)
        stream.options = jit_options(profile.encoder_thread_count)
        for index, frame in enumerate(frames_yuv):
            _raise_if_encode_cancelled()
            frame.pts = index * (profile.timescale // 30)
            frame.time_base = Fraction(1, profile.timescale)
            if index == 0:
                frame.pict_type = av.video.frame.PictureType.I
            else:
                frame.pict_type = av.video.frame.PictureType.NONE
            for packet in stream.encode(frame):
                out.mux(packet)
        _raise_if_encode_cancelled()
        for packet in stream.encode(None):
            out.mux(packet)
    except EncodeCancelled:
        aborted = True
        raise
    finally:
        out.close()
        if aborted and dest.exists() and not dest.is_symlink():
            dest.unlink()
    private(dest)
    apply_configured_vui(dest)


def encode_segment(mezz: Path, keyframes: list[dict], frames: tuple[FrameRec, ...], dest: Path, profile: Profile, phases: dict | None = None) -> None:
    started = time.perf_counter()
    yuv = _decode_kept(mezz, keyframes, frames)
    if phases is not None:
        phases["decode_ms"] = round((time.perf_counter() - started) * 1000.0, 3)
    started = time.perf_counter()
    _encode_pyav(yuv, dest, profile)
    if phases is not None:
        phases["video_encode_ms"] = round((time.perf_counter() - started) * 1000.0, 3)


def sidecar_path(path: Path) -> Path:
    return path.with_name(path.name + ".bind.json")


def load_frames(mezz: Path) -> tuple[list[int], list[int]]:
    path = mezz.with_suffix(".frames.json")
    if not path.is_file():
        raise MezzanineRequired("frame table missing; prepare the mezzanine before serving")
    record = json.loads(path.read_text())
    return list(record["pts_tick"]), list(record["dur_tick"])


def load_keyframes(mezz: Path, mezz_sha: str) -> tuple[list[dict], dict]:
    dest = mezz.with_suffix(".keyframes.json")
    prep = mezz.with_suffix(".prep.json")
    if not dest.is_file() or not prep.is_file():
        raise MezzanineRequired("keyframe index missing; prepare the mezzanine before serving")
    rows = json.loads(dest.read_text())
    record = json.loads(prep.read_text())
    if not rows or rows[0].get("index") != 0:
        raise RuntimeError("keyframe index invalid")
    if record.get("mezz_sha256") != mezz_sha:
        raise CacheIntegrityError("keyframe index is not bound to this mezzanine")
    if record.get("index_sha256") != hashlib.sha256(dest.read_bytes()).hexdigest():
        raise CacheIntegrityError("keyframe index digest mismatch")
    key_source = record.get("keyframe_source")
    if key_source is None and record.get("prepare_ms_source") == "stss":
        key_source = "stss"
    if key_source != "stss":
        raise CacheIntegrityError("refusing a non-stss keyframe index")
    if record.get("prepare_ms_source") not in {"stss", "mezzanine"}:
        raise CacheIntegrityError("refusing an unknown prepare timing source")
    return rows, record


_MEZZ_INDEX: dict[str, tuple] = {}
_MEZZ_INDEX_LOCK = threading.Lock()


def clear_mezz_index_cache() -> None:
    with _MEZZ_INDEX_LOCK:
        _MEZZ_INDEX.clear()


def cached_mezz_index(mezz: Path) -> tuple:
    """Probe, packet table, and mezz sha, keyed by path identity. A new spec must not demux again."""
    stat = mezz.stat()
    key = f"{mezz.resolve()}:{stat.st_mtime_ns}:{stat.st_size}"
    with _MEZZ_INDEX_LOCK:
        found = _MEZZ_INDEX.get(key)
    if found is not None:
        return found
    from index import probe
    sha = sha256_file(mezz)
    probed = probe(mezz)
    ticks, durs = load_frames(mezz)
    keyframes, prep = load_keyframes(mezz, sha)
    found = (sha, probed, tuple(ticks), tuple(durs), keyframes, prep)
    with _MEZZ_INDEX_LOCK:
        _MEZZ_INDEX[key] = found
        while len(_MEZZ_INDEX) > 32:
            _MEZZ_INDEX.pop(next(iter(_MEZZ_INDEX)))
    return found


class Origin:
    def __init__(self, mezz: Path, audio_source: Path, cache: Path, ranges: list[dict], source_sha: str, *, expected_rev: str | None = None):
        self.mezz = Path(mezz)
        self.audio_source = Path(audio_source)
        if not self.mezz.is_file():
            raise MezzanineRequired("refusing to serve without an A1 mezzanine")
        mezz_sha, probed, ticks, durs, keyframes, prep = cached_mezz_index(self.mezz)
        self.mezz_sha256 = mezz_sha
        self.source_sha256 = source_sha
        if self.source_sha256 == self.mezz_sha256:
            raise RuntimeError("source sha and mezzanine sha must be distinct")
        self._keyframes = [dict(row) for row in keyframes]
        self.index_prep = dict(prep)
        self.ticks = list(ticks)
        self.durs = list(durs)
        self.profile = Profile(probed.timescale, probed.width, probed.height)
        if probed.has_b_frames:
            raise RuntimeError("refusing a mezzanine with B-frames")
        self.audio_index, _audio_prep = lib_audio.load_audio_index(self.audio_source)
        self.audio_sha256 = self.audio_index.source_sha256
        self.ranges = ranges
        # ponytail: also recognize v2's historical four-thread identity; never relabel.
        choices = ((SEGMENT_PLAN_VERSION, None), (2, None), (2, "4")) if expected_rev is not None else ((SEGMENT_PLAN_VERSION, None),)
        for version, threads in choices:
            self.profile = Profile(self.profile.timescale, self.profile.width, self.profile.height, threads)
            self.segment_plan_version = version
            self.encoder_hash = encoder_config_hash(self.profile, version)
            self.rev = revision_content_hash(ranges, self.source_sha256, self.encoder_hash, version)
            if expected_rev is None or self.rev == expected_rev:
                break
        else:
            raise CacheIntegrityError("intent mismatch")
        self.namespace = f"{self.mezz_sha256}/{self.audio_sha256}/{self.rev}/{self.encoder_hash}"
        self.segments = plan_segments(ranges, self.ticks, self.durs, self.profile.timescale, self._keyframes, self.segment_plan_version)
        self.timeline = lib_audio.plan_timeline(ranges, self.ticks, self.durs, self.profile.timescale)
        self.audio_grid = lib_audio.assign_grid(self.segments, self.timeline)
        self.playlist = playlist_text(self.segments, self.profile.timescale).encode()
        self.cache_root = Path(cache)
        self.cache = cache / "ns" / self.mezz_sha256 / self.audio_sha256 / self.rev / self.encoder_hash
        self.cache.mkdir(mode=0o700, parents=True, exist_ok=True)
        private(self.cache)
        parent = self.cache.parent
        while parent != cache and parent != parent.parent:
            private(parent)
            parent = parent.parent
        self.init_path = self.cache / "init.mp4"
        self._lock = threading.Lock()
        self._init_avcc: bytes | None = None
        self._init_bytes: bytes | None = None
        self._segment_bytes: dict[int, bytes] = {}
        self.productions: list[dict] = []
        self._last_produce: dict | None = None
        self._served_body = b""
        self._playback_lock = threading.Lock()
        self._playback_waiting = 0
        self._write_namespace_record()

    def keyframes(self) -> list[dict]:
        return self._keyframes

    def _binding(self, artifact: str, seg: int | None) -> dict:
        return {
            "artifact": artifact,
            "audio_align": AUDIO_ALIGN_VERSION,
            "encoder": self.encoder_hash,
            "namespace": self.namespace,
            "rev": self.rev,
            "seg": seg,
            "segment_plan": self.segment_plan_version,
            "source": self.mezz_sha256,
        }

    def _read_bound(self, path: Path, artifact: str, seg: int | None) -> bytes:
        side_path = sidecar_path(path)
        if not path.is_file() or not side_path.is_file():
            raise CacheIntegrityError("missing bound artifact")
        data = path.read_bytes()
        try:
            side = json.loads(side_path.read_text())
        except json.JSONDecodeError as exc:
            raise CacheIntegrityError("unreadable sidecar") from exc
        for key, value in self._binding(artifact, seg).items():
            if side.get(key) != value:
                raise CacheIntegrityError("sidecar key mismatch")
        if side.get("sha256") != hashlib.sha256(data).hexdigest():
            raise CacheIntegrityError("sidecar digest mismatch")
        if side.get("encoder") == legacy_encoder_hash(self.profile):
            raise CacheIntegrityError("old encoder hash refused")
        return data

    def _write_bound(self, path: Path, data: bytes, artifact: str, seg: int | None) -> None:
        record = self._binding(artifact, seg)
        record["sha256"] = hashlib.sha256(data).hexdigest()
        raw = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        atomic_write(path, data, sync=False)
        atomic_write(sidecar_path(path), raw, sync=False)

    def _write_namespace_record(self) -> None:
        record = {
            "audio": self.audio_sha256,
            "encoder": self.encoder_hash,
            "mezz": self.mezz_sha256,
            "namespace": self.namespace,
            "rev": self.rev,
            "segment_plan": self.segment_plan_version,
            "source": self.source_sha256,
            "source_kind": "mezzanine",
        }
        raw = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        self._write_bound(self.cache / "namespace.json", raw, "namespace", None)

    def segment_path(self, index: int) -> Path:
        return self.cache / "seg" / f"{index}.m4s"

    def _unlink_bound(self, path: Path) -> None:
        for item in (path, sidecar_path(path)):
            if item.is_symlink():
                raise RuntimeError("refusing to unlink a symlink in the cache namespace")
            if item.exists():
                item.unlink()

    def _bind_init(self, index: int, init: bytes, avcc: bytes) -> None:
        duration = lib_audio.edit_duration_ticks(lib_audio.movie_timescale(init), self.timeline.samples)
        injected = lib_audio.add_audio_elst(lib_audio.inject_audio_track(init), duration)
        if self._init_avcc is None and self.init_path.exists():
            existing = self._read_bound(self.init_path, "init", None)
            self._init_avcc = avcc_bytes(existing)
            self._init_bytes = existing
        if self._init_avcc is None:
            self._init_avcc = avcc
            self._init_bytes = injected
            self._write_bound(self.init_path, injected, "init", None)
        elif avcc != self._init_avcc or injected != self._init_bytes:
            raise RuntimeError(f"segment {index} init does not match the bound init")

    def _discard_cancelled_produce(self, index: int, *, drop_init: bool) -> None:
        self._segment_bytes.pop(index, None)
        self._served_body = b""
        seg = self.segment_path(index)
        if seg.exists() or sidecar_path(seg).exists():
            self._unlink_bound(seg)
        if not drop_init:
            return
        self._init_bytes = None
        self._init_avcc = None
        if self.init_path.exists() or sidecar_path(self.init_path).exists():
            self._unlink_bound(self.init_path)

    def produce(self, index: int) -> tuple[bytes, float]:
        if index < 0 or index >= len(self.segments):
            raise IndexError(index)
        _raise_if_encode_cancelled()
        segment = self.segments[index]
        require_kept(segment.frames, self.ranges, self.profile.timescale)
        j0, j1 = self.audio_grid[index]
        if j1 <= j0:
            raise RemovedRangeError(f"segment {index} has no audio grid frames")
        phases: dict = {}
        started = time.perf_counter()
        pcm, audio_rows = lib_audio.build_encoder_pcm(self.audio_source, self.timeline, j0, j1)
        tmp = self.cache / f".encode-{index}-{os.getpid()}-{threading.get_ident()}.mp4"
        leading = index == 0
        tail = 0
        if index == len(self.segments) - 1:
            tail = self.timeline.samples - self.timeline.slots[-1].slot_hi
            if tail < 0 or tail >= lib_audio.FRAME:
                raise RuntimeError(f"audio tail {tail} is not a partial last frame")
        audio_box: dict = {}

        def _run_audio() -> None:
            audio_started = time.perf_counter()
            try:
                audio_box["frames"] = lib_audio.encode_kept_frames(pcm, j1 - j0, leading=leading)
                audio_box["aac_pool_miss"] = lib_audio.consume_aac_pool_miss()
            except Exception as exc:
                audio_box["error"] = exc
            finally:
                audio_box["audio_encode_ms"] = round((time.perf_counter() - audio_started) * 1000.0, 3)

        audio_thread = threading.Thread(target=_run_audio)
        audio_thread.start()
        try:
            encode_segment(self.mezz, self.keyframes(), segment.frames, tmp, self.profile, phases)
            init, avcc, media = rewrite_fragment(
                tmp.read_bytes(),
                [frame.dur for frame in segment.frames],
                segment.out_pts,
                index + 1,
            )
        finally:
            audio_thread.join()
            if tmp.exists():
                tmp.unlink()
        if "error" in audio_box:
            _raise_if_encode_cancelled()
            raise audio_box["error"]
        _raise_if_encode_cancelled()
        media = lib_audio.mux_audio(
            media,
            audio_box["frames"],
            lib_audio.audio_tfdt(j0, leading=leading),
            tail=tail,
            video_start_ticks=segment.out_pts,
            video_duration_ticks=segment.duration_ticks,
            video_tb=self.profile.timescale,
            leading=leading,
        )
        init_existed = self.init_path.exists() or sidecar_path(self.init_path).exists()
        try:
            self._bind_init(index, init, avcc)
            body = styp() + media
            _raise_if_encode_cancelled()
            self._write_bound(self.segment_path(index), body, "seg", index)
            _raise_if_encode_cancelled()
        except EncodeCancelled:
            self._discard_cancelled_produce(index, drop_init=not init_existed)
            raise
        self._segment_bytes[index] = body
        elapsed = time.perf_counter() - started
        self._last_produce = {
            "aac_pool_miss": bool(audio_box.get("aac_pool_miss")),
            "phases": {**phases, "audio_encode_ms": audio_box["audio_encode_ms"]},
            "produce_ms": round(elapsed * 1000.0, 3),
        }
        self._served_body = body
        self.last_provenance = [
            {"keep_range": frame.range_index, "seg": index, "source_pts": frame.src_pts}
            for frame in segment.frames
        ]
        for row in self.last_provenance:
            if range_index_for(row["source_pts"], self.ranges, self.profile.timescale) != row["keep_range"]:
                raise RemovedRangeError("produced a removed frame")
        return body, elapsed

    def begin_playback(self, *, startup: bool = False) -> EncodeSlot | None:
        with self._playback_lock:
            self._playback_waiting += 1
        if startup:
            # Thread-keyed slots keep concurrent startup reads separate from publish.
            slot, _ = begin_revision_encode(f"startup:{threading.get_ident()}", self.rev, self.rev)
            return slot
        return None

    def end_playback(self, slot: EncodeSlot | None = None) -> None:
        if slot is not None:
            slot.finish()
        with self._playback_lock:
            if self._playback_waiting > 0:
                self._playback_waiting -= 1

    def playback_waiting(self) -> bool:
        with self._playback_lock:
            return self._playback_waiting > 0

    def ensure(self, index: int) -> bytes:
        if index >= 2 and current_encode_slot() is None:
            # Future-segment work uses the same background admission/yield as exports.
            import limits
            if index >= len(self.segments):
                raise IndexError(index)
            wall0 = time.perf_counter()
            deadline = time.monotonic() + limits.FFMPEG_TIMEOUT_S
            self.begin_playback()
            try:
                while True:
                    try:
                        body = self._read_bound(self.segment_path(index), "seg", index)
                    except CacheIntegrityError:
                        self._segment_bytes.pop(index, None)
                    else:
                        self._segment_bytes[index] = body
                        self._record(index, (time.perf_counter() - wall0) * 1000.0, hit=True, retry=False)
                        return body
                    if time.monotonic() > deadline:
                        raise TimeoutError("encode busy")
                    slot = begin_download_hold(f"segment:{self.rev}", self.rev)
                    if slot is None:
                        time.sleep(0.05)
                        continue
                    bind_encode_slot(slot)
                    try:
                        return self._ensure(index)
                    except EncodeCancelled:
                        if slot.cancelled.is_set():
                            raise
                    finally:
                        bind_encode_slot(None)
                        slot.finish()
            finally:
                self.end_playback()
        playback = current_encode_slot() is None
        slot = None
        if playback:
            slot = self.begin_playback(startup=index < 2)
        try:
            return self._ensure(index)
        finally:
            if playback:
                self.end_playback(slot)

    def _ensure(self, index: int) -> bytes:
        if index < 0 or index >= len(self.segments):
            raise IndexError(index)
        wall0 = time.perf_counter()
        cached = self._segment_bytes.get(index)
        path = self.segment_path(index)
        if cached is not None and path.is_file() and sidecar_path(path).is_file():
            self._record(index, (time.perf_counter() - wall0) * 1000.0, hit=True, retry=False)
            return cached
        with self._lock:
            cached = self._segment_bytes.get(index)
            path = self.segment_path(index)
            if cached is not None and path.is_file() and sidecar_path(path).is_file():
                self._record(index, (time.perf_counter() - wall0) * 1000.0, hit=True, retry=False)
                return cached
            self._segment_bytes.pop(index, None)
            return self._ensure_or_repair(index, wall0)

    def _ensure_or_repair(self, index: int, wall0: float) -> bytes:
        try:
            return self._ensure_locked(index, retry=False, wall0=wall0)
        except CacheIntegrityError:
            self._segment_bytes.pop(index, None)
            self._unlink_bound(self.segment_path(index))
            return self._ensure_locked(index, retry=True, wall0=wall0)

    def _ensure_locked(self, index: int, *, retry: bool, wall0: float) -> bytes:
        path = self.segment_path(index)
        present = path.exists() or sidecar_path(path).exists()
        if present:
            body = self._read_bound(path, "seg", index)
            self._segment_bytes[index] = body
            self._record(index, (time.perf_counter() - wall0) * 1000.0, hit=True, retry=retry)
            return body
        self.produce(index)
        self._record(index, (time.perf_counter() - wall0) * 1000.0, hit=False, retry=retry)
        return self._served_body

    def ensure_init(self) -> bytes:
        playback = current_encode_slot() is None
        slot = None
        if playback:
            slot = self.begin_playback(startup=True)
        try:
            return self._ensure_init()
        finally:
            if playback:
                self.end_playback(slot)

    def _ensure_init(self) -> bytes:
        cached = self._init_bytes
        if cached is not None and self.init_path.is_file() and sidecar_path(self.init_path).is_file():
            return cached
        with self._lock:
            return self._ensure_init_locked()

    def _ensure_init_locked(self) -> bytes:
        if self._init_bytes is not None and self.init_path.is_file() and sidecar_path(self.init_path).is_file():
            return self._init_bytes
        self._init_bytes = None
        if self.init_path.exists() or sidecar_path(self.init_path).exists():
            try:
                data = self._read_bound(self.init_path, "init", None)
                self._init_bytes = data
                self._init_avcc = avcc_bytes(data)
                return data
            except CacheIntegrityError:
                self._unlink_bound(self.init_path)
                self._init_bytes = None
                self._init_avcc = None
        wall0 = time.perf_counter()
        self.produce(0)
        self._record(0, (time.perf_counter() - wall0) * 1000.0, hit=False, retry=False)
        if self._init_bytes is None:
            self._init_bytes = self._read_bound(self.init_path, "init", None)
        return self._init_bytes

    def read_init_for_download(self) -> bytes:
        playback = current_encode_slot() is None
        if playback:
            self.begin_playback()
        try:
            with self._lock:
                preexisted = set(self._segment_bytes)
                try:
                    return self._read_init_for_download_locked()
                finally:
                    for index in list(self._segment_bytes):
                        if index not in preexisted:
                            self._segment_bytes.pop(index, None)
        finally:
            if playback:
                self.end_playback()

    def read_segment_for_download(self, index: int) -> bytes:
        playback = current_encode_slot() is None
        if playback:
            self.begin_playback()
        try:
            return self._read_segment_for_download(index)
        finally:
            if playback:
                self.end_playback()

    def _read_init_for_download_locked(self) -> bytes:
        if self.init_path.is_file() and sidecar_path(self.init_path).is_file():
            try:
                return self._read_bound(self.init_path, "init", None)
            except CacheIntegrityError:
                self._unlink_bound(self.init_path)
                self._init_bytes = None
                self._init_avcc = None
        return self._ensure_init_locked()

    def _read_segment_for_download(self, index: int) -> bytes:
        if index < 0 or index >= len(self.segments):
            raise IndexError(index)
        wall0 = time.perf_counter()
        with self._lock:
            path = self.segment_path(index)
            if index in self._segment_bytes and path.is_file() and sidecar_path(path).is_file():
                try:
                    return self._read_bound(path, "seg", index)
                except CacheIntegrityError:
                    self._segment_bytes.pop(index, None)
                    try:
                        return self._ensure_or_repair(index, wall0)
                    finally:
                        self._segment_bytes.pop(index, None)
            self._segment_bytes.pop(index, None)
            try:
                self._ensure_or_repair(index, wall0)
                return self._read_bound(self.segment_path(index), "seg", index)
            finally:
                self._segment_bytes.pop(index, None)

    def _record(self, index: int, ensure_ms: float, *, hit: bool, retry: bool) -> None:
        produced = self._last_produce or {}
        duration_s = self.segments[index].duration_ticks / self.profile.timescale
        self.productions.append({
            "aac_pool_miss": bool(produced.get("aac_pool_miss")) if not hit else False,
            "duration_s": duration_s,
            "encoder": self.encoder_hash,
            "ensure_ms": round(ensure_ms, 3),
            "hit": hit,
            "integrity_retry": retry,
            "namespace": self.namespace,
            "phases": {} if hit else dict(produced.get("phases") or {}),
            "produce_ms": 0.0 if hit else produced.get("produce_ms"),
            "seg": index,
        })
        if os.environ.get("CAP_WORKER_TIMING") == "1":
            print("origin-segment-timing " + json.dumps(self.productions[-1]), flush=True)


def map_source_time(t: float, ranges: list[dict]) -> float | None:
    cursor = 0.0
    for item in ranges:
        start = float(item["start"])
        end = float(item["end"])
        if t < start:
            return None
        if start <= t < end:
            return cursor + (t - start)
        cursor += end - start
    return None


def remap_cues(cues: list[dict], ranges: list[dict], *, text_key: str) -> list[dict]:
    out = []
    for cue in cues:
        start = map_source_time(float(cue["start"]), ranges)
        end = map_source_time(float(cue.get("end", cue["start"])), ranges)
        if start is None:
            continue
        if end is None:
            end = start
        if end < start:
            continue
        row = {"start": start, "end": end}
        if text_key in cue:
            row[text_key] = cue[text_key]
        if "title" in cue:
            row["title"] = cue["title"]
        out.append(row)
    return out
