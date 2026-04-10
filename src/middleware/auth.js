const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  let token;

  if (header && header.startsWith('Bearer ')) {
    token = header.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  // Try JWT first — it's instant (no DB), so it won't hang on DB cold starts
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    req.tokenRevoked = false;
    return next();
  } catch {
    // Not a valid JWT — fall through to device token lookup
  }

  // Device token: persistent tokens for salesman mobile app
  const dbStart = Date.now();
  try {
    const result = await pool.query(
      `SELECT dt.id AS token_id, dt.user_id, dt.revoked_at, u.username, u.role
       FROM device_tokens dt
       JOIN users u ON u.id = dt.user_id
       WHERE dt.token = $1`,
      [token]
    );
    const dbMs = Date.now() - dbStart;
    if (dbMs > 3000) {
      console.warn(`[AUTH] Slow device-token lookup: ${dbMs}ms | path=${req.path}`);
    }

    if (result.rows.length > 0) {
      const row = result.rows[0];

      if (row.revoked_at) {
        const revokedAge = Date.now() - new Date(row.revoked_at).getTime();
        if (revokedAge > GRACE_PERIOD_MS) {
          return res.status(401).json({ error: 'Token revoked' });
        }
        req.tokenRevoked = true;
      } else {
        req.tokenRevoked = false;
      }

      req.user = { userId: row.user_id, username: row.username, role: row.role };
      req.deviceToken = token;
      pool.query('UPDATE device_tokens SET last_used_at = NOW() WHERE id = $1', [row.token_id]).catch(() => {});
      return next();
    }
  } catch (err) {
    console.error(`[AUTH] Device token lookup FAILED after ${Date.now() - dbStart}ms:`, err.message);
  }

  return res.status(401).json({ error: 'Invalid token' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
