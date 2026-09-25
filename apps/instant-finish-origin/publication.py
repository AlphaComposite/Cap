"""Read-only publication projection. A owns the tables; this process never writes them."""
from __future__ import annotations

from dataclasses import dataclass


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


class PublicationStore:
    def video(self, video_id: str) -> VideoRow | None:
        raise NotImplementedError

    def publication(self, video_id: str) -> PublicationRow | None:
        raise NotImplementedError

    def revision(self, revision_id: str) -> RevisionRow | None:
        raise NotImplementedError

    def source(self, video_id: str) -> SourceRow | None:
        raise NotImplementedError


class MemoryPublication(PublicationStore):
    def __init__(self) -> None:
        self.videos: dict[str, VideoRow] = {}
        self.pubs: dict[str, PublicationRow] = {}
        self.revs: dict[str, RevisionRow] = {}
        self.sources: dict[str, SourceRow] = {}

    def video(self, video_id: str) -> VideoRow | None:
        return self.videos.get(video_id)

    def publication(self, video_id: str) -> PublicationRow | None:
        return self.pubs.get(video_id)

    def revision(self, revision_id: str) -> RevisionRow | None:
        return self.revs.get(revision_id)

    def source(self, video_id: str) -> SourceRow | None:
        return self.sources.get(video_id)

    def put_video(self, row: VideoRow) -> None:
        self.videos[row.video_id] = row

    def put_publication(self, row: PublicationRow) -> None:
        self.pubs[row.video_id] = row

    def put_revision(self, row: RevisionRow) -> None:
        self.revs[row.revision_id] = row

    def put_source(self, row: SourceRow) -> None:
        self.sources[row.video_id] = row


class MySQLPublication(PublicationStore):
    def __init__(self, url: str) -> None:
        self.url = url

    def _conn(self):
        import pymysql
        from urllib.parse import urlparse

        parsed = urlparse(self.url)
        if parsed.scheme not in {"mysql", "mysql+pymysql"}:
            raise RuntimeError("publication URL must be mysql")
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

    def _one(self, sql: str, args: tuple) -> dict | None:
        conn = self._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(sql, args)
                row = cur.fetchone()
            return row
        finally:
            conn.close()

    def video(self, video_id: str) -> VideoRow | None:
        row = self._one(
            "SELECT id, `public`, password IS NOT NULL AS has_password, bucket FROM videos WHERE id=%s",
            (video_id,),
        )
        if row is None:
            return None
        return VideoRow(row["id"], bool(row["public"]), bool(row["has_password"]), row.get("bucket"))

    def publication(self, video_id: str) -> PublicationRow | None:
        row = self._one(
            "SELECT videoId, currentRevisionId, generation, publicationEpoch, policyEpoch "
            "FROM video_publication WHERE videoId=%s",
            (video_id,),
        )
        if row is None:
            return None
        return PublicationRow(
            row["videoId"],
            row["currentRevisionId"],
            int(row["generation"]),
            int(row["publicationEpoch"]),
            int(row["policyEpoch"]),
        )

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
