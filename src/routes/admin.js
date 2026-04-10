const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

const SSE_INTERVAL_MS = 10000;
const SSE_HEARTBEAT_MS = 30000;

// ---------------------------------------------------------------------------
// Shared query helpers (used by both REST & SSE endpoints)
// ---------------------------------------------------------------------------

const USERS_QUERY = `
  SELECT u.id, u.username, u.is_active,
         s.checkin_time AS last_checkin_time,
         s.checkout_time AS last_checkout_time
  FROM users u
  LEFT JOIN LATERAL (
    SELECT checkin_time, checkout_time FROM sessions
    WHERE user_id = u.id ORDER BY checkin_time DESC LIMIT 1
  ) s ON true
  WHERE u.role = 'salesman'
  ORDER BY u.username`;

const LIVE_LOCATIONS_QUERY = `
  SELECT DISTINCT ON (ll.user_id)
         ll.user_id, u.username, ll.latitude, ll.longitude, ll.recorded_at, ll.battery_pct
  FROM location_logs ll
  JOIN users u ON u.id = ll.user_id
  WHERE u.is_active = true
  ORDER BY ll.user_id, ll.recorded_at DESC`;

const SESSION_LOCATIONS_QUERY =
  'SELECT latitude, longitude, recorded_at, battery_pct FROM location_logs WHERE session_id = $1 ORDER BY recorded_at ASC';

async function fetchUserSession(userId, sessionId) {
  let sessionQuery;
  if (sessionId) {
    sessionQuery = await pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );
  } else {
    sessionQuery = await pool.query(
      'SELECT * FROM sessions WHERE user_id = $1 ORDER BY is_active DESC, checkin_time DESC LIMIT 1',
      [userId]
    );
  }

  if (sessionQuery.rows.length === 0) {
    return { session: null, locations: [] };
  }

  const session = sessionQuery.rows[0];
  const locations = await pool.query(SESSION_LOCATIONS_QUERY, [session.id]);
  return { session, locations: locations.rows };
}

// ---------------------------------------------------------------------------
// SSE helper
// ---------------------------------------------------------------------------

const SSE_MAX_DURATION_MS = 5 * 60 * 1000;
const SSE_MAX_ERRORS = 5;
let activeSseCount = 0;

function setupSSE(req, res, fetchData, intervalMs = SSE_INTERVAL_MS) {
  activeSseCount++;
  const sseId = `${req.path}:${Date.now()}`;
  console.log(`[SSE] Opened ${sseId} | active=${activeSseCount}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  let closed = false;
  let consecutiveErrors = 0;

  const send = async () => {
    if (closed) return;
    const start = Date.now();
    try {
      const data = await fetchData();
      const ms = Date.now() - start;
      if (ms > 3000) {
        console.warn(`[SSE] Slow query for ${sseId}: ${ms}ms`);
      }
      if (!closed) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        consecutiveErrors = 0;
      }
    } catch (err) {
      consecutiveErrors++;
      console.warn(`[SSE] Query error (${consecutiveErrors}/${SSE_MAX_ERRORS}) for ${sseId} after ${Date.now() - start}ms:`, err.message);
      if (!closed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Temporary data fetch failure' })}\n\n`);
      }
      if (consecutiveErrors >= SSE_MAX_ERRORS && !closed) {
        console.error(`[SSE] Closing ${sseId} — too many consecutive errors`);
        res.write(`event: close\ndata: ${JSON.stringify({ reason: 'Too many errors, please reconnect' })}\n\n`);
        cleanup();
        res.end();
      }
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeSseCount--;
    clearInterval(interval);
    clearInterval(heartbeat);
    clearTimeout(maxLifeTimer);
    console.log(`[SSE] Closed ${sseId} | active=${activeSseCount}`);
  };

  send();
  const interval = setInterval(send, intervalMs);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, SSE_HEARTBEAT_MS);

  // Force-close long-lived SSE connections to free pool resources.
  // The client should auto-reconnect via EventSource.
  const maxLifeTimer = setTimeout(() => {
    if (!closed) {
      console.log(`[SSE] Max duration reached for ${sseId} — forcing reconnect`);
      res.write(`event: close\ndata: ${JSON.stringify({ reason: 'Connection refresh — please reconnect' })}\n\n`);
      cleanup();
      res.end();
    }
  }, SSE_MAX_DURATION_MS);

  req.on('close', cleanup);
}

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------

router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(USERS_QUERY);
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Admin users error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/locations/live', async (req, res) => {
  try {
    const result = await pool.query(LIVE_LOCATIONS_QUERY);
    res.json({ locations: result.rows });
  } catch (err) {
    console.error('Live locations error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/users/:id/session', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const sessionId = req.query.session_id ? parseInt(req.query.session_id) : null;
    if (req.query.session_id && (isNaN(sessionId) || sessionId <= 0)) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const data = await fetchUserSession(userId, sessionId);
    res.json(data);
  } catch (err) {
    console.error('User session error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/users/:id/sessions', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (isNaN(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const start = Date.now();
    const result = await pool.query(
      `SELECT s.id, s.checkin_time, s.checkout_time, s.is_active,
              s.device_platform, s.device_model, s.os_version,
              COUNT(l.id)::int AS point_count
       FROM sessions s
       LEFT JOIN location_logs l ON l.session_id = s.id
       WHERE s.user_id = $1
       GROUP BY s.id
       ORDER BY s.checkin_time DESC
       LIMIT $2`,
      [userId, limit]
    );
    const ms = Date.now() - start;
    if (ms > 3000) {
      console.warn(`[ADMIN] Slow sessions query: user=${userId} ${ms}ms rows=${result.rows.length}`);
    }
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error(`[ADMIN] User sessions error for user=${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// SSE (Server-Sent Events) endpoints
// ---------------------------------------------------------------------------

router.get('/locations/live/stream', (req, res) => {
  setupSSE(req, res, async () => {
    const [locResult, usersResult] = await Promise.all([
      pool.query(LIVE_LOCATIONS_QUERY),
      pool.query(USERS_QUERY),
    ]);
    return { locations: locResult.rows, users: usersResult.rows };
  });
});

router.get('/users/:id/session/stream', (req, res) => {
  const userId = parseInt(req.params.id);
  if (isNaN(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }

  setupSSE(req, res, () => fetchUserSession(userId, null));
});

module.exports = router;
