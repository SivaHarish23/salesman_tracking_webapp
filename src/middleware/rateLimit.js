const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, try again in a minute' },
  standardHeaders: true,
  legacyHeaders: false,
});

const locationLimiter = rateLimit({
  windowMs: 25 * 1000,
  max: 1,
  keyGenerator: (req) => req.user?.userId || req.ip,
  message: { error: 'Location update too frequent' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { loginLimiter, locationLimiter };
