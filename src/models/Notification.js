'use strict';

const { pool } = require('../config/db');

async function create(userId, type, title, body = null, data = null) {
  const [result] = await pool.execute(
    `INSERT INTO notifications (user_id, type, title, body, data_json) VALUES (?, ?, ?, ?, ?)`,
    [userId, type, title, body, data ? JSON.stringify(data) : null]
  );
  return result.insertId;
}

async function forUser(userId, { unreadOnly = false, page = 1, perPage = 20 } = {}) {
  const offset = Math.max(0, (page - 1) * perPage);
  const where = unreadOnly ? 'WHERE user_id = ? AND is_read = 0' : 'WHERE user_id = ?';

  const [rows] = await pool.query(
    `SELECT id, type, title, body, data_json, is_read, created_at
     FROM notifications ${where}
     ORDER BY created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    [userId]
  );
  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM notifications ${where}`, [userId]);

  return { data: rows, page, per_page: perPage, total: countRows[0].total };
}

async function unreadCount(userId) {
  const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0', [userId]);
  return rows[0].count;
}

/** Scoped to (id, user_id) in the SQL itself — a user can never mark
 * another user's notification read no matter what id they pass in. */
async function markRead(id, userId) {
  const [result] = await pool.execute('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
  return result.affectedRows > 0;
}

async function markAllRead(userId) {
  await pool.execute('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [userId]);
}

/**
 * Admin's platform-wide activity feed (Joan, Sep 2026: "admins
 * notification is meant to emcompass all users and not this" -- the
 * per-user GET /notifications pattern every other role uses is
 * structurally wrong for admin, since nothing ever creates a
 * Notification row addressed to the admin's own user_id. Rather than
 * invent a second notifications table, this reuses the exact same rows
 * every other role's notifications already are -- new messages,
 * listing approvals/rejections, company invites, purchases/rentals/
 * investments, 2FA events -- and surfaces all of them, across every
 * recipient, as one system-wide feed. That's a direct, accurate read
 * of "encompass all users": admin sees everything happening to
 * everyone, not a personal inbox that structurally can never fill.
 */
async function platformFeed({ page = 1, perPage = 20 } = {}) {
  const offset = Math.max(0, (page - 1) * perPage);

  const [rows] = await pool.query(
    `SELECT n.id, n.type, n.title, n.body, n.is_read, n.created_at,
            u.id AS recipient_id, u.role AS recipient_role, u.email AS recipient_email,
            COALESCE(cp.full_name, ap.full_name, c.company_name) AS recipient_name
     FROM notifications n
     JOIN users u ON u.id = n.user_id
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     LEFT JOIN agent_profiles ap ON ap.user_id = u.id
     LEFT JOIN companies c ON c.user_id = u.id
     ORDER BY n.created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`
  );
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM notifications');

  return { data: rows, page, per_page: perPage, total };
}

module.exports = { create, forUser, unreadCount, markRead, markAllRead, platformFeed };
