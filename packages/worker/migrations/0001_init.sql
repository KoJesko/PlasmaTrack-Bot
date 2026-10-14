-- Webhook/event dedupe: a key is claimed once until it expires.
CREATE TABLE dedupe (
  key        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX dedupe_expires ON dedupe (expires_at);

-- Notices that could not be sent as a DM. They reveal a player's Invalid,
-- penalty or revocation status, so every query is scoped to one Discord user
-- and they are only ever shown ephemerally to that user.
CREATE TABLE notices (
  discord_user_id TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  text            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  read_at         INTEGER,
  PRIMARY KEY (discord_user_id, id)
);
CREATE INDEX notices_unread ON notices (discord_user_id, read_at, created_at);
CREATE INDEX notices_expires ON notices (expires_at);
