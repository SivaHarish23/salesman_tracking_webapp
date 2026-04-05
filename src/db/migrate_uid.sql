-- Migration: Add uid column for batch deduplication
-- Run this on existing databases that already have the location_logs table.
-- Safe to run multiple times (IF NOT EXISTS / IF EXISTS guards).

ALTER TABLE location_logs ADD COLUMN IF NOT EXISTS uid VARCHAR(64);

-- Create unique index on uid (only for non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS idx_location_logs_uid ON location_logs(uid) WHERE uid IS NOT NULL;
