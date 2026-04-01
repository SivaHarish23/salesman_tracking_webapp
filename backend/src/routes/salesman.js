const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { locationLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.use(authenticate, requireRole('salesman'));

// Check in - start a new session
router.post('/checkin', async (req, res) => {
  const client = await pool.connect();
  try {
    const { latitude, longitude } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: 'latitude and longitude required' });
    }

    // Check if already checked in
    const existing = await client.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Already checked in. Check out first.' });
    }

    await client.query('BEGIN');

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
    await client.query('ROLLBACK');
    console.error('Checkin error:', err);
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
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: 'latitude and longitude required' });
    }

    const existing = await client.query(
      'SELECT id FROM sessions WHERE user_id = $1 AND is_active = true',
      [req.user.userId]
    );
    if (existing.rows.length === 0) {
      return res.status(409).json({ error: 'Not checked in' });
    }

    const sessionId = existing.rows[0].id;
    await client.query('BEGIN');

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
    await client.query('ROLLBACK');
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Send location update
router.post('/location', locationLimiter, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: 'latitude and longitude required' });
    }

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
    console.error('Location error:', err);
    res.status(500).json({ error: 'Server error' });
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
    console.error('Session error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
