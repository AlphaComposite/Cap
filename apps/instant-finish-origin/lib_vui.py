"""Optional SPS VUI tick rate on encoder output.

Unset ORIGIN_H264_VUI_TICK_RATE leaves the encoder bytes alone. A set value
such as 10/1 is ffmpeg's h264_metadata tick_rate. Only equal-length SPS NAL
bytes are copied back. Sample tables are not remuxed.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

_TICK = re.compile(r"^(?P<num>[1-9]\d*)/(?P<den>[1-9]\d*)$")


def configured_tick_rate(env: dict | None = None) -> str | None:
    raw = (env if env is not None else os.environ).get("ORIGIN_H264_VUI_TICK_RATE", "")
    text = str(raw).strip()
    if not text:
        return None
    if not _TICK.fullmatch(text):
        raise RuntimeError(f"ORIGIN_H264_VUI_TICK_RATE must be num/den, got {text!r}")
    return text


def apply_vui_tick_rate(data: bytes, env: dict | None = None) -> bytes:
    rate = configured_tick_rate(env)
    if rate is None or not data:
        return data
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "in.mp4"
        donor_path = Path(tmp) / "donor.mp4"
        source.write_bytes(data)
        result = subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y", "-i", str(source),
                "-c", "copy", "-bsf:v", f"h264_metadata=tick_rate={rate}",
                "-f", "mp4", str(donor_path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", "replace")[-500:])
        donor = donor_path.read_bytes()
    return splice_sps(data, donor)


def splice_sps(original: bytes, donor: bytes) -> bytes:
    source_sps = _avcc_sps(original)
    donor_sps = _avcc_sps(donor)
    if not source_sps or not donor_sps:
        raise RuntimeError("encoder output has no SPS to retick")
    if len(source_sps) != len(donor_sps):
        raise RuntimeError("VUI tick rewrite changed SPS length")
    if source_sps == donor_sps:
        raise RuntimeError("ORIGIN_H264_VUI_TICK_RATE did not change the SPS")
    count = original.count(source_sps)
    if count < 1:
        raise RuntimeError("SPS bytes were not found in the encoder output")
    return original.replace(source_sps, donor_sps)


def _avcc_sps(data: bytes) -> bytes | None:
    found = data.find(b"avcC")
    if found < 4:
        return None
    box = found - 4
    size = int.from_bytes(data[box:box + 4], "big")
    if size < 8 or box + size > len(data):
        return None
    payload = found + 4
    end = box + size
    if payload + 6 > end:
        return None
    count = data[payload + 5] & 0x1F
    cursor = payload + 6
    for _ in range(count):
        if cursor + 2 > end:
            return None
        length = int.from_bytes(data[cursor:cursor + 2], "big")
        start = cursor + 2
        stop = start + length
        if length < 1 or stop > end:
            return None
        if data[start] & 0x1F == 7:
            return data[start:stop]
        cursor = stop
    return None
