'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

/**
 * One-time passcodes for signup verification, password reset, etc. The
 * code itself is never stored in plaintext — only its bcrypt hash — so a
 * database leak alone can't be used to impersonate anyone via a
 * still-valid OTP.
 */
async function generateAndStore(userId, purpose, ttlMinutes = 10) {
  // 6-digit numeric code, cryptographically random (crypto.randomInt,
  // never Math.random for anything security-sensitive).
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, 10);

  // Invalidate any previous unconsumed codes for the same purpose so
  // only the newest one is ever valid.
  await pool.execute(
    'UPDATE otp_codes SET consumed_at = NOW() WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL',
    [userId, purpose]
  );

  await pool.execute(
    `INSERT INTO otp_codes (user_id, code_hash, purpose, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [userId, codeHash, purpose, ttlMinutes]
  );

  return code;
}

/**
 * Verifies a submitted code; consumes it on success. Tracks attempts to
 * prevent brute-forcing a 6-digit code by guessing. Expiry is checked
 * IN SQL (expires_at vs NOW(), both server-side) rather than fetched and
 * compared in JS, so there's no client/server timezone assumption to
 * get wrong.
 */
async function verify(userId, purpose, submittedCode) {
  const [rows] = await pool.execute(
    `SELECT id, code_hash, attempts, (expires_at < NOW()) AS is_expired
     FROM otp_codes
     WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [userId, purpose]
  );

  const row = rows[0];
  if (!row) return false;
  if (row.attempts >= 5 || row.is_expired) return false;

  await pool.execute('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);

  const matches = await bcrypt.compare(submittedCode, row.code_hash);
  if (!matches) return false;

  await pool.execute('UPDATE otp_codes SET consumed_at = NOW() WHERE id = ?', [row.id]);
  return true;
}

module.exports = { generateAndStore, verify };
