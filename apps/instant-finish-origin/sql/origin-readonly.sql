-- Integrator applies this on a disposable database. Do not run it against production.
-- The origin credential is SELECT-only. It never receives videos.password.
-- Password presence is exposed by origin_video (SQL SECURITY DEFINER), not by a column grant.

CREATE OR REPLACE SQL SECURITY DEFINER VIEW origin_video AS
SELECT id,
       `public` AS is_public,
       (password IS NOT NULL) AS has_password,
       bucket
FROM videos;

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
FLUSH PRIVILEGES;
