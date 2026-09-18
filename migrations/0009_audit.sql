-- Append-only record of administrative and destructive actions.
--
-- Deliberately never stores report content: the log answers "who did what to
-- which record", and copying feedback text into it would create a second place
-- a visitor's words live, with its own retention and its own leak surface.
CREATE TABLE audit (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  actor       TEXT NOT NULL,   -- owner id, 'admin-api', or 'cron'
  action      TEXT NOT NULL,
  target_type TEXT,            -- 'site' | 'report' | 'deployment'
  target_id   TEXT,
  site_id     TEXT,            -- denormalised so an owner can read their own log
  ip_hash     TEXT,            -- bucketed + hashed, never a raw address
  detail      TEXT             -- small JSON, no report content
);
CREATE INDEX audit_site_ts ON audit (site_id, ts DESC);
CREATE INDEX audit_ts ON audit (ts);
