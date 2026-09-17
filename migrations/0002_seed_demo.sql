-- Seeds the local owner plus a demo site so `/demo` works on a fresh database.
-- The demo public key is intentionally fixed and non-secret: a public key only
-- identifies which site a report belongs to, it grants no read access.
INSERT OR IGNORE INTO owners (id, provider, external_id, email, created_at)
VALUES ('own_local', 'local', 'admin', NULL, 0);

INSERT OR IGNORE INTO sites (id, owner_id, name, public_key, webhook_url, created_at)
VALUES ('site_demo', 'own_local', 'Demo site', 'pk_demo_local_only', NULL, 0);
