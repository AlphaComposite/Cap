-- Integrator applies this on a disposable database. Do not run it against production.
-- The origin credential is SELECT-only. It never receives videos.password.
-- Password presence is exposed by origin_video (SQL SECURITY DEFINER), not by a column grant.

CREATE OR REPLACE SQL SECURITY DEFINER VIEW origin_video AS
SELECT id,
       ownerId AS owner_id,
       `public` AS is_public,
       (password IS NOT NULL) AS has_password,
       bucket
FROM videos;

-- Admission facts for live, leased source-prepare jobs only. No payloads,
-- lease tokens, or other job kinds reach the origin credential.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW origin_active_prepare AS
SELECT o.videoId AS video_id,
       JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.ownerId')) AS owner_id,
       JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.sourceObjectKey')) AS source_key
FROM outbox o
WHERE BINARY o.job = BINARY 'source-prepare'
  AND BINARY JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.videoId')) = BINARY o.videoId
  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.finished')), 'false') = 'false'
  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.exhausted')), 'false') = 'false'
  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.peaksOnly')), 'false') = 'false'
  -- UNSIGNED INTEGER: MySQL types large positive JSON numbers that way; still a number compared to now.
  AND JSON_TYPE(JSON_EXTRACT(o.payload, '$.leaseToken')) = 'STRING'
  AND LENGTH(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.leaseToken'))) > 0
  AND JSON_TYPE(JSON_EXTRACT(o.payload, '$.leaseUntilMs')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE')
  AND CAST(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.leaseUntilMs')) AS DECIMAL(20,3))
      > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000;

CREATE USER IF NOT EXISTS 'cap_origin_ro'@'%' IDENTIFIED WITH mysql_native_password BY 'replace-me';
ALTER USER 'cap_origin_ro'@'%' IDENTIFIED WITH mysql_native_password BY 'replace-me';
GRANT SELECT ON origin_video TO 'cap_origin_ro'@'%';
GRANT SELECT (videoId, currentRevisionId, generation, currentGeneration, publicationEpoch, policyEpoch)
  ON video_publication TO 'cap_origin_ro'@'%';
GRANT SELECT (revisionId, videoId, intentId, sourceId, generation, state)
  ON edit_revision TO 'cap_origin_ro'@'%';
GRANT SELECT (videoId, liveKey, sha256, relocationState)
  ON source_object TO 'cap_origin_ro'@'%';
GRANT SELECT (id, videoId, oldKey, newKey, sha256, state)
  ON source_relocation TO 'cap_origin_ro'@'%';
GRANT SELECT ON origin_active_prepare TO 'cap_origin_ro'@'%';
FLUSH PRIVILEGES;
