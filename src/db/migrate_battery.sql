-- Add battery percentage to location logs
ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS battery_pct SMALLINT;
