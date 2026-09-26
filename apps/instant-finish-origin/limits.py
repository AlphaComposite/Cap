"""Admission, media, and subprocess bounds. Env overrides are for the disposable stack."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


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


def origin_cpus() -> int:
    """Encoder thread count. ORIGIN_CPUS wins; otherwise the cgroup quota; else 4."""
    raw = os.environ.get("ORIGIN_CPUS", "").strip()
    if raw:
        try:
            value = float(raw)
        except ValueError as exc:
            raise InputRejected(f"bad ORIGIN_CPUS {raw}") from exc
        if value <= 0:
            raise InputRejected(f"bad ORIGIN_CPUS {raw}")
        return max(1, int(value + 0.5))
    detected = _cgroup_cpus()
    if detected is not None:
        return detected
    return 4


def _cgroup_cpus() -> int | None:
    try:
        lines = Path("/proc/self/cgroup").read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        parts = line.split(":", 2)
        if len(parts) != 3 or not parts[2].strip("/"):
            continue
        root = Path("/sys/fs/cgroup") / parts[2].lstrip("/")
        parsed = _cpu_max(root / "cpu.max")
        if parsed is not None:
            return parsed
        parsed = _cpu_quota(root / "cpu.cfs_quota_us", root / "cpu.cfs_period_us")
        if parsed is not None:
            return parsed
    return None


def _cpu_max(path: Path) -> int | None:
    try:
        quota, period = path.read_text().split()
    except (OSError, ValueError):
        return None
    if quota == "max":
        return None
    return _quota_cpus(quota, period)


def _cpu_quota(quota_path: Path, period_path: Path) -> int | None:
    try:
        return _quota_cpus(quota_path.read_text().strip(), period_path.read_text().strip())
    except OSError:
        return None


def _quota_cpus(quota: str, period: str) -> int | None:
    try:
        q = int(quota)
        p = int(period)
    except ValueError:
        return None
    if q <= 0 or p <= 0:
        return None
    return max(1, int(q / p + 0.5))


def probe_walk_timeout(path) -> float:
    duration = source_duration_s(path)
    derived = max(PROBE_TIMEOUT_S, duration * 0.05 + PROBE_TIMEOUT_S)
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return max(derived, size / (4 * 1024 * 1024))
