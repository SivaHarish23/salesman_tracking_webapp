const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { loginLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Pre-hash a dummy password for constant-time comparison when user doesn't exist
const DUMMY_HASH = bcrypt.hashSync('0000', 10);

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (typeof username !== 'string' || username.length > 50) {
      return res.status(400).json({ error: 'Invalid username' });
    }

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    // Always run bcrypt compare to prevent timing-based user enumeration
    const valid = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !valid) {
      console.log(`[AUTH] Login failed: username=${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Force-checkout any active session (auto-checkout on login from another device)
    let forceCheckout = false;
    try {
      const activeSession = await pool.query(
        'SELECT id, checkin_lat, checkin_lng FROM sessions WHERE user_id = $1 AND is_active = true',
        [user.id]
      );
      if (activeSession.rows.length > 0) {
        const session = activeSession.rows[0];
        // Use last known location from location_logs, or fall back to checkin coords
        const lastLoc = await pool.query(
          'SELECT latitude, longitude FROM location_logs WHERE session_id = $1 ORDER BY recorded_at DESC LIMIT 1',
          [session.id]
        );
        const lat = lastLoc.rows.length > 0 ? lastLoc.rows[0].latitude : session.checkin_lat;
        const lng = lastLoc.rows.length > 0 ? lastLoc.rows[0].longitude : session.checkin_lng;

        await pool.query(
          `UPDATE sessions SET checkout_time = NOW(), checkout_lat = $1, checkout_lng = $2, is_active = false
           WHERE id = $3`,
          [lat, lng, session.id]
        );
        await pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
        forceCheckout = true;
        console.log(`[AUTH] Force-checkout session ${session.id} for user ${user.id}`);
      }
    } catch (e) {
      console.error('[AUTH] Force-checkout error:', e.message);
    }

    console.log(`[AUTH] Login success: userId=${user.id}, role=${user.role}, forceCheckout=${forceCheckout}`);

    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
      force_checkout: forceCheckout,
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
