'use strict';

const jwt = require('jsonwebtoken');
const { env } = require('../config/env');

/**
 * Thin wrapper around jsonwebtoken (HS256). Access tokens are short-lived
 * and stateless; refresh tokens are NOT JWTs (see models/refreshToken.js)
 * — they're opaque random strings hashed in the DB, so they can be
 * revoked instantly, unlike a stateless access token.
 */
function signAccessToken(payload) {
  return jwt.sign({ ...payload, type: 'access' }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
  });
}

function verifyAccessToken(token) {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type !== 'access') return null;
    return decoded;
  } catch (err) {
    return null; // expired, malformed, or bad signature — all treated the same
  }
}

/**
 * A short-lived, single-purpose token issued after a password check
 * succeeds on a 2FA-enabled account, but before the real access token
 * is issued. It proves "this caller just proved they know the
 * password" without granting API access — /auth/2fa/verify-login is
 * the only endpoint that accepts it, and only to exchange it (plus a
 * valid TOTP/recovery code) for real tokens. Without this, a second-
 * factor check keyed only on a submitted user_id would let anyone who
 * can guess/enumerate a user_id skip straight to brute-forcing 2FA
 * codes without ever proving they had the password.
 */
function signPendingTwoFactorToken(payload) {
  return jwt.sign({ ...payload, type: 'pending_2fa' }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: 300, // 5 minutes — enough to open an authenticator app and type a code
  });
}

function verifyPendingTwoFactorToken(token) {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.type !== 'pending_2fa') return null;
    return decoded;
  } catch (err) {
    return null;
  }
}

module.exports = { signAccessToken, verifyAccessToken, signPendingTwoFactorToken, verifyPendingTwoFactorToken };
