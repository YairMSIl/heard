-- Small key/value table for facts about the deployment itself rather than about
-- anyone's feedback. First use: proving the retention cron actually runs, which
-- nothing outside the Worker could otherwise observe.
CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
