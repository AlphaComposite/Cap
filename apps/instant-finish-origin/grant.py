"""Revision media grant. Matches apps/web/lib/revision-media-token.ts.

token = base64url(canonical UTF-8 JSON) + "." + base64url(HMAC-SHA256(secret, canonical JSON bytes))
Canonical JSON uses sorted keys and no whitespace. TTL is 60s. Skew on iat is 5s.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass

GRANT_TTL_S = 60
GRANT_SKEW_S = 5
CLAIM_KEYS = (
    "exp",
    "grantId",
    "iat",
    "policyEpoch",
    "publicationEpoch",
    "revisionId",
    "v",
    "videoId",
)


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


def canonical_json(claims: dict) -> bytes:
    if set(claims) != set(CLAIM_KEYS):
        raise GrantError(401, "claims")
    ordered = {key: claims[key] for key in CLAIM_KEYS}
    if ordered["v"] != 1:
        raise GrantError(401, "version")
    return json.dumps(ordered, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    pad = "=" * ((4 - len(text) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(text + pad)
    except Exception as exc:
        raise GrantError(401, "encoding") from exc


def mint(secret: bytes, claims: dict) -> str:
    payload = canonical_json(claims)
    if int(claims["exp"]) - int(claims["iat"]) != GRANT_TTL_S:
        raise GrantError(401, "ttl")
    sig = hmac.new(secret, payload, hashlib.sha256).digest()
    return f"{b64url_encode(payload)}.{b64url_encode(sig)}"


def verify(secret: bytes, token: str, *, now: int) -> Grant:
    dummy = hmac.new(secret, b"cap-origin-grant", hashlib.sha256).digest()
    parts = token.split(".") if isinstance(token, str) else []
    payload = b""
    sig = b""
    ok_shape = len(parts) == 2 and parts[0] and parts[1]
    if ok_shape:
        try:
            payload = b64url_decode(parts[0])
            sig = b64url_decode(parts[1])
        except GrantError:
            ok_shape = False
    expected = hmac.new(secret, payload, hashlib.sha256).digest() if ok_shape else dummy
    presented = sig if len(sig) == len(expected) else dummy
    if not hmac.compare_digest(expected, presented) or not ok_shape:
        raise GrantError(401, "signature")
    try:
        claims = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GrantError(401, "json") from exc
    if not isinstance(claims, dict) or set(claims) != set(CLAIM_KEYS):
        raise GrantError(401, "claims")
    try:
        canonical = canonical_json(claims)
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
        )
    except (TypeError, ValueError) as exc:
        raise GrantError(401, "claims") from exc
    if grant.exp - grant.iat != GRANT_TTL_S:
        raise GrantError(401, "ttl")
    if grant.iat > now + GRANT_SKEW_S or now >= grant.exp or now + GRANT_SKEW_S < grant.iat:
        raise GrantError(401, "expired")
    if not grant.video_id or not grant.revision_id or not grant.grant_id:
        raise GrantError(401, "claims")
    return grant
