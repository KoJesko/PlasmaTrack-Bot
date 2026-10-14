-- Moderator-issued tokens waiting for their player (server ADMIN_API §10).
-- Holds who issued it and why, never a token.
CREATE TABLE token_grants (
  id              TEXT    PRIMARY KEY,
  backend         TEXT    NOT NULL,
  discord_user_id TEXT    NOT NULL,
  moderator_id    TEXT    NOT NULL,
  reason          TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);
CREATE INDEX token_grants_pending ON token_grants (discord_user_id, backend, used_at, expires_at);
CREATE INDEX token_grants_expires ON token_grants (expires_at);

-- Which review-channel message shows which job.
CREATE TABLE review_posts (
  backend    TEXT NOT NULL,
  job_id     TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (backend, job_id, channel_id)
);
