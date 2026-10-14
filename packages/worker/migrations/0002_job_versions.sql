-- Highest webhook job_version handled per job. Webhooks are unordered
-- (server WEBHOOKS §3); an event older than one already handled is ignored.
-- Rows are purged a week after their last update (the server retries for 72 h).
CREATE TABLE job_versions (
  job_id     TEXT    PRIMARY KEY,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX job_versions_updated ON job_versions (updated_at);
