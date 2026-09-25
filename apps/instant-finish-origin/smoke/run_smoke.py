"""Disposable compose smoke. Never prints secrets, source keys, or grant tokens."""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import grant as grant_mod
from service_auth import sign_request

COMPOSE = ROOT / "docker-compose.smoke.yml"
SQL = ROOT / "sql" / "smoke-projection.sql"
NGINX = "http://127.0.0.1:3118"
ORIGIN = "http://127.0.0.1:3119"
MINIO = "http://127.0.0.1:3117"
MYSQL = "127.0.0.1:3116"
VIDEO = "vidsmoke01"
REV = "revsmoke01"
SOURCE = "srcsmoke01"


def _env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in COMPOSE.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        key = key.strip()
        if key in {
            "MYSQL_ROOT_PASSWORD",
            "MINIO_ROOT_USER",
            "MINIO_ROOT_PASSWORD",
            "S3_ACCESS_KEY",
            "S3_SECRET_KEY",
            "REVISION_MEDIA_GRANT_KEYS",
            "REVISION_ORIGIN_SERVICE_SECRET",
        }:
            values[key] = value.strip().strip('"')
    return values


def _wait(url: str, seconds: int = 90) -> int:
    deadline = time.time() + seconds
    last = 0
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                return response.status
        except Exception:
            last = 0
            time.sleep(1)
    return last


def _req(url: str, method: str = "GET", headers=None, body: bytes | None = None):
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def main() -> int:
    env = _env()
    health = _wait(f"{ORIGIN}/health")
    print(f"origin_health={health}")
    if health != 200:
        return 1
    mysql = subprocess.run(
        [
            "docker", "compose", "-p", "capwire-b-origin", "-f", str(COMPOSE),
            "exec", "-T", "mysql",
            "mysql", "-uroot", f"-p{env['MYSQL_ROOT_PASSWORD']}", "cap",
        ],
        input=SQL.read_bytes(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    print(f"mysql_ddl_exit={mysql.returncode}")
    if mysql.returncode:
        tail = mysql.stderr.decode("utf-8", "replace")[-300:].replace(env["MYSQL_ROOT_PASSWORD"], "[redacted]")
        print(tail)
        return mysql.returncode
    work = Path("/srv/styrir/scratch/cap-fzp-8-wire/build-b-origin/smoke")
    work.mkdir(parents=True, exist_ok=True)
    source = work / "original.mp4"
    made = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1.2",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.2",
            "-c:v", "libx264", "-bf", "2", "-g", "60", "-pix_fmt", "yuv420p",
            "-video_track_timescale", "15360",
            "-c:a", "aac", "-ar", "48000", "-ac", "1", "-shortest", str(source),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    print(f"ffmpeg_exit={made.returncode}")
    if made.returncode:
        print(made.stderr.decode()[-200:])
        return made.returncode
    import boto3
    from botocore.config import Config

    client = boto3.client(
        "s3",
        endpoint_url=MINIO,
        aws_access_key_id=env["MINIO_ROOT_USER"],
        aws_secret_access_key=env["MINIO_ROOT_PASSWORD"],
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
    )
    key = f"owner/{VIDEO}/source/original.mp4"
    client.upload_file(str(source), "cap", key)
    print("minio_put=ok")
    insert = (
        "INSERT INTO videos (id, `public`, password, bucket) VALUES "
        f"('{VIDEO}', 1, NULL, NULL) ON DUPLICATE KEY UPDATE `public`=1;"
        "INSERT INTO edit_revision (revisionId, videoId, intentId, sourceId, generation, state) VALUES "
        f"('{REV}', '{VIDEO}', 'pendinghash', '{SOURCE}', 1, 'READY') "
        "ON DUPLICATE KEY UPDATE state='READY', intentId='pendinghash';"
    )
    inserted = subprocess.run(
        [
            "docker", "compose", "-p", "capwire-b-origin", "-f", str(COMPOSE),
            "exec", "-T", "mysql", "mysql", "-uroot", f"-p{env['MYSQL_ROOT_PASSWORD']}", "cap", "-e", insert,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    print(f"mysql_seed_exit={inserted.returncode}")
    if inserted.returncode:
        print(inserted.stderr.decode("utf-8", "replace")[-200:].replace(env["MYSQL_ROOT_PASSWORD"], "[redacted]"))
        return inserted.returncode
    def signed(path: str, body: bytes) -> dict[str, str]:
        return {
            "x-cap-origin-service": sign_request(env["REVISION_ORIGIN_SERVICE_SECRET"].encode(), "POST", path, body),
            "Content-Type": "application/json",
        }

    source_body = json.dumps({"sourceId": SOURCE, "sourceKey": key}).encode()
    source_path = f"/internal/sources/{VIDEO}/prepare"
    status, _, payload = _req(
        f"{ORIGIN}{source_path}",
        "POST",
        signed(source_path, source_body),
        source_body,
    )
    print(f"source_prepare={status}")
    if status != 200:
        print(payload[:200])
        return 1
    prepared_source = json.loads(payload)
    print(f"source_timescale={prepared_source.get('timescale')} bframes={prepared_source.get('hasBFrames')}")
    import hashlib
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    source_sql = (
        "INSERT INTO source_object (videoId, liveKey, sha256, relocationState) VALUES "
        f"('{VIDEO}', '{key}', '{digest}', 'live') "
        "ON DUPLICATE KEY UPDATE sha256=VALUES(sha256), liveKey=VALUES(liveKey);"
    )
    sourced = subprocess.run(
        [
            "docker", "compose", "-p", "capwire-b-origin", "-f", str(COMPOSE),
            "exec", "-T", "mysql", "mysql", "-uroot", f"-p{env['MYSQL_ROOT_PASSWORD']}", "cap", "-e", source_sql,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    print(f"source_row_exit={sourced.returncode}")
    ranges = [{"start": 0.0, "end": 0.15}, {"start": 0.45, "end": 0.9}]
    revision_body = json.dumps({
        "videoId": VIDEO,
        "sourceId": SOURCE,
        "keepRanges": ranges,
        "captions": [{"start": 0.02, "end": 0.08, "text": "kept"}],
        "chapters": [{"start": 0.0, "end": 0.1, "title": "Open"}],
    }).encode()
    revision_path = f"/internal/revisions/{REV}/prepare"
    status, _, payload = _req(
        f"{ORIGIN}{revision_path}",
        "POST",
        signed(revision_path, revision_body),
        revision_body,
    )
    print(f"revision_prepare={status}")
    if status != 200:
        print(payload[:240])
        return 1
    prepared = json.loads(payload)
    print(
        "revision_ready="
        f"{prepared.get('ready')} segs={prepared.get('segmentCount')} "
        f"seg0_frames={prepared.get('seg0DecodedFrames')} duration_s={prepared.get('durationSeconds')}"
    )
    intent = prepared["intentId"]
    publish = (
        "UPDATE edit_revision SET state='CURRENT', intentId='" + intent + "' WHERE revisionId='" + REV + "';"
        "INSERT INTO video_publication (videoId, currentRevisionId, generation, publicationEpoch, policyEpoch) VALUES "
        f"('{VIDEO}', '{REV}', 1, 2, 3) "
        "ON DUPLICATE KEY UPDATE currentRevisionId=VALUES(currentRevisionId), publicationEpoch=2, policyEpoch=3;"
    )
    published = subprocess.run(
        [
            "docker", "compose", "-p", "capwire-b-origin", "-f", str(COMPOSE),
            "exec", "-T", "mysql", "mysql", "-uroot", f"-p{env['MYSQL_ROOT_PASSWORD']}", "cap", "-e", publish,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    print(f"publish_exit={published.returncode}")
    now = int(time.time())
    token = grant_mod.mint(grant_mod.parse_key_ring(env["REVISION_MEDIA_GRANT_KEYS"]), {
        "exp": now + 60,
        "grantId": "smoke-grant",
        "iat": now,
        "policyEpoch": 3,
        "publicationEpoch": 2,
        "revisionId": REV,
        "v": 1,
        "videoId": VIDEO,
    })
    playlist_url = f"{NGINX}/media/{VIDEO}/r/{REV}/playlist.m3u8?t={token}"
    status, headers, playlist = _req(playlist_url)
    text = playlist.decode("utf-8", "replace")
    print(f"nginx_playlist={status} cache={headers.get('Cache-Control')} endlist={'#EXT-X-ENDLIST' in text} child_grant={'init.mp4?t=' in text}")
    print("nginx_playlist_has_source_key", "source" in text.lower() or "original" in text.lower())
    if status != 200:
        return 1
    status, headers, _ = _req(f"{NGINX}/media/{VIDEO}/r/{REV}/init.mp4?t={token}", "HEAD")
    print(f"nginx_init_head={status} length={headers.get('Content-Length')} cache={headers.get('Cache-Control')}")
    range_status, range_headers, seg = _req(
        f"{NGINX}/media/{VIDEO}/r/{REV}/seg/0.m4s?t={token}",
        headers={"Range": "bytes=0-15"},
    )
    print(
        f"nginx_seg0_range={range_status} cr={range_headers.get('Content-Range')} "
        f"nbytes={len(seg)} cache={range_headers.get('Cache-Control')}"
    )
    status, _, _ = _req(f"{NGINX}/media/{VIDEO}/r/{REV}/playlist.m3u8")
    print(f"nginx_missing_grant={status}")
    status, _, body = _req(f"{NGINX}/media/{VIDEO}/r/{REV}/seg/0.m4s?t={token}")
    print(f"nginx_seg0={status} nbytes={len(body)}")
    init_status, _, init = _req(f"{ORIGIN}/media/{VIDEO}/r/{REV}/init.mp4?t={token}")
    print(f"origin_init={init_status} nbytes={len(init)}")
    if status == 200 and init_status == 200:
        import av
        import io

        blob = init + body[int.from_bytes(body[:4], "big"):] if body[4:8] == b"styp" else init + body
        container = av.open(io.BytesIO(blob))
        frames = sum(1 for _ in container.decode(video=0))
        container.close()
        print(f"decoded_seg0_frames={frames}")
    return 0 if status == 200 and range_status == 206 and str(range_headers.get("Content-Range", "")).startswith("bytes 0-15/") else 1


if __name__ == "__main__":
    raise SystemExit(main())
