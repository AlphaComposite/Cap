"""Private object read and cache file modes. No public presign, no request-path syncfs."""
from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
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


def _url_origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or any(ord(char) <= 32 or ord(char) == 127 or char == "\\" for char in url)
            or parsed.netloc.endswith(":") or parsed.port == 0):
        raise ValueError("invalid object URL")
    return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def _http_fetch(url, method, data, headers, dest):
    request = urllib.request.Request(url, data=data.encode() if data is not None else None,
                                     headers=headers, method=method)
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    with http.open(request, timeout=30) as response:
        if response.status != 200:
            raise StorageError("source object unavailable")
        if dest is not None:
            with Path(dest).open("wb") as stream:
                os.chmod(dest, 0o600)
                shutil.copyfileobj(response, stream, length=1 << 20)
                if stream.tell() != int(response.headers["Content-Length"]):
                    raise StorageError("incomplete source object")
        elif method == "POST":
            return json.load(response)
        return {key.lower(): value for key, value in response.headers.items()}


class PresignedObjectStore(ObjectStore):
    URL_PATH = "/api/internal/origin/object-url"
    URL_FETCH_DEADLINE_S = 30

    def __init__(self, endpoint: str, service_secret: bytes) -> None:
        try:
            origin = os.environ["ORIGIN_STORAGE_ORIGIN"]
            parsed = urlsplit(origin)
            self.storage_origin = _url_origin(origin)
            if parsed.path or "?" in origin or "#" in origin:
                raise ValueError("storage origin must not include a path")
            self.fetch_deadline = float(os.environ.get("ORIGIN_OBJECT_FETCH_DEADLINE_S", "600"))
            if not math.isfinite(self.fetch_deadline) or self.fetch_deadline <= 0:
                raise ValueError("invalid fetch deadline")
        except (KeyError, TypeError, ValueError):
            raise StorageError("valid storage origin and fetch deadline required") from None
        self.endpoint = endpoint.rstrip("/") + self.URL_PATH
        self.service_secret = service_secret

    def _fetch(self, request, timeout, dest=None):
        # A kill-and-wait subprocess bounds DNS, TLS, headers and trickling reads,
        # including on origin worker threads; no transfer can outlive cleanup.
        task = {"url": request.full_url, "method": request.get_method(),
                "data": request.data.decode() if request.data is not None else None,
                "headers": dict(request.header_items()), "dest": str(dest) if dest is not None else None}
        result = subprocess.run([sys.executable, str(Path(__file__).resolve())],
                                input=json.dumps(task).encode(), stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=timeout, check=True)
        return json.loads(result.stdout)

    def _url(self, key: str, field: str) -> str:
        assert_original_key(key)
        try:
            body = json.dumps({"key": key}, separators=(",", ":")).encode()
            token = sign_request(self.service_secret, "POST", self.URL_PATH, body, audience="web-object-url")
            request = urllib.request.Request(self.endpoint, data=body, headers={
                "Content-Type": "application/json", SERVICE_HEADER: token,
            }, method="POST")
            urls = self._fetch(request, self.URL_FETCH_DEADLINE_S)
            for name in ("getUrl", "headUrl"):
                if _url_origin(urls[name]) != self.storage_origin:
                    raise ValueError("unexpected storage origin")
            return urls[field]
        except Exception:
            raise StorageError("source object URL unavailable") from None

    def get_to(self, key: str, dest: Path) -> None:
        url = self._url(key, "getUrl")
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        private(dest.parent)
        tmp = dest.with_name(f".{dest.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            self._fetch(urllib.request.Request(url, method="GET"), self.fetch_deadline, tmp)
            os.replace(tmp, dest)
            private(dest)
        except Exception:
            raise StorageError("source object unavailable") from None
        finally:
            tmp.unlink(missing_ok=True)

    def head(self, key: str) -> ObjectIdentity:
        url = self._url(key, "headUrl")
        try:
            headers = self._fetch(urllib.request.Request(url, method="HEAD"), self.fetch_deadline)
            size = int(headers["content-length"])
            if size < 0:
                raise ValueError("invalid object size")
            return ObjectIdentity(key, headers.get("etag", "").strip('"'),
                                  headers.get("x-amz-version-id", ""), size)
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


if __name__ == "__main__":
    print(json.dumps(_http_fetch(**json.load(sys.stdin))))
