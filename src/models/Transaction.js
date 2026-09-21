'use strict';

const crypto = require('crypto');
const { pool } = require('../config/db');

async function create(connection, { user_id, type, reference_table, reference_id, amount, payment_method }) {
  const executor = connection || pool;
  const [result] = await executor.execute(
    `INSERT INTO transactions (uuid, user_id, type, reference_table, reference_id, amount, payment_method, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [crypto.randomUUID(), user_id, type, reference_table, reference_id, amount, payment_method]
  );
  return result.insertId;
}

async function forUser(userId, page = 1, perPage = 20) {
  const offset = Math.max(0, (page - 1) * perPage);
  const [rows] = await pool.query(
    `SELECT id, uuid, type, reference_table, reference_id, amount, currency, payment_method, status, created_at
     FROM transactions WHERE user_id = ? ORDER BY created_at DESC
     LIMIT ${Number(perPage)} OFFSET ${Number(offset)}`,
    [userId]
  );
  const [countRows] = await pool.execute('SELECT COUNT(*) AS total FROM transactions WHERE user_id = ?', [userId]);
  return { data: rows, page, per_page: perPage, total: countRows[0].total };
}

async function markStatus(connection, id, status) {
  const executor = connection || pool;
  await executor.execute('UPDATE transactions SET status = ? WHERE id = ?', [status, id]);
}

async function findByReference(referenceTable, referenceId, type) {
  const [rows] = await pool.execute(
    `SELECT * FROM transactions WHERE reference_table = ? AND reference_id = ? AND type = ? ORDER BY id DESC LIMIT 1`,
    [referenceTable, referenceId, type]
  );
  return rows[0] || null;
}

module.exports = { create, forUser, markStatus, findByReference };
