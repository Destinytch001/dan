'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

/**
 * Refresh tokens are opaque random strings (not JWTs) so they can be
 * revoked server-side instantly — unlike a stateless access token,
 * which stays valid until it naturally expires. Stored hashed (SHA-256
 * is fine here — this isn't a low-entropy secret like a password, it's
 * a 320-bit random token; the hash is just so a DB leak doesn't hand
 * out directly-usable credentials).
 */
function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issue(userId, ip, userAgent, ttlSeconds) {
  const token = crypto.randomBytes(40).toString('hex');
  await pool.execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip_address, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [userId, hash(token), userAgent, ip, ttlSeconds]
  );
  return token;
}

/**
 * Validates a presented refresh token, returns its owning user_id or
 * null. Does NOT consume it — callers decide whether to rotate (revoke()).
 */
async function validate(token) {
  const [rows] = await pool.execute(
    'SELECT user_id FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1',
    [hash(token)]
  );
  return rows[0] ? rows[0].user_id : null;
}

async function revoke(token) {
  await pool.execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?', [hash(token)]);
}

async function revokeAllForUser(userId) {
  await pool.execute('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [
    userId,
  ]);
}

module.exports = { issue, validate, revoke, revokeAllForUser };
