#!/usr/bin/env python3
"""Presentation-timeline cut for segment-aligned AAC.

Kept audio for a range is the source presentation PCM under that range's
kept video frames, placed on the cumulative kept-frame sample grid.
Windowed ffmpeg -ss is not used: on the real source the exact slice is in
the seek output, but the lead is not a function of packet PTS (loud gap at
seek 7037476, true lead 548, PTS formula 528, span error 0.62). The eager
full-file decode is that presentation timeline. A request only slices it.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import limits

SR = 48000
_PRESENTATION_AUDIO_STREAM = "0:a:0"
FRAME = 1024
PRE_FRAMES = 2
POST_FRAMES = 2
PRE_ROLL = PRE_FRAMES * FRAME
POST_ROLL = POST_FRAMES * FRAME
FADE_S = 0.015
FADE_N = int(round(FADE_S * SR))
TB = 15360
AUDIO_BITRATE = "160k"
AUDIO_TRACK_ID = 2
ROOT = Path(__file__).resolve().parent
MAX_ADJUST = 2
# ponytail: 0.5s ceiling on audio-shorter-than-video padding; larger gaps still fail loudly.
TAIL_SILENCE_MAX = 24000
# ffmpeg native AAC emits one priming frame, then one frame per 1024 input samples.
PRIMING_FRAMES = 1
# Init elst skips this many media samples so the leading overlap frame is not presented.
ELST_MEDIA_TIME = 1024
TFDT_BIAS = ELST_MEDIA_TIME
AAC_ENCODER_ARGS = ("-aac_is", "0", "-aac_pns", "0")

AUDIO_SPEC = {
    "aac_is": 0,
    "aac_pns": 0,
    "bitrate": AUDIO_BITRATE,
    "channels": 2,
    "codec": "aac",
    "cut": "kept-frame-span",
    "elst_media_time": ELST_MEDIA_TIME,
    "fade_s": FADE_S,
    "frame": FRAME,
    "pcm": "full-presentation",
    "post_roll": POST_ROLL,
    "pre_roll": PRE_ROLL,
    "profile": "aac-lc",
    "sample_rate": SR,
    "tfdt_bias": TFDT_BIAS,
}


class RemovedRangeError(RuntimeError):
    """A sample outside the kept-frame spans was offered to the audio encoder."""


class AudioRejected(RuntimeError):
    """Source audio is missing or its sample rate is not one we present at 48 kHz."""


@dataclass(frozen=True)
class AudioIndex:
    pts: np.ndarray
    dur: np.ndarray
    size: np.ndarray
    pos: np.ndarray
    source_sha256: str

    def presentation_origin(self, packet: int) -> int:
        return int(self.pts[packet])


@dataclass(frozen=True)
class RangeSlot:
    index: int
    start: float
    end: float
    v0_tick: int
    v1_tick: int
    src_lo: int
    src_hi: int
    slot_lo: int
    slot_hi: int
    adjust: int

    tb: int = TB

    @property
    def v0_samples(self) -> int:
        return self.v0_tick * SR // self.tb


@dataclass(frozen=True)
class Timeline:
    slots: tuple[RangeSlot, ...]
    samples: int
    max_adjust: int
    video_tb: int = TB

    def slot_at(self, output_index: int) -> RangeSlot | None:
        for slot in self.slots:
            if slot.slot_lo <= output_index < slot.slot_hi:
                return slot
        return None


def private(path: Path) -> None:
    if path.is_dir():
        os.chmod(path, 0o700)
    elif path.exists():
        os.chmod(path, 0o600)


_SHA: dict[str, str] = {}


def clear_sha_cache() -> None:
    _SHA.clear()


def clear_presentation_cache() -> None:
    _PCM.clear()
    _PCM_RECORD.clear()


def _sha256(path: Path) -> str:
    key = str(path)
    found = _SHA.get(key)
    if found is not None:
        return found
    found = _sha256_fresh(path)
    _SHA[key] = found
    return found


def _sha256_fresh(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _owned(source: Path) -> bool:
    media = (ROOT / "media").resolve()
    for candidate in (source, source.resolve()):
        try:
            candidate.absolute().relative_to(media)
        except ValueError:
            continue
        return True
    return False


def index_path(source: Path) -> Path:
    return source.with_suffix(source.suffix + ".apackets.npz")


def index_prep_path(source: Path) -> Path:
    return source.with_suffix(source.suffix + ".aprep.json")


def presentation_pcm_path(source: Path) -> Path:
    return source.with_suffix(source.suffix + ".ppcm")


def presentation_meta_path(source: Path) -> Path:
    return source.with_suffix(source.suffix + ".ppcm.json")


def _parse_packet_lines(text: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    pts, dur, size, pos = [], [], [], []
    for line in text.splitlines():
        nums = []
        for part in line.split(","):
            try:
                nums.append(int(part))
            except ValueError:
                break
        if len(nums) < 4:
            continue
        pts.append(nums[0])
        dur.append(nums[1])
        size.append(nums[2])
        pos.append(nums[3])
    if not pts:
        raise RuntimeError("audio packet index is empty")
    return (
        np.asarray(pts, dtype=np.int64),
        np.asarray(dur, dtype=np.int32),
        np.asarray(size, dtype=np.int32),
        np.asarray(pos, dtype=np.int64),
    )


def _reusable_audio_index(source: Path) -> dict | None:
    dest = index_path(source)
    prep = index_prep_path(source)
    if not dest.is_file() or not prep.is_file():
        return None
    try:
        record = json.loads(prep.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    source_sha = _sha256(source)
    index_sha = _sha256(dest)
    if record.get("source_sha256") != source_sha or record.get("index_sha256") != index_sha:
        return None
    if not isinstance(record.get("packets"), int) or isinstance(record.get("packets"), bool):
        return None
    reused = dict(record)
    reused["reused"] = True
    return reused


def build_audio_index(source: Path) -> dict:
    """Eager packet index. Not called from a segment request."""
    reused = _reusable_audio_index(source)
    if reused is not None:
        return reused
    started = time.perf_counter()
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0", "-show_packets",
            "-show_entries", "packet=pts,duration,size,pos", "-of", "csv=p=0", str(source),
        ],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=limits.timeout_for_source(source),
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-2000:])
    pts, dur, size, pos = _parse_packet_lines(result.stdout.decode())
    dest = index_path(source)
    dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    np.savez(dest, pts=pts, dur=dur, size=size, pos=pos)
    private(dest)
    elapsed = round((time.perf_counter() - started) * 1000, 3)
    record = {
        "index": dest.name,
        "index_sha256": _sha256(dest),
        "packets": int(len(pts)),
        "prepare_ms": elapsed,
        "source": source.name,
        "source_sha256": _sha256(source),
    }
    prep = index_prep_path(source)
    prep.write_bytes((json.dumps(record, indent=2, sort_keys=True) + "\n").encode())
    private(prep)
    return record


def load_audio_index(source: Path) -> tuple[AudioIndex, dict]:
    dest = index_path(source)
    prep_path = index_prep_path(source)
    if not dest.is_file() or not prep_path.is_file():
        raise RuntimeError(f"audio packet index missing for {source}; prepare it before serving")
    record = json.loads(prep_path.read_text())
    source_sha = _sha256(source)
    index_sha = _sha256(dest)
    if record.get("source_sha256") != source_sha or record.get("index_sha256") != index_sha:
        raise RuntimeError(f"audio packet index is not bound to {source}")
    if not isinstance(record.get("prepare_ms"), (int, float)) or isinstance(record.get("prepare_ms"), bool):
        raise RuntimeError(f"audio index preparation time missing for {source}")
    arrays = np.load(dest)
    index = AudioIndex(arrays["pts"], arrays["dur"], arrays["size"], arrays["pos"], source_sha)
    if len(index.pts) != record.get("packets"):
        raise RuntimeError(f"audio index length does not match its preparation record for {source}")
    return index, record


def _has_audio_stream(source: Path) -> bool:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(source)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=limits.timeout_for_source(source),
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-2000:])
    return bool(result.stdout.strip())


def audio_source_for(source: Path, timeline: Path) -> Path:
    """Audio input for a source. Video-only sources get a source-bound silent AAC track, as long as
    the served video timeline (the mezzanine), beside the original, so the editor and renders work
    instead of refusing the recording."""
    if _reusable_audio_index(source) is not None or _has_audio_stream(source):
        return source
    source_sha = _sha256(source)
    dest = source.with_name(f"silent-{source_sha[:32]}.m4a")
    if dest.is_file():
        return dest
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration",
         "-of", "csv=p=0", str(timeline)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=limits.timeout_for_source(source),
    )
    try:
        duration = float(probe.stdout.decode().strip().splitlines()[0])
    except (ValueError, IndexError):
        raise AudioRejected(f"refusing silent source without a video duration: {source.name}") from None
    if probe.returncode or not duration > 0:
        raise AudioRejected(f"refusing silent source without a video duration: {source.name}")
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.{threading.get_ident()}.m4a")
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
         "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=stereo", "-t", f"{duration:.6f}",
         "-c:a", "aac", "-b:a", AUDIO_BITRATE,
         # Bind content (and so its sha / cache namespace) to this source, not just its duration.
         "-metadata", f"comment=silent-for-source-sha256={source_sha}", str(tmp)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=limits.timeout_for_source(source),
    )
    if result.returncode:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-2000:])
    private(tmp)
    os.replace(tmp, dest)
    return dest


def probe_audio_rate(source: Path) -> int:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate", "-of", "csv=p=0", str(source),
        ],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=limits.timeout_for_source(source),
    )
    text = result.stdout.decode().strip().splitlines()
    if result.returncode or not text or not text[0].strip().isdigit():
        raise AudioRejected(f"refusing source with no decodable audio stream: {source.name}")
    return int(text[0].strip())


def _reusable_presentation(dest: Path, meta: Path, source_sha: str) -> dict | None:
    if not dest.is_file() or not meta.is_file():
        return None
    try:
        record = json.loads(meta.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if record.get("source_sha256") != source_sha:
        return None
    pcm_sha = record.get("pcm_sha256")
    if not isinstance(pcm_sha, str) or len(pcm_sha) != 64:
        return None
    samples = record.get("samples")
    if isinstance(samples, bool) or not isinstance(samples, int) or samples <= 0:
        return None
    if dest.stat().st_size != samples * 8:
        return None
    if record.get("audio_stream") != _PRESENTATION_AUDIO_STREAM:
        return None
    input_rate = record.get("input_rate")
    if not _supported_input_rate(input_rate):
        return None
    if record.get("resampled_from") != (None if input_rate == SR else input_rate):
        return None
    if _sha256_fresh(dest) != pcm_sha:
        return None
    return record


def prepare_presentation(source: Path) -> dict:
    """One full-file decode. Sample i is presentation time i/SR. Not a request path.

    Editor-open reuses the PCM when its prep record is still bound to this source
    sha. POST /internal/sources/{videoId}/prepare at upload time is what should
    populate it; editor-open remains the fallback.
    """
    dest = presentation_pcm_path(source)
    meta = presentation_meta_path(source)
    source_sha = _sha256(source)
    reused = _reusable_presentation(dest, meta, source_sha)
    if reused is not None:
        reused = dict(reused)
        reused["reused"] = True
        return reused
    rate = probe_audio_rate(source)
    policy = audio_rate_policy(rate)
    started = time.perf_counter()
    dest = presentation_pcm_path(source)
    dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
            "-map", "0:a:0",
            "-vn", "-ac", "2", "-ar", str(SR), "-f", "f32le", str(dest),
        ],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=limits.timeout_for_source(source),
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-2000:])
    private(dest)
    nbytes = dest.stat().st_size
    if nbytes % 8:
        raise RuntimeError(f"presentation pcm length {nbytes} is not a stereo frame")
    source_sha = _sha256(source)
    _SHA.pop(str(dest), None)
    record = {
        "pcm": dest.name,
        "pcm_sha256": _sha256(dest),
        "prepare_ms": round((time.perf_counter() - started) * 1000, 3),
        "input_rate": rate,
        "resampled_from": None if policy == "native" else rate,
        "samples": nbytes // 8,
        "source": source.name,
        "source_sha256": source_sha,
        "audio_stream": _PRESENTATION_AUDIO_STREAM,
    }
    meta = presentation_meta_path(source)
    meta.write_bytes((json.dumps(record, indent=2, sort_keys=True) + "\n").encode())
    private(meta)
    return record


_PCM: dict[str, np.ndarray] = {}
_PCM_RECORD: dict[str, dict] = {}


def load_presentation(source: Path) -> tuple[np.ndarray, dict]:
    meta_path = presentation_meta_path(source)
    dest = presentation_pcm_path(source)
    key = str(dest)
    cached = _PCM.get(key)
    record = _PCM_RECORD.get(key)
    if cached is not None and record is not None:
        return cached, record
    if not dest.is_file() or not meta_path.is_file():
        raise RuntimeError(f"presentation pcm missing for {source}; prepare it before serving")
    record = json.loads(meta_path.read_text())
    source_sha = _sha256(source)
    if record.get("source_sha256") != source_sha:
        raise RuntimeError(f"presentation pcm is not bound to {source}")
    if dest.stat().st_size != int(record["samples"]) * 8:
        raise RuntimeError(f"presentation pcm length does not match its record for {source}")
    if cached is None or len(cached) != int(record["samples"]):
        cached = np.memmap(dest, dtype="<f4", mode="r").reshape(-1, 2)
        _PCM[key] = cached
    _PCM_RECORD[key] = record
    return cached, record


def _read_presentation(source: Path, lo: int, hi: int) -> np.ndarray:
    if hi <= lo:
        return np.zeros((0, 2), np.float32)
    pcm, _record = load_presentation(source)
    short = hi - len(pcm)
    # Video can outlast audio by a few frames (cap-ol0.9): the gap plays as silence. More than that is a broken index.
    if lo < 0 or short > TAIL_SILENCE_MAX:
        raise RuntimeError(f"presentation slice {lo}:{hi} outside decoded length {len(pcm)}")
    if short <= 0:
        return np.array(pcm[lo:hi], dtype=np.float32, copy=True)
    out = np.zeros((hi - lo, 2), np.float32)
    have = max(0, len(pcm) - lo)
    out[:have] = pcm[lo:lo + have]
    return out


def _samples_at(tick: int, video_tb: int = TB) -> int:
    return int(round(tick / video_tb * SR))


_AAC_RATES = frozenset({
    8000,
    11025,
    12000,
    16000,
    22050,
    24000,
    32000,
    44100,
    48000,
    64000,
    88200,
    96000,
})


def _supported_input_rate(sample_rate: object) -> bool:
    return isinstance(sample_rate, int) and not isinstance(sample_rate, bool) and sample_rate in _AAC_RATES


def audio_rate_policy(sample_rate: object) -> str:
    """48 kHz stays native. Any other supported rate is resampled to 48 kHz. Anything else is refused."""
    if not _supported_input_rate(sample_rate):
        raise AudioRejected(
            f"refusing audio sample rate {sample_rate}; resample a supported rate to {SR} or supply {SR}"
        )
    if sample_rate == SR:
        return "native"
    return "resample"


def range_index_for_time(t: float, ranges: list[dict]) -> int | None:
    for index, item in enumerate(ranges):
        if float(item["start"]) <= t < float(item["end"]):
            return index
    return None


def frame_span_index(timeline: Timeline, sample: int) -> int | None:
    for slot in timeline.slots:
        if slot.src_lo <= sample < slot.src_hi:
            return slot.index
    return None


def plan_timeline(ranges: list[dict], ticks: list[int], durs: list[int], video_tb: int = TB) -> Timeline:
    slots = []
    cursor = 0
    out_lo = 0
    max_adjust = 0
    if isinstance(video_tb, bool) or not isinstance(video_tb, int) or video_tb <= 0:
        raise RuntimeError(f"bad video timescale {video_tb}")
    pts = np.asarray(ticks, dtype=np.float64) / video_tb
    for index, item in enumerate(ranges):
        start = float(item["start"])
        end = float(item["end"])
        ids = np.flatnonzero((pts >= start) & (pts < end))
        if ids.size == 0:
            raise RuntimeError(f"keep range {index} contains no frames")
        first = int(ids[0])
        last = int(ids[-1])
        v0 = ticks[first]
        v1 = ticks[last] + durs[last]
        if v1 - v0 != sum(durs[i] for i in ids.tolist()):
            raise RuntimeError(f"range {index} frame span is not the sum of durations")
        src_lo = _samples_at(v0, video_tb)
        src_hi = _samples_at(v1, video_tb)
        cursor += v1 - v0
        out_hi = _samples_at(cursor, video_tb)
        adjust = (src_hi - src_lo) - (out_hi - out_lo)
        max_adjust = max(max_adjust, abs(adjust))
        if abs(adjust) > MAX_ADJUST:
            raise RuntimeError(
                f"range {index} audio/slot adjustment {adjust} exceeds {MAX_ADJUST} samples"
            )
        slots.append(RangeSlot(index, start, end, v0, v1, src_lo, src_hi, out_lo, out_hi, adjust, video_tb))
        out_lo = out_hi
    pad = (FRAME - out_lo % FRAME) % FRAME
    if pad:
        out_lo += pad
    if out_lo % FRAME:
        raise RuntimeError(f"output timeline {out_lo} is not a multiple of {FRAME}")
    return Timeline(tuple(slots), out_lo, max_adjust, video_tb)


def grid_bounds(out_pts: int, next_pts: int | None, timeline_samples: int, video_tb: int = TB) -> tuple[int, int]:
    den = FRAME * video_tb
    j0 = (out_pts * SR + den - 1) // den
    if next_pts is None:
        j1 = timeline_samples // FRAME
    else:
        j1 = (next_pts * SR + den - 1) // den
    if j1 < j0:
        raise RuntimeError(f"audio grid inverted {j0}..{j1}")
    return j0, j1


def assign_grid(segments, timeline: Timeline) -> list[tuple[int, int]]:
    bounds = []
    for index, segment in enumerate(segments):
        next_pts = segments[index + 1].out_pts if index + 1 < len(segments) else None
        bounds.append(grid_bounds(segment.out_pts, next_pts, timeline.samples, timeline.video_tb))
    cursor = 0
    for j0, j1 in bounds:
        if j0 != cursor:
            raise RuntimeError(f"audio grid gap or overlap at frame {cursor} vs {j0}")
        cursor = j1
    if cursor * FRAME != timeline.samples:
        raise RuntimeError(f"audio grid covers {cursor * FRAME}, timeline {timeline.samples}")
    return bounds


def _slot_source(slot: RangeSlot, rel: int, last: int) -> int:
    """Map an output offset inside the slot to a kept presentation sample."""
    out_n = slot.slot_hi - slot.slot_lo
    src_n = slot.src_hi - slot.src_lo
    adjust = src_n - out_n
    if adjust == 0:
        return slot.src_lo + rel
    if adjust > 0:
        if slot.index == 0 or slot.index != last:
            return slot.src_lo + rel
        if slot.index:
            return slot.src_lo + adjust + rel
        raise RuntimeError(f"range {slot.index} trim has no fade window")
    need = -adjust
    if slot.index == 0 or slot.index != last:
        if rel < src_n:
            return slot.src_lo + rel
        return slot.src_hi - 1
    if slot.index:
        if rel < need:
            return slot.src_lo
        return slot.src_lo + rel - need
    raise RuntimeError(f"range {slot.index} pad has no fade window")


def frame_span_contains(timeline: Timeline, sample: int, keep_range: int) -> bool:
    if keep_range < 0 or keep_range >= len(timeline.slots):
        return False
    slot = timeline.slots[keep_range]
    return slot.src_lo <= sample < slot.src_hi


def assert_plan_kept(rows: list[dict], timeline: Timeline) -> None:
    for row in rows:
        if row.get("kind") == "pad":
            continue
        sample = int(row["presentation"])
        keep = int(row["keep_range"])
        if not frame_span_contains(timeline, sample, keep):
            raise RemovedRangeError(
                f"refusing presentation sample {sample} ({sample / SR:.6f}s) "
                f"outside keep range {keep} frame span"
            )
        src_lo = int(row.get("source_lo", sample))
        src_hi = int(row.get("source_hi", sample + 1))
        for cursor in (src_lo, src_hi - 1):
            if not frame_span_contains(timeline, cursor, keep):
                raise RemovedRangeError(
                    f"refusing source span {src_lo}:{src_hi} outside keep range {keep}"
                )


def refuse_removed_sample(presentation_sample: int, timeline: Timeline, dest: Path) -> None:
    """Gate used by the refusal test. Raises before any encoder input exists."""
    if dest.exists():
        dest.unlink()
    if frame_span_index(timeline, presentation_sample) is None:
        raise RemovedRangeError(
            f"refusing audio presentation sample {presentation_sample} "
            f"({presentation_sample / SR:.6f}s) outside kept-frame spans"
        )
    raise RuntimeError("refuse_removed_sample was given a kept sample")


def _apply_fades(pcm: np.ndarray, timeline: Timeline, out_lo: int) -> None:
    ramp_in = np.linspace(0.0, 1.0, FADE_N, dtype=np.float32)[:, None]
    ramp_out = np.linspace(1.0, 0.0, FADE_N, dtype=np.float32)[:, None]
    last = len(timeline.slots) - 1
    for slot in timeline.slots:
        if slot.index:
            _scale(pcm, out_lo, slot.slot_lo, ramp_in)
        # A lone keep corrects sample rounding at its kept tail, never in removed audio.
        if slot.index != last or (last == 0 and slot.adjust):
            _scale(pcm, out_lo, slot.slot_hi - FADE_N, ramp_out)


def _scale(pcm: np.ndarray, out_lo: int, start: int, ramp: np.ndarray) -> None:
    at = start - out_lo
    if at >= len(pcm) or at + len(ramp) <= 0:
        return
    lo = max(0, at)
    hi = min(len(pcm), at + len(ramp))
    pcm[lo:hi] *= ramp[lo - at:hi - at]


def assemble_cut(source: Path, timeline: Timeline, out_lo: int, out_hi: int) -> tuple[np.ndarray, list[dict]]:
    """Cut PCM for output samples [out_lo, out_hi). Same placement the encoder uses."""
    if out_hi < out_lo:
        raise RuntimeError(f"cut window {out_lo}:{out_hi} is inverted")
    pcm = np.zeros((out_hi - out_lo, 2), np.float32)
    rows = []
    last = len(timeline.slots) - 1
    for slot in timeline.slots:
        a = max(out_lo, slot.slot_lo)
        b = min(out_hi, slot.slot_hi)
        if a >= b:
            continue
        adjust = (slot.src_hi - slot.src_lo) - (slot.slot_hi - slot.slot_lo)
        if adjust == 0:
            src_lo = slot.src_lo + (a - slot.slot_lo)
            src_hi = src_lo + (b - a)
            presentation = src_lo
        else:
            srcs = [_slot_source(slot, rel, last) for rel in range(a - slot.slot_lo, b - slot.slot_lo)]
            src_lo = min(srcs)
            src_hi = max(srcs) + 1
            presentation = srcs[0]
        if src_lo < slot.src_lo or src_hi > slot.src_hi:
            raise RemovedRangeError(
                f"range {slot.index} encoder input {src_lo}:{src_hi} left the frame span "
                f"{slot.src_lo}:{slot.src_hi}"
            )
        decoded = _read_presentation(source, src_lo, src_hi)
        if adjust == 0:
            pcm[a - out_lo:b - out_lo] = decoded
        else:
            srcs = [_slot_source(slot, rel, last) for rel in range(a - slot.slot_lo, b - slot.slot_lo)]
            for offset, src in enumerate(srcs):
                pcm[a - out_lo + offset] = decoded[src - src_lo]
        rows.append({
            "keep_range": slot.index,
            "kind": "kept",
            "output_hi": b,
            "output_lo": a,
            "presentation": presentation,
            "source_hi": src_hi,
            "source_lo": src_lo,
        })
    assert_plan_kept(rows, timeline)
    _apply_fades(pcm, timeline, out_lo)
    return pcm, rows


def build_encoder_pcm(source: Path, timeline: Timeline, j0: int, j1: int) -> tuple[np.ndarray, list[dict]]:
    """Cut PCM for grid frames [j0, j1), plus 2048 samples of kept-neighbor roll."""
    win_lo = j0 * FRAME - PRE_ROLL
    win_hi = j1 * FRAME + POST_ROLL
    pcm = np.zeros((win_hi - win_lo, 2), np.float32)
    inner_lo = max(0, win_lo)
    inner_hi = min(timeline.samples, win_hi)
    inner, rows = assemble_cut(source, timeline, inner_lo, inner_hi)
    pcm[inner_lo - win_lo:inner_hi - win_lo] = inner
    return pcm, rows


def source_for_output(timeline: Timeline, output_index: int) -> tuple[str, int, int] | None:
    slot = timeline.slot_at(output_index)
    if slot is None:
        return None
    src = _slot_source(slot, output_index - slot.slot_lo, len(timeline.slots) - 1)
    return ("kept", src, slot.index)


def render_cut_pcm(source: Path, timeline: Timeline) -> np.ndarray:
    """Full cut PCM using the same placement as build_encoder_pcm."""
    pcm, _rows = assemble_cut(source, timeline, 0, timeline.samples)
    return pcm


def _adts_header(payload_len: int) -> bytes:
    frame_len = payload_len + 7
    return bytes([
        0xFF, 0xF1, 0x4C,
        0x80 | ((frame_len >> 11) & 0x03),
        (frame_len >> 3) & 0xFF,
        ((frame_len & 7) << 5) | 0x1F,
        0xFC,
    ])


def _decode_adts(blob: bytes) -> np.ndarray:
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "aac", "-i", "pipe:0",
            "-ac", "2", "-ar", str(SR), "-f", "f32le", "pipe:1",
        ],
        input=blob, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=30,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", "replace")[-2000:])
    data = np.frombuffer(result.stdout, dtype="<f4")
    if len(data) % 2:
        data = data[:-1]
    return data.reshape(-1, 2).copy()


def _adts_frames(blob: bytes) -> list[bytes]:
    frames = []
    cursor = 0
    while cursor + 7 <= len(blob):
        if blob[cursor] != 0xFF or (blob[cursor + 1] & 0xF0) != 0xF0:
            raise RuntimeError(f"AAC stream is not ADTS at {cursor}")
        length = ((blob[cursor + 3] & 3) << 11) | (blob[cursor + 4] << 3) | (blob[cursor + 5] >> 5)
        if length < 7 or cursor + length > len(blob):
            raise RuntimeError("truncated ADTS frame")
        frames.append(blob[cursor:cursor + length])
        cursor += length
    if cursor != len(blob):
        raise RuntimeError("AAC stream has trailing bytes")
    return frames


_AAC_POOL: queue.Queue = queue.Queue()
_AAC_LOCK = threading.Lock()
_AAC_READY = 2
_AAC_MIN_AGE_S = 0.080
_AAC_STOP = threading.Event()
_AAC_REFILLER: threading.Thread | None = None
_AAC_REFILL_LOCK = threading.Lock()
_AAC_INFLIGHT: subprocess.Popen | None = None
_AAC_MISS = False
_AAC_MISS_COUNT = 0


def _aac_cmd() -> list[str]:
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "pipe:0",
        "-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", str(SR), "-ac", "2",
        *AAC_ENCODER_ARGS, "-f", "adts", "pipe:1",
    ]


def _spawn_aac() -> subprocess.Popen:
    proc = subprocess.Popen(
        _aac_cmd(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    proc._aac_born = time.perf_counter()  # type: ignore[attr-defined]
    return proc


def _aac_age(proc: subprocess.Popen) -> float:
    born = getattr(proc, "_aac_born", None)
    if born is None:
        return 0.0
    return time.perf_counter() - born


def _aac_ready(proc: subprocess.Popen) -> bool:
    return proc.poll() is None and _aac_age(proc) >= _AAC_MIN_AGE_S


def _kill_aac(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    if proc.poll() is None:
        proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    for pipe in (proc.stdin, proc.stdout, proc.stderr):
        if pipe is not None:
            pipe.close()


def _refill_aac() -> None:
    """Publish a process only after it has been alive >= 80 ms. Never holds _AAC_LOCK."""
    global _AAC_INFLIGHT
    while not _AAC_STOP.is_set():
        if _AAC_POOL.qsize() >= _AAC_READY:
            _AAC_STOP.wait(0.02)
            continue
        proc = _spawn_aac()
        _AAC_INFLIGHT = proc
        while not _AAC_STOP.is_set() and _aac_age(proc) < _AAC_MIN_AGE_S:
            remain = _AAC_MIN_AGE_S - _aac_age(proc)
            _AAC_STOP.wait(min(0.02, max(remain, 0.0)))
        _AAC_INFLIGHT = None
        if _AAC_STOP.is_set() or proc.poll() is not None:
            _kill_aac(proc)
            continue
        _AAC_POOL.put(proc)


def _ensure_refiller() -> None:
    global _AAC_REFILLER
    with _AAC_REFILL_LOCK:
        if _AAC_REFILLER is not None and _AAC_REFILLER.is_alive():
            return
        if _AAC_STOP.is_set():
            return
        _AAC_STOP.clear()
        _AAC_REFILLER = threading.Thread(target=_refill_aac, name="aac-refill", daemon=True)
        _AAC_REFILLER.start()


def aac_pool_qsize() -> int:
    return _AAC_POOL.qsize()


def consume_aac_pool_miss() -> bool:
    global _AAC_MISS
    flag = _AAC_MISS
    _AAC_MISS = False
    return flag


def aac_pool_miss_count() -> int:
    return _AAC_MISS_COUNT


def _take_aac() -> subprocess.Popen:
    """Return an init-complete pooled process. Spawn only on an empty pool, and record that miss."""
    global _AAC_MISS, _AAC_MISS_COUNT
    while True:
        try:
            proc = _AAC_POOL.get_nowait()
        except queue.Empty:
            _AAC_MISS = True
            _AAC_MISS_COUNT += 1
            _ensure_refiller()
            return _spawn_aac()
        if proc.poll() is not None:
            continue
        if not _aac_ready(proc):
            # The refiller must not publish a young process. Do not encode with it.
            _AAC_POOL.put(proc)
            _AAC_MISS = True
            _AAC_MISS_COUNT += 1
            _ensure_refiller()
            return _spawn_aac()
        _AAC_MISS = False
        return proc


def warm_aac(count: int = 2) -> None:
    """Fill the pool with init-complete processes. Does not return until they are published."""
    global _AAC_READY
    _AAC_READY = max(int(count), 1)
    if _AAC_STOP.is_set():
        thread = _AAC_REFILLER
        if thread is not None and thread.is_alive():
            thread.join(timeout=2.0)
        _AAC_STOP.clear()
    _ensure_refiller()
    deadline = time.perf_counter() + 5.0
    while aac_pool_qsize() < _AAC_READY:
        if time.perf_counter() > deadline:
            raise RuntimeError(f"aac pool has {aac_pool_qsize()} ready, need {_AAC_READY}")
        time.sleep(0.01)


def reset_aac_pool() -> None:
    """Stop the refiller and empty the pool. The next take is a recorded miss until warm_aac."""
    global _AAC_REFILLER, _AAC_INFLIGHT, _AAC_MISS
    _AAC_STOP.set()
    thread = _AAC_REFILLER
    if thread is not None:
        thread.join(timeout=2.0)
    with _AAC_REFILL_LOCK:
        _AAC_REFILLER = None
    _kill_aac(_AAC_INFLIGHT)
    _AAC_INFLIGHT = None
    while True:
        try:
            proc = _AAC_POOL.get_nowait()
        except queue.Empty:
            break
        _kill_aac(proc)
    _AAC_MISS = False
    if thread is None or not thread.is_alive():
        _AAC_STOP.clear()


def aac_encode_adts(pcm: np.ndarray) -> bytes:
    raw = np.ascontiguousarray(pcm, dtype="<f4").tobytes()
    with _AAC_LOCK:
        proc = _take_aac()
        try:
            out, err = proc.communicate(raw, timeout=60)
        except Exception:
            proc.kill()
            proc.wait(timeout=5)
            raise
        if proc.returncode == 0 and out:
            return out
        raise RuntimeError((err or b"aac encode failed").decode("utf-8", "replace")[-500:])


def encode_kept_frames(pcm: np.ndarray, keep_frames: int, *, leading: bool = False) -> list[bytes]:
    if len(pcm) != PRE_ROLL + keep_frames * FRAME + POST_ROLL:
        raise RuntimeError(f"encoder input length {len(pcm)} is not pre+keep+post")
    frames = _adts_frames(aac_encode_adts(pcm))
    # Bitstream frame j covers input [(j-1)*1024, j*1024). Output sample 0 is input 2048.
    first_kept = PRIMING_FRAMES + PRE_FRAMES
    first = first_kept - 1 if leading else first_kept
    last = first_kept + keep_frames
    if first < 0 or len(frames) < last:
        raise RuntimeError(f"encoder emitted {len(frames)} frames, need {last}")
    kept = [frame[7:] for frame in frames[first:last]]
    if leading and len(kept) != keep_frames + 1:
        raise RuntimeError("segment 0 did not keep exactly one leading frame")
    return kept


def _box(typ: bytes, payload: bytes) -> bytes:
    return (8 + len(payload)).to_bytes(4, "big") + typ + payload


def _fullbox(typ: bytes, version: int, flags: int, payload: bytes) -> bytes:
    return _box(typ, bytes([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]) + payload)


def _children(buf: bytes, start: int, end: int):
    cursor = start
    while cursor + 8 <= end:
        size = int.from_bytes(buf[cursor:cursor + 4], "big")
        header = 8
        if size == 1:
            size = int.from_bytes(buf[cursor + 8:cursor + 16], "big")
            header = 16
        if size < header or cursor + size > end:
            break
        yield cursor, size, header, buf[cursor + 4:cursor + 8]
        cursor += size


def _esds() -> bytes:
    dsi = bytes([0x11, 0x90])
    dcd = bytes([0x40, 0x15, 0x00, 0x18, 0x00]) + (160000).to_bytes(4, "big") + (160000).to_bytes(4, "big")
    dcd += bytes([0x05, len(dsi)]) + dsi
    es = bytes([0x00, 0x02, 0x00]) + bytes([0x04, len(dcd)]) + dcd + bytes([0x06, 0x01, 0x02])
    return _fullbox(b"esds", 0, 0, bytes([0x03, len(es)]) + es)


def _audio_trak() -> bytes:
    tkhd = _fullbox(
        b"tkhd", 0, 3,
        b"\x00" * 8 + AUDIO_TRACK_ID.to_bytes(4, "big") + b"\x00" * 4
        + (0).to_bytes(4, "big") + b"\x00" * 8
        + (0).to_bytes(2, "big") + (0).to_bytes(2, "big")
        + (1).to_bytes(2, "big") + b"\x00" * 2
        + (0x00010000).to_bytes(4, "big") + (0).to_bytes(4, "big") + (0).to_bytes(4, "big")
        + (0).to_bytes(4, "big") + (0x00010000).to_bytes(4, "big") + (0).to_bytes(4, "big")
        + (0).to_bytes(4, "big") + (0).to_bytes(4, "big") + (0x40000000).to_bytes(4, "big")
        + (0).to_bytes(4, "big") + (0).to_bytes(4, "big"),
    )
    mdhd = _fullbox(b"mdhd", 0, 0, b"\x00" * 8 + SR.to_bytes(4, "big") + (0).to_bytes(4, "big") + b"\x55\xc4\x00\x00")
    hdlr = _fullbox(b"hdlr", 0, 0, b"\x00" * 4 + b"soun" + b"\x00" * 12 + b"SoundHandler\x00")
    url = _box(b"url ", b"\x00\x00\x00\x01")
    dinf = _box(b"dinf", _box(b"dref", b"\x00\x00\x00\x00" + (1).to_bytes(4, "big") + url))
    head = b"\x00" * 6 + (1).to_bytes(2, "big") + (0).to_bytes(8, "big")
    head += (2).to_bytes(2, "big") + (16).to_bytes(2, "big") + (0).to_bytes(4, "big") + (SR << 16).to_bytes(4, "big")
    stsd = _box(b"stsd", b"\x00\x00\x00\x00" + (1).to_bytes(4, "big") + _box(b"mp4a", head + _esds()))
    empty = _fullbox(b"stts", 0, 0, (0).to_bytes(4, "big"))
    stsc = _fullbox(b"stsc", 0, 0, (0).to_bytes(4, "big"))
    stsz = _fullbox(b"stsz", 0, 0, (0).to_bytes(4, "big") + (0).to_bytes(4, "big"))
    stco = _fullbox(b"stco", 0, 0, (0).to_bytes(4, "big"))
    stbl = _box(b"stbl", stsd + empty + stsc + stsz + stco)
    minf = _box(b"minf", _fullbox(b"smhd", 0, 0, b"\x00\x00\x00\x00") + dinf + stbl)
    mdia = _box(b"mdia", mdhd + hdlr + minf)
    return _box(b"trak", tkhd + mdia)


def _trex() -> bytes:
    return _fullbox(
        b"trex", 0, 0,
        AUDIO_TRACK_ID.to_bytes(4, "big") + (1).to_bytes(4, "big") + FRAME.to_bytes(4, "big")
        + (0).to_bytes(4, "big") + (0).to_bytes(4, "big"),
    )


def inject_audio_track(init: bytes) -> bytes:
    boxes = list(_children(init, 0, len(init)))
    moov = next((item for item in boxes if item[3] == b"moov"), None)
    if moov is None:
        raise RuntimeError("video init has no moov")
    kids = list(_children(init, moov[0] + moov[2], moov[0] + moov[1]))
    mvhd = next((item for item in kids if item[3] == b"mvhd"), None)
    mvex = next((item for item in kids if item[3] == b"mvex"), None)
    if mvhd is None or mvex is None:
        raise RuntimeError("video init is missing mvhd or mvex")
    if any(item[3] == b"trak" and init[item[0] + 20:item[0] + 24] == AUDIO_TRACK_ID.to_bytes(4, "big") for item in kids):
        raise RuntimeError("video init already has audio track 2")
    patched = bytearray(init)
    patched[mvhd[0] + mvhd[1] - 4:mvhd[0] + mvhd[1]] = (AUDIO_TRACK_ID + 1).to_bytes(4, "big")
    trak = _audio_trak()
    trex = _trex()
    mvex_end = mvex[0] + mvex[1]
    inserted = bytearray(patched[:mvex[0]]) + trak + bytearray(patched[mvex[0]:mvex_end]) + trex + bytearray(patched[mvex_end:])
    grow_moov = len(trak) + len(trex)
    grow_mvex = len(trex)
    moov_at = moov[0]
    mvex_at = mvex[0] + len(trak)
    inserted[moov_at:moov_at + 4] = (moov[1] + grow_moov).to_bytes(4, "big")
    inserted[mvex_at:mvex_at + 4] = (mvex[1] + grow_mvex).to_bytes(4, "big")
    return bytes(inserted)


def presentation_samples(ticks: int, video_tb: int) -> int:
    if isinstance(video_tb, bool) or not isinstance(video_tb, int) or video_tb <= 0 or ticks < 0:
        raise RuntimeError(f"bad audio alignment ticks {ticks} tb {video_tb}")
    return (ticks * SR + video_tb // 2) // video_tb


def _fit_frame_durations(count: int, target: int) -> list[int]:
    if count < 1 or target < count:
        raise RuntimeError(f"cannot align {target} samples across {count} frames")
    durations = [FRAME] * count
    remaining = target - FRAME * count
    limit = FRAME * 4
    index = count - 1
    while remaining != 0:
        if index < 0:
            raise RuntimeError(f"audio alignment residual {remaining}")
        if remaining > 0:
            step = min(remaining, limit - durations[index])
        else:
            step = -min(-remaining, durations[index] - 256)
        durations[index] += step
        remaining -= step
        index -= 1
    if sum(durations) != target:
        raise RuntimeError("audio alignment drifted")
    return durations


def align_audio_timing(
    sample_count: int,
    *,
    leading: bool,
    video_start_ticks: int,
    video_duration_ticks: int,
    video_tb: int,
) -> tuple[int, list[int]]:
    """Container timing so this fragment's audio presentation matches the video fragment.

    WebKit gaps the SourceBuffer when the two tracks in one moof disagree by a few
    milliseconds, which VFR frame durations do against a fixed 1024-sample AAC grid.
    The AAC payloads are unchanged. Segment 0's leading frame stays one frame before
    presentation 0 so the init edit list still applies.
    """
    if sample_count < 1 or video_duration_ticks <= 0:
        raise RuntimeError("audio alignment needs frames and a video duration")
    start = presentation_samples(video_start_ticks, video_tb)
    end = presentation_samples(video_start_ticks + video_duration_ticks, video_tb)
    target = end - start
    if target <= 0:
        raise RuntimeError("video fragment has no presentation samples")
    if leading:
        if start != 0:
            raise RuntimeError("leading segment must start at presentation 0")
        if sample_count < 2:
            raise RuntimeError("leading segment needs a kept audio frame")
    # WebKit's SourceBuffer ignores the init edit list. A +1024 elst bias makes
    # audio start 21 ms after video on every later fragment and splits the buffer.
    return start, _fit_frame_durations(sample_count, target)


def _trun_duration(body: bytes) -> int:
    flags = int.from_bytes(body[1:4], "big")
    count = int.from_bytes(body[4:8], "big")
    cursor = 8
    if flags & 0x1:
        cursor += 4
    if flags & 0x4:
        cursor += 4
    if not flags & 0x100:
        raise RuntimeError("trun has no sample durations")
    total = 0
    for _ in range(count):
        total += int.from_bytes(body[cursor:cursor + 4], "big")
        cursor += 4
        if flags & 0x200:
            cursor += 4
        if flags & 0x400:
            cursor += 4
        if flags & 0x800:
            cursor += 4
    return total


def fragment_track_spans(segment: bytes) -> dict:
    start = 0
    if len(segment) >= 8 and segment[4:8] == b"styp":
        start = int.from_bytes(segment[:4], "big")
    video_ticks = 0
    audio_samples = 0
    audio_tfdt = None
    video_tfdt = None
    for off, size, header, name in _children(segment, start, len(segment)):
        if name != b"moof":
            continue
        for toff, tsize, theader, tname in _children(segment, off + header, off + size):
            if tname != b"traf":
                continue
            track = None
            tfdt = None
            dur_sum = 0
            for xoff, xsize, xheader, xname in _children(segment, toff + theader, toff + tsize):
                body = segment[xoff + xheader:xoff + xsize]
                if xname == b"tfhd":
                    track = int.from_bytes(body[4:8], "big")
                elif xname == b"tfdt":
                    version = body[0]
                    tfdt = int.from_bytes(body[4:12] if version == 1 else body[4:8], "big")
                elif xname == b"trun":
                    dur_sum = _trun_duration(body)
            if track == AUDIO_TRACK_ID:
                audio_samples = dur_sum
                audio_tfdt = tfdt
            else:
                video_ticks += dur_sum
                video_tfdt = tfdt
    return {
        "audio_samples": audio_samples,
        "audio_tfdt": audio_tfdt,
        "video_tfdt": video_tfdt,
        "video_ticks": video_ticks,
    }


def mux_audio(
    media: bytes,
    raw_frames: list[bytes],
    tfdt: int,
    tail: int = 0,
    *,
    video_start_ticks: int | None = None,
    video_duration_ticks: int | None = None,
    video_tb: int | None = None,
    leading: bool = False,
) -> bytes:
    top = list(_children(media, 0, len(media)))
    moofs = [item for item in top if item[3] == b"moof"]
    if len(moofs) != 1 or top[-1][3] != b"mdat":
        raise RuntimeError("segment is not one moof plus one mdat")
    moof = moofs[0]
    mdat = top[-1]
    header = 16 if int.from_bytes(media[mdat[0]:mdat[0] + 4], "big") == 1 else 8
    video_payload = media[mdat[0] + header:mdat[0] + mdat[1]]
    audio_payload = b"".join(raw_frames)
    count = len(raw_frames)
    if video_start_ticks is not None:
        if video_duration_ticks is None or video_tb is None:
            raise RuntimeError("audio alignment needs video start, duration, and timescale")
        found = fragment_track_spans(media)["video_ticks"]
        if found != video_duration_ticks:
            raise RuntimeError(f"video fragment is {found} ticks, alignment expected {video_duration_ticks}")
        tfdt, durations = align_audio_timing(
            count,
            leading=leading,
            video_start_ticks=video_start_ticks,
            video_duration_ticks=video_duration_ticks,
            video_tb=video_tb,
        )
    else:
        durations = [FRAME] * count
        if tail:
            if count < 1 or tail <= 0 or tail >= FRAME:
                raise RuntimeError(f"audio tail trim {tail} is outside one frame")
            durations[-1] = FRAME - tail
    trun_payload = count.to_bytes(4, "big") + (0).to_bytes(4, "big", signed=True) + (0x02000000).to_bytes(4, "big")
    for frame, duration in zip(raw_frames, durations, strict=True):
        trun_payload += duration.to_bytes(4, "big") + len(frame).to_bytes(4, "big")
    trun = _fullbox(b"trun", 0, 0x000305, trun_payload)
    tfhd = _fullbox(b"tfhd", 0, 0x020000, AUDIO_TRACK_ID.to_bytes(4, "big"))
    tfdt_box = _fullbox(b"tfdt", 1, 0, int(tfdt).to_bytes(8, "big"))
    traf = _box(b"traf", tfhd + tfdt_box + trun)
    moof_bytes = bytearray(media[moof[0]:moof[0] + moof[1]])
    moof_bytes.extend(traf)
    moof_bytes[0:4] = len(moof_bytes).to_bytes(4, "big")
    video_trun = None
    for off, size, header_len, name in _children(moof_bytes, 8, len(moof_bytes) - len(traf)):
        if name != b"traf":
            continue
        for toff, _tsize, _th, tname in _children(moof_bytes, off + header_len, off + size):
            if tname == b"trun":
                video_trun = toff
    if video_trun is None:
        raise RuntimeError("video trun missing")
    flags = int.from_bytes(moof_bytes[video_trun + 9:video_trun + 12], "big")
    if not flags & 0x1:
        raise RuntimeError("video trun has no data-offset")
    offset_at = video_trun + 16
    old = int.from_bytes(moof_bytes[offset_at:offset_at + 4], "big", signed=True)
    moof_bytes[offset_at:offset_at + 4] = (old + len(traf)).to_bytes(4, "big", signed=True)
    audio_offset = len(moof_bytes) + 8 + len(video_payload)
    audio_trun_at = (len(moof_bytes) - len(traf)) + 8 + len(tfhd) + len(tfdt_box)
    moof_bytes[audio_trun_at + 16:audio_trun_at + 20] = audio_offset.to_bytes(4, "big", signed=True)
    mdat_box = _box(b"mdat", video_payload + audio_payload)
    return bytes(moof_bytes) + mdat_box


def audio_tfdt(j0: int, *, leading: bool = False) -> int:
    """Media time of the fragment's first sample.

    Kept frame j sits at media time j*1024+1024, so elst media_time 1024 is presentation 0.
    Segment 0's first sample is the leading overlap frame, one frame before that.
    """
    kept = j0 * FRAME + TFDT_BIAS
    if not leading:
        return kept
    if j0 != 0:
        raise RuntimeError("leading overlap frame is only carried by segment 0")
    return kept - FRAME


def movie_timescale(init: bytes) -> int:
    boxes = list(_children(init, 0, len(init)))
    moov = next((item for item in boxes if item[3] == b"moov"), None)
    if moov is None:
        raise RuntimeError("init has no moov")
    mvhd = next((item for item in _children(init, moov[0] + moov[2], moov[0] + moov[1]) if item[3] == b"mvhd"), None)
    if mvhd is None:
        raise RuntimeError("init has no mvhd")
    version = init[mvhd[0] + 8]
    if version == 0:
        return int.from_bytes(init[mvhd[0] + 20:mvhd[0] + 24], "big")
    if version == 1:
        return int.from_bytes(init[mvhd[0] + 28:mvhd[0] + 32], "big")
    raise RuntimeError(f"mvhd version {version}")


def edit_duration_ticks(movie_ts: int, timeline_samples: int) -> int:
    """elst segment_duration in movie timescale, covering the whole audio timeline."""
    if movie_ts <= 0 or timeline_samples < 0:
        raise RuntimeError("bad audio edit duration")
    ticks = (timeline_samples * movie_ts + SR - 1) // SR
    if ticks <= 0 or ticks > 0xFFFFFFFF:
        raise RuntimeError(f"audio edit duration {ticks} does not fit elst version 0")
    if ticks * SR // movie_ts < timeline_samples:
        raise RuntimeError("audio edit duration does not cover the timeline")
    return ticks


def _track_id(buf: bytes, trak: tuple) -> int:
    kids = list(_children(buf, trak[0] + trak[2], trak[0] + trak[1]))
    tkhd = next((item for item in kids if item[3] == b"tkhd"), None)
    if tkhd is None:
        raise RuntimeError("trak has no tkhd")
    version = buf[tkhd[0] + 8]
    at = tkhd[0] + (28 if version else 20)
    return int.from_bytes(buf[at:at + 4], "big")


def add_audio_elst(init: bytes, segment_duration: int) -> bytes:
    """One audio edit in the init. media_time is 0: WebKit MSE applies a non-zero value and fragment tfdt is already presentation time."""
    if segment_duration <= 0 or segment_duration > 0xFFFFFFFF:
        raise RuntimeError("elst segment_duration out of range")
    elst = _fullbox(
        b"elst", 0, 0,
        (1).to_bytes(4, "big")
        + int(segment_duration).to_bytes(4, "big")
        + (0).to_bytes(4, "big", signed=True)
        + (1 << 16).to_bytes(4, "big"),
    )
    edts = _box(b"edts", elst)
    boxes = list(_children(init, 0, len(init)))
    moov = next((item for item in boxes if item[3] == b"moov"), None)
    if moov is None:
        raise RuntimeError("video init has no moov")
    kids = list(_children(init, moov[0] + moov[2], moov[0] + moov[1]))
    audio = next((item for item in kids if item[3] == b"trak" and _track_id(init, item) == AUDIO_TRACK_ID), None)
    if audio is None:
        raise RuntimeError("audio track missing")
    trak_kids = list(_children(init, audio[0] + audio[2], audio[0] + audio[1]))
    if any(item[3] == b"edts" for item in trak_kids):
        raise RuntimeError("audio track already has an edit list")
    tkhd = next((item for item in trak_kids if item[3] == b"tkhd"), None)
    if tkhd is None:
        raise RuntimeError("audio trak has no tkhd")
    insert_at = tkhd[0] + tkhd[1]
    out = bytearray(init[:insert_at]) + edts + bytearray(init[insert_at:])
    out[audio[0]:audio[0] + 4] = (audio[1] + len(edts)).to_bytes(4, "big")
    out[moov[0]:moov[0] + 4] = (moov[1] + len(edts)).to_bytes(4, "big")
    return bytes(out)


PEAKS_MAGIC = b"CAPW1"
PEAKS_PAIRS_PER_SEC = 100
PEAKS_SAMPLES_PER_PAIR = 480
PEAKS_HEADER_BYTES = 64
PEAKS_DB_FLOOR = -60.0
PEAKS_CHUNK_FRAMES = 480 * 64
PEAKS_MAX_PAIR_COUNT = math.ceil(14_400 * PEAKS_PAIRS_PER_SEC) + 1
PEAKS_MAX_SOURCE_SECONDS = 14_400


def quantize_peak_sample(sample: float) -> int:
    if isinstance(sample, bool):
        return 0
    try:
        value = float(sample)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(value) or value == 0.0:
        return 0
    db = 20.0 * math.log10(abs(value))
    if db < PEAKS_DB_FLOOR:
        db = PEAKS_DB_FLOOR
    elif db > 0.0:
        db = 0.0
    mag = math.floor(((db - PEAKS_DB_FLOOR) / -PEAKS_DB_FLOOR) * 127.0 + 0.5)
    mag = max(0, min(127, int(mag)))
    if mag == 0:
        return 0
    return -mag if value < 0.0 else mag


def encode_no_audio_peaks(source_sha256: str) -> bytes:
    _require_peaks_sha(source_sha256)
    out = bytearray(PEAKS_HEADER_BYTES)
    _write_peaks_header(out, source_sha256, 0, no_audio=True)
    return bytes(out)


def audio_track_status(source: Path) -> str:
    """Return present or absent. Unsupported rate stays AudioRejected. Probe failure is not absence."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-select_streams", "a",
                "-show_entries", "stream=sample_rate", "-of", "json", str(source),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=limits.PROBE_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("audio probe failed") from exc
    if result.returncode != 0:
        raise RuntimeError("audio probe failed")
    try:
        payload = json.loads(result.stdout.decode() or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError("audio probe failed") from exc
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise RuntimeError("audio probe failed")
    if not streams:
        return "absent"
    rate = streams[0].get("sample_rate") if isinstance(streams[0], dict) else None
    if isinstance(rate, str) and rate.isdigit():
        rate = int(rate)
    audio_rate_policy(rate)
    return "present"


def peaks_source_window(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError("peaks source duration is not a finite positive bound")
    if not math.isfinite(value) or value <= 0 or value > PEAKS_MAX_SOURCE_SECONDS:
        raise RuntimeError("peaks source duration is not a finite positive bound")
    return float(value)


def peaks_window_samples(duration: float) -> int:
    scaled = duration * SR
    nearest = round(scaled)
    if math.isfinite(scaled) and abs(scaled - nearest) <= 1e-6:
        count = int(nearest)
    else:
        count = math.ceil(scaled)
    if count <= 0 or count > PEAKS_MAX_SOURCE_SECONDS * SR:
        raise RuntimeError("peaks source duration is not a finite positive bound")
    return count


def reduce_presentation_peaks(
    source: Path,
    source_sha256: str,
    *,
    chunk_frames: int = PEAKS_CHUNK_FRAMES,
    source_duration: float | None = None,
) -> bytes:
    _require_peaks_sha(source_sha256)
    if (
        isinstance(chunk_frames, bool)
        or not isinstance(chunk_frames, int)
        or chunk_frames <= 0
        or chunk_frames > PEAKS_CHUNK_FRAMES
        or chunk_frames % PEAKS_SAMPLES_PER_PAIR != 0
    ):
        raise RuntimeError("peaks chunk is not bounded")
    window_samples = None
    if source_duration is not None:
        window_samples = peaks_window_samples(peaks_source_window(source_duration))
    dest = presentation_pcm_path(source)
    if _reusable_presentation(dest, presentation_meta_path(source), source_sha256) is None:
        raise RuntimeError(f"presentation pcm is not bound to {source.name}")
    if not dest.is_file():
        raise RuntimeError(f"presentation pcm missing for {source.name}")
    nbytes = dest.stat().st_size
    if nbytes % 8:
        raise RuntimeError(f"presentation pcm length {nbytes} is not a stereo frame")
    pcm_frames = nbytes // 8
    frames = pcm_frames if window_samples is None else window_samples
    pair_count = math.ceil(frames / PEAKS_SAMPLES_PER_PAIR) if frames else 0
    if pair_count > PEAKS_MAX_PAIR_COUNT:
        raise RuntimeError("peaks pair count exceeds the source bound")
    out = bytearray(PEAKS_HEADER_BYTES + pair_count * 2)
    _write_peaks_header(out, source_sha256, pair_count, no_audio=False)
    readable = pcm_frames if window_samples is None else min(pcm_frames, window_samples)
    if readable == 0:
        return bytes(out)
    mapped = np.memmap(dest, dtype="<f4", mode="r")
    try:
        for start in range(0, readable, chunk_frames):
            end = min(readable, start + chunk_frames)
            window = np.array(mapped[start * 2 : end * 2], dtype=np.float32, copy=True)
            left = window[0::2]
            right = window[1::2]
            mono = (left + right) * np.float32(0.5)
            finite = np.isfinite(mono)
            if not bool(np.any(finite)):
                cleaned = np.zeros(mono.shape, np.float32)
            else:
                cleaned = np.where(finite, mono, np.float32(0.0))
            offset = 0
            count = int(cleaned.shape[0])
            while offset < count:
                bucket_end = min(offset + PEAKS_SAMPLES_PER_PAIR, count)
                bucket = cleaned[offset:bucket_end]
                pair_index = (start + offset) // PEAKS_SAMPLES_PER_PAIR
                pos = PEAKS_HEADER_BYTES + pair_index * 2
                out[pos] = quantize_peak_sample(float(bucket.min())) & 0xFF
                out[pos + 1] = quantize_peak_sample(float(bucket.max())) & 0xFF
                offset = bucket_end
    finally:
        del mapped
    return bytes(out)


def _require_peaks_sha(source_sha256: str) -> None:
    if (
        not isinstance(source_sha256, str)
        or len(source_sha256) != 64
        or any(char not in "0123456789abcdef" for char in source_sha256)
    ):
        raise RuntimeError("peaks source sha is not 64 lowercase hex")


def _write_peaks_header(out: bytearray, source_sha256: str, pair_count: int, *, no_audio: bool) -> None:
    out[0:5] = PEAKS_MAGIC
    out[5] = 1
    out[6] = 1 if no_audio else 0
    out[7] = PEAKS_PAIRS_PER_SEC
    struct_bytes = (SR).to_bytes(4, "little") + PEAKS_SAMPLES_PER_PAIR.to_bytes(2, "little") + pair_count.to_bytes(4, "little")
    out[8:18] = struct_bytes
    out[18:50] = bytes.fromhex(source_sha256)
