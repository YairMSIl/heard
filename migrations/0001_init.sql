-- Heard initial schema.
--
-- `owners` exists from day one even though MVP auth is a single shared admin
-- token: when GitHub OAuth lands, each GitHub user becomes a row here and
-- sites.owner_id already points at it. No migration of site data needed.
CREATE TABLE owners (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL DEFAULT 'local',   -- 'local' | 'github'
  external_id TEXT,                            -- GitHub user id, once OAuth lands
  email       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX owners_provider_external ON owners (provider, external_id);

CREATE TABLE sites (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES owners (id),
  name        TEXT NOT NULL,
  public_key  TEXT NOT NULL UNIQUE,
  webhook_url TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX sites_owner ON sites (owner_id);

CREATE TABLE reports (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL REFERENCES sites (id),
  type       TEXT NOT NULL,                     -- 'bug' | 'idea' | 'praise'
  message    TEXT NOT NULL,
  email      TEXT,
  page_url   TEXT,
  user_agent TEXT,
  viewport   TEXT,
  status     TEXT NOT NULL DEFAULT 'new',       -- 'new' | 'in-progress' | 'done'
  created_at INTEGER NOT NULL
);
CREATE INDEX reports_site_created ON reports (site_id, created_at DESC);
