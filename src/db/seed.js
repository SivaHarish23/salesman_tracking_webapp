require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const fs = require('fs');
const path = require('path');

async function seed() {
  const client = await pool.connect();
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('Schema created.');

    const users = [
      { username: 'admin', password: '1111', role: 'admin' },
      { username: 'admin1', password: '1111', role: 'admin' },
      { username: 'harish', password: '1111', role: 'salesman' },
      { username: 'shake', password: '1111', role: 'salesman' },
      { username: 'jeyap', password: '1111', role: 'salesman' },
      { username: 'siva', password: '1111', role: 'salesman' },
      { username: 'guest', password: '1111', role: 'salesman' },
    ];

    for (const user of users) {
      const hash = await bcrypt.hash(user.password, 10);
      await client.query(
        `INSERT INTO users (username, password, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (username) DO UPDATE SET password = $2, role = $3`,
        [user.username, hash, user.role]
      );
      console.log(`Upserted user: ${user.username} (${user.role})`);
    }

    console.log('Seed complete.');
  } catch (err) {
    console.error('Seed error:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
