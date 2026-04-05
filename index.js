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
const PORT = process.env.PORT || 3000;
const STALE_SESSION_HOURS = 24;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

// Validate critical env vars on startup
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET must be set and at least 16 characters');
  process.exit(1);
}

// CORS: restrict origins in production
const corsOptions = process.env.CORS_ORIGIN
  ? { origin: process.env.CORS_ORIGIN.split(',').map(s => s.trim()), credentials: true }
  : {};
app.use(cors(corsOptions));
app.use(express.json());

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

// Health check with DB connectivity
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
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

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Stale session cleanup: close sessions inactive for more than 24 hours
// ---------------------------------------------------------------------------
async function cleanupStaleSessions() {
  try {
    const result = await pool.query(
      `UPDATE sessions SET checkout_time = NOW(), is_active = false
       WHERE is_active = true
         AND checkin_time < NOW() - INTERVAL '${STALE_SESSION_HOURS} hours'
       RETURNING user_id`
    );
    if (result.rows.length > 0) {
      const userIds = result.rows.map(r => r.user_id);
      await pool.query(
        `UPDATE users SET is_active = false WHERE id = ANY($1::int[])`,
        [userIds]
      );
      console.log(`Cleaned up ${result.rows.length} stale session(s)`);
    }
  } catch (err) {
    console.error('Stale session cleanup error:', err.message);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on 0.0.0.0:${PORT}`);
  // Run cleanup on startup, then every hour
  cleanupStaleSessions();
  setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
});
