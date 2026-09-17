-- Per-site webhook signing secret. Nullable: sites created before this
-- migration keep working (unsigned) until their owner generates one.
ALTER TABLE sites ADD COLUMN webhook_secret TEXT;

-- GitHub login, kept alongside the existing (provider, external_id) identity so
-- the dashboard can show who is signed in without another API call.
ALTER TABLE owners ADD COLUMN login TEXT;
