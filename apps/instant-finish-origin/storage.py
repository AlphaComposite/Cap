"""Private object read and cache file modes. No public presign, no request-path syncfs."""
from __future__ import annotations

import os
import threading
from pathlib import Path

import hashlib

FORBIDDEN_SUFFIXES = ("result.mp4", ".webm")
FORBIDDEN_PARTS = ("raw-upload", "/segments/", "preview/", "screenshot/")


class StorageError(RuntimeError):
    pass


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


class S3ObjectStore(ObjectStore):
    def __init__(self, endpoint: str, bucket: str, access_key: str, secret_key: str, region: str) -> None:
        self.endpoint = endpoint
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region

    def get_to(self, key: str, dest: Path) -> None:
        assert_original_key(key)
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=self.endpoint,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
            region_name=self.region,
            config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
        )
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.s3.tmp")
        try:
            client.download_file(self.bucket, key, str(tmp))
            os.chmod(tmp, 0o600)
            os.replace(tmp, dest)
        finally:
            if tmp.exists():
                tmp.unlink()
        private(dest)
