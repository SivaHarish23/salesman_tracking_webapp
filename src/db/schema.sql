CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    username    VARCHAR(50) UNIQUE NOT NULL,
    password    VARCHAR(255) NOT NULL,
    role        VARCHAR(10) NOT NULL DEFAULT 'salesman',
    is_active   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    checkin_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checkout_time   TIMESTAMPTZ,
    checkin_lat     DOUBLE PRECISION NOT NULL,
    checkin_lng     DOUBLE PRECISION NOT NULL,
    checkout_lat    DOUBLE PRECISION,
    checkout_lng    DOUBLE PRECISION,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT chk_checkout_coords CHECK (
        (checkout_time IS NULL AND checkout_lat IS NULL AND checkout_lng IS NULL) OR
        (checkout_time IS NOT NULL AND checkout_lat IS NOT NULL AND checkout_lng IS NOT NULL)
    )
);

-- Partial unique index: only one active session per user (prevents race condition duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_session
    ON sessions(user_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS location_logs (
    id          SERIAL PRIMARY KEY,
    session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    latitude    DOUBLE PRECISION NOT NULL,
    longitude   DOUBLE PRECISION NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uid         VARCHAR(64),
    CONSTRAINT chk_latitude CHECK (latitude >= -90 AND latitude <= 90),
    CONSTRAINT chk_longitude CHECK (longitude >= -180 AND longitude <= 180)
);

CREATE INDEX IF NOT EXISTS idx_location_logs_session ON location_logs(session_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_location_logs_user ON location_logs(user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, is_active);

-- Partial unique index: dedup batch-synced points by uid (only non-NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_location_logs_uid ON location_logs(uid) WHERE uid IS NOT NULL;
