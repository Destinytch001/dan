'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool, withTransaction } = require('../config/db');

/**
 * HouseBank's 2FA is email-OTP based, not an authenticator app — the
 * schema's otp_codes.purpose enum has included 'login_2fa' since the
 * very first migration, reusing the exact same OtpCode/mailer
 * infrastructure signup verification and password reset already run
 * through in production. There's no persistent secret to store or
 * encrypt: a fresh 6-digit code is emailed and consumed each time (see
 * OtpCode.generateAndStore/verify), so this model only needs to track
 * whether 2FA is turned on, plus a small set of single-use recovery
 * codes for when email isn't reachable.
 */
async function isEnabled(userId) {
  const [rows] = await pool.execute('SELECT two_factor_enabled_at FROM users WHERE id = ?', [userId]);
  return !!rows[0] && rows[0].two_factor_enabled_at !== null;
}

function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars, 40 bits
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/**
 * Turns 2FA on and issues a fresh set of recovery codes, replacing any
 * that existed before — atomic so a failure partway through can't leave
 * 2FA "on" with no usable recovery codes on file. Returns the plain
 * codes; only their bcrypt hash is ever stored, so this is the only
 * moment they can be shown to the user.
 */
async function enable(userId) {
  const codes = generateRecoveryCodes();
  await withTransaction(async (connection) => {
    await connection.execute('UPDATE users SET two_factor_enabled_at = NOW() WHERE id = ?', [userId]);
    await connection.execute('DELETE FROM user_recovery_codes WHERE user_id = ?', [userId]);
    for (const code of codes) {
      // eslint-disable-next-line no-await-in-loop
      const hash = await bcrypt.hash(code, 10);
      await connection.execute('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)', [userId, hash]);
    }
  });
  return codes;
}

async function disable(userId) {
  await withTransaction(async (connection) => {
    await connection.execute('UPDATE users SET two_factor_enabled_at = NULL WHERE id = ?', [userId]);
    await connection.execute('DELETE FROM user_recovery_codes WHERE user_id = ?', [userId]);
  });
}

/** Checks a recovery code against the user's unused codes and consumes
 * it (single-use) if it matches — at most 8 bcrypt.compare calls,
 * negligible next to the login path's own compare against the
 * password hash. */
async function consumeRecoveryCode(userId, code) {
  const [rows] = await pool.execute(
    'SELECT id, code_hash FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
  const clean = String(code || '').trim().toUpperCase();
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(clean, row.code_hash)) {
      await pool.execute('UPDATE user_recovery_codes SET used_at = NOW() WHERE id = ?', [row.id]);
      return true;
    }
  }
  return false;
}

async function remainingRecoveryCodeCount(userId) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS count FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    [userId]
  );
  return rows[0].count;
}

module.exports = { isEnabled, enable, disable, consumeRecoveryCode, remainingRecoveryCodeCount };
