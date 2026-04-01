CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    username    VARCHAR(50) UNIQUE NOT NULL,
    password    VARCHAR(255) NOT NULL,
    role        VARCHAR(10) NOT NULL DEFAULT 'salesman',
    is_active   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
    checkin_time    TIMESTAMP NOT NULL DEFAULT NOW(),
    checkout_time   TIMESTAMP,
    checkin_lat     DOUBLE PRECISION NOT NULL,
    checkin_lng     DOUBLE PRECISION NOT NULL,
    checkout_lat    DOUBLE PRECISION,
    checkout_lng    DOUBLE PRECISION,
    is_active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS location_logs (
    id          SERIAL PRIMARY KEY,
    session_id  INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    latitude    DOUBLE PRECISION NOT NULL,
    longitude   DOUBLE PRECISION NOT NULL,
    recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_logs_session ON location_logs(session_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_location_logs_user ON location_logs(user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, is_active);
