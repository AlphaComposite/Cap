"""Revision media grant. Matches apps/web/lib/revision-media-token.ts.

token = kid + "." + base64url(canonical UTF-8 JSON) + "." + base64url(HMAC-SHA256(secret, encoded payload))
Canonical JSON uses D's fixed claim order, not sorted keys. Playback TTL is 60s.
Download artifact TTL is 1800s. iat skew is 5s.
The key id is the token header. Verification uses REVISION_MEDIA_GRANT_KEYS, never NEXTAUTH_SECRET.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from dataclasses import dataclass

GRANT_TTL_S = 60
DOWNLOAD_GRANT_TTL_S = 30 * 60
GRANT_SKEW_S = 5
MIN_SECRET_BYTES = 32
SAFE_INT_MAX = 9_007_199_254_740_991
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
GRANT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


class GrantError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class Grant:
    video_id: str
    revision_id: str
    publication_epoch: int
    policy_epoch: int
    iat: int
    exp: int
    grant_id: str
    kid: str
    artifact: str | None = None


def _safe_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise GrantError(401, "claims")
    if value < 0 or value > SAFE_INT_MAX:
        raise GrantError(401, "claims")
    return value


def canonical_grant_json(claims: dict) -> str:
    required = (
        "v",
        "videoId",
        "revisionId",
        "publicationEpoch",
        "policyEpoch",
        "iat",
        "exp",
        "grantId",
    )
    if not isinstance(claims, dict) or claims.get("v") != 1 or set(required) - set(claims):
        raise GrantError(401, "claims")
    extra = set(claims) - set(required)
    artifact = None
    if extra == {"artifact"}:
        if claims.get("artifact") != "download":
            raise GrantError(401, "claims")
        artifact = "download"
    elif extra:
        raise GrantError(401, "claims")
    body = (
        '{"v":1,"videoId":'
        + json.dumps(claims["videoId"], ensure_ascii=False)
        + ',"revisionId":'
        + json.dumps(claims["revisionId"], ensure_ascii=False)
        + ',"publicationEpoch":'
        + str(_safe_int(claims["publicationEpoch"]))
        + ',"policyEpoch":'
        + str(_safe_int(claims["policyEpoch"]))
        + ',"iat":'
        + str(_safe_int(claims["iat"]))
        + ',"exp":'
        + str(_safe_int(claims["exp"]))
        + ',"grantId":'
        + json.dumps(claims["grantId"], ensure_ascii=False)
    )
    if artifact is not None:
        body += ',"artifact":' + json.dumps(artifact, ensure_ascii=False)
    return body + "}"


def ttl_for(artifact: str | None) -> int:
    return DOWNLOAD_GRANT_TTL_S if artifact == "download" else GRANT_TTL_S


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    pad = "=" * ((4 - len(text) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(text + pad)
    except Exception as exc:
        raise GrantError(401, "encoding") from exc


def parse_key_ring(raw: str) -> list[tuple[str, bytes]]:
    keys: list[tuple[str, bytes]] = []
    for part in raw.split(","):
        trimmed = part.strip()
        if not trimmed or ":" not in trimmed:
            continue
        kid, secret = trimmed.split(":", 1)
        if not kid or len(secret.encode()) < MIN_SECRET_BYTES or "." in kid:
            continue
        keys.append((kid, secret.encode()))
    return keys


def _as_ring(secret: bytes | list[tuple[str, bytes]], kid: str = "k1") -> list[tuple[str, bytes]]:
    if isinstance(secret, list):
        return [(key_id, key) for key_id, key in secret if len(key) >= MIN_SECRET_BYTES and "." not in key_id]
    if len(secret) < MIN_SECRET_BYTES:
        return []
    return [(kid, secret)]


def mint(secret: bytes | list[tuple[str, bytes]], claims: dict, kid: str = "k1") -> str:
    ring = _as_ring(secret, kid)
    chosen = next((item for item in ring if item[0] == kid), ring[0] if ring else None)
    if chosen is None:
        raise GrantError(401, "key")
    key_id, key = chosen
    payload = canonical_grant_json(claims).encode("utf-8")
    artifact = claims.get("artifact")
    if _safe_int(claims["exp"]) - _safe_int(claims["iat"]) != ttl_for(
        artifact if isinstance(artifact, str) else None
    ):
        raise GrantError(401, "ttl")
    encoded = b64url_encode(payload)
    sig = hmac.new(key, encoded.encode("ascii"), hashlib.sha256).digest()
    return f"{key_id}.{encoded}.{b64url_encode(sig)}"


def verify(
    secret: bytes | list[tuple[str, bytes]],
    token: str,
    *,
    now: int,
    kid: str = "k1",
) -> Grant:
    ring = _as_ring(secret, kid)
    dummy = hmac.new(b"cap-origin-grant-placeholder-secret", b"cap-origin-grant", hashlib.sha256).digest()
    parts = token.split(".") if isinstance(token, str) else []
    ok_shape = len(parts) == 3 and all(parts)
    presented_kid = parts[0] if ok_shape else ""
    encoded = parts[1] if ok_shape else ""
    signature = b""
    if ok_shape:
        try:
            signature = b64url_decode(parts[2])
            b64url_decode(encoded)
        except GrantError:
            ok_shape = False
    key = next((item[1] for item in ring if item[0] == presented_kid), b"")
    expected = (
        hmac.new(key, encoded.encode("ascii"), hashlib.sha256).digest()
        if ok_shape and key
        else dummy
    )
    presented = signature if len(signature) == len(expected) else dummy
    if not hmac.compare_digest(expected, presented) or not ok_shape or not key:
        raise GrantError(401, "signature")
    try:
        payload = b64url_decode(encoded)
        claims = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, GrantError) as exc:
        raise GrantError(401, "json") from exc
    if not isinstance(claims, dict):
        raise GrantError(401, "claims")
    try:
        canonical = canonical_grant_json(claims).encode("utf-8")
    except GrantError as exc:
        raise GrantError(401, exc.code) from exc
    if not hmac.compare_digest(canonical, payload):
        raise GrantError(401, "canonical")
    try:
        grant = Grant(
            video_id=str(claims["videoId"]),
            revision_id=str(claims["revisionId"]),
            publication_epoch=int(claims["publicationEpoch"]),
            policy_epoch=int(claims["policyEpoch"]),
            iat=int(claims["iat"]),
            exp=int(claims["exp"]),
            grant_id=str(claims["grantId"]),
            kid=presented_kid,
            artifact=str(claims["artifact"]) if "artifact" in claims else None,
        )
    except (TypeError, ValueError) as exc:
        raise GrantError(401, "claims") from exc
    if grant.exp - grant.iat != ttl_for(grant.artifact):
        raise GrantError(401, "ttl")
    if not ID_RE.fullmatch(grant.video_id) or not ID_RE.fullmatch(grant.revision_id):
        raise GrantError(401, "claims")
    if not GRANT_ID_RE.fullmatch(grant.grant_id):
        raise GrantError(401, "claims")
    if grant.iat > now + GRANT_SKEW_S:
        raise GrantError(401, "skew")
    if now > grant.exp + GRANT_SKEW_S:
        raise GrantError(401, "expired")
    return grant
