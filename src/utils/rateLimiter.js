'use strict';

const { pool, withTransaction } = require('../config/db');
const { logger } = require('./logger');
const response = require('./response');

/**
 * DB-backed sliding-window rate limiter, deliberately NOT an in-memory
 * Map. cPanel's Node.js Selector (Passenger) can restart or recycle your
 * app process at any time (idle timeout, deploy, memory cap) — an
 * in-memory limiter silently resets to zero on every restart, which
 * means it can quietly stop protecting anything. A small MySQL table
 * survives restarts and works the same way whether you're running one
 * process or several.
 *
 * The read-check-write is done inside a transaction with
 * `SELECT ... FOR UPDATE`, not as three separate unguarded statements —
 * the original version read the row, decided in JS whether to allow it,
 * then wrote separately, which meant two concurrent requests hitting the
 * same bucket_key at the same moment could both read "not over the
 * limit yet" before either had written anything, letting more than
 * maxAttempts through (exactly the kind of race a login/OTP brute-force
 * would exploit on purpose). `FOR UPDATE` makes the second request wait
 * for the first to commit, so the count it reads is always accurate.
 *
 * @returns {Promise<boolean>} true if allowed, false if the limit was hit
 */
async function attemptOnce(key, maxAttempts, windowSeconds) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      'SELECT attempts, UNIX_TIMESTAMP(window_started_at) AS started FROM rate_limits WHERE bucket_key = ? FOR UPDATE',
      [key]
    );

    const now = Math.floor(Date.now() / 1000);

    if (rows.length === 0) {
      await conn.execute(
        'INSERT INTO rate_limits (bucket_key, attempts, window_started_at) VALUES (?, 1, NOW())',
        [key]
      );
      return true;
    }

    const { attempts: currentAttempts, started } = rows[0];

    if (now - started > windowSeconds) {
      await conn.execute(
        'UPDATE rate_limits SET attempts = 1, window_started_at = NOW() WHERE bucket_key = ?',
        [key]
      );
      return true;
    }

    if (currentAttempts >= maxAttempts) {
      return false;
    }

    await conn.execute('UPDATE rate_limits SET attempts = attempts + 1 WHERE bucket_key = ?', [key]);
    return true;
  });
}

async function attempt(key, maxAttempts, windowSeconds) {
  try {
    return await attemptOnce(key, maxAttempts, windowSeconds);
  } catch (err) {
    // `SELECT ... FOR UPDATE` on a bucket_key that doesn't exist yet
    // locks nothing (there's no row to lock) — so two concurrent
    // FIRST-EVER attempts on a brand-new key can both fall into the
    // `rows.length === 0` branch and race on the INSERT. bucket_key is
    // UNIQUE, so the loser gets a real ER_DUP_ENTRY here instead of
    // silently corrupting the count. Retry once: the winner's row is
    // committed by the time this runs, so the retry's
    // `SELECT ... FOR UPDATE` sees it and locks it correctly.
    if (err && err.code === 'ER_DUP_ENTRY') {
      return attemptOnce(key, maxAttempts, windowSeconds);
    }
    throw err;
  }
}

async function reset(key) {
  await pool.execute('DELETE FROM rate_limits WHERE bucket_key = ?', [key]);
}

/**
 * Express middleware factory: enforce a limit keyed by a function of the
 * request (usually IP, sometimes IP+account), short-circuiting with 429.
 */
function enforce(keyFn, maxAttempts, windowSeconds, message) {
  return async (req, res, next) => {
    try {
      const key = keyFn(req);
      const allowed = await attempt(key, maxAttempts, windowSeconds);
      if (!allowed) {
        logger.security('Rate limit exceeded', { key });
        return response.tooManyRequests(res, message);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { attempt, reset, enforce };
