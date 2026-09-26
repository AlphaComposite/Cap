"""Internal origin MAC. Matches apps/web/lib/revision-media-token.ts."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

SERVICE_HEADER = "x-cap-origin-service"
ATTESTATION_HEADER = "x-cap-origin-attestation"
SERVICE_SKEW_S = 5
SERVICE_TTL_S = 30
SAFE_INT_MAX = 9_007_199_254_740_991


class ServiceAuthError(Exception):
    pass


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    pad = "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text + pad)


def body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def sign_request(
    secret: bytes,
    method: str,
    path: str,
    body: bytes = b"",
    now: int | None = None,
) -> str:
    if len(secret) < 32:
        raise ServiceAuthError("short service secret")
    iat = int(time.time()) if now is None else int(now)
    claims = {
        "v": 1,
        "aud": "origin-service",
        "iat": iat,
        "exp": iat + SERVICE_TTL_S,
        "nonce": b64url(hashlib.sha256(f"{iat}:{path}:{len(body)}".encode()).digest())[:16],
    }
    encoded = b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    mac_input = f"{encoded}.{method.upper()}.{path}.{body_sha256(body)}".encode()
    mac = b64url(hmac.new(secret, mac_input, hashlib.sha256).digest())
    return f"{encoded}.{mac}"


def verify_request(
    secret: bytes,
    token: str,
    method: str,
    path: str,
    body: bytes = b"",
    now: int | None = None,
) -> bool:
    if len(secret) < 32 or not isinstance(token, str):
        return False
    parts = token.split(".")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return False
    expected = b64url(
        hmac.new(
            secret,
            f"{parts[0]}.{method.upper()}.{path}.{body_sha256(body)}".encode(),
            hashlib.sha256,
        ).digest()
    )
    if not hmac.compare_digest(expected, parts[1]):
        return False
    try:
        claims = json.loads(b64url_decode(parts[0]).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        return False
    if not isinstance(claims, dict) or claims.get("aud") != "origin-service" or claims.get("v") != 1:
        return False
    wall = int(time.time()) if now is None else int(now)
    iat = _safe_int(claims.get("iat"))
    exp = _safe_int(claims.get("exp"))
    if iat is None or exp is None or exp - iat != SERVICE_TTL_S:
        return False
    return iat <= wall + SERVICE_SKEW_S and wall <= exp


def canonical_json(payload: dict) -> bytes:
    """Sorted-key JSON plus a trailing newline. Sign these exact bytes."""
    return (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8")


def sign_attestation(secret: bytes, body: bytes) -> str:
    """HMAC-SHA256 of the response body, same secret as the request MAC."""
    if len(secret) < 32:
        raise ServiceAuthError("short service secret")
    if not isinstance(body, (bytes, bytearray)):
        raise ServiceAuthError("attestation body must be bytes")
    return b64url(hmac.new(secret, bytes(body), hashlib.sha256).digest())


def verify_attestation(secret: bytes, token: str, body: bytes) -> bool:
    if len(secret) < 32 or not isinstance(token, str) or not token:
        return False
    if not isinstance(body, (bytes, bytearray)):
        return False
    expected = b64url(hmac.new(secret, bytes(body), hashlib.sha256).digest())
    return hmac.compare_digest(expected, token)


def _safe_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > SAFE_INT_MAX:
        return None
    return value
