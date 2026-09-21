'use strict';

const { pool } = require('../config/db');

/**
 * Backs the homepage's "Say Hello to HouseBank" contact form. Anonymous
 * public inquiries -- distinct from the authenticated customer ->
 * company messaging in src/models/Conversation.js, which requires a real
 * account and an existing relationship. This is the "someone found us
 * from the website and typed a question" path.
 */

async function create({ full_name, email, message, ip_address }) {
  const [result] = await pool.execute(
    `INSERT INTO contact_messages (full_name, email, message, ip_address)
     VALUES (?, ?, ?, ?)`,
    [full_name, email, message, ip_address || null]
  );
  return result.insertId;
}

async function list(page = 1, perPage = 30, status) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = Math.max(0, (page - 1) * perPage);

  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM contact_messages ${whereSql}`, params);
  const [rows] = await pool.query(
    `SELECT id, full_name, email, message, status, created_at FROM contact_messages
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    params
  );
  return { items: rows, total: countRows[0].total, page, per_page: perPage };
}

async function markRead(id) {
  await pool.execute(`UPDATE contact_messages SET status = 'read' WHERE id = ?`, [id]);
}

module.exports = { create, list, markRead };
