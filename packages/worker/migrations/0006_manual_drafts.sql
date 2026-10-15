-- Manual submissions being prepared with /submit (one per player per backend).
-- Holds the typed values and evidence IDs, never image bytes. Expire after an hour.
CREATE TABLE manual_drafts (
  backend    TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  rev        INTEGER NOT NULL,
  job        TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (backend, user_id)
);
CREATE INDEX manual_drafts_expires ON manual_drafts (expires_at);
