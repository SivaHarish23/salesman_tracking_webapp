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
  connectionTimeoutMillis: 30000,
  statement_timeout: 15000,
  query_timeout: 15000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

pool.on('connect', () => {
  const { totalCount, idleCount, waitingCount } = pool;
  console.log(`[DB] New connection opened | total=${totalCount} idle=${idleCount} waiting=${waitingCount}`);
});

pool.on('remove', () => {
  const { totalCount, idleCount, waitingCount } = pool;
  console.log(`[DB] Connection removed | total=${totalCount} idle=${idleCount} waiting=${waitingCount}`);
});

// Keep the free-tier DB awake by pinging it every 4 minutes.
// Render free Postgres sleeps after ~15 min of inactivity; this prevents that.
const KEEP_ALIVE_MS = 4 * 60 * 1000;
let keepAliveTimer;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    const start = Date.now();
    try {
      await pool.query('SELECT 1');
      const ms = Date.now() - start;
      if (ms > 2000) {
        console.warn(`[DB] Keep-alive slow: ${ms}ms (possible DB wake-up)`);
      }
    } catch (err) {
      console.error(`[DB] Keep-alive FAILED after ${Date.now() - start}ms:`, err.message);
    }
  }, KEEP_ALIVE_MS);
  keepAliveTimer.unref();
}

function getPoolStats() {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

// Warm up the DB connection on startup with retries
(async () => {
  const maxRetries = 5;
  for (let i = 1; i <= maxRetries; i++) {
    const start = Date.now();
    try {
      await pool.query('SELECT 1');
      console.log(`[DB] Connection established in ${Date.now() - start}ms`);
      startKeepAlive();
      return;
    } catch (err) {
      console.warn(`[DB] Connection attempt ${i}/${maxRetries} failed after ${Date.now() - start}ms: ${err.message}`);
      if (i < maxRetries) await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('[DB] Could not connect after retries — queries will retry on demand');
  startKeepAlive();
})();

module.exports = pool;
module.exports.getPoolStats = getPoolStats;
