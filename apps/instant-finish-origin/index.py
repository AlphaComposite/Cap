"""Packet and stss index. Frame keys come from the stss box, not a decoded frame walk."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from storage import atomic_write, private, sha256_file


class IndexError_(RuntimeError):
    pass


@dataclass(frozen=True)
class PacketRow:
    pts: int
    dur: int
    key: bool


@dataclass(frozen=True)
class Probe:
    width: int
    height: int
    timescale: int
    codec: str
    has_b_frames: int
    packets: tuple[PacketRow, ...]
    audio_rate: int | None
    audio_channels: int | None


def _iter_boxes(data: bytes, start: int, end: int):
    cursor = start
    while cursor + 8 <= end:
        size = int.from_bytes(data[cursor:cursor + 4], "big")
        header = 8
        if size == 1:
            if cursor + 16 > end:
                break
            size = int.from_bytes(data[cursor + 8:cursor + 16], "big")
            header = 16
        if size < header or cursor + size > end:
            break
        yield cursor, size, header, data[cursor + 4:cursor + 8]
        cursor += size


def _find_child(data: bytes, start: int, end: int, name: bytes):
    for off, size, header, child in _iter_boxes(data, start, end):
        if child == name:
            return off, size, header
    return None


def stss_samples(data: bytes) -> list[int] | None:
    """0-based sync-sample indexes from the video trak stss box. None if the box is absent."""
    moov = _find_child(data, 0, len(data), b"moov")
    if moov is None:
        return None
    cursor = moov[0] + moov[2]
    end = moov[0] + moov[1]
    while cursor + 8 <= end:
        size = int.from_bytes(data[cursor:cursor + 4], "big")
        header = 8
        if size == 1 and cursor + 16 <= end:
            size = int.from_bytes(data[cursor + 8:cursor + 16], "big")
            header = 16
        if size < header or cursor + size > end:
            break
        if data[cursor + 4:cursor + 8] != b"trak":
            cursor += size
            continue
        mdia = _find_child(data, cursor + header, cursor + size, b"mdia")
        if mdia is None:
            cursor += size
            continue
        hdlr = _find_child(data, mdia[0] + mdia[2], mdia[0] + mdia[1], b"hdlr")
        if hdlr is None or data[hdlr[0] + hdlr[2] + 8:hdlr[0] + hdlr[2] + 12] != b"vide":
            cursor += size
            continue
        minf = _find_child(data, mdia[0] + mdia[2], mdia[0] + mdia[1], b"minf")
        if minf is None:
            return None
        stbl = _find_child(data, minf[0] + minf[2], minf[0] + minf[1], b"stbl")
        if stbl is None:
            return None
        stss = _find_child(data, stbl[0] + stbl[2], stbl[0] + stbl[1], b"stss")
        if stss is None:
            return None
        payload = data[stss[0] + stss[2]:stss[0] + stss[1]]
        if len(payload) < 8:
            raise IndexError_("truncated stss")
        count = int.from_bytes(payload[4:8], "big")
        body = payload[8:]
        if len(body) < count * 4:
            raise IndexError_("truncated stss entries")
        return [int.from_bytes(body[i * 4:(i + 1) * 4], "big") - 1 for i in range(count)]
    return None


def probe(path: Path) -> Probe:
    import av

    container = av.open(str(path))
    try:
        stream = container.streams.video[0]
        tb = stream.time_base
        if tb is None or tb.numerator != 1 or tb.denominator <= 0:
            raise IndexError_(f"refusing video time base {tb}")
        ctx = stream.codec_context
        width = int(ctx.width)
        height = int(ctx.height)
        if width <= 0 or height <= 0 or width % 2 or height % 2:
            raise IndexError_(f"refusing frame size {width}x{height}")
        packets: list[PacketRow] = []
        for packet in container.demux(stream):
            if packet.pts is None:
                continue
            dur = packet.duration
            packets.append(PacketRow(int(packet.pts), -1 if dur is None else int(dur), bool(packet.is_keyframe)))
        audio_rate = None
        audio_channels = None
        if container.streams.audio:
            audio = container.streams.audio[0]
            audio_rate = int(audio.codec_context.sample_rate or 0) or None
            audio_channels = int(audio.codec_context.channels or 0) or None
        return Probe(
            width=width,
            height=height,
            timescale=int(tb.denominator),
            codec=stream.codec_context.name or "",
            has_b_frames=int(getattr(ctx, "has_b_frames", 0) or 0),
            packets=tuple(packets),
            audio_rate=audio_rate,
            audio_channels=audio_channels,
        )
    finally:
        container.close()


def frame_table(probed: Probe) -> tuple[list[int], list[int]]:
    if not probed.packets:
        raise IndexError_("empty video")
    ordered = sorted(probed.packets, key=lambda row: row.pts)
    ticks = [row.pts for row in ordered]
    if len(set(ticks)) != len(ticks):
        raise IndexError_("duplicate video pts")
    durs: list[int] = []
    for index, row in enumerate(ordered):
        if index + 1 < len(ordered):
            delta = ordered[index + 1].pts - row.pts
            if delta <= 0:
                raise IndexError_("non-monotonic video pts")
            durs.append(delta)
        elif row.dur > 0:
            durs.append(row.dur)
        else:
            raise IndexError_("last frame has no duration")
    return ticks, durs


def keyframe_rows(path: Path, probed: Probe) -> list[dict]:
    data = path.read_bytes()
    stss = stss_samples(data)
    ordered = sorted(enumerate(probed.packets), key=lambda item: item[1].pts)
    if stss is not None:
        if not stss or stss[0] != 0:
            raise IndexError_("stss has no IDR at sample 0")
        packets = list(probed.packets)
        rows = []
        for sample in stss:
            if sample < 0 or sample >= len(packets):
                raise IndexError_("stss sample out of range")
            rows.append({"index": sample, "pts": int(packets[sample].pts)})
        packet_keys = [index for index, row in enumerate(packets) if row.key]
        if packet_keys != [row["index"] for row in rows]:
            raise IndexError_("stss does not match packet keyframes")
        return rows
    rows = [{"index": index, "pts": int(row.pts)} for index, (_, row) in enumerate(ordered) if row.key]
    if not rows or rows[0]["index"] != 0:
        raise IndexError_("packet index has no IDR at frame 0")
    return rows


def write_keyframe_index(mezz: Path, rows: list[dict], mezz_sha: str, prepare_ms: float) -> dict:
    dest = mezz.with_suffix(".keyframes.json")
    atomic_write(dest, json.dumps(rows).encode())
    private(dest)
    record = {
        "index": dest.name,
        "index_sha256": sha256_file(dest),
        "keyframe_count": len(rows),
        "mezz": mezz.name,
        "mezz_sha256": mezz_sha,
        "prepare_ms": prepare_ms,
        "prepare_ms_source": "stss",
    }
    prep = mezz.with_suffix(".prep.json")
    atomic_write(prep, (json.dumps(record, sort_keys=True, indent=2) + "\n").encode())
    return record
