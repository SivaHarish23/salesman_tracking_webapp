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

function validateCoords(latitude, longitude) {
  if (latitude == null || longitude == null) return 'latitude and longitude required';
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return 'latitude and longitude must be numbers';
  if (!isFinite(latitude) || !isFinite(longitude)) return 'Invalid coordinates';
  if (latitude < -90 || latitude > 90) return 'latitude must be between -90 and 90';
  if (longitude < -180 || longitude > 180) return 'longitude must be between -180 and 180';
  return null;
}

router.post('/checkin', async (req, res) => {
  const connectStart = Date.now();
  const client = await pool.connect();
  const connectMs = Date.now() - connectStart;
  if (connectMs > 2000) {
    console.warn(`[SALESMAN] Slow pool.connect for checkin: ${connectMs}ms | user=${req.user.userId}`);
  }
  try {
    const { latitude, longitude, device_platform, device_model, os_version, app_version } = req.body;
    const coordError = validateCoords(latitude, longitude);
    if (coordError) return res.status(400).json({ error: coordError });

    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_active = true FOR UPDATE',
      [req.user.userId]
    );
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Already checked in. Check out first.' });
    }

    const sessionResult = await client.query(
      `INSERT INTO sessions (user_id, checkin_lat, checkin_lng, device_platform, device_model, os_version, app_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.user.userId, latitude, longitude,
        (device_platform || '').slice(0, 10) || null,
        (device_model || '').slice(0, 100) || null,
        (os_version || '').slice(0, 50) || null,
        (app_version || '').slice(0, 20) || null,
      ]
    );
    const session = sessionResult.rows[0];

    await client.query(
      `INSERT INTO location_logs (session_id, user_id, latitude, longitude)
       VALUES ($1, $2, $3, $4)`,
      [session.id, req.user.userId, latitude, longitude]
    );

    await client.query('UPDATE users SET is_active = true WHERE id = $1', [req.user.userId]);

    await client.query('COMMIT');
    res.json({ session });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && err.constraint === 'idx_unique_active_session') {
      return res.status(409).json({ error: 'Already checked in. Check out first.' });
    }
    console.error(`[SALESMAN] Checkin error for user=${req.user.userId}:`, err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/checkout', async (req, res) => {
  const connectStart = Date.now();
  const client = await pool.connect();
  const connectMs = Date.now() - connectStart;
  if (connectMs > 2000) {
    console.warn(`[SALESMAN] Slow pool.connect for checkout: ${connectMs}ms | user=${req.user.userId}`);
  }
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

    const sessionResult = await client.query(
      `UPDATE sessions SET checkout_time = NOW(), checkout_lat = $1, checkout_lng = $2, is_active = false
       WHERE id = $3 RETURNING *`,
      [latitude, longitude, sessionId]
    );

    await client.query(
      `INSERT INTO location_logs (session_id, user_id, latitude, longitude)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, req.user.userId, latitude, longitude]
    );

    await client.query('UPDATE users SET is_active = false WHERE id = $1', [req.user.userId]);

    await client.query('COMMIT');
    res.json({ session: sessionResult.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[SALESMAN] Checkout error for user=${req.user.userId}:`, err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

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
    console.error(`[SALESMAN] Location error for user=${req.user.userId}:`, err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/location/batch', batchLocationLimiter, async (req, res) => {
  const connectStart = Date.now();
  const client = await pool.connect();
  const connectMs = Date.now() - connectStart;
  if (connectMs > 2000) {
    console.warn(`[SALESMAN] Slow pool.connect for batch: ${connectMs}ms | user=${req.user.userId}`);
  }
  try {
    const { points } = req.body;
    if (!Array.isArray(points) || points.length === 0) {
      return res.status(400).json({ error: 'points array required' });
    }
    if (points.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_SIZE} points per batch` });
    }

    const session = await client.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );
    if (session.rows.length === 0) {
      client.release();
      return res.status(409).json({ error: 'No active session. Check in first.' });
    }
    const sessionId = session.rows[0].id;

    const now = new Date();
    const validPoints = [];
    const rejections = [];
    for (const pt of points) {
      const { uid, latitude, longitude, recorded_at } = pt;

      if (!uid || typeof uid !== 'string' || uid.length > MAX_UID_LENGTH) {
        rejections.push({ uid: uid || null, reason: 'bad_uid', type: typeof uid });
        continue;
      }

      const lat = typeof latitude === 'number' ? latitude : parseFloat(latitude);
      const lng = typeof longitude === 'number' ? longitude : parseFloat(longitude);
      const coordError = validateCoords(lat, lng);
      if (coordError) {
        rejections.push({ uid, reason: 'bad_coords', detail: coordError });
        continue;
      }

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

      let battery = null;
      if (pt.battery_pct != null) {
        const b = parseInt(pt.battery_pct);
        if (!isNaN(b) && b >= 0 && b <= 100) battery = b;
      }

      validPoints.push({ uid, latitude: lat, longitude: lng, ts, battery });
    }

    let inserted = 0;
    const insertErrors = [];
    if (validPoints.length > 0) {
      await client.query('BEGIN');
      for (let i = 0; i < validPoints.length; i++) {
        const { uid, latitude, longitude, ts, battery } = validPoints[i];
        const sp = `sp_${i}`;
        try {
          await client.query(`SAVEPOINT ${sp}`);
          await client.query(
            `INSERT INTO location_logs (session_id, user_id, latitude, longitude, recorded_at, uid, battery_pct)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (uid) WHERE uid IS NOT NULL DO NOTHING`,
            [sessionId, req.user.userId, latitude, longitude, ts.toISOString(), uid, battery]
          );
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          inserted++;
        } catch (e) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
          insertErrors.push({ uid, error: e.message });
        }
      }
      await client.query('COMMIT');
    }

    const totalMs = Date.now() - connectStart;
    if (totalMs > 5000) {
      console.warn(`[SALESMAN] Slow batch: user=${req.user.userId} points=${points.length} inserted=${inserted} ${totalMs}ms`);
    }

    res.json({ ok: true, inserted, total: points.length, validated: validPoints.length, rejections, insertErrors });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[SALESMAN] Batch error for user=${req.user.userId}:`, err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.get('/sessions/history', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT s.id, s.checkin_time, s.checkout_time, s.is_active,
              s.device_model, s.device_platform,
              COUNT(l.id)::int AS point_count
       FROM sessions s
       LEFT JOIN location_logs l ON l.session_id = s.id
       WHERE s.user_id = $1
       GROUP BY s.id
       ORDER BY s.checkin_time DESC
       LIMIT $2 OFFSET $3`,
      [req.user.userId, limit, offset]
    );
    res.json({ sessions: result.rows, page, limit });
  } catch (err) {
    console.error(`[SALESMAN] Session history error for user=${req.user.userId}:`, err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

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
      'SELECT latitude, longitude, recorded_at, battery_pct FROM location_logs WHERE session_id = $1 ORDER BY recorded_at ASC',
      [session.id]
    );

    res.json({ session, locations: locations.rows });
  } catch (err) {
    console.error(`[SALESMAN] Current session error for user=${req.user.userId}:`, err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/session/:id', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    if (isNaN(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const sessionResult = await pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
      [sessionId, req.user.userId]
    );
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionResult.rows[0];
    const locations = await pool.query(
      'SELECT latitude, longitude, recorded_at, battery_pct FROM location_logs WHERE session_id = $1 ORDER BY recorded_at ASC',
      [session.id]
    );
    res.json({ session, locations: locations.rows });
  } catch (err) {
    console.error(`[SALESMAN] Session detail error for user=${req.user.userId}:`, err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
