-- Webhook delivery health. `webhook_failures` counts *consecutive* failures and
-- resets on any success; `webhook_disabled_at` is set when it reaches the limit,
-- so a dead endpoint stops being a standing outbound request generator.
ALTER TABLE sites ADD COLUMN webhook_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN webhook_disabled_at INTEGER;
ALTER TABLE sites ADD COLUMN webhook_verified_at INTEGER;
