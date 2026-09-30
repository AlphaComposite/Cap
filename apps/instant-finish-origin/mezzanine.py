"""A1 mezzanine: same geometry, veryfast CRF18, bf=0, forced IDR every 1s, VFR passthrough, AAC copy."""
from __future__ import annotations

import json as json_mod
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from index import Probe, keyframe_rows, probe, write_keyframe_index
from storage import atomic_write, private, sha256_file
import limits

MEZZ_X264 = "keyint=1000:min-keyint=1:scenecut=0:open-gop=0:b-adapt=0"
_A1_SLOT = threading.BoundedSemaphore(1)


class MezzanineError(RuntimeError):
    pass


def mezz_command(source: Path, dest: Path, timescale: int) -> list[str]:
    if timescale <= 0:
        raise MezzanineError(f"bad timescale {timescale}")
    return [
        "nice", "-n", "19",
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(source),
        "-fps_mode", "passthrough",
        "-g", "1000",
        "-force_key_frames", "expr:gte(t,n_forced*1)",
        "-x264-params", MEZZ_X264,
        "-threads", str(limits.origin_cpus()),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.1",
        "-bf", "0", "-forced-idr", "1",
        "-enc_time_base:v", f"1/{timescale}",
        "-video_track_timescale", str(timescale),
        "-c:a", "copy",
        "-movflags", "+faststart",
        str(dest),
    ]


def _duration_s(probed: Probe) -> float:
    if not probed.packets or probed.timescale <= 0:
        return 0.0
    ticks = max(row.pts + max(row.dur, 0) for row in probed.packets)
    return ticks / probed.timescale


def build_mezzanine(source: Path, dest: Path, video_id: str = "") -> dict:
    with _A1_SLOT:
        return _encode_mezzanine(source, dest, video_id)


def _encode_mezzanine(source: Path, dest: Path, video_id: str = "") -> dict:
    """Build A1 beside the immutable original. Does not replace the original and is not a Finish path."""
    original = probe(source)
    if original.audio_rate is None:
        raise MezzanineError("refusing source with no audio stream")
    dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = dest.with_name(
        f".{dest.stem}.{os.getpid()}.{threading.get_ident()}.build.mp4"
    )
    started = time.perf_counter()
    cmd = mezz_command(source, tmp, original.timescale)
    print(f"source-prepare-encode video={video_id}", file=sys.stderr, flush=True)
    if "-vf" in cmd or "fps=" in " ".join(cmd):
        raise MezzanineError("A1 command drifted")
    try:
        result = limits.run_cmd(
            cmd,
            limits.timeout_for_duration(_duration_s(original)),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except limits.InputRejected as exc:
        if tmp.exists():
            tmp.unlink()
        raise MezzanineError("ffmpeg timeout") from exc
    if result.returncode:
        if tmp.exists():
            tmp.unlink()
        raise MezzanineError(result.stderr.decode("utf-8", "replace")[-500:])
    os_replace(tmp, dest)
    private(dest)
    try:
        return _finish_mezzanine(source, dest, original, started)
    except Exception:
        _discard_partial_mezz(dest)
        raise


def _discard_partial_mezz(dest: Path) -> None:
    dest.unlink(missing_ok=True)
    for suffix in (".frames.json", ".keyframes.json", ".prep.json", ".source-bind.json"):
        sidecar = dest.with_suffix(suffix)
        if sidecar.is_file():
            sidecar.unlink()


def _finish_mezzanine(source: Path, dest: Path, original: Probe, started: float) -> dict:
    built = probe(dest)
    if built.has_b_frames != 0:
        raise MezzanineError(f"mezzanine still has B-frames ({built.has_b_frames})")
    if built.timescale != original.timescale or built.width != original.width or built.height != original.height:
        raise MezzanineError("mezzanine geometry or timescale drifted")
    src_pts = sorted(row.pts for row in original.packets)
    mezz_pts = [row.pts for row in built.packets]
    if mezz_pts != sorted(mezz_pts) or src_pts != mezz_pts:
        raise MezzanineError("mezzanine PTS does not match the source")
    from index import frame_table
    ticks, durs = frame_table(built)
    atomic_write(
        dest.with_suffix(".frames.json"),
        (json_mod.dumps({"dur_tick": durs, "pts_tick": ticks, "timescale": built.timescale}, separators=(",", ":")) + "\n").encode(),
    )
    rows = keyframe_rows(dest, built)
    record = write_keyframe_index(dest, rows, sha256_file(dest), round((time.perf_counter() - started) * 1000, 3))
    record["source_sha256"] = sha256_file(source)
    record["width"] = built.width
    record["height"] = built.height
    record["timescale"] = built.timescale
    record["has_b_frames"] = built.has_b_frames
    record["audio_rate"] = original.audio_rate
    atomic_write(dest.with_suffix(".source-bind.json"), _bind(record))
    return record


def os_replace(src: Path, dest: Path) -> None:
    import os
    os.chmod(src, 0o600)
    os.replace(src, dest)


def _bind(record: dict) -> bytes:
    import json
    return (json.dumps({
        "height": record["height"],
        "mezz_sha256": record["mezz_sha256"],
        "source_sha256": record["source_sha256"],
        "timescale": record["timescale"],
        "width": record["width"],
    }, sort_keys=True, separators=(",", ":")) + "\n").encode()


def load_source_bind(mezz: Path) -> dict:
    import json
    path = mezz.with_suffix(".source-bind.json")
    if not path.is_file():
        raise MezzanineError("mezzanine is not bound to a source sha")
    return json.loads(path.read_text())
