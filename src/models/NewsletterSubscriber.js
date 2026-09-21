'use strict';

const { pool } = require('../config/db');

/**
 * Backs the homepage footer's newsletter signup form ("Looking to Buy,
 * Rent and Invest in Real Estate?"). Anonymous/public -- no signed-in
 * user required, so this is deliberately its own tiny table rather than
 * tied to `users` in any way.
 */

/**
 * Idempotent on purpose: someone submitting the same email twice (double
 * click, or resubscribing after a change of heart) should feel like it
 * worked both times, not surface a confusing "already subscribed" error
 * on a public marketing form. A previously-unsubscribed email that
 * resubmits is treated as re-subscribing.
 */
async function subscribe(email, source = 'homepage_footer') {
  await pool.execute(
    `INSERT INTO newsletter_subscribers (email, source, subscribed_at, unsubscribed_at)
     VALUES (?, ?, NOW(), NULL)
     ON DUPLICATE KEY UPDATE source = VALUES(source), subscribed_at = NOW(), unsubscribed_at = NULL`,
    [email, source]
  );
}

async function list(page = 1, perPage = 50) {
  const offset = Math.max(0, (page - 1) * perPage);
  const [countRows] = await pool.execute(
    'SELECT COUNT(*) AS total FROM newsletter_subscribers WHERE unsubscribed_at IS NULL'
  );
  const [rows] = await pool.query(
    `SELECT id, email, source, subscribed_at FROM newsletter_subscribers
     WHERE unsubscribed_at IS NULL
     ORDER BY subscribed_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`
  );
  return { items: rows, total: countRows[0].total, page, per_page: perPage };
}

module.exports = { subscribe, list };
