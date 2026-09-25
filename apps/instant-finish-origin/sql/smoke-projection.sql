-- Disposable projection for capwire-b-origin smoke only. Not a production migration.
CREATE TABLE IF NOT EXISTS videos (
  id varchar(64) NOT NULL PRIMARY KEY,
  `public` tinyint(1) NOT NULL,
  password text NULL,
  bucket varchar(64) NULL
);
CREATE TABLE IF NOT EXISTS video_publication (
  videoId varchar(64) NOT NULL PRIMARY KEY,
  currentRevisionId varchar(128) NULL,
  generation int NOT NULL,
  publicationEpoch int NOT NULL,
  policyEpoch int NOT NULL
);
CREATE TABLE IF NOT EXISTS edit_revision (
  revisionId varchar(128) NOT NULL PRIMARY KEY,
  videoId varchar(64) NOT NULL,
  intentId varchar(128) NOT NULL,
  sourceId varchar(128) NOT NULL,
  generation int NOT NULL,
  state varchar(32) NOT NULL
);
CREATE TABLE IF NOT EXISTS source_object (
  videoId varchar(64) NOT NULL PRIMARY KEY,
  liveKey varchar(512) NOT NULL,
  sha256 char(64) NOT NULL,
  relocationState varchar(32) NOT NULL
);
