const express = require('express');
const pool = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

// List all salesmen with status
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.is_active,
              s.checkin_time AS last_checkin_time,
              s.checkout_time AS last_checkout_time
       FROM users u
       LEFT JOIN LATERAL (
         SELECT checkin_time, checkout_time FROM sessions
         WHERE user_id = u.id ORDER BY checkin_time DESC LIMIT 1
       ) s ON true
       WHERE u.role = 'salesman'
       ORDER BY u.username`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Live locations of all active salesmen
router.get('/locations/live', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (ll.user_id)
              ll.user_id, u.username, ll.latitude, ll.longitude, ll.recorded_at
       FROM location_logs ll
       JOIN users u ON u.id = ll.user_id
       WHERE u.is_active = true
       ORDER BY ll.user_id, ll.recorded_at DESC`
    );
    res.json({ locations: result.rows });
  } catch (err) {
    console.error('Live locations error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Specific user's session with full route
router.get('/users/:id/session', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const sessionId = req.query.session_id;

    let sessionQuery;
    if (sessionId) {
      sessionQuery = await pool.query(
        'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
        [sessionId, userId]
      );
    } else {
      // Get current active session, or latest session
      sessionQuery = await pool.query(
        'SELECT * FROM sessions WHERE user_id = $1 ORDER BY is_active DESC, checkin_time DESC LIMIT 1',
        [userId]
      );
    }

    if (sessionQuery.rows.length === 0) {
      return res.json({ session: null, locations: [] });
    }

    const session = sessionQuery.rows[0];
    const locations = await pool.query(
      'SELECT latitude, longitude, recorded_at FROM location_logs WHERE session_id = $1 ORDER BY recorded_at ASC',
      [session.id]
    );

    res.json({ session, locations: locations.rows });
  } catch (err) {
    console.error('User session error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
