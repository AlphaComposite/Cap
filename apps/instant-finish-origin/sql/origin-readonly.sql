-- Integrator applies this on a disposable database. Do not run it against production.
-- The origin credential is SELECT-only on the publication projection.

CREATE USER IF NOT EXISTS 'cap_origin_ro'@'%' IDENTIFIED BY 'replace-me';
GRANT SELECT ON cap.video_publication TO 'cap_origin_ro'@'%';
GRANT SELECT ON cap.edit_revision TO 'cap_origin_ro'@'%';
GRANT SELECT ON cap.videos TO 'cap_origin_ro'@'%';
GRANT SELECT ON cap.source_object TO 'cap_origin_ro'@'%';
FLUSH PRIVILEGES;
