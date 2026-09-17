-- Per-site submission caps. NULL means "use the built-in default" (30/hour,
-- 200/day) rather than "no limit", so clearing an override restores the
-- default instead of silently disabling protection.
ALTER TABLE sites ADD COLUMN hourly_cap INTEGER;
ALTER TABLE sites ADD COLUMN daily_cap INTEGER;
