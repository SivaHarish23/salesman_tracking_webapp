require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./src/config/db');

const authRoutes = require('./src/routes/auth');
const salesmanRoutes = require('./src/routes/salesman');
const adminRoutes = require('./src/routes/admin');

const app = express();
app.set('trust proxy', 1);

// Port defaults to 10000 (Render's expected default); override via PORT env var
const PORT = process.env.PORT || 10000;
const STALE_SESSION_HOURS = 24;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Validate critical env vars on startup
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET must be set and at least 16 characters');
  process.exit(1);
}
console.log('[BOOT] Environment validated successfully');

// CORS: restrict origins in production
const corsOptions = process.env.CORS_ORIGIN
  ? { origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()), credentials: true }
  : {};
app.use(cors(corsOptions));
app.use(express.json());

// Structured request logging
app.use((req, res, next) => {
  const start = Date.now();
  const originalEnd = res.end;
  res.end = function (...args) {
    const log = {
      ts: Date.now(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
      userId: req.user?.userId || null,
    };
    // Skip health checks and SSE streams from verbose logging
    if (req.path !== '/api/health' && !req.path.endsWith('/stream')) {
      console.log(JSON.stringify(log));
    }
    originalEnd.apply(res, args);
  };
  next();
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

// Health check with DB connectivity — used by uptime monitors and load balancers
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    console.error('[HEALTH] DB health check failed:', err.message);
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// Salesman API routes (keep after more specific /api/* routes)
app.use('/api', salesmanRoutes);

// 404 for unmatched API routes (prevents falling through to static files)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Serve web admin dashboard
app.use(express.static(path.join(__dirname, 'web')));

// Global error handler — catches all unhandled errors from route handlers
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path} —`, err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Stale session cleanup: close sessions inactive for more than 24 hours
// ---------------------------------------------------------------------------
async function cleanupStaleSessions() {
  console.log('[CLEANUP] Starting stale session cleanup...');
  try {
    // Use checkin coords as checkout coords for stale sessions (satisfies chk_checkout_coords constraint)
    // Parameterized interval to avoid SQL interpolation
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
      console.log(`Cleaned up ${result.rows.length} stale session(s)`);
    }

    // Purge device tokens whose grace period has expired
    const purged = await pool.query(
      `DELETE FROM device_tokens WHERE revoked_at < NOW() - INTERVAL '24 hours' RETURNING id`
    );
    if (purged.rows.length > 0) {
      console.log(`Purged ${purged.rows.length} expired device token(s)`);
    }
  } catch (err) {
    console.error('[CLEANUP] Stale session cleanup error:', err.message);
  }
}

// Start server bound to 0.0.0.0 so it's reachable behind reverse proxies (Render, etc.)
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] Server running on 0.0.0.0:${PORT}`);
  console.log(`[BOOT] keepAliveTimeout=${server.keepAliveTimeout}ms, headersTimeout=${server.headersTimeout}ms`);
  // Run cleanup on startup, then every hour
  cleanupStaleSessions();
  setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
});

// Fix 502 Bad Gateway: keep connections alive longer than the reverse proxy's timeout.
// Most proxies (Render, ALB, nginx) default to ~60s; setting 120s prevents premature closes.
server.keepAliveTimeout = 120000;  // 120 seconds
server.headersTimeout = 120000;    // must be >= keepAliveTimeout
