-- Add device info columns to sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_platform VARCHAR(10);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_model VARCHAR(100);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS os_version VARCHAR(50);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS app_version VARCHAR(20);
