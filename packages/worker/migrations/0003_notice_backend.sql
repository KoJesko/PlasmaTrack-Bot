-- Notices now belong to one PlasmaTrack backend (each Discord server has its
-- own), so /notices in a server shows only that server's notices. Rows from
-- before this change came from the only backend there was.
ALTER TABLE notices ADD COLUMN backend TEXT NOT NULL DEFAULT 'production';
DROP INDEX notices_unread;
CREATE INDEX notices_unread ON notices (discord_user_id, backend, read_at, created_at);
