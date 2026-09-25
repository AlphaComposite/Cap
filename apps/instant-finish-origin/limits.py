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
MEZZ_TIMEOUT_S = _float("ORIGIN_MEZZ_TIMEOUT_S", 600.0)
PROBE_TIMEOUT_S = _float("ORIGIN_PROBE_TIMEOUT_S", 8.0)
ORIGIN_CACHE_MAX = _int("ORIGIN_CACHE_MAX", 32)
ORIGIN_CACHE_TTL_S = _float("ORIGIN_CACHE_TTL_S", 600.0)
TIMINGS_MAX = _int("ORIGIN_TIMINGS_MAX", 256)
DECODER_MAX = _int("ORIGIN_DECODER_MAX", 8)
SHA_CACHE_MAX = _int("ORIGIN_SHA_CACHE_MAX", 256)
SHA_IDENT_TTL_S = _float("ORIGIN_SHA_IDENT_TTL_S", 30.0)
RETRY_AFTER_S = "1"


class InputRejected(Exception):
    pass


def run_cmd(cmd: list[str], timeout: float, **kwargs) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, timeout=timeout, **kwargs)
    except subprocess.TimeoutExpired as exc:
        raise InputRejected("subprocess timeout") from exc
