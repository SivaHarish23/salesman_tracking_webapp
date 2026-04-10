require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./src/config/db');
const { getPoolStats } = require('./src/config/db');

const authRoutes = require('./src/routes/auth');
const salesmanRoutes = require('./src/routes/salesman');
const adminRoutes = require('./src/routes/admin');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 10000;
const STALE_SESSION_HOURS = 24;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 25000;
const SLOW_REQUEST_MS = 5000;
const POOL_LOG_INTERVAL_MS = 5 * 60 * 1000;

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET must be set and at least 16 characters');
  process.exit(1);
}
console.log('[BOOT] Environment validated successfully');

const corsOptions = process.env.CORS_ORIGIN
  ? { origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()), credentials: true }
  : {};
app.use(cors(corsOptions));
app.use(express.json());

// Request-level timeout: kill hanging requests before Render's proxy does (which causes 502)
app.use((req, res, next) => {
  if (req.path.endsWith('/stream')) return next();
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      const stats = getPoolStats();
      console.error(`[TIMEOUT] ${req.method} ${req.path} exceeded ${REQUEST_TIMEOUT_MS}ms | pool: total=${stats.total} idle=${stats.idle} waiting=${stats.waiting} | userId=${req.user?.userId || 'anon'}`);
      res.status(504).json({ error: 'Request timed out' });
    }
  }, REQUEST_TIMEOUT_MS);
  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));
  next();
});

// Structured request logging with slow-request detection
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function (...args) {
    const ms = Date.now() - start;
    const log = {
      ts: Date.now(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms,
      userId: req.user?.userId || null,
    };
    if (req.path !== '/api/health' && !req.path.endsWith('/stream')) {
      if (ms > SLOW_REQUEST_MS) {
        const stats = getPoolStats();
        log.slow = true;
        log.pool = stats;
        console.warn('[SLOW]', JSON.stringify(log));
      } else {
        console.log(JSON.stringify(log));
      }
    }
    originalEnd.apply(res, args);
  };
  next();
});

// Lightweight liveness check — always returns 200 even if DB is slow,
// so Render doesn't restart the service during DB cold starts.
app.get('/api/health', async (req, res) => {
  const stats = getPoolStats();
  const result = { status: 'ok', uptime: process.uptime(), pool: stats, mem: process.memoryUsage().rss };
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    result.db = 'connected';
    result.dbLatencyMs = Date.now() - dbStart;
  } catch (err) {
    result.db = 'slow_or_disconnected';
    result.dbError = err.message;
  }
  res.json(result);
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', salesmanRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.use(express.static(path.join(__dirname, 'web')));

app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path} —`, err.stack || err.message);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Stale session cleanup
// ---------------------------------------------------------------------------
async function cleanupStaleSessions() {
  const start = Date.now();
  console.log('[CLEANUP] Starting stale session cleanup...');
  try {
    const result = await pool.query(
      `UPDATE sessions SET checkout_time = NOW(), checkout_lat = checkin_lat, checkout_lng = checkin_lng, is_active = false
       WHERE is_active = true
         AND checkin_time < NOW() - make_interval(hours => $1)
       RETURNING user_id`,
      [STALE_SESSION_HOURS]
    );
    if (result.rows.length > 0) {
      const userIds = result.rows.map(r => r.user_id);
      await pool.query(
        `UPDATE users SET is_active = false WHERE id = ANY($1::int[])`,
        [userIds]
      );
      console.log(`[CLEANUP] Cleaned up ${result.rows.length} stale session(s) in ${Date.now() - start}ms`);
    }

  } catch (err) {
    console.error(`[CLEANUP] Error after ${Date.now() - start}ms:`, err.message);
  }
}

// Periodic pool health snapshot — surfaces pool exhaustion before it causes 502s
setInterval(() => {
  const stats = getPoolStats();
  const mem = process.memoryUsage();
  console.log(`[POOL] total=${stats.total} idle=${stats.idle} waiting=${stats.waiting} | rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
  if (stats.waiting > 0) {
    console.warn(`[POOL] WARNING: ${stats.waiting} queries waiting for a connection — possible pool exhaustion`);
  }
}, POOL_LOG_INTERVAL_MS);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] Server running on 0.0.0.0:${PORT}`);
  console.log(`[BOOT] NODE_ENV=${process.env.NODE_ENV} keepAliveTimeout=${server.keepAliveTimeout}ms headersTimeout=${server.headersTimeout}ms`);
  cleanupStaleSessions();
  setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
});

// CRITICAL: headersTimeout MUST be strictly greater than keepAliveTimeout.
// When they're equal, Node.js can destroy connections that Render's proxy
// still considers alive, causing 502 Bad Gateway.
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

// Track active connections for shutdown diagnostics
let activeConnections = 0;
server.on('connection', (socket) => {
  activeConnections++;
  socket.on('close', () => activeConnections--);
});

// Graceful shutdown: let in-flight requests finish before killing the process.
// Render sends SIGTERM during deploys; without this, active requests get 502.
function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received | activeConnections=${activeConnections} | pool=${JSON.stringify(getPoolStats())}`);
  server.close(() => {
    console.log('[SHUTDOWN] HTTP server closed');
    pool.end().then(() => {
      console.log('[SHUTDOWN] DB pool drained');
      process.exit(0);
    });
  });
  setTimeout(() => {
    console.error(`[SHUTDOWN] Forced exit — ${activeConnections} connections still open`);
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.stack || err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
