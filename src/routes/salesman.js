const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { locationLimiter, batchLocationLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.use(authenticate, requireRole('salesman'));

const MAX_BATCH_SIZE = 100;
const MAX_POINT_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 60000;
const MAX_UID_LENGTH = 64;

// Validate lat/lng values
function validateCoords(latitude, longitude) {
  if (latitude == null || longitude == null) return 'latitude and longitude required';
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return 'latitude and longitude must be numbers';
  if (!isFinite(latitude) || !isFinite(longitude)) return 'Invalid coordinates';
  if (latitude < -90 || latitude > 90) return 'latitude must be between -90 and 90';
  if (longitude < -180 || longitude > 180) return 'longitude must be between -180 and 180';
  return null;
}

// Check in - start a new session
router.post('/checkin', async (req, res) => {
  const client = await pool.connect();
  try {
    const { latitude, longitude } = req.body;
    const coordError = validateCoords(latitude, longitude);
    if (coordError) return res.status(400).json({ error: coordError });

    // Begin transaction BEFORE the check to prevent race condition
    await client.query('BEGIN');

    // Lock user row to prevent concurrent checkins
    const existing = await client.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_active = true FOR UPDATE',
      [req.user.userId]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already checked in. Check out first.' });
    }

    // Create session
    const sessionResult = await client.query(
      `INSERT INTO sessions (user_id, checkin_lat, checkin_lng)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.userId, latitude, longitude]
    );
    const session = sessionResult.rows[0];

    // Insert first location log
    await client.query(
      `INSERT INTO location_logs (session_id, user_id, latitude, longitude)
       VALUES ($1, $2, $3, $4)`,
      [session.id, req.user.userId, latitude, longitude]
    );

    // Mark user as active
    await client.query('UPDATE users SET is_active = true WHERE id = $1', [req.user.userId]);

    await client.query('COMMIT');
    res.json({ session });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Handle unique constraint violation (race condition fallback)
    if (err.code === '23505' && err.constraint === 'idx_unique_active_session') {
      return res.status(409).json({ error: 'Already checked in. Check out first.' });
    }
    console.error('Checkin error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Check out - end current session
router.post('/checkout', async (req, res) => {
  const client = await pool.connect();
  try {
    const { latitude, longitude } = req.body;
    const coordError = validateCoords(latitude, longitude);
    if (coordError) return res.status(400).json({ error: coordError });

    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_active = true FOR UPDATE',
      [req.user.userId]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Not checked in' });
    }

    const sessionId = existing.rows[0].id;

    // Update session with checkout data
    const sessionResult = await client.query(
      `UPDATE sessions SET checkout_time = NOW(), checkout_lat = $1, checkout_lng = $2, is_active = false
       WHERE id = $3 RETURNING *`,
      [latitude, longitude, sessionId]
    );

    // Insert final location log
    await client.query(
      `INSERT INTO location_logs (session_id, user_id, latitude, longitude)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, req.user.userId, latitude, longitude]
    );

    // Mark user as inactive
    await client.query('UPDATE users SET is_active = false WHERE id = $1', [req.user.userId]);

    await client.query('COMMIT');
    res.json({ session: sessionResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Send location update
router.post('/location', locationLimiter, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const coordError = validateCoords(latitude, longitude);
    if (coordError) return res.status(400).json({ error: coordError });

    const session = await pool.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );
    if (session.rows.length === 0) {
      return res.status(409).json({ error: 'No active session. Check in first.' });
    }

    await pool.query(
      `INSERT INTO location_logs (session_id, user_id, latitude, longitude)
       VALUES ($1, $2, $3, $4)`,
      [session.rows[0].id, req.user.userId, latitude, longitude]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Location error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Batch location upload (SQLite local-first sync)
router.post('/location/batch', batchLocationLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { points } = req.body;
    if (!Array.isArray(points) || points.length === 0) {
      return res.status(400).json({ error: 'points array required' });
    }
    if (points.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_SIZE} points per batch` });
    }

    // Look up active session
    const session = await client.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );
    if (session.rows.length === 0) {
      return res.status(409).json({ error: 'No active session. Check in first.' });
    }
    const sessionId = session.rows[0].id;

    const now = new Date();

    // Validate and collect all valid points first
    const validPoints = [];
    const rejections = [];
    for (const pt of points) {
      const { uid, latitude, longitude, recorded_at } = pt;

      // Validate uid
      if (!uid || typeof uid !== 'string' || uid.length > MAX_UID_LENGTH) {
        rejections.push({ uid: uid || null, reason: 'bad_uid', type: typeof uid });
        continue;
      }

      // Validate coords
      const lat = typeof latitude === 'number' ? latitude : parseFloat(latitude);
      const lng = typeof longitude === 'number' ? longitude : parseFloat(longitude);
      const coordError = validateCoords(lat, lng);
      if (coordError) {
        rejections.push({ uid, reason: 'bad_coords', detail: coordError });
        continue;
      }

      // Validate recorded_at timestamp (must be within 24h and not in the future)
      let ts;
      try {
        ts = new Date(recorded_at);
        if (isNaN(ts.getTime())) {
          rejections.push({ uid, reason: 'invalid_date', recorded_at });
          continue;
        }
        if (ts > new Date(now.getTime() + FUTURE_TOLERANCE_MS)) {
          rejections.push({ uid, reason: 'future', ts: ts.toISOString(), now: now.toISOString() });
          continue;
        }
        if (now - ts > MAX_POINT_AGE_MS) {
          rejections.push({ uid, reason: 'too_old', ts: ts.toISOString(), now: now.toISOString(), ageMs: now - ts });
          continue;
        }
      } catch (e) {
        rejections.push({ uid, reason: 'date_exception', error: e.message });
        continue;
      }

      validPoints.push({ uid, latitude: lat, longitude: lng, ts });
    }
    console.log(`[BATCH] user=${req.user.userId}: ${validPoints.length}/${points.length} valid, rejections:`, rejections);

    // Insert all valid points in a single transaction
    let inserted = 0;
    const insertErrors = [];
    if (validPoints.length > 0) {
      await client.query('BEGIN');
      for (const { uid, latitude, longitude, ts } of validPoints) {
        try {
          await client.query(
            `INSERT INTO location_logs (session_id, user_id, latitude, longitude, recorded_at, uid)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (uid) WHERE uid IS NOT NULL DO NOTHING`,
            [sessionId, req.user.userId, latitude, longitude, ts.toISOString(), uid]
          );
          inserted++;
        } catch (e) {
          insertErrors.push({ uid, error: e.message });
        }
      }
      await client.query('COMMIT');
    }

    res.json({ ok: true, inserted, total: points.length, validated: validPoints.length, rejections, insertErrors });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Batch location error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Get current active session with route
router.get('/session/current', async (req, res) => {
  try {
    const sessionResult = await pool.query(
      'SELECT * FROM sessions WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.json({ session: null, locations: [] });
    }

    const session = sessionResult.rows[0];
    const locations = await pool.query(
      'SELECT latitude, longitude, recorded_at FROM location_logs WHERE session_id = $1 ORDER BY recorded_at ASC',
      [session.id]
    );

    res.json({ session, locations: locations.rows });
  } catch (err) {
    console.error('Session error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
