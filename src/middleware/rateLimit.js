const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, try again in a minute' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Allow up to 10 location updates per minute per user
// (normal = 2/min at 30s interval, but buffered flushes can send bursts)
const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `loc_${req.user?.userId || req.ip}`,
  message: { error: 'Location update too frequent' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for batch endpoint: each request can carry up to 100 points,
// so 5 req/min × 100 pts = 500 points/min max (vs previous 1000/min)
const batchLocationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => `batch_${req.user?.userId || req.ip}`,
  message: { error: 'Batch upload too frequent' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { loginLimiter, locationLimiter, batchLocationLimiter };
