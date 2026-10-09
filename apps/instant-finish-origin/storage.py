"""Private object read and cache file modes. No public presign, no request-path syncfs."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from service_auth import SERVICE_HEADER, sign_request

FORBIDDEN_SUFFIXES = ("result.mp4", ".webm")
FORBIDDEN_PARTS = ("raw-upload", "/segments/", "preview/", "screenshot/")


class StorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class ObjectIdentity:
    key: str
    etag: str
    version: str
    size: int


class ShaIdentityCache:
    def __init__(self, max_entries: int = 256) -> None:
        self.max_entries = max_entries
        self._items: dict[tuple[str, str, str, int], str] = {}
        self._lock = threading.Lock()

    def get(self, ident: ObjectIdentity) -> str | None:
        with self._lock:
            return self._items.get((ident.key, ident.etag, ident.version, ident.size))

    def put(self, ident: ObjectIdentity, sha256: str) -> None:
        key = (ident.key, ident.etag, ident.version, ident.size)
        with self._lock:
            self._items.pop(key, None)
            self._items[key] = sha256
            while len(self._items) > self.max_entries:
                self._items.pop(next(iter(self._items)))


def private(path: Path) -> None:
    if path.is_dir():
        os.chmod(path, 0o700)
    elif path.exists():
        os.chmod(path, 0o600)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_original_key(key: str) -> None:
    if not key or key.startswith("/") or ".." in key.split("/"):
        raise StorageError("refusing source key")
    lower = key.lower()
    if lower.endswith(FORBIDDEN_SUFFIXES) or any(part in lower for part in FORBIDDEN_PARTS):
        raise StorageError("refusing non-original source key")
    if "x-amz-signature" in lower or lower.startswith("http://") or lower.startswith("https://"):
        raise StorageError("refusing presigned source URL")


def atomic_write(path: Path, data: bytes, *, sync: bool = False) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    private(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    if tmp.parent.resolve() != path.parent.resolve():
        raise StorageError("tmp escaped the cache namespace")
    try:
        with tmp.open("wb") as stream:
            stream.write(data)
            stream.flush()
            if sync:
                os.fsync(stream.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()
    private(path)


class ObjectStore:
    def get_to(self, key: str, dest: Path) -> None:
        raise NotImplementedError

    def head(self, key: str) -> ObjectIdentity:
        raise NotImplementedError


class LocalObjectStore(ObjectStore):
    def __init__(self, root: Path) -> None:
        self.root = root

    def get_to(self, key: str, dest: Path) -> None:
        assert_original_key(key)
        src = (self.root / key).resolve()
        if self.root.resolve() not in src.parents or not src.is_file():
            raise StorageError("source object missing")
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_write(dest, src.read_bytes(), sync=False)

    def head(self, key: str) -> ObjectIdentity:
        assert_original_key(key)
        src = (self.root / key).resolve()
        if self.root.resolve() not in src.parents or not src.is_file():
            raise StorageError("source object missing")
        stat = src.stat()
        return ObjectIdentity(key, f"{stat.st_mtime_ns}:{stat.st_size}", "", stat.st_size)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PresignedObjectStore(ObjectStore):
    URL_PATH = "/api/internal/origin/object-url"

    def __init__(self, endpoint: str, service_secret: bytes) -> None:
        self.endpoint = endpoint.rstrip("/") + self.URL_PATH
        self.service_secret = service_secret
        self._http = urllib.request.build_opener(_NoRedirect())

    def _open(self, request):
        response = self._http.open(request, timeout=30)
        if response.status != 200:
            response.close()
            raise StorageError("source object unavailable")
        return response

    def _url(self, key: str, field: str) -> str:
        assert_original_key(key)
        try:
            body = json.dumps({"key": key}, separators=(",", ":")).encode()
            token = sign_request(self.service_secret, "POST", self.URL_PATH, body, audience="web-object-url")
            request = urllib.request.Request(self.endpoint, data=body, headers={
                "Content-Type": "application/json", SERVICE_HEADER: token,
            }, method="POST")
            with self._open(request) as response:
                url = json.load(response)[field]
            parsed = urlsplit(url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError("invalid object URL")
            return url
        except Exception:
            raise StorageError("source object URL unavailable") from None

    def get_to(self, key: str, dest: Path) -> None:
        url = self._url(key, "getUrl")
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        private(dest.parent)
        tmp = dest.with_name(f".{dest.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            with self._open(urllib.request.Request(url, method="GET")) as response, tmp.open("wb") as stream:
                os.chmod(tmp, 0o600)
                shutil.copyfileobj(response, stream, length=1 << 20)
                if stream.tell() != int(response.headers["Content-Length"]):
                    raise StorageError("incomplete source object")
            os.replace(tmp, dest)
            private(dest)
        except Exception:
            raise StorageError("source object unavailable") from None
        finally:
            tmp.unlink(missing_ok=True)

    def head(self, key: str) -> ObjectIdentity:
        url = self._url(key, "headUrl")
        try:
            with self._open(urllib.request.Request(url, method="HEAD")) as response:
                size = int(response.headers["Content-Length"])
                if size < 0:
                    raise ValueError("invalid object size")
                return ObjectIdentity(key, response.headers.get("ETag", "").strip('"'),
                                      response.headers.get("x-amz-version-id", ""), size)
        except Exception:
            raise StorageError("source object unavailable") from None


class S3ObjectStore(ObjectStore):
    def __init__(self, endpoint: str, bucket: str, access_key: str, secret_key: str, region: str) -> None:
        self.endpoint = endpoint
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self._s3 = None
        self._s3_lock = threading.Lock()

    def get_to(self, key: str, dest: Path) -> None:
        assert_original_key(key)
        client = self._client()
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.s3.tmp")
        try:
            client.download_file(self.bucket, key, str(tmp))
            os.chmod(tmp, 0o600)
            os.replace(tmp, dest)
        except Exception as exc:
            raise StorageError("source object missing") from exc
        finally:
            if tmp.exists():
                tmp.unlink()
        private(dest)

    def head(self, key: str) -> ObjectIdentity:
        assert_original_key(key)
        import boto3
        from botocore.config import Config

        client = self._client()
        try:
            response = client.head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            raise StorageError("source object missing") from exc
        etag = str(response.get("ETag", "")).strip('"')
        version = str(response.get("VersionId") or "")
        return ObjectIdentity(key, etag, version, int(response["ContentLength"]))

    def _client(self):
        with self._s3_lock:
            if self._s3 is None:
                import boto3
                from botocore.config import Config

                self._s3 = boto3.client(
                    "s3",
                    endpoint_url=self.endpoint,
                    aws_access_key_id=self.access_key,
                    aws_secret_access_key=self.secret_key,
                    region_name=self.region,
                    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
                )
            return self._s3
