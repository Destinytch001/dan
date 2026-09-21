'use strict';

/**
 * One-time CLI script to create the first admin account. There is no
 * public "sign up as admin" endpoint on purpose — admin is the
 * highest-privilege role (property approval, agent/company
 * verification, dispute resolution) and must never be self-service.
 *
 * Usage (from the project root, over SSH or cPanel Terminal):
 *   node database/seedAdmin.js admin@yourdomain.com 08012345678 "A-Strong-Password1"
 */

const { pool } = require('../src/config/db');
const User = require('../src/models/User');

async function main() {
  const [, , email, phone, password] = process.argv;

  if (!email || !phone || !password) {
    console.error('Usage: node database/seedAdmin.js <email> <phone> <password>');
    process.exit(1);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Invalid email address.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const existing = await User.findByEmail(email);
  if (existing) {
    console.error('A user with that email already exists.');
    process.exit(1);
  }

  const connection = await pool.getConnection();
  try {
    const id = await User.create(connection, { email, phone, password, role: 'admin' });
    await User.markEmailVerified(id);
    console.log(`Admin account created — id=${id}, email=${email}`);
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to create admin:', err.message);
  process.exit(1);
});
