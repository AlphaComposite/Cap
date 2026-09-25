"""Admission, media, and subprocess bounds. Env overrides are for the disposable stack."""
from __future__ import annotations

import os
import subprocess


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return int(raw)


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return float(raw)


MAX_DURATION_S = _float("ORIGIN_MAX_DURATION_S", 14_400.0)
MAX_WIDTH = _int("ORIGIN_MAX_WIDTH", 4096)
MAX_HEIGHT = _int("ORIGIN_MAX_HEIGHT", 2160)
MAX_SOURCE_BYTES = _int("ORIGIN_MAX_SOURCE_BYTES", 2 * 1024 * 1024 * 1024)
MAX_KEEP_RANGES = _int("ORIGIN_MAX_KEEP_RANGES", 512)
MAX_INFLIGHT = _int("ORIGIN_MAX_INFLIGHT", 8)
FFMPEG_TIMEOUT_S = _float("ORIGIN_FFMPEG_TIMEOUT_S", 120.0)
# Floor only. The encode bound is timeout_for_duration(); a fixed 600s cap
# killed nothing on the measured 1037s source (190s) but would on a longer one.
MEZZ_TIMEOUT_S = _float("ORIGIN_MEZZ_TIMEOUT_S", 0.0)
PROBE_TIMEOUT_S = _float("ORIGIN_PROBE_TIMEOUT_S", 8.0)
ORIGIN_CACHE_MAX = _int("ORIGIN_CACHE_MAX", 32)
ORIGIN_CACHE_TTL_S = _float("ORIGIN_CACHE_TTL_S", 600.0)
TIMINGS_MAX = _int("ORIGIN_TIMINGS_MAX", 256)
DECODER_MAX = _int("ORIGIN_DECODER_MAX", 8)
SHA_CACHE_MAX = _int("ORIGIN_SHA_CACHE_MAX", 256)
SHA_IDENT_TTL_S = _float("ORIGIN_SHA_IDENT_TTL_S", 30.0)
RETRY_AFTER_S = "1"
# Cold A1 of a 1037s source took 190s (0.183 wall-seconds per source-second).
# 0.75x plus slack finishes that measurement and scales with longer sources.
A1_TIMEOUT_PER_SOURCE_S = _float("ORIGIN_A1_TIMEOUT_PER_SOURCE_S", 0.75)
A1_TIMEOUT_SLACK_S = _float("ORIGIN_A1_TIMEOUT_SLACK_S", 30.0)


class InputRejected(Exception):
    pass


def run_cmd(cmd: list[str], timeout: float, **kwargs) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired as exc:
        raise InputRejected("subprocess timeout") from exc


def timeout_for_duration(duration_s: float) -> float:
    derived = max(0.0, duration_s) * A1_TIMEOUT_PER_SOURCE_S + A1_TIMEOUT_SLACK_S
    return max(derived, MEZZ_TIMEOUT_S)


def source_duration_s(path) -> float:
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "csv=p=0", str(path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=PROBE_TIMEOUT_S,
        )
        duration = float(result.stdout.decode().strip() or "nan")
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return 0.0
    if duration < 0 or duration != duration:
        return 0.0
    return duration


def timeout_for_source(path) -> float:
    return timeout_for_duration(source_duration_s(path))


def probe_walk_timeout(path) -> float:
    duration = source_duration_s(path)
    derived = max(PROBE_TIMEOUT_S, duration * 0.05 + PROBE_TIMEOUT_S)
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return max(derived, size / (4 * 1024 * 1024))
