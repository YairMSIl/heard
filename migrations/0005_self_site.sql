-- Heard's own feedback site, so Heard is used to collect feedback about Heard.
--
-- Owned by the GitHub owner when that row exists (the real case in production,
-- created when @YairMSIl signed in), falling back to the local operator so a
-- fresh database — a new clone, a local dev setup — still gets a working self
-- site instead of a failed migration.
--
-- The key is generated here rather than hardcoded: it is a real site, and every
-- deployment should get its own. Guarded by NOT EXISTS so re-running is a no-op.
INSERT INTO sites (id, owner_id, name, public_key, webhook_url, webhook_secret, created_at)
SELECT
  'site_self',
  COALESCE((SELECT id FROM owners WHERE provider = 'github' AND login = 'YairMSIl'), 'own_local'),
  'Heard (self)',
  'pk_' || lower(hex(randomblob(12))),
  NULL,
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (SELECT 1 FROM sites WHERE id = 'site_self');
