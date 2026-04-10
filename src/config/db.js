const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL must be set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  // Render free-tier Postgres can take 15-30s to wake from sleep; 30s avoids cold-start timeouts
  connectionTimeoutMillis: 30000,
});

// Log pool-level errors (e.g. idle client disconnects) so they don't go silent
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Warm up the DB connection on startup with retries (handles cold-start delay)
(async () => {
  const maxRetries = 5;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log('[DB] Connection established');
      return;
    } catch (err) {
      console.warn(`[DB] Connection attempt ${i}/${maxRetries} failed: ${err.message}`);
      if (i < maxRetries) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('[DB] Could not connect after retries — queries will retry on demand');
})();

module.exports = pool;
