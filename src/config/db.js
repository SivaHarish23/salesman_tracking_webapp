const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL must be set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

module.exports = pool;
