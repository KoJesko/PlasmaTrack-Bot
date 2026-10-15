-- Slash commands per user per fixed time window (core RateLimiter).
-- Old windows are deleted by the daily cron.
CREATE TABLE rate_limits (
  key          TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);
