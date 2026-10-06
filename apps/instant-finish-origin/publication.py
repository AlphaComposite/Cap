"""Read-only publication projection. A owns the tables; this process never writes them."""
from __future__ import annotations

import os
import queue
import threading
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class VideoRow:
    video_id: str
    public: bool
    has_password: bool
    bucket: str | None


@dataclass(frozen=True)
class PublicationRow:
    video_id: str
    current_revision_id: str | None
    generation: int
    publication_epoch: int
    policy_epoch: int
    current_generation: int | None = None


@dataclass(frozen=True)
class RevisionRow:
    revision_id: str
    video_id: str
    intent_id: str
    source_id: str
    generation: int
    state: str


@dataclass(frozen=True)
class SourceRow:
    video_id: str
    live_key: str
    sha256: str
    relocation_state: str


@dataclass(frozen=True)
class AuthorizeSnapshot:
    video: VideoRow
    publication: PublicationRow | None
    revision: RevisionRow | None
    source_sha256: str | None
    source_live_key: str | None


AUTHORIZE_SQL = (
    "SELECT v.id AS video_id, v.is_public AS is_public, v.has_password AS has_password, "
    "v.bucket AS bucket, p.currentRevisionId AS current_revision_id, "
    "p.generation AS allocated_generation, p.currentGeneration AS current_generation, "
    "p.publicationEpoch AS publication_epoch, p.policyEpoch AS policy_epoch, "
    "r.revisionId AS revision_id, r.videoId AS revision_video_id, r.intentId AS intent_id, "
    "r.sourceId AS source_id, r.generation AS revision_generation, r.state AS revision_state, "
    "s.sha256 AS source_sha256, s.liveKey AS source_live_key "
    "FROM origin_video v "
    "LEFT JOIN video_publication p ON p.videoId = v.id "
    "LEFT JOIN edit_revision r ON r.revisionId = %s AND r.videoId = v.id "
    "LEFT JOIN source_object s ON s.videoId = v.id "
    "WHERE v.id = %s"
)

RECHECK_SQL = (
    "SELECT p.currentRevisionId AS current_revision_id, p.currentGeneration AS current_generation, "
    "p.publicationEpoch AS publication_epoch, p.policyEpoch AS policy_epoch, "
    "r.generation AS revision_generation, r.state AS revision_state "
    "FROM video_publication p "
    "JOIN edit_revision r ON r.revisionId = %s AND r.videoId = p.videoId "
    "WHERE p.videoId = %s"
)


@dataclass(frozen=True)
class StagedRelocation:
    video_id: str
    old_key: str
    new_key: str
    sha256: str
    state: str


class PublicationStore:
    def video(self, video_id: str) -> VideoRow | None:
        raise NotImplementedError

    def publication(self, video_id: str) -> PublicationRow | None:
        raise NotImplementedError

    def revision(self, revision_id: str) -> RevisionRow | None:
        raise NotImplementedError

    def source(self, video_id: str) -> SourceRow | None:
        raise NotImplementedError

    def staged_source(self, video_id: str, key: str) -> StagedRelocation | None:
        return None

    def authorize(self, video_id: str, revision_id: str) -> AuthorizeSnapshot | None:
        raise NotImplementedError

    def recheck(self, video_id: str, revision_id: str) -> dict | None:
        raise NotImplementedError


class MemoryPublication(PublicationStore):
    def __init__(self) -> None:
        self.videos: dict[str, VideoRow] = {}
        self.pubs: dict[str, PublicationRow] = {}
        self.revs: dict[str, RevisionRow] = {}
        self.sources: dict[str, SourceRow] = {}
        self.relocations: list[dict[str, str]] = []

    def video(self, video_id: str) -> VideoRow | None:
        return self.videos.get(video_id)

    def publication(self, video_id: str) -> PublicationRow | None:
        return self.pubs.get(video_id)

    def revision(self, revision_id: str) -> RevisionRow | None:
        return self.revs.get(revision_id)

    def source(self, video_id: str) -> SourceRow | None:
        return self.sources.get(video_id)

    def staged_source(self, video_id: str, key: str) -> StagedRelocation | None:
        for row in self.relocations:
            if (
                row.get("videoId") == video_id
                and row.get("newKey") == key
                and row.get("state") in {"COPIED", "POINTER", "PURGED"}
            ):
                return StagedRelocation(
                    video_id,
                    row.get("oldKey", ""),
                    row.get("newKey", ""),
                    row.get("sha256", ""),
                    row.get("state", ""),
                )
        return None

    def authorize(self, video_id: str, revision_id: str) -> AuthorizeSnapshot | None:
        video = self.video(video_id)
        if video is None:
            return None
        source = self.source(video_id)
        return AuthorizeSnapshot(
            video,
            self.publication(video_id),
            self.revision(revision_id),
            None if source is None else source.sha256,
            None if source is None else source.live_key,
        )

    def recheck(self, video_id: str, revision_id: str) -> dict | None:
        pub = self.publication(video_id)
        rev = self.revision(revision_id)
        if pub is None or rev is None or rev.video_id != video_id:
            return None
        return {
            "current_generation": pub.current_generation,
            "current_revision_id": pub.current_revision_id,
            "policy_epoch": pub.policy_epoch,
            "publication_epoch": pub.publication_epoch,
            "revision_generation": rev.generation,
            "revision_state": rev.state,
        }

    def put_video(self, row: VideoRow) -> None:
        self.videos[row.video_id] = row

    def put_publication(self, row: PublicationRow) -> None:
        self.pubs[row.video_id] = row

    def put_revision(self, row: RevisionRow) -> None:
        self.revs[row.revision_id] = row

    def put_source(self, row: SourceRow) -> None:
        self.sources[row.video_id] = row


class ConnectionPool:
    def __init__(self, url: str, size: int | None = None) -> None:
        self.url = url
        self.size = size if size is not None else int(os.environ.get("ORIGIN_DB_POOL", "4"))
        if self.size < 1:
            raise RuntimeError("origin db pool must be at least 1")
        self._idle: queue.Queue = queue.Queue(maxsize=self.size)
        self._created = 0
        self._lock = threading.Lock()
        self.connects = 0

    def _connect(self):
        import pymysql

        parsed = urlparse(self.url)
        if parsed.scheme not in {"mysql", "mysql+pymysql"}:
            raise RuntimeError("publication URL must be mysql")
        self.connects += 1
        return pymysql.connect(
            host=parsed.hostname or "127.0.0.1",
            port=parsed.port or 3306,
            user=parsed.username or "",
            password=parsed.password or "",
            database=(parsed.path or "/").lstrip("/"),
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
            read_timeout=5,
            write_timeout=5,
            connect_timeout=5,
        )

    def acquire(self):
        try:
            conn = self._idle.get_nowait()
        except queue.Empty:
            with self._lock:
                if self._created < self.size:
                    self._created += 1
                    try:
                        return self._connect()
                    except Exception:
                        self._created -= 1
                        raise
            conn = self._idle.get(timeout=2)
        return self._revalidate(conn)

    def _revalidate(self, conn):
        # Idle connections can be closed server-side (wait_timeout, DB restart);
        # reuse without a check surfaced as OperationalError 2013 on editor open.
        try:
            conn.ping(reconnect=True)
            return conn
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            with self._lock:
                self._created = max(0, self._created - 1)
            raise

    def release(self, conn) -> None:
        try:
            conn.ping(reconnect=True)
            self._idle.put_nowait(conn)
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            with self._lock:
                self._created = max(0, self._created - 1)


class MySQLPublication(PublicationStore):
    def __init__(self, url: str, pool: ConnectionPool | None = None) -> None:
        self.url = url
        self.pool = pool or ConnectionPool(url)

    def _one(self, sql: str, args: tuple) -> dict | None:
        conn = self.pool.acquire()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, args)
                fetched = cur.fetchone()
                return fetched if isinstance(fetched, dict) else None
        finally:
            self.pool.release(conn)

    def video(self, video_id: str) -> VideoRow | None:
        snap = self.authorize(video_id, "")
        return None if snap is None else snap.video

    def publication(self, video_id: str) -> PublicationRow | None:
        snap = self.authorize(video_id, "")
        return None if snap is None else snap.publication

    def revision(self, revision_id: str) -> RevisionRow | None:
        row = self._one(
            "SELECT revisionId, videoId, intentId, sourceId, generation, state "
            "FROM edit_revision WHERE revisionId=%s",
            (revision_id,),
        )
        if row is None:
            return None
        return RevisionRow(
            row["revisionId"],
            row["videoId"],
            row["intentId"],
            row["sourceId"],
            int(row["generation"]),
            row["state"],
        )

    def source(self, video_id: str) -> SourceRow | None:
        row = self._one(
            "SELECT videoId, liveKey, sha256, relocationState FROM source_object WHERE videoId=%s",
            (video_id,),
        )
        if row is None:
            return None
        return SourceRow(row["videoId"], row["liveKey"], row["sha256"], row["relocationState"])

    def staged_source(self, video_id: str, key: str) -> StagedRelocation | None:
        row = self._one(
            "SELECT videoId, oldKey, newKey, sha256, state FROM source_relocation "
            "WHERE videoId=%s AND newKey=%s AND state IN ('COPIED','POINTER','PURGED') "
            "ORDER BY id DESC LIMIT 1",
            (video_id, key),
        )
        if row is None:
            return None
        return StagedRelocation(
            row["videoId"],
            row["oldKey"],
            row["newKey"],
            row["sha256"],
            row["state"],
        )

    def authorize(self, video_id: str, revision_id: str) -> AuthorizeSnapshot | None:
        row = self._one(AUTHORIZE_SQL, (revision_id, video_id))
        if row is None:
            return None
        publication = None
        if row.get("publication_epoch") is not None:
            publication = PublicationRow(
                video_id,
                row.get("current_revision_id"),
                int(row["allocated_generation"]),
                int(row["publication_epoch"]),
                int(row["policy_epoch"]),
                None if row.get("current_generation") is None else int(row["current_generation"]),
            )
        revision = None
        if row.get("revision_id"):
            revision = RevisionRow(
                row["revision_id"],
                row["revision_video_id"],
                row["intent_id"],
                row["source_id"],
                int(row["revision_generation"]),
                row["revision_state"],
            )
        return AuthorizeSnapshot(
            VideoRow(row["video_id"], bool(row["is_public"]), bool(row["has_password"]), row.get("bucket")),
            publication,
            revision,
            row.get("source_sha256"),
            row.get("source_live_key"),
        )

    def recheck(self, video_id: str, revision_id: str) -> dict | None:
        row = self._one(RECHECK_SQL, (revision_id, video_id))
        if row is None:
            return None
        return {
            "current_generation": None if row.get("current_generation") is None else int(row["current_generation"]),
            "current_revision_id": row.get("current_revision_id"),
            "policy_epoch": int(row["policy_epoch"]),
            "publication_epoch": int(row["publication_epoch"]),
            "revision_generation": int(row["revision_generation"]),
            "revision_state": row["revision_state"],
        }
