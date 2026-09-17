-- Optional per-site Origin lock. NULL or empty means "any origin", which is the
-- MVP behaviour and must stay the default: turning this on by default would
-- break every existing embed the moment it shipped.
ALTER TABLE sites ADD COLUMN allowed_origins TEXT;
